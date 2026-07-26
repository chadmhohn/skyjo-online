import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { revealOpeningCard, startFreshGame } from '../../../src/game';
import {
  createSoloGameSetup,
  enqueueCompletedGame,
  listStatsOutbox,
  loadSoloSession,
  saveSoloSession,
  soloOwnerKey,
  statsOutboxStoreName
} from '../../../src/soloDurability';
import * as soloDurabilityModule from '../../../src/soloDurability';
import type { AccountUser } from '../../../src/account';
import type { GameState } from '../../../src/types';
import { completedSoloGameState } from '../../helpers/soloGameState';

const mocks = vi.hoisted(() => ({
  account: {
    loading: false,
    user: null as AccountUser | null,
    localSoloOwnerId: null as string | null,
    error: '',
    clearError: vi.fn(),
    refresh: vi.fn(async () => undefined),
    login: vi.fn(async () => undefined),
    signup: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    changePassword: vi.fn(async () => undefined),
    updateProfile: vi.fn(async () => undefined)
  },
  saveSinglePlayerGame: vi.fn(async () => ({ game: { id: 'server-game' } })),
  chooseAiMove: vi.fn(() => null)
}));

vi.mock('../../../src/account', () => ({
  AccountProvider: ({ children }: { children: ReactNode }) => children,
  useAccount: () => mocks.account,
  createRoomInvite: vi.fn(),
  fetchStatsSummary: vi.fn(),
  fetchStatsGames: vi.fn(),
  fetchStatsGame: vi.fn(),
  fetchPlayerStats: vi.fn(),
  fetchAdminUsers: vi.fn(),
  createAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  setAdminUserPassword: vi.fn(),
  saveSinglePlayerGame: mocks.saveSinglePlayerGame
}));

vi.mock('../../../src/audio', () => ({
  useAudioSettings: () => [{ ambience: false, ambienceVolume: 0, soundEffects: false, soundVolume: 0 }, vi.fn(), 'ready'],
  useGameAudio: vi.fn(),
  playAudioCue: vi.fn(),
  playAudioTestCue: vi.fn(),
  primeAudio: vi.fn(async () => true)
}));

vi.mock('../../../src/push', () => ({
  loadPushNotificationStatus: vi.fn(async () => 'prompt'),
  enablePushNotifications: vi.fn(),
  disablePushNotifications: vi.fn()
}));

vi.mock('../../../src/lazySoloAiStrategy', () => ({
  loadSoloAiStrategy: vi.fn(async () => ({ chooseAiMoveForState: mocks.chooseAiMove }))
}));

import App from '../../../src/App';

const alice: AccountUser = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'alice@example.test',
  displayName: 'Alice',
  role: 'player',
  disabled: false,
  createdAt: 1,
  updatedAt: 2,
  lastLoginAt: 3
};
const savedGameId = '11111111-1111-4111-8111-111111111111';
const queuedGameId = '22222222-2222-4222-8222-222222222222';
const focusedGameId = '33333333-3333-4333-8333-333333333333';

function activeState(): GameState {
  return startFreshGame({ aiOpponentCount: 2, random: () => 0.2 });
}

function completedState(): GameState {
  return completedSoloGameState(1, () => 0.3);
}

function activeAiTurnState(): GameState {
  let state = startFreshGame({ aiOpponentCount: 1, random: () => 0.2 });
  while (state.phase === 'opening-reveal') {
    const active = state.players[state.currentPlayerIndex];
    state = revealOpeningCard(
      state,
      active.grid.findIndex((card) => !card.faceUp && !card.removed)
    );
  }
  return {
    ...state,
    currentPlayerIndex: state.players.findIndex((player) => player.kind === 'ai')
  };
}

function renderSolo() {
  window.history.replaceState({}, '', '/single-player');
  return render(<App />);
}

