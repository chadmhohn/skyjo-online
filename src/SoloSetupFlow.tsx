import { useEffect, useRef, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { singlePlayerAiOpponentRange } from './game';
import type {
  SoloGameSetup,
  SoloPersistenceWarning,
  SoloSessionRecord
} from './soloDurability';
import {
  formatSoloSavedAt,
  soloDifficultyLabel,
  soloDifficultyOptions,
  soloSessionSummary,
  type SoloIntent,
  type SoloSetupOrigin
} from './soloUx';

export function HomeSoloActions({
  loading,
  session,
  warning
}: {
  loading: boolean;
  session: SoloSessionRecord | null;
  warning: SoloPersistenceWarning | null;
}) {
  return (
    <section aria-labelledby="skyjo-play-title" className="skyjo-home-play-panel skyjo-panel">
      <div>
        <p className="skyjo-kicker">Choose a table</p>
        <h2 className="skyjo-serif mt-1 text-2xl font-black text-[#f5e6c8]" id="skyjo-play-title">
          Play
        </h2>
      </div>
      {loading ? (
        <div className="skyjo-home-play-loading" role="status">Checking for a saved solo game…</div>
      ) : session ? (
        <div className="skyjo-home-solo-actions">
          <Link
            className="skyjo-button skyjo-button-primary skyjo-home-play-action"
            state={{ soloIntent: 'continue' satisfies SoloIntent }}
            to="/single-player"
          >
            <span>Continue Solo</span>
            <span className="skyjo-home-action-meta">{soloSessionSummary(session)}</span>
            <span className="skyjo-home-action-meta">Saved {formatSoloSavedAt(session.updatedAt)}</span>
          </Link>
          <Link
            className="skyjo-button skyjo-home-play-action"
            state={{ soloIntent: 'new' satisfies SoloIntent }}
            to="/single-player"
          >
            <span>New Solo Game</span>
            <span className="skyjo-home-action-meta">Choose opponents and difficulty first</span>
          </Link>
        </div>
      ) : (
        <Link
          className="skyjo-button skyjo-button-primary skyjo-home-play-action"
          state={{ soloIntent: 'new' satisfies SoloIntent }}
          to="/single-player"
        >
          <span>Start Solo Game</span>
          <span className="skyjo-home-action-meta">Choose opponents and difficulty</span>
        </Link>
      )}
      <Link className="skyjo-button skyjo-home-play-action" to="/lobby">
        <span>Multiplayer</span>
        <span className="skyjo-home-action-meta">Create or join a private room</span>
      </Link>
      {warning ? <p className="skyjo-home-session-warning" role="status">{warning.message}</p> : null}
    </section>
  );
}

function useSoloScreenFocus(onBack: () => void) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onBack]);
  return headingRef;
}

export function SoloLauncher({
  session,
  warning,
  onContinue,
  onNewGame,
  onBack
}: {
  session: SoloSessionRecord;
  warning: SoloPersistenceWarning | null;
  onContinue: () => void;
  onNewGame: () => void;
  onBack: () => void;
}) {
  const headingRef = useSoloScreenFocus(onBack);
  return (
    <main className="skyjo-surface skyjo-solo-flow-surface px-4 py-6" data-testid="solo-launcher">
      <section className="skyjo-shell skyjo-solo-flow-shell">
        <button className="skyjo-back-link skyjo-button px-3" onClick={onBack} type="button">Back Home</button>
        <div className="skyjo-panel skyjo-solo-flow-panel">
          <p className="skyjo-kicker">Single player</p>
          <h1 className="skyjo-serif mt-2 text-4xl font-black text-[#f5e6c8]" ref={headingRef} tabIndex={-1}>
            Your solo table is waiting
          </h1>
          <p className="mt-3 leading-7 text-[#f5e6c8]/70">Continue exactly where you stopped, or review a new setup without touching this save.</p>
          <div className="skyjo-saved-session-card mt-5">
            <span className="skyjo-kicker">Saved game</span>
            <strong>{soloSessionSummary(session)}</strong>
            <span>Saved {formatSoloSavedAt(session.updatedAt)}</span>
          </div>
          {warning ? <p className="mt-3 text-sm font-bold text-[#f5e6c8]/75" role="status">{warning.message}</p> : null}
          <div className="skyjo-solo-flow-actions mt-5">
            <button className="skyjo-button skyjo-button-primary px-4 py-3" onClick={onContinue} type="button">Continue Solo</button>
            <button className="skyjo-button px-4 py-3" onClick={onNewGame} type="button">Set Up New Game</button>
          </div>
        </div>
      </section>
    </main>
  );
}

