import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { startFreshGame } from '../../../src/game';
import {
  enqueueCompletedGame,
  listStatsOutbox,
  loadSoloSession,
  saveSoloSession,
  soloOwnerKey
} from '../../../src/soloDurability';
import type { AccountUser } from '../../../src/account';
import type { GameState } from '../../../src/types';

const mocks = vi.hoisted(() => ({
  account: {
    loading: false,
    user: null as AccountUser | null,
    error: '',
    clearError: vi.fn(),
    refresh: vi.fn(async () => undefined),
    login: vi.fn(async () => undefined),
    signup: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    changePassword: vi.fn(async () => undefined),
    updateProfile: vi.fn(async () => undefined)
  },
  saveSinglePlayerGame: vi.fn(async () => ({ game: { id: 'server-game' } }))
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

import App from '../../../src/App';

const alice: AccountUser = {
  id: 'alice',
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
  return { ...startFreshGame({ aiOpponentCount: 2, random: () => 0.2 }), round: 3 };
}

function completedState(): GameState {
  const state = startFreshGame({ aiOpponentCount: 1, random: () => 0.3 });
  return {
    ...state,
    phase: 'game-over',
    winnerId: 'human',
    players: state.players.map((player, index) => ({ ...player, roundScore: 8 + index, totalScore: 8 + index }))
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
    mocks.saveSinglePlayerGame.mockResolvedValue({ game: { id: 'server-game' } });
  });

  it('offers Continue and New Game, then restores the same stable game snapshot', async () => {
    const state = activeState();
    await saveSoloSession('guest', savedGameId, state, 2, () => Date.UTC(2026, 6, 12, 12));
    const actor = userEvent.setup();
    renderSolo();

    expect(await screen.findByRole('dialog', { name: 'Continue your solo game?' })).toBeInTheDocument();
    expect(screen.getByText(/Round 3 with 2 AI opponents/)).toBeInTheDocument();
    await actor.click(screen.getByRole('button', { name: 'Continue Game' }));
    expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
    expect(screen.getByText(/Round 3\./)).toBeInTheDocument();
    await waitFor(async () => expect((await loadSoloSession('guest')).session?.gameId).toBe(savedGameId));
  });

  it('discards a saved game only when New Game is chosen', async () => {
    await saveSoloSession('guest', savedGameId, activeState(), 2);
    const actor = userEvent.setup();
    renderSolo();
    await actor.click(await screen.findByRole('button', { name: 'New Game' }));

    expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
    expect(screen.getByText(/Round 1\./)).toBeInTheDocument();
    await waitFor(async () => expect((await loadSoloSession('guest')).session?.gameId).not.toBe(savedGameId));
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
      expect.any(AbortSignal)
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
});
