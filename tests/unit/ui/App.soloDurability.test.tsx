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
  soloOwnerKey,
  statsOutboxStoreName
} from '../../../src/soloDurability';
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
