import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import AccountPage from '../../../src/AccountPage';
import {
  AccountProvider,
  createAdminUser,
  createRoomInvite,
  fetchAdminUsers,
  fetchPlayerStats,
  fetchStatsGame,
  fetchStatsGames,
  fetchStatsSummary,
  lastConfirmedSoloOwnerStorageKey,
  saveSinglePlayerGame,
  setAdminUserPassword,
  updateAdminUser,
  useAccount
} from '../../../src/account';
import type { AccountUser } from '../../../src/account';
import type { GameState } from '../../../src/types';

const user: AccountUser = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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
      <output data-testid="solo-owner">{account.localSoloOwnerId || 'no-owner'}</output>
      <button onClick={() => void account.login('login@example.test', 'secret').catch(() => undefined)}>login</button>
      <button onClick={() => void account.signup('new@example.test', 'New Player', 'secret', 'secret').catch(() => undefined)}>signup</button>
      <button onClick={() => void account.updateProfile('Renamed').catch(() => undefined)}>profile</button>
      <button onClick={() => void account.changePassword('old', 'new', 'new').catch(() => undefined)}>password</button>
      <button onClick={() => void account.deleteAccount('current-secret', 'DELETE').catch(() => undefined)}>delete</button>
      <button onClick={() => void account.logout().catch(() => undefined)}>logout</button>
      <button onClick={() => account.clearError()}>clear</button>
      <button onClick={() => void account.refresh()}>refresh</button>
    </div>
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  return <AccountProvider>{children}</AccountProvider>;
}

function IdentityHarness() {
  const account = useAccount();
  const previousUser = useRef(account.user);
  const [identityChanges, setIdentityChanges] = useState(0);
  useEffect(() => {
    if (previousUser.current === account.user) return;
    previousUser.current = account.user;
    setIdentityChanges((count) => count + 1);
  }, [account.user]);
  return (
    <div>
      <output data-testid="identity-name">{account.user?.displayName || 'guest'}</output>
      <output data-testid="identity-changes">{identityChanges}</output>
    </div>
  );
}

