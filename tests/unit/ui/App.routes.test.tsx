import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { AccountUser, StatsGame, StatsSummary } from '../../../src/account';

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
  audioSettings: { ambience: false, ambienceVolume: 0.34, soundEffects: true, soundVolume: 0.72 },
  setAudioSettings: vi.fn(),
  playAudioTestCue: vi.fn(),
  primeAudio: vi.fn(async () => true),
  playAudioCue: vi.fn(),
  loadPushStatus: vi.fn(async () => 'prompt'),
  enablePush: vi.fn(async () => undefined),
  disablePush: vi.fn(async () => undefined),
  fetchStatsSummary: vi.fn(),
  fetchStatsGames: vi.fn(),
  fetchStatsGame: vi.fn(),
  fetchPlayerStats: vi.fn(),
  fetchAdminUsers: vi.fn(),
  createAdminUser: vi.fn(),
  updateAdminUser: vi.fn(async () => undefined),
  setAdminUserPassword: vi.fn(async () => undefined),
  saveSinglePlayerGame: vi.fn(async () => ({ game: {} }))
}));

vi.mock('../../../src/account', () => ({
  AccountProvider: ({ children }: { children: ReactNode }) => children,
  useAccount: () => mocks.account,
  createRoomInvite: vi.fn(),
  fetchStatsSummary: mocks.fetchStatsSummary,
  fetchStatsGames: mocks.fetchStatsGames,
  fetchStatsGame: mocks.fetchStatsGame,
  fetchPlayerStats: mocks.fetchPlayerStats,
  fetchAdminUsers: mocks.fetchAdminUsers,
  createAdminUser: mocks.createAdminUser,
  updateAdminUser: mocks.updateAdminUser,
  setAdminUserPassword: mocks.setAdminUserPassword,
  saveSinglePlayerGame: mocks.saveSinglePlayerGame
}));

vi.mock('../../../src/audio', () => ({
  useAudioSettings: () => [mocks.audioSettings, mocks.setAudioSettings, 'ready'] as const,
  useGameAudio: vi.fn(),
  playAudioCue: mocks.playAudioCue,
  playAudioTestCue: mocks.playAudioTestCue,
  primeAudio: mocks.primeAudio
}));

vi.mock('../../../src/push', () => ({
  loadPushNotificationStatus: mocks.loadPushStatus,
  enablePushNotifications: mocks.enablePush,
  disablePushNotifications: mocks.disablePush
}));

import App from '../../../src/App';

const playerUser: AccountUser = {
  id: 'user-1',
  email: 'player@example.test',
  displayName: 'Player One',
  role: 'player',
  disabled: false,
  createdAt: 1,
  updatedAt: 2,
  lastLoginAt: 3
};

const adminUser: AccountUser = { ...playerUser, id: 'admin-1', email: 'admin@example.test', displayName: 'Admin One', role: 'admin' };

const savedGame: StatsGame = {
  id: 'game-1',
  mode: 'multi',
  roomCode: 'ABCDE',
  completedAt: Date.UTC(2026, 0, 2, 3, 4),
  roundCount: 2,
  winnerName: 'Player One',
  winnerUserId: playerUser.id,
  participants: [
    {
      id: 'participant-1',
      userId: playerUser.id,
      playerId: 'p1',
      displayName: 'Player One',
      kind: 'human',
      rank: 1,
      roundScore: 4,
      totalScore: 12,
      won: true
    },
    {
      id: 'participant-2',
      userId: null,
      playerId: 'ai-1',
      displayName: 'Data',
      kind: 'ai',
      rank: 2,
      roundScore: 8,
      totalScore: 22,
      won: false
    }
  ],
  rounds: [
    { id: 'round-1', round: 1, playerId: 'p1', userId: playerUser.id, displayName: 'Player One', roundScore: 8, totalScore: 8 },
    { id: 'round-2', round: 2, playerId: 'p1', userId: playerUser.id, displayName: 'Player One', roundScore: 4, totalScore: 12 }
  ]
};

