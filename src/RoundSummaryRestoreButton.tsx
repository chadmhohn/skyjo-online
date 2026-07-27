import type { GameState } from './types';

export default function RoundSummaryRestoreButton({
  state,
  updateReserved,
  meta,
  onRestore
}: {
  state: GameState;
  updateReserved?: boolean;
  meta?: string;
  onRestore: () => void;
}) {
  return (
    <button
      className="skyjo-round-summary-chip"
      data-testid="round-summary-restore"
      onClick={onRestore}
      style={updateReserved ? { bottom: 'var(--u)' } : {}}
      type="button"
    >
      <span className="min-w-0">
        <span className="skyjo-kicker block">{state.phase === 'game-over' ? 'Final totals' : 'Round scoring'}</span>
        <span className="block truncate text-sm font-black text-[#f5e6c8]">{meta || 'Review scores'}</span>
      </span>
      <span className="skyjo-summary-meta">
        <span className="skyjo-kicker">Open</span>
        <span className="skyjo-disclosure-caret skyjo-disclosure-caret-open" aria-hidden="true" />
      </span>
    </button>
  );
}
