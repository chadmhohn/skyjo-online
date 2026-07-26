import { lazy, Suspense } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GameSettingsDialogLoadFallback from '../../../src/GameSettingsDialogLoadFallback';
import SoloGamePromptLoadFallback from '../../../src/SoloGamePromptLoadFallback';
import { startFreshGame } from '../../../src/game';
import type { SoloGamePromptProps } from '../../../src/SoloGamePrompt';

function createSoloPromptProps(overrides: Partial<SoloGamePromptProps> = {}): SoloGamePromptProps {
  return {
    resumeSession: {
      ownerKey: 'guest',
      gameId: 'solo-recovery-game',
      schemaVersion: 1,
      state: startFreshGame({ aiOpponentCount: 1, random: () => 0.25 }),
      aiOpponentCount: 1,
      setup: { aiOpponentCount: 1, difficulty: 'hard' },
      updatedAt: Date.UTC(2026, 6, 26)
    },
    replacementOpen: false,
    replacementPending: false,
    warning: null,
    onCancelReplacement: vi.fn(),
    onConfirmReplacement: vi.fn(),
    onContinue: vi.fn(),
    onDismissResume: vi.fn(),
    onRequestReplacement: vi.fn(),
    ...overrides
  };
}

describe('settings and solo prompt lazy-load fallbacks', () => {
  it('shows a focus-trapped, inert, dismissible settings shell while the chunk is unresolved', async () => {
    const PendingSettings = lazy(() => new Promise<{ default: () => null }>(() => undefined));
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const onDismiss = vi.fn();
    const { container } = render(
      <>
        <button type="button">Table action</button>
        <Suspense fallback={<GameSettingsDialogLoadFallback onDismiss={onDismiss} state={null} triggerRef={{ current: trigger }} />}>
          <PendingSettings />
        </Suspense>
      </>
    );

    expect(screen.getByRole('status')).toHaveTextContent('Settings are loading');
    const close = screen.getByRole('button', { name: 'Close Settings' });
    await waitFor(() => expect(close).toHaveFocus());
    expect(container).toHaveAttribute('inert');
    expect(document.body).toHaveStyle({ overflow: 'hidden' });
    await userEvent.setup().keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('keeps the saved-game route visible and actionable while its chunk is unresolved', async () => {
    const PendingPrompt = lazy(() => new Promise<{ default: () => null }>(() => undefined));
    const actor = userEvent.setup();
    const props = createSoloPromptProps();
    render(
      <Suspense fallback={<SoloGamePromptLoadFallback {...props} />}>
        <PendingPrompt />
      </Suspense>
    );

    expect(screen.getByRole('status')).toHaveTextContent('Game options are loading');
    await actor.click(screen.getByRole('button', { name: 'Continue Game' }));
    await actor.click(screen.getByRole('button', { name: 'New Game' }));
    expect(props.onContinue).toHaveBeenCalledOnce();
    expect(props.onRequestReplacement).toHaveBeenCalledOnce();
  });

  it('keeps replacement atomic and cannot dismiss it while its save is pending', async () => {
    const actor = userEvent.setup();
    const onCancelReplacement = vi.fn();
    const onConfirmReplacement = vi.fn();
    const props = createSoloPromptProps({
      replacementOpen: true,
      replacementPending: true,
      warning: { kind: 'quota', message: 'Storage is full. Keep the saved game and free some space.' },
      onCancelReplacement,
      onConfirmReplacement
    });
    const { rerender } = render(<SoloGamePromptLoadFallback {...props} />);

    expect(screen.getByRole('button', { name: 'Keep Current Game' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving New Game…' })).toBeDisabled();
    expect(screen.getByText(/Storage is full/)).toBeVisible();
    await actor.keyboard('{Escape}');
    expect(onCancelReplacement).not.toHaveBeenCalled();

    rerender(<SoloGamePromptLoadFallback {...props} replacementPending={false} />);
    await actor.click(screen.getByRole('button', { name: 'Replace Saved Game' }));
    expect(onConfirmReplacement).toHaveBeenCalledOnce();
  });

  it('uses the same local recovery shell when the detailed prompt chunk rejects', async () => {
    const props = createSoloPromptProps({
      replacementOpen: true,
      warning: { kind: 'unavailable', message: 'Saved-game storage is unavailable.' }
    });
    const RejectedPrompt = lazy(() =>
      Promise.reject(new Error('chunk unavailable')).catch(() => ({
        default: () => <SoloGamePromptLoadFallback {...props} />
      }))
    );
    render(
      <Suspense fallback={<SoloGamePromptLoadFallback {...props} />}>
        <RejectedPrompt />
      </Suspense>
    );

    expect(await screen.findByRole('button', { name: 'Keep Current Game' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Replace Saved Game' })).toBeEnabled();
    expect(screen.getByText('Saved-game storage is unavailable.')).toBeVisible();
  });
});