export function SoloGameSetupPanel({
  draft,
  origin,
  pending,
  protectedSession,
  warning,
  startButtonRef,
  onBack,
  onChange,
  onStart
}: {
  draft: SoloGameSetup;
  origin: SoloSetupOrigin;
  pending: boolean;
  protectedSession: SoloSessionRecord | null;
  warning: SoloPersistenceWarning | null;
  startButtonRef?: RefObject<HTMLButtonElement>;
  onBack: () => void;
  onChange: (setup: SoloGameSetup) => void;
  onStart: () => void;
}) {
  const headingRef = useSoloScreenFocus(onBack);
  const count = draft.aiOpponentCount;
  const changeCount = (next: number) => {
    const bounded = Math.max(singlePlayerAiOpponentRange.min, Math.min(singlePlayerAiOpponentRange.max, next));
    onChange({ ...draft, aiOpponentCount: bounded, playerDifficulties: undefined });
  };
  const backLabel = origin === 'home' ? 'Back Home' : origin === 'active' ? 'Back to Game' : origin === 'game-over' ? 'Back to Scores' : 'Back';

  return (
    <main className="skyjo-surface skyjo-solo-flow-surface px-3 py-4 sm:px-5 sm:py-7" data-testid="solo-game-setup">
      <section className="skyjo-shell skyjo-solo-flow-shell">
        <button className="skyjo-back-link skyjo-button px-3" disabled={pending} onClick={onBack} type="button">{backLabel}</button>
        <div className="skyjo-panel skyjo-solo-flow-panel skyjo-solo-setup-panel">
          <div>
            <p className="skyjo-kicker">Single player</p>
            <h1 className="skyjo-serif mt-1 text-3xl font-black text-[#f5e6c8] sm:text-4xl" ref={headingRef} tabIndex={-1}>
              Set up your solo table
            </h1>
            <p className="mt-2 text-sm leading-6 text-[#f5e6c8]/68">Nothing is created or replaced until you confirm Start.</p>
          </div>

          {protectedSession ? (
            <aside className="skyjo-protected-save-note" aria-label="Protected saved game">
              <span className="skyjo-kicker">Protected save</span>
              <strong>{soloSessionSummary(protectedSession)}</strong>
              <span>Your current game stays untouched while you choose.</span>
            </aside>
          ) : null}

          <p aria-live="polite" className="skyjo-solo-setup-selection">
            <span>Selected</span>
            <strong>{count} bot{count === 1 ? '' : 's'} · {soloDifficultyLabel(draft.difficulty)}</strong>
          </p>

          <fieldset className="skyjo-solo-setup-fieldset">
            <legend>
              <span className="skyjo-kicker">Opponents</span>
              <strong>How many bots?</strong>
            </legend>
            <div aria-label="Choose AI opponent count" className="skyjo-opponent-stepper" role="group">
              <button
                aria-label="Decrease AI opponents"
                className="skyjo-button"
                disabled={pending || count <= singlePlayerAiOpponentRange.min}
                id="solo-opponent-decrease"
                onClick={() => changeCount(count - 1)}
                type="button"
              >−</button>
              <output aria-live="off" className="skyjo-opponent-count" htmlFor="solo-opponent-decrease solo-opponent-increase">
                <strong>{count}</strong>
                <span>AI opponent{count === 1 ? '' : 's'}</span>
              </output>
              <button
                aria-label="Increase AI opponents"
                className="skyjo-button"
                disabled={pending || count >= singlePlayerAiOpponentRange.max}
                id="solo-opponent-increase"
                onClick={() => changeCount(count + 1)}
                type="button"
              >+</button>
            </div>
          </fieldset>

          <fieldset className="skyjo-solo-setup-fieldset">
            <legend>
              <span className="skyjo-kicker">Difficulty</span>
              <strong>How should the bots play?</strong>
            </legend>
            <div className="skyjo-difficulty-grid">
              {soloDifficultyOptions.map((option) => (
                <label className={`skyjo-difficulty-option ${draft.difficulty === option.value ? 'skyjo-difficulty-option-selected' : ''}`} key={option.value}>
                  <input
                    checked={draft.difficulty === option.value}
                    disabled={pending}
                    name="solo-difficulty"
                    onChange={() => onChange({ ...draft, difficulty: option.value, playerDifficulties: undefined })}
                    type="radio"
                    value={option.value}
                  />
                  <span>
                    <strong>
                      {option.label}
                      {option.recommended ? <span className="skyjo-recommended-badge">Recommended</span> : null}
                    </strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {warning ? <p className="skyjo-disabled-note" role="status">{warning.message}</p> : null}
          <div className="skyjo-solo-flow-actions">
            <button className="skyjo-button px-4 py-3" disabled={pending} onClick={onBack} type="button">Cancel</button>
            <button
              className="skyjo-button skyjo-button-primary px-4 py-3"
              data-testid="solo-start-button"
              disabled={pending}
              onClick={onStart}
              ref={startButtonRef}
              type="button"
            >
              {pending ? 'Preparing Game…' : protectedSession ? 'Review & Start' : 'Start Solo Game'}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
