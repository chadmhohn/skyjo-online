import type { GameState } from './types';

export function GameSettingsButtonPendingFallback({ state }: { state?: GameState | null }) {
  return (
    <button
      aria-label="Open game settings"
      className="skyjo-button skyjo-icon-button"
      disabled
      title={state ? 'Game settings are loading. Your game is still safe.' : 'Game settings are loading.'}
      type="button"
    >
      <span aria-hidden="true">⚙</span>
    </button>
  );
}
