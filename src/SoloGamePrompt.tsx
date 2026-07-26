import { useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from './accessibility';
import type { SoloGameSetup, SoloPersistenceWarning, SoloSessionRecord } from './soloDurability';
import { soloDifficultyLabel, soloSessionSummary } from './soloUx';

export interface SoloGamePromptProps {
  resumeSession: SoloSessionRecord | null;
  replacementOpen: boolean;
  replacementPending: boolean;
  replacementCurrentSession?: SoloSessionRecord | null;
  replacementTriggerRef?: RefObject<HTMLButtonElement>;
  replacementSetup?: SoloGameSetup | null;
  warning: SoloPersistenceWarning | null;
  onCancelReplacement: () => void;
  onConfirmReplacement: () => void;
  onContinue: () => void;
  onDismissResume: () => void;
  onRequestReplacement: () => void;
  restoreFocusFallback?: () => HTMLElement | null;
}

function formatSavedAt(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

export default function SoloGamePrompt({
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
  const resumeDialogRef = useRef<HTMLDivElement | null>(null);
  const continueGameRef = useRef<HTMLButtonElement | null>(null);
  const replacementDialogRef = useRef<HTMLElement | null>(null);
  const keepCurrentGameRef = useRef<HTMLButtonElement | null>(null);

  useModalFocus({
    open: Boolean(resumeSession && !replacementOpen),
    dialogRef: resumeDialogRef,
    initialFocusRef: continueGameRef,
    onDismiss: onDismissResume
  });
  useModalFocus({
    open: replacementOpen,
    dialogRef: replacementDialogRef,
    initialFocusRef: keepCurrentGameRef,
    onDismiss: () => {
      if (!replacementPending) onCancelReplacement();
    },
    restoreFocusFallback,
    triggerRef: replacementTriggerRef
  });

  const replacementDialog = replacementOpen
    ? createPortal(
        <div
          className="skyjo-settings-overlay skyjo-solo-replacement-overlay fixed inset-0 flex items-end justify-center bg-black/70 px-3 py-4 backdrop-blur-sm sm:items-center sm:px-5"
          data-modal-overlay
          onClick={(event) => {
            if (event.target === event.currentTarget && !replacementPending) onCancelReplacement();
          }}
        >
          <section
            aria-describedby="solo-replacement-description"
            aria-labelledby="solo-replacement-title"
            aria-modal="true"
            className="skyjo-panel skyjo-solo-replacement-dialog w-full max-w-lg p-6"
            ref={replacementDialogRef}
            role="dialog"
          >
            <p className="skyjo-kicker">Review new solo game</p>
            <h2 className="skyjo-serif mt-2 text-3xl font-black text-[#f5e6c8]" id="solo-replacement-title">
              Replace your saved game?
            </h2>
            <p className="mt-3 leading-7 text-[#f5e6c8]/68" id="solo-replacement-description">
              Your current game stays resumable until the new game is saved successfully.
            </p>
            {replacementSetup && replacementCurrentSession ? (
              <div className="skyjo-replacement-comparison mt-4">
                <div>
                  <span className="skyjo-kicker">Current saved game</span>
                  <strong>{soloSessionSummary(replacementCurrentSession)}</strong>
                </div>
                <div>
                  <span className="skyjo-kicker">New game</span>
                  <strong>
                    {replacementSetup.aiOpponentCount} AI opponent{replacementSetup.aiOpponentCount === 1 ? '' : 's'} · {soloDifficultyLabel(replacementSetup.difficulty)}
                  </strong>
                </div>
              </div>
            ) : null}
            {warning ? (
              <p className="mt-3 text-sm font-bold text-[#f5e6c8]/75" role="status">
                {warning.message}
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                className="skyjo-button px-4 py-3"
                disabled={replacementPending}
                onClick={onCancelReplacement}
                ref={keepCurrentGameRef}
                type="button"
              >
                Keep Current Game
              </button>
              <button
                className="skyjo-button skyjo-button-primary px-4 py-3"
                disabled={replacementPending}
                onClick={onConfirmReplacement}
                type="button"
              >
                {replacementPending ? 'Saving new game…' : 'Replace saved game & start'}
              </button>
            </div>
          </section>
        </div>,
        document.body
      )
    : null;

  if (!resumeSession) return replacementDialog;
  return (
    <>
      <main className="skyjo-surface px-4 py-8" data-modal-overlay data-testid="solo-resume-choice">
        {!replacementOpen ? (
          <section className="skyjo-shell mx-auto flex min-h-[70vh] max-w-2xl items-center">
            <div
              aria-describedby="solo-resume-description"
              aria-labelledby="solo-resume-title"
              aria-modal="true"
              className="skyjo-panel skyjo-solo-resume-dialog w-full p-6"
              ref={resumeDialogRef}
              role="dialog"
            >
              <p className="skyjo-kicker">Saved game found</p>
              <h1 className="skyjo-serif mt-2 text-3xl font-black text-[#f5e6c8]" id="solo-resume-title">
                Continue your solo game?
              </h1>
              <p className="mt-3 leading-7 text-[#f5e6c8]/68" id="solo-resume-description">
                Round {resumeSession.state.round} with {resumeSession.aiOpponentCount} AI opponent
                {resumeSession.aiOpponentCount === 1 ? '' : 's'}, saved {formatSavedAt(resumeSession.updatedAt)}.
              </p>
              {warning ? <p className="mt-3 text-sm font-bold text-[#f5e6c8]/70">{warning.message}</p> : null}
              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  className="skyjo-button skyjo-button-primary px-4 py-3"
                  onClick={onContinue}
                  ref={continueGameRef}
                  type="button"
                >
                  Continue Game
                </button>
                <button className="skyjo-button px-4 py-3" onClick={onRequestReplacement} type="button">
                  New Game
                </button>
              </div>
            </div>
          </section>
        ) : null}
      </main>
      {replacementDialog}
    </>
  );
}
