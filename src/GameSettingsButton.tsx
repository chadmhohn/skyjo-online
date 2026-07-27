import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import GameSettingsDialogLoadFallback from './GameSettingsDialogLoadFallback';
import type { GameState } from './types';

const GameSettingsDialog = lazy(() => import('./GameSettingsDialog').catch(() => ({ default: GameSettingsDialogLoadFallback })));

export interface GameSettingsButtonProps {
  aiOpponentCount?: number;
  aiOpponentSummary?: string;
  aiDifficultySummary?: string;
  onSetupAnotherGame?: () => void;
  onOpenChange?: (open: boolean) => void;
  state?: GameState | null;
}

function GearIcon() {
  return (
    <svg aria-hidden="true" className="skyjo-icon" focusable="false" viewBox="0 0 24 24">
      <path d="M12 15.25A3.25 3.25 0 1 0 12 8.75a3.25 3.25 0 0 0 0 6.5Z" />
      <path d="M18.45 13.45c.08-.47.08-.93 0-1.4l2.02-1.57-1.92-3.32-2.38.95a7.03 7.03 0 0 0-1.22-.7L14.6 4.85h-3.84l-.36 2.56c-.43.18-.84.41-1.22.7l-2.38-.95-1.92 3.32 2.02 1.57a7.2 7.2 0 0 0 0 1.4l-2.02 1.57 1.92 3.32 2.38-.95c.38.29.79.52 1.22.7l.36 2.56h3.84l.35-2.56c.44-.18.85-.41 1.22-.7l2.38.95 1.92-3.32-2.02-1.57Z" />
    </svg>
  );
}

export default function GameSettingsButton({
  aiOpponentCount,
  aiOpponentSummary,
  aiDifficultySummary,
  onSetupAnotherGame,
  onOpenChange,
  state
}: GameSettingsButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const setSettingsVisibility = useCallback((open: boolean) => {
    setIsOpen(open);
    onOpenChange?.(open);
  }, [onOpenChange]);
  const dialogProps = {
    aiOpponentCount,
    aiOpponentSummary,
    aiDifficultySummary,
    onDismiss: () => setSettingsVisibility(false),
    onSetupAnotherGame,
    state,
    triggerRef
  };

  return (
    <>
      <button
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label="Open game settings"
        className="skyjo-button skyjo-icon-button"
        onClick={() => setSettingsVisibility(true)}
        ref={triggerRef}
        title="Game settings"
        type="button"
      >
        <GearIcon />
      </button>
      {isOpen ? (
        <Suspense fallback={<GameSettingsDialogLoadFallback {...dialogProps} />}>
          <GameSettingsDialog {...dialogProps} />
        </Suspense>
      ) : null}
    </>
  );
}
