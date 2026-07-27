import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from './accessibility';
import type { SoloGamePromptProps } from './SoloGamePrompt';
import { soloDifficultyLabel, soloSessionSummary } from './soloUx';

export default function SoloGamePromptLoadFallback({
  resumeSession,
  replacementOpen,
  replacementPending,
  replacementCurrentSession,
  replacementTriggerRef,
  replacementSetup,
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
    triggerRef: replacementOpen ? replacementTriggerRef : undefined,
    restoreFocusFallback: replacementOpen ? restoreFocusFallback : undefined
  });

  const actions = replacementOpen ? (
    <>
      <button className="skyjo-button px-4 py-3" disabled={replacementPending} onClick={onCancelReplacement} ref={firstButtonRef} type="button">
        Keep Current Game
      </button>
      <button className="skyjo-button skyjo-button-primary px-4 py-3" disabled={replacementPending} onClick={onConfirmReplacement} type="button">
        {replacementPending ? 'Saving new game…' : 'Replace saved game & start'}
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
    <section aria-describedby="solo-options-loading" aria-label="Solo game options" aria-modal="true" className="skyjo-panel skyjo-solo-replacement-dialog w-full max-w-lg p-6" ref={dialogRef} role="dialog">
      <p className="skyjo-disabled-note" id="solo-options-loading" role="status">Game options are loading. Safe actions remain available.</p>
      {replacementOpen && replacementSetup && replacementCurrentSession ? (
        <div className="skyjo-replacement-comparison mt-3">
          <div><span className="skyjo-kicker">Current saved game</span><strong>{soloSessionSummary(replacementCurrentSession)}</strong></div>
          <div>
            <span className="skyjo-kicker">New game</span>
            <strong>{replacementSetup.aiOpponentCount} AI opponent{replacementSetup.aiOpponentCount === 1 ? '' : 's'} · {soloDifficultyLabel(replacementSetup.difficulty)}</strong>
          </div>
        </div>
      ) : null}
      {warning ? <p className="mt-3 text-sm font-bold text-[#f5e6c8]/75" role="status">{warning.message}</p> : null}
      <div className="mt-5 flex flex-wrap gap-2">{actions}</div>
    </section>
  );
  return replacementOpen
    ? createPortal(
        <div
          className="skyjo-settings-overlay skyjo-solo-replacement-overlay fixed inset-0 flex items-end justify-center bg-black/70 px-3 py-4"
          data-modal-overlay
          onClick={(event) => {
            if (event.target === event.currentTarget && !replacementPending) onCancelReplacement();
          }}
        >
          {dialog}
        </div>,
        document.body
      )
    : <main className="skyjo-surface px-4 py-8" data-modal-overlay data-testid="solo-resume-choice">{dialog}</main>;
}