const summary: StatsSummary = {
  self: {
    gamesPlayed: 3,
    wins: 2,
    multiplayerGames: 2,
    singlePlayerGames: 1,
    winRate: 67,
    averageTotalScore: 19,
    bestTotalScore: 12
  },
  coPlayers: [
    { userId: 'user-2', displayName: 'Friend', gamesTogether: 1, wins: 1, averageTotalScore: 24, latestAt: savedGame.completedAt }
  ],
  recentGames: [savedGame],
  admin: null
};

function renderRoute(path: string) {
  window.history.replaceState({}, '', path);
  return render(<App />);
}

describe('application routes and solo controls', () => {
  beforeEach(() => {
    mocks.account.loading = false;
    mocks.account.user = null;
    mocks.account.error = '';
    mocks.audioSettings.ambience = false;
    mocks.audioSettings.ambienceVolume = 0.34;
    mocks.audioSettings.soundEffects = true;
    mocks.audioSettings.soundVolume = 0.72;
    mocks.loadPushStatus.mockResolvedValue('prompt');
    mocks.fetchStatsSummary.mockResolvedValue(summary);
    mocks.fetchStatsGames.mockResolvedValue({ games: [savedGame] });
    mocks.fetchStatsGame.mockResolvedValue({ game: savedGame });
    mocks.fetchPlayerStats.mockResolvedValue({ user: playerUser, summary: summary.self, games: [savedGame] });
    mocks.fetchAdminUsers.mockResolvedValue({
      users: [
        { ...adminUser, gamesPlayed: 4, wins: 2 },
        { ...playerUser, gamesPlayed: 3, wins: 2 },
        { ...playerUser, id: 'disabled-1', displayName: 'Disabled', disabled: true, gamesPlayed: 0, wins: 0 }
      ]
    });
    mocks.createAdminUser.mockResolvedValue({ user: { ...playerUser, email: 'new@example.test' } });
  });

  it('renders guest and signed-in home choices with audio controls', async () => {
    const actor = userEvent.setup();
    const view = renderRoute('/');
    expect(screen.getByRole('heading', { name: 'Skyjo' })).toBeInTheDocument();
    expect(screen.getByText(/Sign in to save stats/)).toBeInTheDocument();

    await actor.click(screen.getByRole('checkbox', { name: /Sound effects/ }));
    await actor.click(screen.getByRole('checkbox', { name: /Ambience/ }));
    await actor.click(screen.getByRole('button', { name: 'Test sound' }));
    expect(mocks.setAudioSettings).toHaveBeenCalledWith({ soundEffects: false });
    expect(mocks.setAudioSettings).toHaveBeenCalledWith({ ambience: true });
    expect(mocks.playAudioTestCue).toHaveBeenCalled();

    view.unmount();
    mocks.account.user = adminUser;
    renderRoute('/');
    expect(screen.getByText('Signed in as Admin One')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Admin' })).toBeInTheDocument();
  });

  it('submits login and signup forms and validates a safe return path', async () => {
    const actor = userEvent.setup();
    const view = renderRoute('/account?next=%2Fstats');
    await actor.type(screen.getByLabelText('Email'), 'player@example.test');
    await actor.type(screen.getByLabelText('Password'), 'secret');
    await actor.click(screen.getByRole('button', { name: 'Sign In' }));
    await waitFor(() => expect(mocks.account.login).toHaveBeenCalledWith('player@example.test', 'secret'));
    expect(window.location.pathname).toBe('/stats');

    view.unmount();
    renderRoute('/account?next=https%3A%2F%2Fevil.example');
    await actor.click(screen.getByRole('button', { name: 'Create Account' }));
    await actor.type(screen.getByLabelText('Email'), 'new@example.test');
    await actor.type(screen.getByLabelText('Display name'), 'New Player');
    await actor.type(screen.getByLabelText('Password'), 'secret');
    await actor.type(screen.getByLabelText('Confirm password'), 'secret');
    await actor.click(screen.getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(mocks.account.signup).toHaveBeenCalledWith('new@example.test', 'New Player', 'secret', 'secret'));
    expect(window.location.pathname).toBe('/');
  });

  it('surfaces account errors and manages profile, password, push, and logout actions', async () => {
    const actor = userEvent.setup();
    mocks.account.user = adminUser;
    mocks.account.updateProfile.mockRejectedValueOnce(new Error('Profile rejected'));
    const view = renderRoute('/account');

    const displayName = await screen.findByLabelText('Display name');
    await actor.clear(displayName);
    await actor.type(displayName, 'Renamed Admin');
    await actor.click(screen.getByRole('button', { name: 'Save Display Name' }));
    expect(await screen.findByText('Profile rejected')).toBeInTheDocument();

    mocks.account.updateProfile.mockResolvedValueOnce(undefined);
    await actor.click(screen.getByRole('button', { name: 'Save Display Name' }));
    expect(await screen.findByText('Display name updated.')).toBeInTheDocument();

    const passwords = screen.getAllByLabelText(/password/i);
    await actor.type(passwords[0], 'old-secret');
    await actor.type(passwords[1], 'new-secret');
    await actor.type(passwords[2], 'new-secret');
    await actor.click(screen.getByRole('button', { name: 'Change Password' }));
    expect(await screen.findByText(/Password changed/)).toBeInTheDocument();

    await screen.findByText('Off');
    await actor.click(screen.getByRole('button', { name: 'Enable' }));
    expect(await screen.findByText('Notifications enabled.')).toBeInTheDocument();
    await actor.click(screen.getByRole('button', { name: 'Disable' }));
    expect(await screen.findByText('Notifications disabled.')).toBeInTheDocument();

    await actor.click(screen.getByRole('button', { name: 'Logout' }));
    expect(mocks.account.logout).toHaveBeenCalled();
    expect(window.location.pathname).toBe('/');
    view.unmount();
  });

  it('renders account-required fallbacks and complete stats routes', async () => {
    let view = renderRoute('/stats');
    expect(await screen.findByRole('heading', { name: 'Sign in to see stats' })).toBeInTheDocument();
    view.unmount();

    mocks.account.user = playerUser;
    view = renderRoute('/stats');
    expect(await screen.findByText('Saved games')).toBeInTheDocument();
    expect(screen.getByText("People you've played")).toBeInTheDocument();
    expect(screen.getByText('Room ABCDE')).toBeInTheDocument();
    expect(screen.getByText('Friend')).toBeInTheDocument();
    view.unmount();

    view = renderRoute('/stats/games/game-1');
    expect(await screen.findByRole('heading', { name: 'Player One won' })).toBeInTheDocument();
    expect(screen.getByText('#2 Data')).toBeInTheDocument();
    expect(screen.getByText('R2 Player One')).toBeInTheDocument();
    view.unmount();

    renderRoute('/stats/players/user-2');
    expect(await screen.findByRole('heading', { name: 'Player One' })).toBeInTheDocument();
    expect(mocks.fetchPlayerStats).toHaveBeenCalledWith('user-2');
  });

  it('shows empty and failed stats states', async () => {
    mocks.account.user = playerUser;
    mocks.fetchStatsSummary.mockResolvedValueOnce({ ...summary, coPlayers: [], self: { ...summary.self, bestTotalScore: null } });
    mocks.fetchStatsGames.mockResolvedValueOnce({ games: [] });
    const view = renderRoute('/stats');
    expect(await screen.findByText('No saved games yet.')).toBeInTheDocument();
    expect(screen.getByText(/Multiplayer stats will show up/)).toBeInTheDocument();
    expect(screen.getByText('-')).toBeInTheDocument();
    view.unmount();

    mocks.fetchStatsSummary.mockRejectedValueOnce(new Error('Stats unavailable'));
    mocks.fetchStatsGames.mockResolvedValueOnce({ games: [] });
    renderRoute('/stats');
    expect(await screen.findByText('Stats unavailable')).toBeInTheDocument();
  });

  it('enforces admin access and completes user administration actions', async () => {
    let view = renderRoute('/admin');
    expect(await screen.findByRole('heading', { name: 'Sign in for admin tools' })).toBeInTheDocument();
    view.unmount();

    mocks.account.user = playerUser;
    view = renderRoute('/admin');
    expect(await screen.findByRole('heading', { name: 'Admin privileges required' })).toBeInTheDocument();
    view.unmount();

    mocks.account.user = adminUser;
    const actor = userEvent.setup();
    renderRoute('/admin');
    expect(await screen.findByText('Disabled')).toBeInTheDocument();

    await actor.type(screen.getByLabelText('Email'), 'new@example.test');
    await actor.type(screen.getByLabelText('Display name'), 'New User');
    await actor.type(screen.getByLabelText('Temporary password'), 'secret');
    await actor.type(screen.getByLabelText('Confirm password'), 'secret');
    await actor.selectOptions(screen.getByLabelText('Role'), 'admin');
    await actor.click(screen.getByRole('button', { name: 'Create Account' }));
    expect(await screen.findByText('Created account for new@example.test.')).toBeInTheDocument();

    await actor.click(screen.getAllByRole('button', { name: 'Disable' }).find((button) => !button.hasAttribute('disabled'))!);
    expect(await screen.findByText('User updated.')).toBeInTheDocument();
    await actor.click(screen.getByRole('button', { name: 'Enable' }));
    await actor.click(screen.getAllByRole('button', { name: 'Make Admin' })[0]);

    const passwordInputs = screen.getAllByPlaceholderText('New password');
    await actor.type(passwordInputs[1], 'reset-secret');
    const setPasswordButtons = screen.getAllByRole('button', { name: 'Set Password' });
    await actor.click(setPasswordButtons[1]);
    expect(await screen.findByText('Password updated.')).toBeInTheDocument();
  });

  it('opens every solo settings panel and exercises opening-card controls', async () => {
    const actor = userEvent.setup();
    renderRoute('/single-player');
    expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Reveal opening card/ }).length).toBeGreaterThan(0);
    await actor.click(screen.getAllByRole('button', { name: /Reveal opening card 1/ })[0]);
    expect(mocks.playAudioCue).toHaveBeenCalledWith('flip');

    await actor.click(screen.getByRole('button', { name: 'Open game settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    await actor.click(screen.getByRole('tab', { name: 'Game' }));
    await actor.click(screen.getByRole('button', { name: '3' }));
    await actor.click(screen.getByRole('button', { name: 'New Game' }));
    await actor.click(screen.getByRole('tab', { name: 'Rules' }));
    expect(screen.getByRole('heading', { name: 'Ending and scoring' })).toBeInTheDocument();
    await actor.click(screen.getByRole('tab', { name: 'Log' }));
    expect(screen.getByRole('heading', { name: 'Move Log' })).toBeInTheDocument();
    await actor.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('covers loading and rejected history requests', async () => {
    mocks.account.loading = true;
    let view = renderRoute('/stats');
    expect(document.body).toHaveTextContent('');
    view.unmount();

    mocks.account.loading = false;
    mocks.account.user = playerUser;
    mocks.fetchStatsGame.mockRejectedValueOnce(new Error('Game unavailable'));
    view = renderRoute('/stats/games/missing');
    expect(await screen.findByText('Game unavailable')).toBeInTheDocument();
    view.unmount();

    mocks.fetchPlayerStats.mockRejectedValueOnce(new Error('Player unavailable'));
    renderRoute('/stats/players/missing');
    expect(await screen.findByText('Player unavailable')).toBeInTheDocument();
  });

  it('surfaces rejected auth, password, push, and logout operations', async () => {
    const actor = userEvent.setup();
    mocks.account.login.mockRejectedValueOnce(new Error('Login rejected'));
    let view = renderRoute('/account');
    await actor.type(screen.getByLabelText('Email'), 'player@example.test');
    await actor.type(screen.getByLabelText('Password'), 'wrong');
    await actor.click(screen.getByRole('button', { name: 'Sign In' }));
    expect(await screen.findByText('Login rejected')).toBeInTheDocument();
    view.unmount();

    mocks.account.user = playerUser;
    mocks.loadPushStatus.mockRejectedValueOnce(new Error('Push check failed'));
    mocks.account.changePassword.mockRejectedValueOnce(new Error('Password rejected'));
    mocks.account.logout.mockRejectedValueOnce(new Error('Logout rejected'));
    view = renderRoute('/account');
    expect(await screen.findByText('Could not check')).toBeInTheDocument();
    await actor.click(screen.getByRole('button', { name: 'Change Password' }));
    expect(await screen.findByText('Password rejected')).toBeInTheDocument();
    await actor.click(screen.getByRole('button', { name: 'Logout' }));
    expect(await screen.findByText('Logout rejected')).toBeInTheDocument();
    view.unmount();

    mocks.loadPushStatus.mockResolvedValueOnce('prompt');
    mocks.enablePush.mockRejectedValueOnce(new Error('Permission rejected'));
    renderRoute('/account');
    await screen.findByText('Off');
    await actor.click(screen.getByRole('button', { name: 'Enable' }));
    expect(await screen.findByText('Permission rejected')).toBeInTheDocument();
  });

  it('surfaces admin load, create, update, and password errors', async () => {
    mocks.account.user = adminUser;
    mocks.fetchAdminUsers.mockRejectedValueOnce(new Error('Users unavailable'));
    let view = renderRoute('/admin');
    expect(await screen.findByText('Users unavailable')).toBeInTheDocument();
    view.unmount();

    mocks.fetchAdminUsers.mockResolvedValue({ users: [{ ...playerUser, gamesPlayed: 3, wins: 2 }] });
    mocks.createAdminUser.mockRejectedValueOnce(new Error('Creation rejected'));
    const actor = userEvent.setup();
    view = renderRoute('/admin');
    await screen.findByText('Player One');
    await actor.type(screen.getByLabelText('Email'), 'new@example.test');
    await actor.type(screen.getByLabelText('Display name'), 'New User');
    await actor.type(screen.getByLabelText('Temporary password'), 'secret');
    await actor.type(screen.getByLabelText('Confirm password'), 'secret');
    await actor.click(screen.getByRole('button', { name: 'Create Account' }));
    expect(await screen.findByText('Creation rejected')).toBeInTheDocument();

    mocks.updateAdminUser.mockRejectedValueOnce(new Error('Update rejected'));
    await actor.click(screen.getByRole('button', { name: 'Disable' }));
    expect(await screen.findByText('Update rejected')).toBeInTheDocument();

    mocks.setAdminUserPassword.mockRejectedValueOnce(new Error('Password reset rejected'));
    await actor.click(screen.getByRole('button', { name: 'Set Password' }));
    expect(await screen.findByText('Password reset rejected')).toBeInTheDocument();
    view.unmount();
  });

  it('closes settings with Escape and backdrop interaction', async () => {
    const actor = userEvent.setup();
    renderRoute('/single-player');
    await actor.click(await screen.findByRole('button', { name: 'Open game settings' }));
    await actor.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();

    await actor.click(screen.getByRole('button', { name: 'Open game settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const overlay = dialog.parentElement!;
    await actor.pointer({ keys: '[MouseLeft]', target: overlay });
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
  });
});
