import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, type ReactNode } from 'react';
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
import { completedSoloGameState, soloProgressGameStates } from '../../helpers/soloGameState';

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

async function startNewSolo(actor: ReturnType<typeof userEvent.setup>) {
  expect(await screen.findByRole('heading', { name: 'Set up your solo table' })).toBeInTheDocument();
  await actor.click(screen.getByRole('button', { name: 'Start Solo Game' }));
  expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
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

  it('does not create a session before Start and defaults a genuinely new setup to Medium', async () => {
    const actor = userEvent.setup();
    const random = vi.spyOn(Math, 'random');
    renderSolo();

    expect(await screen.findByRole('heading', { name: 'Set up your solo table' })).toBeInTheDocument();
    expect(random).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: /Medium/ })).toBeChecked();
    expect(await loadSoloSession('guest')).toEqual({ session: null, warning: null });
    await actor.click(screen.getByRole('button', { name: 'Increase AI opponents' }));
    await actor.click(screen.getByRole('radio', { name: /Mixed/ }));
    expect(await loadSoloSession('guest')).toEqual({ session: null, warning: null });
    expect(random).not.toHaveBeenCalled();

    await actor.click(screen.getByRole('button', { name: 'Start Solo Game' }));
    expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
    expect(random).toHaveBeenCalled();
    await waitFor(async () => {
      expect((await loadSoloSession('guest')).session?.setup).toMatchObject({
        aiOpponentCount: 2,
        difficulty: 'mixed'
      });
    });
  });

  it('shows saved solo metadata on Home with distinct Continue and New actions', async () => {
    await saveSoloSession('guest', savedGameId, activeState(), createSoloGameSetup(2, 'ultra'), () => Date.UTC(2026, 6, 12, 12));
    window.history.replaceState({}, '', '/');
    render(<App />);

    expect(await screen.findByRole('link', { name: /Continue Solo/ })).toHaveTextContent('Round 1 · 2 AI opponents · Ultra Hard');
    expect(screen.getByRole('link', { name: /New Solo Game/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Multiplayer/ })).toBeInTheDocument();
  });

  it('consumes Continue navigation intent exactly once under StrictMode', async () => {
    await saveSoloSession('guest', savedGameId, activeState(), createSoloGameSetup(2, 'hard'));
    window.history.replaceState({ usr: { soloIntent: 'continue' }, key: 'strict-continue', idx: 0 }, '', '/single-player');
    render(<StrictMode><App /></StrictMode>);

    expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your solo table is waiting' })).not.toBeInTheDocument();
    expect(window.history.state.usr).toBeNull();
    await waitFor(async () => expect((await loadSoloSession('guest')).session?.gameId).toBe(savedGameId));
  });

  it('consumes New navigation intent under StrictMode without mutating the protected save', async () => {
    const originalState = activeState();
    await saveSoloSession('guest', savedGameId, originalState, createSoloGameSetup(2, 'hard'));
    window.history.replaceState({ usr: { soloIntent: 'new' }, key: 'strict-new', idx: 0 }, '', '/single-player');
    render(<StrictMode><App /></StrictMode>);

    expect(await screen.findByRole('heading', { name: 'Set up your solo table' })).toBeInTheDocument();
    expect(screen.getByLabelText('Protected saved game')).toHaveTextContent('Round 1 · 2 AI opponents · Hard');
    expect(window.history.state.usr).toBeNull();
    expect((await loadSoloSession('guest')).session).toMatchObject({ gameId: savedGameId, state: originalState });
  });

  it('offers Continue and setup as explicit launcher actions, then restores the same stable snapshot', async () => {
    const state = activeState();
    await saveSoloSession('guest', savedGameId, state, 2, () => Date.UTC(2026, 6, 12, 12));
    const actor = userEvent.setup();
    renderSolo();

    expect(await screen.findByRole('heading', { name: 'Your solo table is waiting' })).toBeInTheDocument();
    expect(screen.getByText(/Round 1 · 2 AI opponents · Hard/)).toBeInTheDocument();
    await actor.click(screen.getByRole('button', { name: 'Continue Solo' }));
    expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
    expect(screen.getByText(/Round 1\./)).toBeInTheDocument();
    await waitFor(async () => expect((await loadSoloSession('guest')).session?.gameId).toBe(savedGameId));
  });

  it('focuses gameplay on entry without stealing a control reached before the deferred focus frame', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nextFrameId += 1;
      frames.set(nextFrameId, callback);
      return nextFrameId;
    });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frameId) => {
      frames.delete(frameId);
    });
    const flushFrames = () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(1));
    };

    try {
      await saveSoloSession(
        'guest',
        savedGameId,
        activeState(),
        createSoloGameSetup(2, 'medium')
      );
      const firstView = renderSolo();
      fireEvent.click(await screen.findByRole('button', { name: 'Continue Solo' }));
      expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
      const guidance = screen.getByRole('region', { name: 'Action guidance' });
      act(flushFrames);
      expect(guidance).toHaveFocus();
      firstView.unmount();

      await saveSoloSession(
        'guest',
        savedGameId,
        soloProgressGameStates().drawnDecision,
        createSoloGameSetup(1, 'medium')
      );
      renderSolo();
      fireEvent.click(await screen.findByRole('button', { name: 'Continue Solo' }));
      expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
      const placeChoice = screen.getByRole('button', { name: 'Place drawn card' });
      placeChoice.focus();
      expect(placeChoice).toHaveFocus();
      act(flushFrames);
      expect(placeChoice).toHaveFocus();
      expect(screen.getByRole('button', { name: 'Open game settings' })).not.toHaveFocus();
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it('passes the persisted active profile to the lazily loaded solo strategy', async () => {
    const state = activeAiTurnState();
    await saveSoloSession('guest', savedGameId, state, createSoloGameSetup(1, 'ultra'));
    const actor = userEvent.setup();
    renderSolo();
    await actor.click(await screen.findByRole('button', { name: 'Continue Solo' }));

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

    const launcherHeading = await screen.findByRole('heading', { name: 'Your solo table is waiting' });
    await waitFor(() => expect(launcherHeading).toHaveFocus());
    await actor.keyboard('{Escape}');

    expect(await screen.findByRole('heading', { name: 'Skyjo' })).toBeInTheDocument();
    expect((await loadSoloSession('guest')).session?.gameId).toBe(savedGameId);
  });

  it('does not mutate a saved game when replacement is cancelled', async () => {
    await saveSoloSession('guest', savedGameId, activeState(), 2);
    const actor = userEvent.setup();
    renderSolo();
    await actor.click(await screen.findByRole('button', { name: 'Set Up New Game' }));
    await actor.click(screen.getByRole('button', { name: 'Review & Start' }));

    expect(await screen.findByRole('dialog', { name: 'Replace your saved game?' })).toBeInTheDocument();
    expect(screen.getByText('Current saved game')).toBeInTheDocument();
    expect(screen.getByText('New game')).toBeInTheDocument();
    expect((await loadSoloSession('guest')).session?.gameId).toBe(savedGameId);
    await actor.click(screen.getByRole('button', { name: 'Keep Current Game' }));

    expect(await screen.findByRole('heading', { name: 'Set up your solo table' })).toBeInTheDocument();
    await actor.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('heading', { name: 'Your solo table is waiting' })).toBeInTheDocument();
    expect((await loadSoloSession('guest')).session?.gameId).toBe(savedGameId);
  });

  it('replaces a saved game only after explicit confirmation', async () => {
    await saveSoloSession('guest', savedGameId, activeState(), 2);
    const actor = userEvent.setup();
    renderSolo();
    await actor.click(await screen.findByRole('button', { name: 'Set Up New Game' }));
    await actor.click(screen.getByRole('button', { name: 'Review & Start' }));
    await actor.click(await screen.findByRole('button', { name: 'Replace saved game & start' }));

    expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
    expect(screen.getByText(/Round 1\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('region', { name: 'Action guidance' })).toHaveFocus());
    await waitFor(async () => expect((await loadSoloSession('guest')).session?.gameId).not.toBe(savedGameId));
  });

  it('keeps active setup and autosaves valid while next-game opponent count is edited and cancelled', async () => {
    const actor = userEvent.setup();
    renderSolo();
    await startNewSolo(actor);
    const originalGameId = await waitFor(async () => (await loadSoloSession('guest')).session?.gameId);

    await actor.click(screen.getByRole('button', { name: 'Open game settings' }));
    await actor.click(await screen.findByRole('tab', { name: 'Game' }));
    expect(screen.getByText('Current game: 1 AI opponent')).toBeInTheDocument();
    await actor.click(screen.getByRole('button', { name: 'Set up another game…' }));
    await actor.click(screen.getByRole('button', { name: 'Increase AI opponents' }));
    await actor.click(screen.getByRole('button', { name: 'Increase AI opponents' }));
    await actor.click(screen.getByRole('button', { name: 'Review & Start' }));

    expect(screen.getByRole('dialog', { name: 'Replace your saved game?' })).toBeInTheDocument();
    const beforeCancel = (await loadSoloSession('guest')).session;
    expect(beforeCancel).toMatchObject({ gameId: originalGameId, aiOpponentCount: 1 });
    await actor.click(screen.getByRole('button', { name: 'Keep Current Game' }));
    await actor.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Action guidance' })).toHaveFocus());
    await waitFor(async () => {
      expect((await loadSoloSession('guest')).session).toMatchObject({ gameId: originalGameId, aiOpponentCount: 1 });
    });
    expect(screen.queryByText(/Saved games are unavailable/)).not.toBeInTheDocument();
  });

  it('pauses an AI opening turn while the settings draft is open and resumes after closing', async () => {
    const actor = userEvent.setup();
    renderSolo();
    await startNewSolo(actor);
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
    await actor.click(await screen.findByRole('button', { name: 'Set Up New Game' }));
    await actor.click(screen.getByRole('button', { name: 'Review & Start' }));
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('Storage full', 'QuotaExceededError');
    });
    await actor.click(screen.getByRole('button', { name: 'Replace saved game & start' }));

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
    await actor.click(await screen.findByRole('button', { name: 'Set Up New Game' }));
    await actor.click(screen.getByRole('button', { name: 'Review & Start' }));
    await actor.click(screen.getByRole('button', { name: 'Replace saved game & start' }));
    await waitFor(() => expect(replacement).toHaveBeenCalledTimes(1));

    mocks.account.user = alice;
    view.rerender(<App />);
    expect(await screen.findByRole('heading', { name: 'Set up your solo table' })).toBeInTheDocument();
    finishReplacement?.(null);
    await waitFor(() => expect(screen.queryByText('Saving new game…')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Set up your solo table' })).toBeInTheDocument();
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

    expect(await screen.findByRole('heading', { name: 'Your solo table is waiting' })).toBeInTheDocument();
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
      await screen.findByText('Saved game stats are unavailable in this browser session. Your game can continue safely.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/sensitive local database path/i)).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Set up your solo table' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start Solo Game' }));
    expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
    index.mockRestore();
    expect((await listStatsOutbox(ownerKey)).map((record) => record.gameId)).toEqual([queuedGameId]);
  });
});
