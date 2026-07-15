import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus, usePhoneLayout } from './accessibility';
import type { GameState } from './types';

export interface RoundSummaryProps {
  state: GameState;
  actionLabel?: string;
  actionDisabledReason?: string;
  onAction?: () => void;
  onMinimize?: () => void;
  restoreFocusFallback?: () => HTMLElement | null;
  children?: ReactNode;
}

export default function RoundSummary({
  state,
  actionLabel,
  actionDisabledReason,
  onAction,
  onMinimize,
  restoreFocusFallback,
  children
}: RoundSummaryProps) {
  const phoneLayout = usePhoneLayout();
  const dialogRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  useModalFocus({
    open: true,
    dialogRef,
    initialFocusRef: titleRef,
    onDismiss: onMinimize,
    closeOnEscape: Boolean(onMinimize),
    containFocus: phoneLayout,
    inertBackground: phoneLayout,
    lockScroll: phoneLayout,
    restoreFocusFallback: () =>
      document.querySelector<HTMLElement>('[data-testid="round-summary-restore"]') ??
      restoreFocusFallback?.() ??
      document.querySelector<HTMLElement>('[aria-label="Open game settings"]')
  });
  useEffect(() => {
    if (!phoneLayout) titleRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [phoneLayout]);
  const rankedPlayers = [...state.players].sort((a, b) => a.totalScore - b.totalScore || a.roundScore - b.roundScore);
  const leader = rankedPlayers[0];
  const winner = state.winnerId ? state.players.find((player) => player.id === state.winnerId) : null;
  const headline = state.phase === 'game-over' ? `${winner?.name || leader.name} wins the game.` : 'Round complete.';
  const outcome = state.phase === 'game-over'
    ? `${winner?.name || leader.name} finished lowest at ${(winner || leader).totalScore} total.`
    : `${leader.name} leads at ${leader.totalScore} total.`;
  const latestScoringNote = state.log[0];

  const summary = (
    <section
      aria-labelledby="skyjo-round-summary-title"
      aria-modal={phoneLayout ? true : undefined}
      className="skyjo-panel skyjo-score-panel skyjo-round-summary-panel"
      ref={dialogRef}
      role={phoneLayout ? 'dialog' : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="skyjo-kicker">{state.phase === 'game-over' ? 'Final totals' : 'Round scoring'}</div>
          <h2
            className="skyjo-serif mt-1 text-2xl font-bold leading-tight text-[#f5e6c8]"
            id="skyjo-round-summary-title"
            ref={titleRef}
            tabIndex={-1}
          >
            {headline}
          </h2>
          <p className="mt-2 text-sm font-bold text-[#f5e6c8]/78">{outcome}</p>
          {latestScoringNote ? <p className="mt-1 text-xs leading-5 text-[#f5e6c8]/58">{latestScoringNote}</p> : null}
        </div>
        {onMinimize ? (
          <button className="skyjo-button skyjo-round-summary-minimize px-3 py-2 text-xs" onClick={onMinimize} type="button">
            Minimize
          </button>
        ) : null}
      </div>

      <div className="skyjo-score-list mt-4" aria-label="Round score and total score">
        {rankedPlayers.map((player, index) => {
          const isWinner = winner ? player.id === winner.id : index === 0;
          return (
            <div className={`skyjo-score-row ${isWinner ? 'skyjo-score-row-leader' : ''}`} key={player.id}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="skyjo-score-rank">#{index + 1}</span>
                  <span className="skyjo-score-player-name font-extrabold text-[#f5e6c8]">{player.name}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-right tabular-nums">
                <div>
                  <div className="skyjo-score-label">Round score</div>
                  <div className="font-black text-[#f5e6c8]">{player.roundScore}</div>
                </div>
                <div>
                  <div className="skyjo-score-label">Total score</div>
                  <div className="font-black text-[#f5e6c8]">{player.totalScore}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

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
      {actionDisabledReason ? (
        <p className="skyjo-disabled-note mt-4">
          <span>Action unavailable:</span> {actionDisabledReason}
        </p>
      ) : null}
    </section>
  );
  return phoneLayout
    ? createPortal(
        <div className="skyjo-round-summary-overlay" data-modal-overlay>
          {summary}
        </div>,
        document.body
      )
    : summary;
}
