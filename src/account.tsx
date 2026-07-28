/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { GameState } from './types';

export interface AccountUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'player';
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
}

export interface StatsParticipant {
  id: string;
  userId: string | null;
  playerId: string;
  displayName: string;
  kind: 'human' | 'ai';
  rank: number;
  roundScore: number;
  totalScore: number;
  won: boolean;
}

export interface StatsRoundScore {
  id: string;
  round: number;
  playerId: string;
  userId: string | null;
  displayName: string;
  roundScore: number;
  totalScore: number;
}

export interface StatsGame {
  id: string;
  mode: 'single' | 'multi';
  roomCode: string | null;
  completedAt: number;
  roundCount: number;
  winnerPlayerId: string | null;
  winnerName: string;
  winnerUserId: string | null;
  createdByUserId: string | null;
  finishedByAi: boolean;
  participants: StatsParticipant[];
  rounds: StatsRoundScore[];
}

export interface StatsSummary {
  self: {
    gamesPlayed: number;
    wins: number;
    multiplayerGames: number;
    singlePlayerGames: number;
    winRate: number;
    averageTotalScore: number;
    bestTotalScore: number | null;
  };
  coPlayers: Array<{
    userId: string;
    displayName: string;
    gamesTogether: number;
    wins: number;
    averageTotalScore: number;
    latestAt: number;
  }>;
  recentGames: StatsGame[];
  admin: { users: number; games: number } | null;
}

type AccountContextValue = {
  loading: boolean;
  user: AccountUser | null;
  localSoloOwnerId: string | null;
  error: string;
  clearError: () => void;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, displayName: string, password: string, confirmPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, password: string, confirmPassword: string) => Promise<void>;
  updateProfile: (displayName: string) => Promise<void>;
};

const AccountContext = createContext<AccountContextValue | null>(null);
export const lastConfirmedSoloOwnerStorageKey = 'skyjo:last-confirmed-solo-owner';

function validLocalSoloOwnerId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readLocalSoloOwnerId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(lastConfirmedSoloOwnerStorageKey);
    return validLocalSoloOwnerId(value) ? value : null;
  } catch {
    return null;
  }
}

function writeLocalSoloOwnerId(userId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (userId) window.localStorage.setItem(lastConfirmedSoloOwnerStorageKey, userId);
    else window.localStorage.removeItem(lastConfirmedSoloOwnerStorageKey);
  } catch {
    // Local identity hints are optional and never authorize a request.
  }
}

function sameAccountUser(left: AccountUser | null, right: AccountUser | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.id === right.id &&
    left.email === right.email &&
    left.displayName === right.displayName &&
    left.role === right.role &&
    left.disabled === right.disabled &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.lastLoginAt === right.lastLoginAt
  );
}

