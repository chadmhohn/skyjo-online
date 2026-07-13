import { useEffect, useRef, useState, type RefObject } from 'react';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

const inertState = new Map<HTMLElement, { count: number; wasInert: boolean }>();
const modalStack: symbol[] = [];
let bodyLockDepth = 0;
let bodyOverflowBeforeLock = '';

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => {
    if (element.tabIndex < 0) return false;
    let current: HTMLElement | null = element;
    while (current && current !== dialog) {
      const style = window.getComputedStyle(current);
      if (
        current.hidden ||
        current.hasAttribute('inert') ||
        current.getAttribute('aria-hidden') === 'true' ||
        style.display === 'none' ||
        style.visibility === 'hidden'
      ) {
        return false;
      }
      current = current.parentElement;
    }
    return true;
  });
}

function setBackgroundInert(overlay: HTMLElement): () => void {
  const modalLayer = overlay.parentElement === document.body
    ? overlay
    : [...document.body.children].find((element) => element.contains(overlay));
  const background = [...document.body.children].filter(
    (element): element is HTMLElement => element instanceof HTMLElement && element !== modalLayer
  );
  for (const element of background) {
    const current = inertState.get(element);
    if (current) {
      current.count += 1;
    } else {
      inertState.set(element, { count: 1, wasInert: element.hasAttribute('inert') });
      element.setAttribute('inert', '');
    }
  }
  return () => {
    for (const element of background) {
      const current = inertState.get(element);
      if (!current) continue;
      current.count -= 1;
      if (current.count > 0) continue;
      if (!current.wasInert) element.removeAttribute('inert');
      inertState.delete(element);
    }
  };
}

function lockBodyScroll(): () => void {
  if (bodyLockDepth === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  bodyLockDepth += 1;
  return () => {
    bodyLockDepth = Math.max(0, bodyLockDepth - 1);
    if (bodyLockDepth === 0) document.body.style.overflow = bodyOverflowBeforeLock;
  };
}

type ModalFocusOptions = {
  open: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  triggerRef?: RefObject<HTMLElement | null>;
  onDismiss?: () => void;
  closeOnEscape?: boolean;
  restoreFocusFallback?: () => HTMLElement | null;
};

export function useModalFocus({
  open,
  dialogRef,
  initialFocusRef,
  triggerRef,
  onDismiss,
  closeOnEscape = true,
  restoreFocusFallback
}: ModalFocusOptions): void {
  const onDismissRef = useRef(onDismiss);
  const restoreFocusFallbackRef = useRef(restoreFocusFallback);
  const activeSessionRef = useRef<symbol | null>(null);
  onDismissRef.current = onDismiss;
  restoreFocusFallbackRef.current = restoreFocusFallback;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const overlay = dialog.closest<HTMLElement>('[data-modal-overlay]') ?? dialog;
    const opener = triggerRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const token = Symbol('modal-focus');
    activeSessionRef.current = token;
    modalStack.push(token);
    const restoreInert = setBackgroundInert(overlay);
    const unlockBody = lockBodyScroll();

    const focusFirst = () => {
      const target = initialFocusRef?.current ?? focusableElements(dialog)[0] ?? dialog;
      target.focus({ preventScroll: true });
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== token) return;
      if (event.key === 'Escape' && closeOnEscape && onDismissRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onDismissRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1] ?? first;
      const active = document.activeElement;
      const activeIsOutsideTabOrder = !(active instanceof HTMLElement) || !focusable.includes(active);
      if (event.shiftKey && (document.activeElement === first || activeIsOutsideTabOrder)) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (document.activeElement === last || activeIsOutsideTabOrder)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (modalStack[modalStack.length - 1] !== token || dialog.contains(event.target as Node)) return;
      focusFirst();
    };

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    focusFirst();

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      const stackIndex = modalStack.lastIndexOf(token);
      if (stackIndex >= 0) modalStack.splice(stackIndex, 1);
      if (activeSessionRef.current === token) activeSessionRef.current = null;
      restoreInert();
      unlockBody();
      queueMicrotask(() => {
        if (activeSessionRef.current !== null) return;
        const fallback = restoreFocusFallbackRef.current?.() ?? null;
        const target = opener && opener !== document.body && opener.isConnected ? opener : fallback;
        target?.focus({ preventScroll: true });
      });
    };
  }, [closeOnEscape, dialogRef, initialFocusRef, open, triggerRef]);
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const updateMatch = () => setMatches(mediaQuery.matches);
    updateMatch();
    mediaQuery.addEventListener('change', updateMatch);
    return () => mediaQuery.removeEventListener('change', updateMatch);
  }, [query]);

  return matches;
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

export function usePhoneLayout(): boolean {
  return useMediaQuery('(max-width: 640px)');
}
