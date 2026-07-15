import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus, usePhoneLayout } from './accessibility';
import type { ActiveRoomOptionsDialogProps } from './ActiveRoomOptionsDialog';
import type { RoundSummaryProps } from './RoundSummary';

export function RoundSummaryLoadFallback({
  actionDisabledReason,
  actionLabel,
  children,
  onAction,
  onMinimize,
  restoreFocusFallback
}: RoundSummaryProps) {
  const phoneLayout = usePhoneLayout();
  const dialogRef = useRef<HTMLElement | null>(null);
  const alertRef = useRef<HTMLParagraphElement | null>(null);
  useModalFocus({
    open: phoneLayout,
    dialogRef,
    initialFocusRef: alertRef,
    onDismiss: onMinimize,
    closeOnEscape: Boolean(onMinimize),
    restoreFocusFallback
  });
  const summary = (
    <section
      aria-label="Round controls unavailable"
      aria-modal={phoneLayout ? true : undefined}
      className="skyjo-panel skyjo-score-panel skyjo-round-summary-panel"
      ref={dialogRef}
      role={phoneLayout ? 'dialog' : undefined}
    >
      <p className="skyjo-disabled-note" ref={alertRef} role="alert" tabIndex={-1}>
        Scores unavailable. Round controls still work.
      </p>
      {onMinimize ? (
        <button className="skyjo-button mt-3 px-3 py-2" onClick={onMinimize} type="button">Minimize</button>
      ) : null}
      {children}
      {actionLabel && onAction ? (
        <button
          className="skyjo-button skyjo-button-primary mt-4 w-full px-4 py-3"
          disabled={Boolean(actionDisabledReason)}
          onClick={onAction}
          title={actionDisabledReason || actionLabel}
          type="button"
        >
          {actionLabel}
        </button>
      ) : null}
    </section>
  );
  return phoneLayout
    ? createPortal(<div className="skyjo-round-summary-overlay" data-modal-overlay>{summary}</div>, document.body)
    : summary;
}

export function ActiveRoomOptionsLoadFallback({
  active,
  children,
  onDismiss,
  open,
  triggerRef
}: ActiveRoomOptionsDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus({
    open: active && open,
    dialogRef,
    initialFocusRef: closeButtonRef,
    triggerRef,
    onDismiss
  });
  if (!active) return <>{children}</>;
  if (!open) return null;
  return createPortal(
    <div
      className="skyjo-room-options-overlay fixed inset-0 flex items-end justify-center bg-black/70 px-3 py-4"
      data-modal-overlay
    >
      <section
        aria-label="Room options unavailable"
        aria-modal="true"
        className="skyjo-panel skyjo-room-options-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="skyjo-room-options-header">
          <button className="skyjo-button px-3 py-2" onClick={onDismiss} ref={closeButtonRef} type="button">
            Close room options
          </button>
        </header>
        <div className="skyjo-room-options-body">{children}</div>
      </section>
    </div>,
    document.body
  );
}