async function apiJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(payload.error || 'Request failed.');
  return payload as T;
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [localSoloOwnerId, setLocalSoloOwnerId] = useState(readLocalSoloOwnerId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const applyConfirmedUser = useCallback((nextUser: AccountUser | null) => {
    setUser((currentUser) => (sameAccountUser(currentUser, nextUser) ? currentUser : nextUser));
    const nextOwnerId = validLocalSoloOwnerId(nextUser?.id) ? nextUser.id : null;
    setLocalSoloOwnerId(nextOwnerId);
    writeLocalSoloOwnerId(nextOwnerId);
  }, []);

  const refresh = useCallback(async () => {
    const payload = await apiJson<{ user: AccountUser | null }>('/api/account/me');
    applyConfirmedUser(payload.user ?? null);
  }, [applyConfirmedUser]);

  useEffect(() => {
    refresh()
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Could not load account.'))
      .finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    const syncLiveAccount = () => {
      void refresh().catch(() => undefined);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== lastConfirmedSoloOwnerStorageKey) return;
      setLocalSoloOwnerId(validLocalSoloOwnerId(event.newValue) ? event.newValue : null);
      syncLiveAccount();
    };
    window.addEventListener('focus', syncLiveAccount);
    window.addEventListener('online', syncLiveAccount);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('focus', syncLiveAccount);
      window.removeEventListener('online', syncLiveAccount);
      window.removeEventListener('storage', handleStorage);
    };
  }, [refresh]);

  const value = useMemo<AccountContextValue>(
    () => ({
      loading,
      user,
      localSoloOwnerId,
      error,
      clearError: () => setError(''),
      refresh,
      async login(email, password) {
        setError('');
        const payload = await apiJson<{ user: AccountUser }>('/api/account/login', {
          method: 'POST',
          body: JSON.stringify({ email, password })
        });
        applyConfirmedUser(payload.user);
      },
      async signup(email, displayName, password, confirmPassword) {
        setError('');
        const payload = await apiJson<{ user: AccountUser }>('/api/account/signup', {
          method: 'POST',
          body: JSON.stringify({ email, displayName, password, confirmPassword })
        });
        applyConfirmedUser(payload.user);
      },
      async logout() {
        setError('');
        try {
          await apiJson<{ ok: boolean }>('/api/account/logout', { method: 'POST' });
        } finally {
          applyConfirmedUser(null);
        }
      },
      async changePassword(currentPassword, password, confirmPassword) {
        setError('');
        await apiJson<{ ok: boolean }>('/api/account/password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, password, confirmPassword })
        });
        applyConfirmedUser(null);
      },
      async updateProfile(displayName) {
        setError('');
        const payload = await apiJson<{ user: AccountUser }>('/api/account/profile', {
          method: 'PATCH',
          body: JSON.stringify({ displayName })
        });
        applyConfirmedUser(payload.user);
      }
    }),
    [applyConfirmedUser, error, loading, localSoloOwnerId, refresh, user]
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount must be used inside AccountProvider.');
  return value;
}

export async function saveSinglePlayerGame(
  state: GameState,
  clientGameKey: string,
  signal: AbortSignal | undefined,
  options: { completedAt?: number; expectedAccountUserId: string }
) {
  return apiJson<{ game: StatsGame }>('/api/stats/single-player', {
    method: 'POST',
    body: JSON.stringify({ state, clientGameKey, ...options }),
    signal
  });
}

export async function createRoomInvite(roomCode: string) {
  return apiJson<{ roomCode: string; path: string; expiresAt: number }>('/api/rooms/invite', {
    method: 'POST',
    body: JSON.stringify({ roomCode })
  });
}

export async function fetchStatsSummary() {
  return apiJson<StatsSummary>('/api/stats/summary');
}

export async function fetchStatsGames() {
  return apiJson<{ games: StatsGame[] }>('/api/stats/games');
}

export async function fetchStatsGame(gameId: string) {
  return apiJson<{ game: StatsGame }>(`/api/stats/games/${encodeURIComponent(gameId)}`);
}

export async function fetchPlayerStats(userId: string) {
  return apiJson<{ user: AccountUser; summary: StatsSummary['self']; games: StatsGame[] }>(
    `/api/stats/players/${encodeURIComponent(userId)}`
  );
}

export async function fetchAdminUsers() {
  return apiJson<{ users: Array<AccountUser & { gamesPlayed: number; wins: number }> }>('/api/admin/users');
}

export async function createAdminUser({
  confirmPassword,
  displayName,
  email,
  password,
  role
}: {
  confirmPassword: string;
  displayName: string;
  email: string;
  password: string;
  role: 'admin' | 'player';
}) {
  return apiJson<{ user: AccountUser }>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ confirmPassword, displayName, email, password, role })
  });
}

export async function updateAdminUser(userId: string, patch: Partial<Pick<AccountUser, 'displayName' | 'role' | 'disabled'>>) {
  return apiJson<{ user: AccountUser }>(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
}

export async function setAdminUserPassword(userId: string, password: string, confirmPassword: string) {
  return apiJson<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(userId)}/password`, {
    method: 'POST',
    body: JSON.stringify({ password, confirmPassword })
  });
}