describe('solo durability integration', () => {
  beforeEach(() => {
    mocks.account.loading = false;
    mocks.account.user = null;
    mocks.account.localSoloOwnerId = null;
    mocks.saveSinglePlayerGame.mockReset();
    mocks.saveSinglePlayerGame.mockResolvedValue({ game: { id: 'server-game' } });
    mocks.chooseAiMove.mockReset();
    mocks.chooseAiMove.mockReturnValue(null);
  });

  it('offers Continue and New Game, then restores the same stable game snapshot', async () => {
    const state = activeState();
    await saveSoloSession('guest', savedGameId, state, 2, () => Date.UTC(2026, 6, 12, 12));
    const actor = userEvent.setup();
    renderSolo();

    expect(await screen.findByRole('dialog', { name: 'Continue your solo game?' })).toBeInTheDocument();
    expect(screen.getByText(/Round 1 with 2 AI opponents/)).toBeInTheDocument();
    await actor.click(screen.getByRole('button', { name: 'Continue Game' }));
    expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
    expect(screen.getByText(/Round 1\./)).toBeInTheDocument();
    await waitFor(async () => expect((await loadSoloSession('guest')).session?.gameId).toBe(savedGameId));
  });

  it('passes the persisted active profile to the lazily loaded solo strategy', async () => {
    const state = activeAiTurnState();
    await saveSoloSession('guest', savedGameId, state, createSoloGameSetup(1, 'ultra'));
    const actor = userEvent.setup();
    renderSolo();
    await actor.click(await screen.findByRole('button', { name: 'Continue Game' }));

    await waitFor(() => expect(mocks.chooseAiMove).toHaveBeenCalled(), { timeout: 2_000 });
    expect(mocks.chooseAiMove).toHaveBeenCalledWith(
      expect.objectContaining({ currentPlayerIndex: 1 }),
      expect.objectContaining({ playerId: 'ai-1', difficulty: 'ultra', decisionKey: expect.stringContaining(savedGameId) })
    );
  });

  it('leaves a saved-game choice with Escape without deleting the session', async () => {
    await saveSoloSession('guest', savedGameId, activeState(), 2);
    const actor = userEvent.setup();
    renderSolo();

    const continueButton = await screen.findByRole('button', { name: 'Continue Game' });
    await waitFor(() => expect(continueButton).toHaveFocus());
    await actor.keyboard('{Escape}');

    expect(await screen.findByRole('heading', { name: 'Skyjo' })).toBeInTheDocument();
    expect((await loadSoloSession('guest')).session?.gameId).toBe(savedGameId);
  });

  it('does not mutate a saved game when replacement is cancelled', async () => {
    await saveSoloSession('guest', savedGameId, activeState(), 2);
    const actor = userEvent.setup();
    renderSolo();
    await actor.click(await screen.findByRole('button', { name: 'New Game' }));

    expect(screen.queryByRole('dialog', { name: 'Continue your solo game?' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Replace your saved game?' })).toBeInTheDocument();
    expect((await loadSoloSession('guest')).session?.gameId).toBe(savedGameId);
    await actor.click(screen.getByRole('button', { name: 'Keep Current Game' }));

    expect(await screen.findByRole('dialog', { name: 'Continue your solo game?' })).toBeInTheDocument();
    expect((await loadSoloSession('guest')).session?.gameId).toBe(savedGameId);
  });

  it('replaces a saved game only after explicit confirmation', async () => {
    await saveSoloSession('guest', savedGameId, activeState(), 2);
    const actor = userEvent.setup();
    renderSolo();
    await actor.click(await screen.findByRole('button', { name: 'New Game' }));
    await actor.click(screen.getByRole('button', { name: 'Replace Saved Game' }));

    expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
    expect(screen.getByText(/Round 1\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open game settings' })).toHaveFocus());
    await waitFor(async () => expect((await loadSoloSession('guest')).session?.gameId).not.toBe(savedGameId));
  });

  it('keeps active setup and autosaves valid while next-game opponent count is edited and cancelled', async () => {
    const actor = userEvent.setup();
    renderSolo();
    expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
    const originalGameId = await waitFor(async () => (await loadSoloSession('guest')).session?.gameId);

    await actor.click(screen.getByRole('button', { name: 'Open game settings' }));
    await actor.click(await screen.findByRole('tab', { name: 'Game' }));
    expect(screen.getByText('Current game: 1 AI opponent')).toBeInTheDocument();
    await actor.click(screen.getByRole('button', { name: '3' }));
    await actor.click(screen.getByRole('button', { name: 'New Game' }));

    expect(screen.getByRole('dialog', { name: 'Replace your saved game?' })).toBeInTheDocument();
    const beforeCancel = (await loadSoloSession('guest')).session;
    expect(beforeCancel).toMatchObject({ gameId: originalGameId, aiOpponentCount: 1 });
    await actor.click(screen.getByRole('button', { name: 'Keep Current Game' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open game settings' })).toHaveFocus());
    await waitFor(async () => {
      expect((await loadSoloSession('guest')).session).toMatchObject({ gameId: originalGameId, aiOpponentCount: 1 });
    });
    expect(screen.queryByText(/Saved games are unavailable/)).not.toBeInTheDocument();
  });

  it('pauses an AI opening turn while the settings draft is open and resumes after closing', async () => {
    const actor = userEvent.setup();
    renderSolo();
    expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
    await actor.click(screen.getAllByRole('button', { name: /Reveal this opening card/ })[0]);

    // Keep this regression focused on the AI pause contract. Preload the lazy
    // dialog before fake timers so the assertion is independent of test order.
    await act(async () => {
      await import('../../../src/GameSettingsDialog');
    });

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getAllByRole('button', { name: /Reveal this opening card/ })[0]);
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(document.querySelector('[data-player-role="opponent"] [aria-label="0 of 12 cards flipped"]')).not.toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Open game settings' }));
      });
      expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(document.querySelector('[data-player-role="opponent"] [aria-label="0 of 12 cards flipped"]')).not.toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      await act(async () => vi.advanceTimersByTimeAsync(225));
      expect(document.querySelector('[data-player-role="opponent"] [aria-label="2 of 12 cards flipped"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports replacement storage failure while preserving the prior game', async () => {
    const originalState = activeState();
    await saveSoloSession('guest', savedGameId, originalState, 2);
    const actor = userEvent.setup();
    renderSolo();
    await actor.click(await screen.findByRole('button', { name: 'New Game' }));
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('Storage full', 'QuotaExceededError');
    });
    await actor.click(screen.getByRole('button', { name: 'Replace Saved Game' }));

    expect(await screen.findByText(/This device is low on storage/)).toBeInTheDocument();
    put.mockRestore();
    expect((await loadSoloSession('guest')).session).toMatchObject({ gameId: savedGameId, state: originalState });
  });

  it('does not install an awaited replacement after the active owner changes', async () => {
    await saveSoloSession('guest', savedGameId, activeState(), 2);
    let finishReplacement: ((warning: null) => void) | undefined;
    const replacement = vi.spyOn(soloDurabilityModule, 'replaceSoloSession').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishReplacement = resolve;
        })
    );
    const actor = userEvent.setup();
    const view = renderSolo();
    await actor.click(await screen.findByRole('button', { name: 'New Game' }));
    await actor.click(screen.getByRole('button', { name: 'Replace Saved Game' }));
    await waitFor(() => expect(replacement).toHaveBeenCalledTimes(1));

    mocks.account.user = alice;
    view.rerender(<App />);
    expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
    finishReplacement?.(null);
    await waitFor(() => expect(screen.queryByText('Saving New Game…')).not.toBeInTheDocument());

    await actor.click(screen.getByRole('button', { name: 'Open game settings' }));
    await actor.click(await screen.findByRole('tab', { name: 'Game' }));
    expect(screen.getByText('Current game: 1 AI opponent')).toBeInTheDocument();
    replacement.mockRestore();
  });

  it('retries account-scoped offline stats on sign-in, online, and focus events', async () => {
    const ownerKey = soloOwnerKey(alice.id);
    await enqueueCompletedGame(ownerKey, queuedGameId, completedState());
    mocks.account.user = alice;
    mocks.saveSinglePlayerGame.mockRejectedValueOnce(new TypeError('offline'));
    renderSolo();

    await waitFor(() => expect(mocks.saveSinglePlayerGame).toHaveBeenCalledTimes(1));
    expect(mocks.saveSinglePlayerGame).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'game-over' }),
      queuedGameId,
      expect.any(AbortSignal),
      {
        completedAt: expect.any(Number),
        expectedAccountUserId: alice.id
      }
    );
    expect((await listStatsOutbox(ownerKey)).map((record) => record.gameId)).toEqual([queuedGameId]);

    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(mocks.saveSinglePlayerGame).toHaveBeenCalledTimes(2));
    await waitFor(async () => expect(await listStatsOutbox(ownerKey)).toEqual([]));

    await enqueueCompletedGame(ownerKey, focusedGameId, completedState());
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(mocks.saveSinglePlayerGame).toHaveBeenCalledTimes(3));
    await waitFor(async () => expect(await listStatsOutbox(ownerKey)).toEqual([]));
  });

  it('restores the last confirmed account partition while offline without authorizing stats delivery', async () => {
    const ownerKey = soloOwnerKey(alice.id);
    await saveSoloSession(ownerKey, savedGameId, activeState(), 2, () => Date.UTC(2026, 6, 12, 12));
    mocks.account.localSoloOwnerId = alice.id;
    renderSolo();

    expect(await screen.findByRole('dialog', { name: 'Continue your solo game?' })).toBeInTheDocument();
    expect(screen.getByText(/2 AI opponents/)).toBeInTheDocument();
    expect(mocks.saveSinglePlayerGame).not.toHaveBeenCalled();
  });

  it('sanitizes synchronous IndexedDB flush failures and keeps gameplay available', async () => {
    const ownerKey = soloOwnerKey(alice.id);
    await enqueueCompletedGame(ownerKey, queuedGameId, completedState(), () => 123);
    mocks.account.user = alice;
    const realIndex = IDBObjectStore.prototype.index;
    const index = vi.spyOn(IDBObjectStore.prototype, 'index').mockImplementation(function (this: IDBObjectStore, name: string) {
      if (this.name === statsOutboxStoreName) throw new Error('sensitive local database path');
      return realIndex.call(this, name);
    });

    renderSolo();
    expect(
      await screen.findByText('Game stats sync is unavailable. Play can continue and Skyjo will retry later.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/sensitive local database path/i)).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
    index.mockRestore();
    expect((await listStatsOutbox(ownerKey)).map((record) => record.gameId)).toEqual([queuedGameId]);
  });
});
