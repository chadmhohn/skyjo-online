import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import {
  AccountProvider,
  createAdminUser,
  createRoomInvite,
  fetchAdminUsers,
  fetchPlayerStats,
  fetchStatsGame,
  fetchStatsGames,
  fetchStatsSummary,
  saveSinglePlayerGame,
  setAdminUserPassword,
  updateAdminUser,
  useAccount
} from '../../../src/account';
import type { AccountUser } from '../../../src/account';
import type { GameState } from '../../../src/types';

const user: AccountUser = {
  id: 'user-1',
  email: 'player@example.test',
  displayName: 'Player One',
  role: 'player',
  disabled: false,
  createdAt: 1,
  updatedAt: 2,
  lastLoginAt: 3
};

type FetchCall = { path: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function ContextHarness() {
  const account = useAccount();
  return (
    <div>
      <output>{account.loading ? 'loading' : account.user?.displayName || 'guest'}</output>
      <output>{account.error || 'no-error'}</output>
      <button onClick={() => void account.login('login@example.test', 'secret')}>login</button>
      <button onClick={() => void account.signup('new@example.test', 'New Player', 'secret', 'secret')}>signup</button>
      <button onClick={() => void account.updateProfile('Renamed')}>profile</button>
      <button onClick={() => void account.changePassword('old', 'new', 'new')}>password</button>
      <button onClick={() => void account.logout()}>logout</button>
      <button onClick={() => account.clearError()}>clear</button>
      <button onClick={() => void account.refresh()}>refresh</button>
    </div>
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  return <AccountProvider>{children}</AccountProvider>;
}

describe('account API and provider', () => {
  let calls: FetchCall[];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        calls.push({ path, init });
        if (path === '/api/account/me') return jsonResponse({ user: null });
        if (path === '/api/account/logout' || path === '/api/account/password') return jsonResponse({ ok: true });
        if (path.includes('/password')) return jsonResponse({ ok: true });
        if (path === '/api/rooms/invite') return jsonResponse({ roomCode: 'ABCDE', path: '/invite/token', expiresAt: 99 });
        if (path === '/api/stats/summary') return jsonResponse({ self: {}, coPlayers: [], recentGames: [], admin: null });
        if (path === '/api/stats/games') return jsonResponse({ games: [] });
        if (path.startsWith('/api/stats/games/')) return jsonResponse({ game: { id: 'game/1' } });
        if (path.startsWith('/api/stats/players/')) return jsonResponse({ user, summary: {}, games: [] });
        if (path === '/api/admin/users' && init?.method === 'POST') return jsonResponse({ user: { ...user, role: 'admin' } });
        if (path === '/api/admin/users') return jsonResponse({ users: [] });
        if (path.startsWith('/api/admin/users/')) return jsonResponse({ user: { ...user, displayName: 'Updated' } });
        if (path === '/api/stats/single-player') return jsonResponse({ game: { id: 'single-1' } });
        const payload = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
        return jsonResponse({ user: { ...user, displayName: payload.displayName || user.displayName } });
      })
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('drives every account mutation and refreshes state', async () => {
    const actor = userEvent.setup();
    render(<ContextHarness />, { wrapper: Wrapper });

    expect(screen.getByText('loading')).toBeInTheDocument();
    await screen.findByText('guest');
    await actor.click(screen.getByRole('button', { name: 'login' }));
    await screen.findByText('Player One');
    await actor.click(screen.getByRole('button', { name: 'profile' }));
    await screen.findByText('Renamed');
    await actor.click(screen.getByRole('button', { name: 'password' }));
    await screen.findByText('guest');
    await actor.click(screen.getByRole('button', { name: 'signup' }));
    await screen.findByText('New Player');
    await actor.click(screen.getByRole('button', { name: 'logout' }));
    await screen.findByText('guest');
    await actor.click(screen.getByRole('button', { name: 'refresh' }));

    expect(calls.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        '/api/account/me',
        '/api/account/login',
        '/api/account/profile',
        '/api/account/password',
        '/api/account/signup',
        '/api/account/logout'
      ])
    );
    expect(calls.find(({ path }) => path === '/api/account/profile')?.init?.headers).toMatchObject({
      'Content-Type': 'application/json'
    });
  });

  it('surfaces initial request failures and permits clearing the error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: 'Session unavailable' }, 503));
    const actor = userEvent.setup();
    render(<ContextHarness />, { wrapper: Wrapper });

    await screen.findByText('Session unavailable');
    await actor.click(screen.getByRole('button', { name: 'clear' }));
    expect(screen.getByText('no-error')).toBeInTheDocument();
  });

  it('uses the generic error when a failed response is not JSON', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('not-json', { status: 500 }));
    render(<ContextHarness />, { wrapper: Wrapper });
    await screen.findByText('Request failed.');
  });

  it('covers the typed account, stats, invite, and admin helpers', async () => {
    const state = { players: [] } as unknown as GameState;
    await saveSinglePlayerGame(state, 'stable-key');
    await createRoomInvite('abcde');
    await fetchStatsSummary();
    await fetchStatsGames();
    await fetchStatsGame('game/1');
    await fetchPlayerStats('user/1');
    await fetchAdminUsers();
    await createAdminUser({
      email: 'admin@example.test',
      displayName: 'Admin',
      password: 'secret',
      confirmPassword: 'secret',
      role: 'admin'
    });
    await updateAdminUser('user/1', { disabled: true });
    await setAdminUserPassword('user/1', 'new-secret', 'new-secret');

    expect(calls.map(({ path }) => path)).toEqual([
      '/api/stats/single-player',
      '/api/rooms/invite',
      '/api/stats/summary',
      '/api/stats/games',
      '/api/stats/games/game%2F1',
      '/api/stats/players/user%2F1',
      '/api/admin/users',
      '/api/admin/users',
      '/api/admin/users/user%2F1',
      '/api/admin/users/user%2F1/password'
    ]);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ state, clientGameKey: 'stable-key' });
  });
});