describe('account API and provider', () => {
  let calls: FetchCall[];
  let currentMeUser: AccountUser | null;

  beforeEach(() => {
    calls = [];
    currentMeUser = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        calls.push({ path, init });
        if (path === '/api/account/me') return jsonResponse({ user: currentMeUser });
        if (path === '/api/account/logout' || path === '/api/account/password' || path === '/api/account') return jsonResponse({ ok: true });
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
    expect(screen.getByTestId('solo-owner')).toHaveTextContent(user.id);
    expect(window.localStorage.getItem(lastConfirmedSoloOwnerStorageKey)).toBe(user.id);
    await actor.click(screen.getByRole('button', { name: 'profile' }));
    await screen.findByText('Renamed');
    await actor.click(screen.getByRole('button', { name: 'password' }));
    await screen.findByText('guest');
    expect(screen.getByTestId('solo-owner')).toHaveTextContent('no-owner');
    await actor.click(screen.getByRole('button', { name: 'signup' }));
    await screen.findByText('New Player');
    await actor.click(screen.getByRole('button', { name: 'logout' }));
    await screen.findByText('guest');
    expect(window.localStorage.getItem(lastConfirmedSoloOwnerStorageKey)).toBeNull();
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

  it('preserves the last confirmed local solo partition while account refresh is offline', async () => {
    window.localStorage.setItem(lastConfirmedSoloOwnerStorageKey, user.id);
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('offline'));
    render(<ContextHarness />, { wrapper: Wrapper });
    await screen.findByText('offline');
    expect(screen.getByTestId('solo-owner')).toHaveTextContent(user.id);
    expect(screen.getByText('guest')).toBeInTheDocument();
  });

  it('refreshes live account state on focus, online, and owner-hint storage changes', async () => {
    render(<ContextHarness />, { wrapper: Wrapper });
    await screen.findByText('guest');

    currentMeUser = user;
    window.dispatchEvent(new Event('focus'));
    await screen.findByText('Player One');
    expect(screen.getByTestId('solo-owner')).toHaveTextContent(user.id);

    currentMeUser = null;
    window.dispatchEvent(new Event('online'));
    await screen.findByText('guest');
    expect(screen.getByTestId('solo-owner')).toHaveTextContent('no-owner');

    currentMeUser = user;
    window.dispatchEvent(
      new StorageEvent('storage', { key: lastConfirmedSoloOwnerStorageKey, newValue: user.id, storageArea: localStorage })
    );
    await screen.findByText('Player One');
    expect(calls.filter(({ path }) => path === '/api/account/me')).toHaveLength(4);
  });

  it('preserves account object identity across unchanged focus refreshes', async () => {
    currentMeUser = user;
    render(<IdentityHarness />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByTestId('identity-changes')).toHaveTextContent('1'));

    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(calls.filter(({ path }) => path === '/api/account/me')).toHaveLength(2));
    expect(screen.getByTestId('identity-changes')).toHaveTextContent('1');

    currentMeUser = { ...user, displayName: 'Updated Player', updatedAt: user.updatedAt + 1 };
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.getByTestId('identity-name')).toHaveTextContent('Updated Player'));
    expect(screen.getByTestId('identity-changes')).toHaveTextContent('2');
  });

  it('clears local identity state on explicit logout even when the network request fails', async () => {
    currentMeUser = user;
    const actor = userEvent.setup();
    render(<ContextHarness />, { wrapper: Wrapper });
    await screen.findByText('Player One');
    expect(window.localStorage.getItem(lastConfirmedSoloOwnerStorageKey)).toBe(user.id);

    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('offline'));
    await actor.click(screen.getByRole('button', { name: 'logout' }));
    await waitFor(() => expect(screen.getByTestId('solo-owner')).toHaveTextContent('no-owner'));
    expect(screen.getByText('guest')).toBeInTheDocument();
    expect(window.localStorage.getItem(lastConfirmedSoloOwnerStorageKey)).toBeNull();
  });

  it('requires the explicit account deletion request and clears local identity only after success', async () => {
    currentMeUser = user;
    const actor = userEvent.setup();
    render(<ContextHarness />, { wrapper: Wrapper });
    await screen.findByText('Player One');

    await actor.click(screen.getByRole('button', { name: 'delete' }));
    await screen.findByText('guest');
    expect(screen.getByTestId('solo-owner')).toHaveTextContent('no-owner');
    expect(window.localStorage.getItem(lastConfirmedSoloOwnerStorageKey)).toBeNull();
    expect(calls.find(({ path }) => path === '/api/account')?.init).toMatchObject({
      method: 'DELETE',
      body: JSON.stringify({ currentPassword: 'current-secret', confirmation: 'DELETE' })
    });
  });

  it('exposes a cancellable destructive web flow with password and exact confirmation', async () => {
    currentMeUser = user;
    const actor = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/account']}>
        <AccountProvider><AccountPage /></AccountProvider>
      </MemoryRouter>
    );
    await screen.findByText('Player One');

    await actor.click(screen.getByRole('button', { name: 'Delete Account' }));
    const permanent = screen.getByRole('button', { name: 'Permanently Delete Account' });
    expect(permanent).toBeDisabled();
    await actor.type(screen.getAllByLabelText('Current password').at(-1)!, 'current-secret');
    await actor.type(screen.getByLabelText('Type DELETE to confirm'), 'delete');
    expect(permanent).toBeDisabled();
    await actor.clear(screen.getByLabelText('Type DELETE to confirm'));
    await actor.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    expect(permanent).toBeEnabled();
    await actor.click(permanent);

    await waitFor(() => expect(calls.some(({ path }) => path === '/api/account')).toBe(true));
    expect(calls.find(({ path }) => path === '/api/account')?.init?.method).toBe('DELETE');
  });

  it('uses the generic error when a failed response is not JSON', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('not-json', { status: 500 }));
    render(<ContextHarness />, { wrapper: Wrapper });
    await screen.findByText('Request failed.');
  });

  it('covers the typed account, stats, invite, and admin helpers', async () => {
    const state = { players: [] } as unknown as GameState;
    const controller = new AbortController();
    await saveSinglePlayerGame(state, 'stable-key', controller.signal, {
      completedAt: 123,
      expectedAccountUserId: user.id
    });
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
    expect(calls[0].init?.signal).toBe(controller.signal);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      state,
      clientGameKey: 'stable-key',
      completedAt: 123,
      expectedAccountUserId: user.id
    });
  });
});
