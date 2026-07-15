import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PHONE_LAYOUT_MEDIA_QUERY } from '../../../src/accessibility';
import {
  ActiveRoomOptionsLoadFallback,
  RoundSummaryLoadFallback
} from '../../../src/CriticalLoadFallbacks';
import RoomChatLoadFallback from '../../../src/RoomChatLoadFallback';
import type { GameState } from '../../../src/types';
import { setMediaQueryMatches } from '../../setup/dom';

const unusedState = {} as GameState;

describe('critical lazy-load fallbacks', () => {
  it('keeps round actions available when the detailed score chunk fails', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <RoundSummaryLoadFallback actionLabel="Next Round" onAction={onAction} state={unusedState}>
        <p>Ready controls</p>
      </RoundSummaryLoadFallback>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Round controls still work');
    expect(screen.getByText('Ready controls')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next Round' }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('preserves the phone score modal focus, scroll-lock, and Escape contract', async () => {
    act(() => setMediaQueryMatches(PHONE_LAYOUT_MEDIA_QUERY, true));
    const onMinimize = vi.fn();
    render(
      <RoundSummaryLoadFallback
        actionDisabledReason="Waiting for one player."
        actionLabel="Next Round"
        onAction={vi.fn()}
        onMinimize={onMinimize}
        state={unusedState}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'Round controls unavailable' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('button', { name: 'Next Round' })).toBeDisabled();
    await userEvent.setup().keyboard('{Escape}');
    expect(onMinimize).toHaveBeenCalledOnce();
  });

  it('keeps room options out of flow and restores modal focus behavior', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const triggerRef = { current: trigger };
    const onDismiss = vi.fn();
    const props = {
      active: false,
      onDismiss,
      open: false,
      roomCode: 'ABCDE',
      triggerRef
    };
    const { rerender } = render(
      <ActiveRoomOptionsLoadFallback {...props}><p>Room controls</p></ActiveRoomOptionsLoadFallback>
    );
    expect(screen.getByText('Room controls')).toBeVisible();

    rerender(
      <ActiveRoomOptionsLoadFallback {...props} active open><button type="button">Reset Room</button></ActiveRoomOptionsLoadFallback>
    );
    const dialog = screen.getByRole('dialog', { name: 'Room options unavailable' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close room options' })).toHaveFocus());
    await userEvent.setup().keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('reports chat failure without disturbing the table flow', () => {
    const common = {
      isOpen: false,
      messages: [],
      onSend: vi.fn(),
      onToggle: vi.fn(),
      playerId: 'p1',
      unreadCount: 0
    };
    const { rerender } = render(<RoomChatLoadFallback {...common} variant="panel" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Table chat could not load');
    rerender(<RoomChatLoadFallback {...common} variant="dock" />);
    expect(screen.getByRole('button', { name: 'Table chat unavailable' })).toBeDisabled();
  });
});
