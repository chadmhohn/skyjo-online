import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { noFocusScroll, useModalFocus } from './accessibility';
import AudioSettingsControls from './AudioSettingsControls';
import type { GameState } from './types';

const RulesHelpPanel = lazy(() => import('./RulesHelpPanel').catch(() => ({
  default: () => <p className="skyjo-disabled-note" role="alert">Rules could not load. Reload Skyjo to try again.</p>
})));
export interface GameSettingsDialogProps {
  aiOpponentCount?: number;
  aiOpponentSummary?: string;
  aiDifficultySummary?: string;
  onDismiss: () => void;
  onSetupAnotherGame?: () => void;
  state?: GameState | null;
  triggerRef: RefObject<HTMLButtonElement>;
}

type GameSettingsPanel = 'audio' | 'game' | 'rules' | 'log';

function CloseIcon() {
  return (
    <svg aria-hidden="true" className="skyjo-icon" focusable="false" viewBox="0 0 24 24">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function MoveLogList({ state }: { state: GameState }) {
  return (
    <div className="skyjo-move-log-list space-y-2 text-sm text-[#f5e6c8]/72">
      {state.log.length > 0 ? (
        state.log.map((entry, index) => (
          <div className="rounded-lg border border-white/[0.04] bg-white/[0.025] px-3 py-2" key={`${index}-${entry}`}>
            {entry}
          </div>
        ))
      ) : (
        <div className="rounded-lg border border-dashed border-[#f5e6c8]/14 px-3 py-5 text-center text-sm font-bold text-[#f5e6c8]/45">
          No moves yet.
        </div>
      )}
    </div>
  );
}

export default function GameSettingsDialog({
  aiOpponentCount,
  aiOpponentSummary,
  aiDifficultySummary,
  onDismiss,
  onSetupAnotherGame,
  state,
  triggerRef
}: GameSettingsDialogProps) {
  const [activePanel, setActivePanel] = useState<GameSettingsPanel>('audio');
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const hasAiSettings = typeof aiOpponentCount === 'number' && Boolean(aiOpponentSummary && aiDifficultySummary && onSetupAnotherGame);
  const settingsPanels = useMemo(
    () => [
      { key: 'audio' as const, label: 'Audio' },
      ...(hasAiSettings ? [{ key: 'game' as const, label: 'Game' }] : []),
      { key: 'rules' as const, label: 'Rules' },
      ...(state ? [{ key: 'log' as const, label: 'Log' }] : [])
    ],
    [hasAiSettings, state]
  );

  useModalFocus({
    open: true,
    dialogRef,
    initialFocusRef: closeButtonRef,
    triggerRef,
    onDismiss
  });
  useEffect(() => {
    if (!settingsPanels.some((panel) => panel.key === activePanel)) setActivePanel('audio');
  }, [activePanel, settingsPanels]);

  function handleSettingsTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % settingsPanels.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + settingsPanels.length) % settingsPanels.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = settingsPanels.length - 1;
    else return;
    event.preventDefault();
    const nextPanel = settingsPanels[nextIndex];
    setActivePanel(nextPanel.key);
    document.getElementById(`skyjo-settings-tab-${nextPanel.key}`)?.focus(noFocusScroll);
  }

  return createPortal(
    <div
      className="skyjo-settings-overlay fixed inset-0 flex items-end justify-center bg-black/70 px-3 py-4 backdrop-blur-sm sm:items-center sm:px-5"
      data-modal-overlay
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <section
        aria-describedby="skyjo-game-settings-intro"
        aria-labelledby="skyjo-game-settings-title"
        aria-modal="true"
        className="skyjo-panel skyjo-settings-dialog w-full max-w-3xl overflow-hidden rounded-2xl bg-[#09110e]/95 shadow-2xl"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="skyjo-settings-dialog-header flex items-start justify-between gap-3 border-b border-[#f5e6c8]/10 p-4 sm:p-5">
          <div className="min-w-0">
            <p className="skyjo-kicker">Game</p>
            <h2 className="skyjo-serif mt-1 text-2xl font-black leading-tight text-[#f5e6c8] sm:text-3xl" id="skyjo-game-settings-title">
              Settings
            </h2>
            <p className="skyjo-settings-intro mt-2 text-sm leading-6" id="skyjo-game-settings-intro">
              Audio, table options, rules, and the move log.
            </p>
          </div>
          <button aria-label="Close game settings" className="skyjo-button skyjo-icon-button shrink-0" onClick={onDismiss} ref={closeButtonRef} type="button">
            <CloseIcon />
          </button>
        </div>

        <div className="skyjo-settings-body overflow-y-auto p-4 sm:p-5">
          <div aria-label="Settings sections" aria-orientation="horizontal" className={`skyjo-settings-tabs skyjo-settings-tabs-${settingsPanels.length}`} role="tablist">
            {settingsPanels.map((panel, index) => (
              <button
                aria-controls={`skyjo-settings-panel-${panel.key}`}
                aria-selected={activePanel === panel.key}
                className={`skyjo-settings-tab ${activePanel === panel.key ? 'skyjo-settings-tab-active' : ''}`}
                id={`skyjo-settings-tab-${panel.key}`}
                key={panel.key}
                onClick={() => setActivePanel(panel.key)}
                onKeyDown={(event) => handleSettingsTabKeyDown(event, index)}
                role="tab"
                tabIndex={activePanel === panel.key ? 0 : -1}
                type="button"
              >
                {panel.label}
              </button>
            ))}
          </div>

          <div aria-labelledby={`skyjo-settings-tab-${activePanel}`} className="skyjo-settings-panel" id={`skyjo-settings-panel-${activePanel}`} role="tabpanel">
            {activePanel === 'audio' ? (
              <section className="skyjo-settings-section">
                <div className="skyjo-settings-section-heading">
                  <p className="skyjo-kicker">Audio</p>
                  <h3 className="skyjo-serif text-xl font-bold leading-tight text-[#f5e6c8]">Sound</h3>
                </div>
                <AudioSettingsControls />
              </section>
            ) : null}

            {activePanel === 'game' && hasAiSettings ? (
              <section className="skyjo-settings-section">
                <div className="skyjo-settings-section-heading">
                  <p className="skyjo-kicker">Single player</p>
                  <h3 className="skyjo-serif text-xl font-bold leading-tight text-[#f5e6c8]">Current setup</h3>
                </div>
                <div className="skyjo-settings-ai-toolbar">
                  <div className="skyjo-current-setup-summary text-sm font-bold text-[#f5e6c8]/75">
                    <span>{aiOpponentSummary}</span>
                    <span>{aiDifficultySummary}</span>
                  </div>
                  <button
                    className="skyjo-button skyjo-new-game-button text-sm"
                    onClick={() => {
                      onDismiss();
                      onSetupAnotherGame?.();
                    }}
                    type="button"
                  >
                    Set up another game…
                  </button>
                </div>
                <p className="mt-3 text-sm font-bold text-[#f5e6c8]/62">This setup is fixed for the running game. Set up another game to choose different opponents or difficulty.</p>
              </section>
            ) : null}

            {activePanel === 'rules' ? (
              <Suspense fallback={<p className="skyjo-kicker" role="status">Loading rules...</p>}>
                <RulesHelpPanel />
              </Suspense>
            ) : null}

            {activePanel === 'log' && state ? (
              <section className="skyjo-settings-section">
                <div className="skyjo-settings-section-heading">
                  <p className="skyjo-kicker">Table</p>
                  <h3 className="skyjo-serif text-xl font-bold leading-tight text-[#f5e6c8]">Move Log</h3>
                </div>
                <MoveLogList state={state} />
              </section>
            ) : null}
          </div>
        </div>

        <div className="skyjo-settings-footer border-t border-[#f5e6c8]/10 p-4 sm:p-5">
          <button className="skyjo-button skyjo-button-primary w-full px-4 py-2 text-sm sm:w-auto" onClick={onDismiss} type="button">
            Done
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
