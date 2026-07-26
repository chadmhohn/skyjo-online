import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from './accessibility';
import type { SoloGamePromptProps } from './SoloGamePrompt';

export default function SoloGamePromptLoadFallback({
  resumeSession,
  replacementOpen,
  replacementPending,
  warning,
  onCancelReplacement,
  onConfirmReplacement,
  onContinue,
  onDismissResume,
  onRequestReplacement,
  restoreFocusFallback
}: SoloGamePromptProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const firstButtonRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus({
    open: Boolean(resumeSession || replacementOpen),
    dialogRef,
    initialFocusRef: firstButtonRef,
    onDismiss: replacementOpen ? (replacementPending ? undefined : onCancelReplacement) : onDismissResume,
    restoreFocusFallback: replacementOpen ? restoreFocusFallback : undefined
  });

  const actions = replacementOpen ? (
    <>
      <button className="skyjo-button px-4 py-3" disabled={replacementPending} onClick={onCancelReplacement} ref={firstButtonRef} type="button">
        Keep Current Game
      </button>
      <button className="skyjo-button skyjo-button-primary px-4 py-3" disabled={replacementPending} onClick={onConfirmReplacement} type="button">
        {replacementPending ? 'Saving New Game…' : 'Replace Saved Game'}
      </button>
    </>
  ) : (
    <>
      <button className="skyjo-button skyjo-button-primary px-4 py-3" onClick={onContinue} ref={firstButtonRef} type="button">
        Continue Game
      </button>
      <button className="skyjo-button px-4 py-3" onClick={onRequestReplacement} type="button">
        New Game
      </button>
    </>
  );
  const dialog = (
    <section aria-describedby="solo-options-loading" aria-label="Solo game options" aria-modal="true" className="skyjo-panel w-full max-w-lg p-6" ref={dialogRef} role="dialog">
      <p className="skyjo-disabled-note" id="solo-options-loading" role="status">Game options are loading. Safe actions remain available.</p>
      {warning ? <p className="mt-3 text-sm font-bold text-[#f5e6c8]/75" role="status">{warning.message}</p> : null}
      <div className="mt-5 flex flex-wrap gap-2">{actions}</div>
    </section>
  );
  return replacementOpen
    ? createPortal(
        <div className="skyjo-settings-overlay fixed inset-0 flex items-end justify-center bg-black/70 px-3 py-4" data-modal-overlay>
          {dialog}
        </div>,
        document.body
      )
    : <main className="skyjo-surface px-4 py-8" data-modal-overlay data-testid="solo-resume-choice">{dialog}</main>;
}
