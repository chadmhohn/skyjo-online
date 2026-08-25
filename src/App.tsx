import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  cancelDiscardSelection,
  chooseDiscard,
  discardDrawnAndReveal,
  drawBlind,
  replaceCard,
  revealOpeningCard,
  singlePlayerAiOpponentRange,
  startFreshGame,
  startNextRound
} from './game';
import { GameTableLayout, type DrawIntent } from './GameTableLayout';
import {
  handleScrollableRegionKeyDown,
  usePhoneLayout,
  usePrefersReducedMotion
} from './accessibility';
import SoloGamePromptLoadFallback from './SoloGamePromptLoadFallback';
import RoundSummaryRestoreButton from './RoundSummaryRestoreButton';
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
  useAccount,
  type AccountUser,
  type StatsGame,
  type StatsSummary
} from './account';
import {
  useAudioSettings,
  useGameAudio,
  type GameAudioDelivery
} from './audio';
import {
  activatePwaUpdate,
  getPwaUpdateSnapshot,
  isPwaUpdateDeferredPath,
  subscribeToPwaUpdates
} from './pwaUpdate';
import type {
  RoomConnectionController,
  RoomConnectionFrame,
  RoomConnectionSocket,
  RoomConnectionState
} from './roomConnection';
import { loadRoomConnection } from './lazyRoomConnection';
import {
  parseResetRecoveryHint,
  RESET_RECOVERY_STORAGE_KEY,
  serializeResetRecoveryHint,
  type ResetRecoveryHint
} from './resetRecovery';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  multiplayerRoomForRender,
  type ClientCommand,
  type GameCommand,
  type PublicRoomSnapshot
} from './protocolV2';
import {
  createSoloGameId,
  createSoloGameSetup,
  createStatsOutboxCoordinator,
  deleteSoloSession,
  enqueueCompletedGame,
  loadSoloSession,
  replaceSoloSession,
  saveSoloSession,
  soloOwnerKey,
  type SoloGameSetup,
  type SoloOwnerKey,
  type SoloPersistenceWarning,
  type SoloSessionRecord
} from './soloDurability';
import type { GameState, MultiplayerRoom } from './types';
import { advanceSoloAiOpeningSeat, drainSoloAiOpening, soloAiOpeningSeatDelayMs } from './soloAiOpening';
import { difficultyForSoloPlayer, resolveSoloGameSetup } from './soloAiSetup';
import { loadSoloAiStrategy } from './lazySoloAiStrategy';
import {
  RouteLoadFailure,
  RouteLoadFallback
} from './SoloFlowLoadFallbacks';
import {
  GameSettingsButtonPendingFallback
} from './PendingControlFallbacks';
import { soloDifficultyLabel, type SoloIntent, type SoloSetupOrigin } from './soloUx';

type SoloStatsCoordinator = ReturnType<typeof createStatsOutboxCoordinator>;
type SoloStatsFlushResult = Awaited<ReturnType<SoloStatsCoordinator['flush']>>;
type SoloReplacementRequest = {
  ownerKey: SoloOwnerKey;
  ownerGeneration: number;
  previousGameId: string;
  setup: SoloGameSetup;
};
type SoloScreen = 'loading' | 'launcher' | 'setup' | 'playing';

function beginSoloStatsFlush(
  coordinator: SoloStatsCoordinator,
  onResult: (result: SoloStatsFlushResult) => void,
  onFailure: () => void
): void {
  void Promise.resolve()
    .then(() => coordinator.flush(true))
    .then(onResult)
    .catch(onFailure);
}

function statsSyncUnavailableWarning(): SoloPersistenceWarning {
  return {
    kind: 'unavailable',
    message: 'Saved game stats are unavailable in this browser session. Your game can continue safely.'
  };
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

function accountPath(next?: string) {
  return next ? `/account?next=${encodeURIComponent(next)}` : '/account';
}

function RequireAccountPanel({ next, title = 'Sign in to continue' }: { next: string; title?: string }) {
  return (
    <main className="skyjo-surface px-4 py-8">
      <section className="skyjo-shell mx-auto flex min-h-[70vh] max-w-2xl items-center">
        <div className="skyjo-panel w-full p-6">
          <p className="skyjo-kicker">Account required</p>
          <h1 className="skyjo-serif mt-2 text-3xl font-black text-[#f5e6c8]">{title}</h1>
          <p className="mt-3 leading-7 text-[#f5e6c8]/68">Single-player is open for casual play, but multiplayer and saved stats need a Flipvale account.</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link className="skyjo-button skyjo-button-primary px-4 py-2" to={accountPath(next)}>
              Sign In
            </Link>
            <Link className="skyjo-button px-4 py-2" to="/">
              Back Home
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}

const RoundSummary = lazy(() => import('./RoundSummary').catch(() => import('./CriticalLoadFallbacks').then((module) => ({
  default: module.RoundSummaryLoadFallback
}))));
const RoomChat = lazy(() => import('./RoomChat').catch(() => import('./RoomChatLoadFallback')));
const SoloGamePrompt = lazy(() => import('./SoloGamePrompt').catch(() => ({ default: SoloGamePromptLoadFallback })));
const GameSettingsButton = lazy(() => import('./GameSettingsButton').catch(() =>
  import('./CriticalLoadFallbacks').then((module) => ({ default: module.GameSettingsButtonLoadFallback }))
));
const Home = lazy(() => import('./Home').catch(() => ({ default: RouteLoadFailure })));
const AccountPage = lazy(() => import('./AccountPage').catch(() => ({ default: RouteLoadFailure })));
const PrivacyPolicyPage = lazy(() => import('./LegalPages').then((module) => ({ default: module.PrivacyPolicyPage })).catch(() => ({
  default: RouteLoadFailure
})));
const SupportPage = lazy(() => import('./LegalPages').then((module) => ({ default: module.SupportPage })).catch(() => ({
  default: RouteLoadFailure
})));
const SoloLauncher = lazy(() => import('./SoloSetupFlow').then((module) => ({ default: module.SoloLauncher })).catch(() => ({
  default: RouteLoadFailure
})));
const SoloGameSetupPanel = lazy(() => import('./SoloSetupFlow').then((module) => ({ default: module.SoloGameSetupPanel })).catch(() => ({
  default: RouteLoadFailure
})));
const ActiveRoomOptionsDialog = lazy(() => import('./ActiveRoomOptionsDialog').catch(() => import('./CriticalLoadFallbacks').then((module) => ({
  default: module.ActiveRoomOptionsLoadFallback
}))));


function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="skyjo-stat-tile">
      <div className="skyjo-kicker">{label}</div>
      <div className="mt-1 text-2xl font-black text-[#f5e6c8]">{value}</div>
    </div>
  );
}

function GameRows({ games }: { games: StatsGame[] }) {
  if (games.length === 0) return <p className="text-sm leading-6 text-[#f5e6c8]/62">No saved games yet.</p>;
  return (
    <div className="skyjo-history-list">
      {games.map((game) => (
        <Link className="skyjo-history-row" key={game.id} to={`/stats/games/${game.id}`}>
          <div className="min-w-0">
            <div className="font-black text-[#f5e6c8]">{game.mode === 'multi' ? `Room ${game.roomCode || 'Multiplayer'}` : 'Single Player'}</div>
            <div className="text-xs text-[#f5e6c8]/54">{formatDate(game.completedAt)}</div>
          </div>
          <div className="text-right text-sm font-extrabold text-[#f5e6c8]/78">
            <div>{game.winnerName} won</div>
            <div>{game.roundCount} round{game.roundCount === 1 ? '' : 's'}</div>
          </div>
        </Link>
      ))}
    </div>
  );
}

function StatsPage() {
  const { loading, user } = useAccount();
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [games, setGames] = useState<StatsGame[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) return;
    Promise.all([fetchStatsSummary(), fetchStatsGames()])
      .then(([summaryPayload, gamesPayload]) => {
        setSummary(summaryPayload);
        setGames(gamesPayload.games);
      })
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Could not load stats.'));
  }, [user]);

  if (loading) return null;
  if (!user) return <RequireAccountPanel next="/stats" title="Sign in to see stats" />;

  return (
    <main className="skyjo-surface px-4 py-8">
      <section className="skyjo-shell mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link className="skyjo-back-link text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/">
              Back
            </Link>
            <h1 className="skyjo-title skyjo-game-title mt-2 text-5xl">Stats</h1>
          </div>
          <Link className="skyjo-button px-4 py-2" to="/account">
            Account
          </Link>
        </div>
        {error ? <div className="skyjo-error-note">{error}</div> : null}
        {summary ? (
          <>
            <section className="skyjo-panel p-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <StatTile label="Games" value={summary.self.gamesPlayed} />
                <StatTile label="Wins" value={summary.self.wins} />
                <StatTile label="Win rate" value={`${summary.self.winRate}%`} />
                <StatTile label="Avg score" value={summary.self.averageTotalScore} />
                <StatTile label="Best score" value={summary.self.bestTotalScore ?? '-'} />
              </div>
            </section>
            <section className="grid gap-5 lg:grid-cols-[1fr_0.85fr]">
              <div className="skyjo-panel p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <p className="skyjo-kicker">History</p>
                    <h2 className="skyjo-serif text-2xl font-black text-[#f5e6c8]">Saved games</h2>
                  </div>
                </div>
                <GameRows games={games} />
              </div>
              <div className="skyjo-panel p-5">
                <p className="skyjo-kicker">Co-players</p>
                <h2 className="skyjo-serif text-2xl font-black text-[#f5e6c8]">People you've played</h2>
                <div className="skyjo-history-list mt-4">
                  {summary.coPlayers.length === 0 ? (
                    <p className="text-sm leading-6 text-[#f5e6c8]/62">Multiplayer stats will show up after completed games.</p>
                  ) : (
                    summary.coPlayers.map((player) => (
                      <Link className="skyjo-history-row" key={player.userId} to={`/stats/players/${player.userId}`}>
                        <div>
                          <div className="font-black text-[#f5e6c8]">{player.displayName}</div>
                          <div className="text-xs text-[#f5e6c8]/54">{player.gamesTogether} shared game{player.gamesTogether === 1 ? '' : 's'}</div>
                        </div>
                        <div className="text-right text-sm font-extrabold text-[#f5e6c8]/78">{player.wins} wins</div>
                      </Link>
                    ))
                  )}
                </div>
              </div>
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}

function GameDetailPage() {
  const { loading, user } = useAccount();
  const { gameId = '' } = useParams();
  const [game, setGame] = useState<StatsGame | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user || !gameId) return;
    fetchStatsGame(gameId)
      .then((payload) => setGame(payload.game))
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Could not load game.'));
  }, [gameId, user]);

  if (loading) return null;
  if (!user) return <RequireAccountPanel next={`/stats/games/${gameId}`} title="Sign in to see game history" />;

  return (
    <main className="skyjo-surface px-4 py-8">
      <section className="skyjo-shell mx-auto max-w-4xl space-y-5">
        <Link className="skyjo-back-link text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/stats">
          Back to stats
        </Link>
        {error ? <div className="skyjo-error-note">{error}</div> : null}
        {game ? (
          <div className="skyjo-panel p-5">
            <p className="skyjo-kicker">{game.mode === 'multi' ? 'Multiplayer game' : 'Single-player game'}</p>
            <h1 className="skyjo-serif mt-2 text-3xl font-black text-[#f5e6c8]">{game.winnerName} won</h1>
            <p className="mt-1 text-sm text-[#f5e6c8]/58">{formatDate(game.completedAt)}</p>
            <div className="skyjo-history-list mt-5">
              {game.participants.map((participant) => (
                <div className="skyjo-history-row" key={participant.id}>
                  <div>
                    <div className="font-black text-[#f5e6c8]">#{participant.rank} {participant.displayName}</div>
                    <div className="text-xs text-[#f5e6c8]/54">{participant.kind === 'ai' ? 'AI' : 'Player'}</div>
                  </div>
                  <div className="text-right text-sm font-extrabold text-[#f5e6c8]/78">
                    <div>Total {participant.totalScore}</div>
                    <div>Last round {participant.roundScore}</div>
                  </div>
                </div>
              ))}
            </div>
            {game.rounds.length > 0 ? (
              <div className="mt-6">
                <p className="skyjo-kicker">Round scores</p>
                <div className="skyjo-round-score-grid mt-3">
                  {game.rounds.map((round) => (
                    <div className="skyjo-round-score-cell" key={round.id}>
                      <span>R{round.round} {round.displayName}</span>
                      <strong>{round.roundScore}</strong>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function PlayerStatsPage() {
  const { loading, user } = useAccount();
  const { playerId = '' } = useParams();
  const [playerStats, setPlayerStats] = useState<{ user: AccountUser; summary: StatsSummary['self']; games: StatsGame[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user || !playerId) return;
    fetchPlayerStats(playerId)
      .then(setPlayerStats)
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Could not load player.'));
  }, [playerId, user]);

  if (loading) return null;
  if (!user) return <RequireAccountPanel next={`/stats/players/${playerId}`} title="Sign in to see player stats" />;

  return (
    <main className="skyjo-surface px-4 py-8">
      <section className="skyjo-shell mx-auto max-w-4xl space-y-5">
        <Link className="skyjo-back-link text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/stats">
          Back to stats
        </Link>
        {error ? <div className="skyjo-error-note">{error}</div> : null}
        {playerStats ? (
          <div className="skyjo-panel p-5">
            <p className="skyjo-kicker">Player history</p>
            <h1 className="skyjo-serif mt-2 text-3xl font-black text-[#f5e6c8]">{playerStats.user.displayName}</h1>
            <div className="mt-5 grid gap-3 sm:grid-cols-4">
              <StatTile label="Games" value={playerStats.summary.gamesPlayed} />
              <StatTile label="Wins" value={playerStats.summary.wins} />
              <StatTile label="Win rate" value={`${playerStats.summary.winRate}%`} />
              <StatTile label="Avg score" value={playerStats.summary.averageTotalScore} />
            </div>
            <div className="mt-5">
              <GameRows games={playerStats.games} />
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function AdminPage() {
  const { loading, user } = useAccount();
  const [users, setUsers] = useState<Array<AccountUser & { gamesPlayed: number; wins: number }>>([]);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserName, setNewUserName] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserConfirmPassword, setNewUserConfirmPassword] = useState('');
  const [newUserRole, setNewUserRole] = useState<'admin' | 'player'>('player');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function refreshUsers() {
    const payload = await fetchAdminUsers();
    setUsers(payload.users);
  }

  useEffect(() => {
    if (user?.role !== 'admin') return;
    refreshUsers().catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Could not load users.'));
  }, [user?.role]);

  async function patchUser(userId: string, patch: Partial<Pick<AccountUser, 'role' | 'disabled'>>) {
    setError('');
    setMessage('');
    try {
      await updateAdminUser(userId, patch);
      await refreshUsers();
      setMessage('User updated.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'User update failed.');
    }
  }

  async function createUserForAdmin(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      const payload = await createAdminUser({
        confirmPassword: newUserConfirmPassword,
        displayName: newUserName,
        email: newUserEmail,
        password: newUserPassword,
        role: newUserRole
      });
      setNewUserEmail('');
      setNewUserName('');
      setNewUserPassword('');
      setNewUserConfirmPassword('');
      setNewUserRole('player');
      await refreshUsers();
      setMessage(`Created account for ${payload.user.email}.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'User creation failed.');
    }
  }

  async function resetPassword(userId: string) {
    const password = passwords[userId] || '';
    setError('');
    setMessage('');
    try {
      await setAdminUserPassword(userId, password, password);
      setPasswords((current) => ({ ...current, [userId]: '' }));
      setMessage('Password updated.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Password update failed.');
    }
  }

  if (loading) return null;
  if (!user) return <RequireAccountPanel next="/admin" title="Sign in for admin tools" />;
  if (user.role !== 'admin') return <RequireAccountPanel next="/" title="Admin privileges required" />;

  return (
    <main className="skyjo-surface px-4 py-8">
      <section className="skyjo-shell mx-auto max-w-5xl space-y-5">
        <Link className="skyjo-back-link text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/">
          Back
        </Link>
        <div className="skyjo-panel p-5">
          <p className="skyjo-kicker">Admin</p>
          <h1 className="skyjo-serif mt-2 text-4xl font-black text-[#f5e6c8]">Users</h1>
          {message ? <div className="skyjo-success-note mt-4">{message}</div> : null}
          {error ? <div className="skyjo-error-note mt-4">{error}</div> : null}
          <form className="skyjo-admin-create-form mt-5" onSubmit={createUserForAdmin}>
            <label>
              Email
              <input
                className="skyjo-input px-3 py-2"
                onChange={(event) => setNewUserEmail(event.target.value)}
                required
                type="email"
                value={newUserEmail}
              />
            </label>
            <label>
              Display name
              <input
                className="skyjo-input px-3 py-2"
                onChange={(event) => setNewUserName(event.target.value)}
                required
                value={newUserName}
              />
            </label>
            <label>
              Temporary password
              <input
                className="skyjo-input px-3 py-2"
                onChange={(event) => setNewUserPassword(event.target.value)}
                required
                type="password"
                value={newUserPassword}
              />
            </label>
            <label>
              Confirm password
              <input
                className="skyjo-input px-3 py-2"
                onChange={(event) => setNewUserConfirmPassword(event.target.value)}
                required
                type="password"
                value={newUserConfirmPassword}
              />
            </label>
            <label>
              Role
              <select
                className="skyjo-input px-3 py-2"
                onChange={(event) => setNewUserRole(event.target.value === 'admin' ? 'admin' : 'player')}
                value={newUserRole}
              >
                <option value="player">Player</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <button className="skyjo-button skyjo-button-primary px-4 py-2" type="submit">
              Create Account
            </button>
          </form>
          <div className="skyjo-admin-user-list mt-5">
            {users.map((item) => {
              const isSelf = item.id === user.id;
              return (
                <div className="skyjo-admin-user-row" key={item.id}>
                  <div className="min-w-0">
                    <div className="font-black text-[#f5e6c8]">{item.displayName}</div>
                    <div className="text-xs text-[#f5e6c8]/54">{item.email}</div>
                    <div className="mt-1 text-xs font-bold text-[#f5e6c8]/68">
                      {isSelf ? 'you - ' : ''}
                      {item.role} - {item.disabled ? 'disabled' : 'active'} - {item.gamesPlayed} games - {item.wins} wins
                    </div>
                  </div>
                  <div className="skyjo-admin-user-actions">
                    <button
                      className="skyjo-button px-3 py-2 text-sm"
                      disabled={isSelf}
                      onClick={() => patchUser(item.id, { disabled: !item.disabled })}
                      title={isSelf ? 'You cannot disable your own account.' : item.disabled ? 'Enable user' : 'Disable user'}
                      type="button"
                    >
                      {item.disabled ? 'Enable' : 'Disable'}
                    </button>
                    <button
                      className="skyjo-button px-3 py-2 text-sm"
                      disabled={isSelf}
                      onClick={() => patchUser(item.id, { role: item.role === 'admin' ? 'player' : 'admin' })}
                      title={isSelf ? 'You cannot revoke your own admin role.' : item.role === 'admin' ? 'Make player' : 'Make admin'}
                      type="button"
                    >
                      {item.role === 'admin' ? 'Make Player' : 'Make Admin'}
                    </button>
                    <input
                      className="skyjo-input px-3 py-2 text-sm"
                      onChange={(event) => setPasswords((current) => ({ ...current, [item.id]: event.target.value }))}
                      placeholder="New password"
                      type="password"
                      value={passwords[item.id] || ''}
                    />
                    <button className="skyjo-button skyjo-button-primary px-3 py-2 text-sm" onClick={() => resetPassword(item.id)} type="button">
                      Set Password
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </main>
  );
}

function SinglePlayer() {
  const { loading: accountLoading, localSoloOwnerId, user } = useAccount();
  const location = useLocation();
  const navigate = useNavigate();
  const pwaUpdate = useSyncExternalStore(subscribeToPwaUpdates, getPwaUpdateSnapshot, getPwaUpdateSnapshot);
  const prefersReducedMotion = usePrefersReducedMotion();
  const ownerKey = soloOwnerKey(user?.id ?? localSoloOwnerId);
  const initialIntentRef = useRef<SoloIntent | undefined>(
    (location.state as { soloIntent?: SoloIntent } | null)?.soloIntent
  );
  const [activeSetup, setActiveSetup] = useState<SoloGameSetup>(() =>
    createSoloGameSetup(singlePlayerAiOpponentRange.min, 'medium')
  );
  const [draftSetup, setDraftSetup] = useState<SoloGameSetup>(() =>
    createSoloGameSetup(singlePlayerAiOpponentRange.min, 'medium')
  );
  const [state, setState] = useState<GameState | null>(null);
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const [screen, setScreen] = useState<SoloScreen>('loading');
  const [setupOrigin, setSetupOrigin] = useState<SoloSetupOrigin>('home');
  const [setupPending, setSetupPending] = useState(false);
  const [hydratedOwnerKey, setHydratedOwnerKey] = useState('');
  const [resumeSession, setResumeSession] = useState<SoloSessionRecord | null>(null);
  const [protectedSession, setProtectedSession] = useState<SoloSessionRecord | null>(null);
  const [persistenceWarning, setPersistenceWarning] = useState<SoloPersistenceWarning | null>(null);
  const [drawIntent, setDrawIntent] = useState<DrawIntent>('place');
  const [roundSummaryOpen, setRoundSummaryOpen] = useState(false);
  const [statsSaveStatus, setStatsSaveStatus] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [replacementRequest, setReplacementRequest] = useState<SoloReplacementRequest | null>(null);
  const [replacementPending, setReplacementPending] = useState(false);
  const completedQueueKeyRef = useRef('');
  const gameplayFocusPendingRef = useRef(false);
  const replacementFocusPendingRef = useRef(false);
  const setupStartButtonRef = useRef<HTMLButtonElement | null>(null);
  const lastPersistedSessionRef = useRef<{
    activeSetup: SoloGameSetup;
    gameId: string;
    ownerKey: SoloOwnerKey;
    state: GameState;
  } | null>(null);
  const ownerContextRef = useRef({ generation: 0, ownerKey });
  if (ownerContextRef.current.ownerKey !== ownerKey) {
    ownerContextRef.current = { generation: ownerContextRef.current.generation + 1, ownerKey };
  }
  const statsCoordinatorRef = useRef<ReturnType<typeof createStatsOutboxCoordinator> | null>(null);
  if (!statsCoordinatorRef.current) {
    statsCoordinatorRef.current = createStatsOutboxCoordinator((record, signal) => {
      const expectedAccountUserId = record.ownerKey.startsWith('account:') ? record.ownerKey.slice('account:'.length) : '';
      return saveSinglePlayerGame(record.state, record.gameId, signal, {
        completedAt: record.createdAt,
        expectedAccountUserId
      });
    });
  }
  const activePlayer = state?.players[state.currentPlayerIndex] ?? null;
  const humanTurn = activePlayer?.kind === 'human';
  const localPlayerId = state?.players.find((player) => player.kind === 'human')?.id;
  const aiOpponentCount = activeSetup.aiOpponentCount;
  const aiOpponentSummary = `Current game: ${aiOpponentCount} AI opponent${aiOpponentCount === 1 ? '' : 's'}`;
  const aiDifficultySummary = `Difficulty: ${soloDifficultyLabel(activeSetup.difficulty)}`;
  const mixedDifficultyBadges = activeSetup.difficulty === 'mixed'
    ? Object.fromEntries(
        Object.entries(activeSetup.playerDifficulties ?? {}).map(([playerId, difficulty]) => [
          playerId,
          `${soloDifficultyLabel(difficulty)} AI`
        ])
      )
    : undefined;
  const isScoringPhase = state?.phase === 'round-over' || state?.phase === 'game-over';
  const summaryModalOpen = isScoringPhase && roundSummaryOpen;
  const durabilityReady = Boolean(
    screen === 'playing' && state && activeGameId && !accountLoading && hydratedOwnerKey === ownerKey
  );

  useGameAudio(screen === 'playing' ? state : null, {
    sessionId: activeGameId ?? 'solo-pending',
    localPlayerId: localPlayerId ?? null
  });

  useEffect(() => {
    if (accountLoading) return;
    let cancelled = false;
    const intent = initialIntentRef.current;
    setHydratedOwnerKey('');
    setScreen('loading');
    setState(null);
    setActiveGameId(null);
    setResumeSession(null);
    setProtectedSession(null);
    setReplacementRequest(null);
    setReplacementPending(false);
    setSetupPending(false);
    setSettingsOpen(false);
    setRoundSummaryOpen(false);
    setDrawIntent('place');
    setStatsSaveStatus('');
    setPersistenceWarning(null);
    lastPersistedSessionRef.current = null;
    completedQueueKeyRef.current = '';

    loadSoloSession(ownerKey).then((result) => {
      if (cancelled) return;
      if (intent) {
        initialIntentRef.current = undefined;
        navigate('/single-player', { replace: true, state: null });
      }
      setPersistenceWarning((current) => result.warning ?? current);
      setHydratedOwnerKey(ownerKey);
      if (result.session) {
        lastPersistedSessionRef.current = {
          activeSetup: result.session.setup,
          gameId: result.session.gameId,
          ownerKey,
          state: result.session.state
        };
        setProtectedSession(result.session);
        setDraftSetup(result.session.setup);
        if (intent === 'continue') {
          setActiveSetup(result.session.setup);
          setActiveGameId(result.session.gameId);
          setState(result.session.state);
          setProtectedSession(null);
          gameplayFocusPendingRef.current = true;
          setScreen('playing');
          completedQueueKeyRef.current = '';
        } else if (intent === 'new') {
          setSetupOrigin('home');
          setScreen('setup');
        } else {
          setResumeSession(result.session);
          setScreen('launcher');
        }
        return;
      }
      const setup = createSoloGameSetup(singlePlayerAiOpponentRange.min, 'medium');
      setDraftSetup(setup);
      setSetupOrigin('home');
      setScreen('setup');
    });

    return () => {
      cancelled = true;
    };
  }, [accountLoading, navigate, ownerKey]);

  useEffect(() => {
    const coordinator = statsCoordinatorRef.current;
    if (!coordinator) return;
    let cancelled = false;
    coordinator.setOwner(user ? ownerKey : null);

    const flush = () => {
      beginSoloStatsFlush(
        coordinator,
        (result) => {
          if (cancelled || result.aborted) return;
          if (result.delivered > 0) setStatsSaveStatus('Queued game stats were saved.');
          else if (result.pending > 0) setStatsSaveStatus('Game stats are safely queued and will retry when online.');
        },
        () => {
          if (cancelled) return;
          setPersistenceWarning(statsSyncUnavailableWarning());
          setStatsSaveStatus('Game stats sync is unavailable. Play can continue and Flipvale will retry later.');
        }
      );
    };

    if (user) flush();
    window.addEventListener('online', flush);
    window.addEventListener('focus', flush);
    return () => {
      cancelled = true;
      window.removeEventListener('online', flush);
      window.removeEventListener('focus', flush);
      coordinator.setOwner(null);
    };
  }, [ownerKey, user]);

  useEffect(() => {
    const coordinator = statsCoordinatorRef.current;
    return () => coordinator?.dispose();
  }, []);

  useEffect(() => {
    if (!state || state.phase !== 'choose-replacement' || state.selectedSource !== 'draw' || !state.drawnCard) {
      setDrawIntent('place');
    }
  }, [state]);

  useEffect(() => {
    if (screen !== 'playing' || !gameplayFocusPendingRef.current) return undefined;
    gameplayFocusPendingRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (
        active &&
        active !== document.body &&
        active !== document.documentElement &&
        active.isConnected
      ) {
        return;
      }
      const target =
        document.querySelector<HTMLElement>('[aria-label="Action guidance"]') ??
        document.querySelector<HTMLElement>('[aria-label="Open game settings"]');
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeGameId, screen, state?.round]);

  useEffect(() => {
    if (
      !durabilityReady ||
      !state ||
      !activeGameId ||
      settingsOpen ||
      replacementRequest ||
      activePlayer?.kind !== 'ai' ||
      state.phase === 'round-over' ||
      state.phase === 'game-over'
    ) {
      return;
    }
    let cancelled = false;
    const openingReveal = state.phase === 'opening-reveal';
    const strategy = openingReveal ? null : loadSoloAiStrategy();
    const timer = window.setTimeout(() => {
      if (openingReveal) {
        setState((current) => current
          ? (prefersReducedMotion ? drainSoloAiOpening(current) : advanceSoloAiOpeningSeat(current))
          : current);
        return;
      }
      void strategy?.then(
        ({ chooseAiMoveForState }) => {
          if (cancelled) return;
          setState((current) => {
            if (!current) return current;
            const currentAi = current.players[current.currentPlayerIndex];
            if (!currentAi || currentAi.kind !== 'ai') return current;
            const move = chooseAiMoveForState(current, {
              playerId: currentAi.id,
              difficulty: difficultyForSoloPlayer(activeSetup, currentAi.id),
              decisionKey: `${activeGameId}:${current.round}:${current.log[0] ?? ''}`
            });
            if (!move) return current;
            if (move.action === 'discard') return chooseDiscard(current);
            if (move.action === 'draw') return drawBlind(current);
            if (move.action === 'replace') return replaceCard(current, move.index ?? 0);
            return discardDrawnAndReveal(current, move.index ?? 0);
          });
        },
        () => {
          if (cancelled) return;
          setPersistenceWarning({
            kind: 'unavailable',
            message: 'AI opponents could not load on this device. Reload Flipvale to retry safely.'
          });
        }
      );
    }, openingReveal ? (prefersReducedMotion ? 0 : soloAiOpeningSeatDelayMs) : 650);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeGameId, activePlayer?.kind, activeSetup, durabilityReady, prefersReducedMotion, replacementRequest, settingsOpen, state]);

  useEffect(() => {
    setRoundSummaryOpen(isScoringPhase);
  }, [isScoringPhase, state?.round]);

  useEffect(() => {
    if (replacementRequest || !replacementFocusPendingRef.current) return undefined;
    replacementFocusPendingRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      setupStartButtonRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [replacementRequest]);

  useEffect(() => {
    if (!durabilityReady || !state || !activeGameId) return;
    let cancelled = false;
    if (state.phase !== 'game-over') {
      const lastPersisted = lastPersistedSessionRef.current;
      if (
        lastPersisted?.ownerKey === ownerKey &&
        lastPersisted.gameId === activeGameId &&
        lastPersisted.state === state &&
        lastPersisted.activeSetup === activeSetup
      ) {
        return;
      }
      void saveSoloSession(ownerKey, activeGameId, state, activeSetup).then((warning) => {
        if (cancelled) return;
        if (warning) {
          setPersistenceWarning(warning);
          return;
        }
        lastPersistedSessionRef.current = { activeSetup, gameId: activeGameId, ownerKey, state };
      });
      return () => {
        cancelled = true;
      };
    }

    const completionKey = `${ownerKey}:${activeGameId}`;
    if (completedQueueKeyRef.current === completionKey) return;
    completedQueueKeyRef.current = completionKey;
    void enqueueCompletedGame(ownerKey, activeGameId, state).then(async (warning) => {
      if (!warning) {
        await deleteSoloSession(ownerKey, activeGameId).catch(() => undefined);
        lastPersistedSessionRef.current = null;
      }
      if (cancelled) return;
      if (warning) {
        setPersistenceWarning(warning);
        setStatsSaveStatus('Stats could not be queued on this device. Your completed game remains playable.');
        return;
      }
      if (!user) {
        setStatsSaveStatus(
          localSoloOwnerId
            ? 'Game stats are queued for your last confirmed account and will sync after sign-in is restored.'
            : 'This guest game stays on this device and will not be added to an account.'
        );
        return;
      }
      setStatsSaveStatus('Game stats are safely queued.');
      const coordinator = statsCoordinatorRef.current;
      if (!coordinator) return;
      beginSoloStatsFlush(
        coordinator,
        (result) => {
          if (cancelled || result.aborted) return;
          setStatsSaveStatus(
            result.pending === 0 ? 'Game saved to your stats.' : 'Game stats are safely queued and will retry when online.'
          );
        },
        () => {
          if (cancelled) return;
          setPersistenceWarning(statsSyncUnavailableWarning());
          setStatsSaveStatus('Game stats sync is unavailable. Play can continue and Flipvale will retry later.');
        }
      );
    });
    return () => {
      cancelled = true;
    };
  }, [activeGameId, activeSetup, durabilityReady, localSoloOwnerId, ownerKey, state, user]);

  function handleCard(index: number) {
    if (!state || !humanTurn || (state.phase !== 'opening-reveal' && state.phase !== 'choose-replacement')) return;
    if (state.phase === 'opening-reveal') {
      setState((current) => current ? revealOpeningCard(current, index) : current);
      return;
    }
    setState((current) =>
      current && drawIntent === 'discard' && current.selectedSource === 'draw' && current.drawnCard
        ? discardDrawnAndReveal(current, index)
        : current ? replaceCard(current, index) : current
    );
  }

  function chooseDiscardForSinglePlayer() {
    setState((current) => current ? chooseDiscard(current) : current);
  }

  function drawForSinglePlayer() {
    setState((current) => current ? drawBlind(current) : current);
  }

  function continueSavedGame() {
    if (!resumeSession) return;
    setActiveSetup(resumeSession.setup);
    setDraftSetup(resumeSession.setup);
    setActiveGameId(resumeSession.gameId);
    setState(resumeSession.state);
    setResumeSession(null);
    setProtectedSession(null);
    setHydratedOwnerKey(ownerKey);
    gameplayFocusPendingRef.current = true;
    setScreen('playing');
    completedQueueKeyRef.current = '';
  }

  function setUpNewGameFromLauncher() {
    if (!resumeSession) return;
    setProtectedSession(resumeSession);
    setDraftSetup(resumeSession.setup);
    setResumeSession(null);
    setSetupOrigin('launcher');
    setScreen('setup');
  }

  function currentSoloSession(): SoloSessionRecord | null {
    if (!state || !activeGameId) return null;
    return {
      ownerKey,
      gameId: activeGameId,
      schemaVersion: 1,
      state,
      aiOpponentCount: activeSetup.aiOpponentCount,
      setup: activeSetup,
      updatedAt: Date.now()
    };
  }

  function openSetupFromGame(origin: Extract<SoloSetupOrigin, 'active' | 'game-over'>) {
    const currentSession = currentSoloSession();
    if (!currentSession) return;
    setRoundSummaryOpen(false);
    setSettingsOpen(false);
    setProtectedSession(origin === 'active' ? currentSession : null);
    setDraftSetup(activeSetup);
    setSetupOrigin(origin);
    setScreen('setup');
  }

  function leaveSetup() {
    if (setupPending || replacementPending) return;
    setReplacementRequest(null);
    if (setupOrigin === 'launcher' && protectedSession) {
      setResumeSession(protectedSession);
      setScreen('launcher');
      return;
    }
    if (setupOrigin === 'active' || setupOrigin === 'game-over') {
      setProtectedSession(null);
      if (setupOrigin === 'active') gameplayFocusPendingRef.current = true;
      setScreen('playing');
      if (setupOrigin === 'game-over') setRoundSummaryOpen(true);
      return;
    }
    navigate('/');
  }

  function requestSetupStart() {
    if (setupPending || replacementPending) return;
    if (setupOrigin === 'game-over') {
      void startAfterCompletedGame(draftSetup);
      return;
    }
    if (protectedSession) {
      setReplacementRequest({
        ownerKey,
        ownerGeneration: ownerContextRef.current.generation,
        previousGameId: protectedSession.gameId,
        setup: draftSetup
      });
      return;
    }
    void startUnprotectedGame(draftSetup);
  }

  async function startUnprotectedGame(setup: SoloGameSetup) {
    setSetupPending(true);
    const requestOwner = ownerContextRef.current;
    const nextGameId = createSoloGameId();
    const nextState = startFreshGame({ aiOpponentCount: setup.aiOpponentCount });
    const nextSetup = resolveSoloGameSetup(
      createSoloGameSetup(setup.aiOpponentCount, setup.difficulty),
      nextState,
      nextGameId
    );
    const warning = await saveSoloSession(ownerKey, nextGameId, nextState, nextSetup);
    if (
      ownerContextRef.current.ownerKey !== requestOwner.ownerKey ||
      ownerContextRef.current.generation !== requestOwner.generation
    ) return;
    if (warning?.kind === 'conflict') {
      setPersistenceWarning(warning);
      setSetupPending(false);
      return;
    }
    setActiveSetup(nextSetup);
    setDraftSetup(nextSetup);
    setActiveGameId(nextGameId);
    setState(nextState);
    setResumeSession(null);
    setProtectedSession(null);
    setStatsSaveStatus('');
    setPersistenceWarning(warning);
    setSetupPending(false);
    if (!warning) {
      lastPersistedSessionRef.current = { activeSetup: nextSetup, gameId: nextGameId, ownerKey, state: nextState };
    }
    gameplayFocusPendingRef.current = true;
    setScreen('playing');
    completedQueueKeyRef.current = '';
  }

  async function confirmReplacement() {
    if (!replacementRequest || replacementPending) return;
    const request = replacementRequest;
    setReplacementPending(true);
    const nextGameId = createSoloGameId();
    const nextState = startFreshGame({ aiOpponentCount: request.setup.aiOpponentCount });
    const nextSetup = resolveSoloGameSetup(
      createSoloGameSetup(request.setup.aiOpponentCount, request.setup.difficulty),
      nextState,
      nextGameId
    );
    const warning = await replaceSoloSession(
      request.ownerKey,
      request.previousGameId,
      nextGameId,
      nextState,
      nextSetup
    );
    if (
      ownerContextRef.current.ownerKey !== request.ownerKey ||
      ownerContextRef.current.generation !== request.ownerGeneration
    ) {
      return;
    }
    if (warning) {
      setPersistenceWarning(warning);
      setReplacementPending(false);
      return;
    }

    setActiveSetup(nextSetup);
    setDraftSetup(nextSetup);
    setActiveGameId(nextGameId);
    setState(nextState);
    setResumeSession(null);
    setProtectedSession(null);
    setHydratedOwnerKey(ownerKey);
    setStatsSaveStatus('');
    setPersistenceWarning(null);
    setReplacementRequest(null);
    setReplacementPending(false);
    setSetupPending(false);
    lastPersistedSessionRef.current = { activeSetup: nextSetup, gameId: nextGameId, ownerKey, state: nextState };
    gameplayFocusPendingRef.current = true;
    setScreen('playing');
    completedQueueKeyRef.current = '';
  }

  async function startAfterCompletedGame(setup: SoloGameSetup) {
    if (setupPending || replacementPending || !activeGameId) return;
    setSetupPending(true);
    const requestOwner = ownerContextRef.current;
    const nextGameId = createSoloGameId();
    const nextState = startFreshGame({ aiOpponentCount: setup.aiOpponentCount });
    const nextSetup = resolveSoloGameSetup(
      createSoloGameSetup(setup.aiOpponentCount, setup.difficulty),
      nextState,
      nextGameId
    );
    const warning = await replaceSoloSession(ownerKey, activeGameId, nextGameId, nextState, nextSetup);
    if (
      ownerContextRef.current.ownerKey !== requestOwner.ownerKey ||
      ownerContextRef.current.generation !== requestOwner.generation
    ) return;
    if (warning) {
      setPersistenceWarning(warning);
      setSetupPending(false);
      return;
    }
    setActiveSetup(nextSetup);
    setDraftSetup(nextSetup);
    setActiveGameId(nextGameId);
    setState(nextState);
    setProtectedSession(null);
    setStatsSaveStatus('');
    setPersistenceWarning(null);
    setSetupPending(false);
    setRoundSummaryOpen(false);
    lastPersistedSessionRef.current = { activeSetup: nextSetup, gameId: nextGameId, ownerKey, state: nextState };
    gameplayFocusPendingRef.current = true;
    setScreen('playing');
    completedQueueKeyRef.current = '';
  }

  function replaySameSetup() {
    void startAfterCompletedGame(activeSetup);
  }

  function cancelReplacement() {
    if (replacementPending) return;
    replacementFocusPendingRef.current = true;
    setReplacementRequest(null);
  }

  const soloGamePromptProps = {
    onCancelReplacement: cancelReplacement,
    onConfirmReplacement: () => void confirmReplacement(),
    onContinue: () => undefined,
    onDismissResume: () => undefined,
    onRequestReplacement: () => undefined,
    replacementOpen: Boolean(replacementRequest),
    replacementPending,
    replacementCurrentSession: protectedSession,
    replacementTriggerRef: setupStartButtonRef,
    replacementSetup: replacementRequest?.setup,
    resumeSession: null,
    restoreFocusFallback: () =>
      document.querySelector<HTMLElement>('[data-testid="solo-start-button"]') ??
      document.querySelector<HTMLElement>('[aria-label="Action guidance"]') ??
      document.querySelector<HTMLElement>('[aria-label="Open game settings"]'),
    warning: persistenceWarning
  };
  const soloGamePrompt = (
    <Suspense fallback={<SoloGamePromptLoadFallback {...soloGamePromptProps} />}>
      <SoloGamePrompt {...soloGamePromptProps} />
    </Suspense>
  );

  if (screen === 'loading' || accountLoading || hydratedOwnerKey !== ownerKey) {
    return (
      <main className="skyjo-surface px-4 py-8" data-testid="solo-storage-loading">
        <section className="skyjo-shell mx-auto flex min-h-[70vh] max-w-2xl items-center">
          <div className="skyjo-panel w-full p-6" role="status">
            <p className="skyjo-kicker">Single Player</p>
            <h1 className="skyjo-serif mt-2 text-3xl font-black text-[#f5e6c8]">Checking for a saved game…</h1>
          </div>
        </section>
      </main>
    );
  }

  if (screen === 'launcher' && resumeSession) {
    return (
      <Suspense fallback={<RouteLoadFallback />}>
        <SoloLauncher
          onBack={() => navigate('/')}
          onContinue={continueSavedGame}
          onNewGame={setUpNewGameFromLauncher}
          session={resumeSession}
          warning={persistenceWarning}
        />
      </Suspense>
    );
  }

  if (screen === 'setup') {
    return (
      <>
        <Suspense fallback={<RouteLoadFallback />}>
          <SoloGameSetupPanel
            draft={draftSetup}
            onBack={leaveSetup}
            onChange={(setup) => setDraftSetup(createSoloGameSetup(setup.aiOpponentCount, setup.difficulty))}
            onStart={requestSetupStart}
            origin={setupOrigin}
            pending={setupPending || replacementPending}
            protectedSession={protectedSession}
            startButtonRef={setupStartButtonRef}
            warning={replacementRequest ? null : persistenceWarning}
          />
        </Suspense>
        {replacementRequest ? soloGamePrompt : null}
      </>
    );
  }

  if (!state || !activeGameId) return <RouteLoadFailure />;

  return (
    <main
      className={`skyjo-surface px-4 py-5 ${summaryModalOpen ? 'skyjo-round-summary-surface' : ''}`}
      data-testid="game-table"
    >
      <div
        className={`skyjo-shell skyjo-active-game-layout ${
          summaryModalOpen ? 'skyjo-round-summary-mode' : ''
        } grid gap-5`}
        data-pwa-update-deferred={pwaUpdate.available}
      >
        {isScoringPhase && !roundSummaryOpen ? (
          <RoundSummaryRestoreButton
            state={state}
            updateReserved={pwaUpdate.available}
            onRestore={() => setRoundSummaryOpen(true)}
          />
        ) : null}

        <div className="skyjo-game-header flex flex-wrap items-start justify-between gap-3">
          <div className="skyjo-game-heading min-w-0">
            <Link aria-label="Back to home" className="skyjo-back-link text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/">
              Back
            </Link>
            <h1 className="skyjo-title skyjo-game-title mt-2 text-5xl">Single Player</h1>
            <p className="skyjo-game-subtitle mt-1 text-[#f5e6c8]/55">Round {state.round}. Lowest score wins; first to 100 ends the game.</p>
          </div>
          <div className="skyjo-header-controls flex w-auto items-start justify-end">
            <div className="skyjo-header-actions flex items-start justify-end gap-2">
              <Suspense fallback={<GameSettingsButtonPendingFallback state={state} />}>
                <GameSettingsButton
                  aiDifficultySummary={aiDifficultySummary}
                  aiOpponentCount={aiOpponentCount}
                  aiOpponentSummary={aiOpponentSummary}
                  onOpenChange={setSettingsOpen}
                  onSetupAnotherGame={() => openSetupFromGame('active')}
                  state={state}
                />
              </Suspense>
            </div>
          </div>
          {statsSaveStatus || persistenceWarning ? (
            <div
              aria-label="Game status"
              className="skyjo-game-status"
              onKeyDown={handleScrollableRegionKeyDown}
              role="region"
              tabIndex={0}
            >
              {statsSaveStatus ? <p className="text-sm font-bold text-[#f5e6c8]/62">{statsSaveStatus}</p> : null}
              {persistenceWarning ? (
                <p className="text-sm font-bold text-[#f5e6c8]/72" role="status">
                  {persistenceWarning.message}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <GameTableLayout
          drawIntent={drawIntent}
          localPlayerId={localPlayerId}
          localTurn={humanTurn}
          onCancelDiscard={() => setState((current) => current ? cancelDiscardSelection(current) : current)}
          onCardClick={handleCard}
          onChooseDiscard={chooseDiscardForSinglePlayer}
          onDraw={drawForSinglePlayer}
          onSetDrawIntent={setDrawIntent}
          playerBadges={mixedDifficultyBadges}
          state={state}
        />

        {isScoringPhase && roundSummaryOpen ? (
          <aside className="skyjo-secondary-stack space-y-4">
            <Suspense fallback={null}>
              <RoundSummary
                actionLabel={state.phase === 'game-over' ? (setupPending ? 'Starting…' : 'Play again with same setup') : 'Next Round'}
                actionDisabledReason={state.phase === 'game-over' && setupPending ? 'Preparing your next game.' : undefined}
                onMinimize={() => setRoundSummaryOpen(false)}
                onAction={() => (state.phase === 'game-over'
                  ? void replaySameSetup()
                  : setState((current) => current ? startNextRound(current) : current))}
                restoreFocusFallback={() => document.querySelector<HTMLElement>('[aria-label="Action guidance"]')}
                playerBadges={mixedDifficultyBadges}
                state={state}
              >
                {state.phase === 'game-over' ? (
                  <button
                    className="skyjo-button mt-3 w-full px-4 py-3"
                    disabled={setupPending}
                    onClick={() => openSetupFromGame('game-over')}
                    type="button"
                  >
                    Change setup
                  </button>
                ) : null}
              </RoundSummary>
            </Suspense>
          </aside>
        ) : null}
      </div>
      {replacementRequest ? soloGamePrompt : null}
    </main>
  );
}

const multiplayerConnectionCopy: Record<RoomConnectionState, { label: string; detail: string }> = {
  idle: { label: 'Not connected', detail: 'Create a room or join with a code.' },
  connecting: { label: 'Connecting', detail: 'Opening a secure room connection.' },
  connected: { label: 'Connected', detail: 'Room state is synchronized.' },
  reconnecting: { label: 'Reconnecting', detail: 'Game controls are paused while room state catches up.' },
  offline: { label: 'Offline', detail: 'Game controls are paused until your network returns.' },
  error: { label: 'Connection error', detail: 'Choose an available recovery action before multiplayer resumes.' }
};

function MultiplayerConnectionStatus({ state, roomActive }: { state: RoomConnectionState; roomActive: boolean }) {
  const copy =
    state === 'idle' && roomActive
      ? { label: 'Not connected', detail: 'Retry your saved seat or leave the room to start over.' }
      : multiplayerConnectionCopy[state];
  return (
    <div
      aria-live={state === 'error' ? 'assertive' : 'polite'}
      className={`rounded-xl border px-4 py-3 text-sm ${
        state === 'connected'
          ? 'border-emerald-300/30 bg-emerald-950/55 text-emerald-100'
          : state === 'offline' || state === 'error'
            ? 'border-red-400/40 bg-red-950/70 text-red-100'
            : 'border-amber-200/25 bg-amber-950/45 text-amber-50'
      }`}
      data-connection-state={state}
      data-testid="connection-status"
      role={state === 'error' ? 'alert' : 'status'}
    >
      <span className="font-black">{copy.label}.</span> {copy.detail}
    </div>
  );
}

function formatLifecycleCountdown(deadline: number, serverNow: number): string {
  const totalSeconds = Math.max(0, Math.ceil((deadline - serverNow) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

type InitialLobbySession = {
  joinCode: string;
  playerId: string;
  recoveryCommandId?: string;
  recoveryExpectedRevision?: number;
  roomCode: string;
};

function roomSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/rooms`;
}

function cleanRoomCode(value: string | null | undefined) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 5);
}

function createMultiplayerCommandId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('Secure command ids are unavailable in this browser.');
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function getInitialLobbySession(): InitialLobbySession {
  const savedRoomCode = cleanRoomCode(window.localStorage.getItem('skyjo-room-code'));
  const savedPlayerId = window.localStorage.getItem('skyjo-player-id') || '';
  const sharedRoomCode = cleanRoomCode(new URLSearchParams(window.location.search).get('room'));
  const useSavedSession = !sharedRoomCode || sharedRoomCode === savedRoomCode;
  const roomCode = useSavedSession ? savedRoomCode : '';
  const playerId = useSavedSession ? savedPlayerId : '';
  const rawRecoveryHint = window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY);
  const recoveryHint = parseResetRecoveryHint(rawRecoveryHint);
  const useRecoveryHint = Boolean(
    recoveryHint && recoveryHint.fromCode === roomCode && recoveryHint.playerId === playerId
  );
  if (rawRecoveryHint !== null && !useRecoveryHint) {
    window.localStorage.removeItem(RESET_RECOVERY_STORAGE_KEY);
  }

  return {
    joinCode: sharedRoomCode || savedRoomCode,
    playerId,
    roomCode,
    ...(useRecoveryHint && recoveryHint
      ? {
          recoveryCommandId: recoveryHint.commandId,
          recoveryExpectedRevision: recoveryHint.expectedRevision
        }
      : {})
  };
}

function absoluteShareUrl(path: string) {
  const url = new URL(path, window.location.origin);
  return url.toString();
}

function Lobby() {
  const { loading: accountLoading, user: accountUser } = useAccount();
  const accountUserId = accountUser?.id ?? '';
  const accountDisplayName = accountUser?.displayName ?? '';
  const location = useLocation();
  const phoneLayout = usePhoneLayout();
  const pwaUpdate = useSyncExternalStore(subscribeToPwaUpdates, getPwaUpdateSnapshot, getPwaUpdateSnapshot);
  const initialLobbyRef = useRef<InitialLobbySession | null>(null);
  if (!initialLobbyRef.current) initialLobbyRef.current = getInitialLobbySession();
  const initialLobby = initialLobbyRef.current;
  const connectionControllerRef = useRef<RoomConnectionController | null>(null);
  const frameHandlerRef = useRef<(frame: RoomConnectionFrame) => void>(() => {});
  const shareStatusTimerRef = useRef<number | null>(null);
  const roomOptionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const roomCodeRef = useRef(initialLobby.roomCode);
  const playerIdRef = useRef(initialLobby.playerId);
  const roomAudioNeedsBaselineRef = useRef(true);
  const terminalSessionRetiredRef = useRef(false);
  const resetRecoveryHintRef = useRef<ResetRecoveryHint | null>(
    initialLobby.recoveryCommandId && initialLobby.recoveryExpectedRevision !== undefined
      ? {
          fromCode: initialLobby.roomCode,
          playerId: initialLobby.playerId,
          commandId: initialLobby.recoveryCommandId,
          expectedRevision: initialLobby.recoveryExpectedRevision
        }
      : null
  );
  const lastSharedRoomCodeRef = useRef(cleanRoomCode(new URLSearchParams(location.search).get('room')));
  const [name, setName] = useState(() => window.localStorage.getItem('skyjo-player-name') || 'Player');
  const [joinCode, setJoinCode] = useState(initialLobby.joinCode);
  const [roomCode, setRoomCode] = useState(initialLobby.roomCode);
  const [playerId, setPlayerId] = useState(initialLobby.playerId);
  const [room, setRoom] = useState<MultiplayerRoom | null>(null);
  const [clientNow, setClientNow] = useState(() => Date.now());
  const [serverClockOffset, setServerClockOffset] = useState(0);
  const [connection, setConnection] = useState<RoomConnectionState>('idle');
  const [roomAudioDelivery, setRoomAudioDelivery] = useState<GameAudioDelivery>('baseline');
  const [commandPending, setCommandPending] = useState(false);
  const [error, setError] = useState('');
  const [shareStatus, setShareStatus] = useState('');
  const [drawIntent, setDrawIntent] = useState<DrawIntent>('place');
  const [chatOpen, setChatOpen] = useState(false);
  const [roomOptionsOpen, setRoomOptionsOpen] = useState(false);
  const [roundSummaryOpen, setRoundSummaryOpen] = useState(false);
  const [lastSeenChatMessageId, setLastSeenChatMessageId] = useState('');
  const lastSeenChatRoomCodeRef = useRef('');
  const hasPendingDrawDecision = Boolean(
    room?.state && room.state.phase === 'choose-replacement' && room.state.selectedSource === 'draw' && room.state.drawnCard
  );
  const chatMessages = room?.chatMessages ?? [];
  const latestChatMessage = chatMessages[chatMessages.length - 1];
  const roomChatCode = room?.code || '';
  const lastSeenChatIndex = chatMessages.findIndex((message) => message.id === lastSeenChatMessageId);
  const unreadChatCount = chatMessages.reduce(
    (count, message, index) => (index > lastSeenChatIndex && message.playerId !== playerId ? count + 1 : count),
    0
  );
  const clearResetRecoveryHint = useCallback((commandId?: string) => {
    const currentHint = resetRecoveryHintRef.current;
    try {
      const storedHint = parseResetRecoveryHint(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY));
      if (!commandId || storedHint?.commandId === commandId) {
        window.localStorage.removeItem(RESET_RECOVERY_STORAGE_KEY);
      }
    } catch {
      // Recovery cleanup is best effort when browser storage is unavailable.
    }
    if (!commandId || currentHint?.commandId === commandId) {
      resetRecoveryHintRef.current = null;
    }
  }, []);
  const retireTerminalRoomSession = useCallback((message = '') => {
    if (terminalSessionRetiredRef.current) return;
    terminalSessionRetiredRef.current = true;
    const retiringRoomCode = roomCodeRef.current;
    const retiringPlayerId = playerIdRef.current;
    try {
      const storedRoomCode = window.localStorage.getItem('skyjo-room-code');
      const storedPlayerId = window.localStorage.getItem('skyjo-player-id');
      if (
        retiringRoomCode &&
        retiringPlayerId &&
        storedRoomCode === retiringRoomCode &&
        storedPlayerId === retiringPlayerId
      ) {
        window.localStorage.removeItem('skyjo-player-id');
        window.localStorage.removeItem('skyjo-room-code');
      }
      const storedRecoveryHint = parseResetRecoveryHint(
        window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY)
      );
      if (
        storedRecoveryHint?.fromCode === retiringRoomCode &&
        storedRecoveryHint.playerId === retiringPlayerId
      ) {
        window.localStorage.removeItem(RESET_RECOVERY_STORAGE_KEY);
      }
    } catch {
      // The in-memory terminal state must still retire when browser storage is unavailable.
    }
    resetRecoveryHintRef.current = null;
    playerIdRef.current = '';
    roomCodeRef.current = '';
    setPlayerId('');
    setRoomCode('');
    setJoinCode('');
    setRoom(null);
    setError(message);
  }, []);
  frameHandlerRef.current = handleRoomFrame;

  useEffect(
    () => () => {
      if (shareStatusTimerRef.current !== null) {
        window.clearTimeout(shareStatusTimerRef.current);
        shareStatusTimerRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    if (!hasPendingDrawDecision) {
      setDrawIntent('place');
    }
  }, [hasPendingDrawDecision]);

  useEffect(() => {
    setRoundSummaryOpen(false);
  }, [room?.state?.phase, room?.state?.round]);

  useEffect(() => {
    roomCodeRef.current = roomCode;
  }, [roomCode]);

  useEffect(() => {
    if (!accountUserId) return;
    setName(accountDisplayName);
    window.localStorage.setItem('skyjo-player-name', accountDisplayName);
  }, [accountDisplayName, accountUserId]);

  useEffect(() => {
    if (!accountUserId) return;
    let disposed = false;
    let controller: RoomConnectionController | null = null;
    setConnection('connecting');
    void loadRoomConnection().then(({ createRoomConnection }) => {
      if (disposed) return;
      controller = createRoomConnection({
        url: roomSocketUrl(),
        createSocket: (url) => new WebSocket(url) as unknown as RoomConnectionSocket,
        onFrame: (frame) => frameHandlerRef.current(frame),
        onStateChange: (state) => {
          if (state !== 'connected') roomAudioNeedsBaselineRef.current = true;
          setConnection(state);
        },
        onPendingCommandChange: setCommandPending,
        onError: (message) => setError(message)
      });
      connectionControllerRef.current = controller;
      if (roomCodeRef.current && playerIdRef.current) {
        const recoveryHint = resetRecoveryHintRef.current;
        controller.recover({
          action: 'join-room',
          code: roomCodeRef.current,
          name: accountDisplayName,
          playerId: playerIdRef.current,
          ...(recoveryHint
            ? {
                recoveryCommandId: recoveryHint.commandId,
                recoveryExpectedRevision: recoveryHint.expectedRevision
              }
            : {})
        });
      }
      controller.setOnline(navigator.onLine !== false);
      controller.setVisible(document.visibilityState === 'visible');
      setConnection(controller.getState());
    }).catch(() => {
      if (disposed) return;
      setConnection('error');
      setError('Could not initialize the room connection. Reload and try again.');
    });
    return () => {
      disposed = true;
      if (controller && connectionControllerRef.current === controller) connectionControllerRef.current = null;
      controller?.dispose();
    };
  }, [accountDisplayName, accountUserId]);

  useEffect(() => {
    playerIdRef.current = playerId;
  }, [playerId]);

  useEffect(() => {
    const sharedRoomCode = cleanRoomCode(new URLSearchParams(location.search).get('room'));
    if (!sharedRoomCode || sharedRoomCode === lastSharedRoomCodeRef.current) return;
    lastSharedRoomCodeRef.current = sharedRoomCode;
    if (sharedRoomCode === roomCodeRef.current) return;

    clearResetRecoveryHint();
    connectionControllerRef.current?.disconnect();
    window.localStorage.removeItem('skyjo-player-id');
    window.localStorage.removeItem('skyjo-room-code');
    playerIdRef.current = '';
    roomCodeRef.current = '';
    setPlayerId('');
    setRoomCode('');
    setRoom(null);
    setJoinCode(sharedRoomCode);
    setConnection('idle');
    setError('');
  }, [clearResetRecoveryHint, location.search]);

  useEffect(() => {
    if (!roomChatCode) return;
    const latestId = latestChatMessage?.id || '';
    if (lastSeenChatRoomCodeRef.current !== roomChatCode) {
      lastSeenChatRoomCodeRef.current = roomChatCode;
      setLastSeenChatMessageId(latestId);
      return;
    }
    if (chatOpen || latestChatMessage?.playerId === playerId) {
      setLastSeenChatMessageId(latestId);
    }
  }, [chatOpen, latestChatMessage?.id, latestChatMessage?.playerId, playerId, roomChatCode]);

  function connect(action: 'create-room' | 'join-room', codeOverride?: string) {
    if (!accountUser) {
      setError('Sign in to your Flipvale account before joining multiplayer.');
      return;
    }
    const cleanedName = accountUser.displayName || name.trim() || 'Player';
    const cleanedCode = cleanRoomCode(codeOverride ?? joinCode);
    if (action === 'join-room' && !cleanedCode) {
      setError('Enter a room code.');
      return;
    }
    terminalSessionRetiredRef.current = false;
    window.localStorage.setItem('skyjo-player-name', cleanedName);
    setError('');
    const controller = connectionControllerRef.current;
    if (!controller) {
      setConnection('error');
      setError('Room connection is still initializing. Try again.');
      return;
    }
    clearResetRecoveryHint();
    controller.connect(
      action === 'create-room'
        ? { action: 'create-room', name: cleanedName }
        : {
            action: 'join-room',
            code: cleanedCode,
            name: cleanedName,
            playerId: cleanedCode === roomCodeRef.current ? playerIdRef.current || playerId || undefined : undefined
          }
    );
  }

  function handleRoomFrame(message: RoomConnectionFrame) {
    if (message.type === 'snapshot' || message.type === 'resync') {
      const joinedPlayerId = message.playerId as string;
      const joinedRoom = multiplayerRoomForRender(message.room as PublicRoomSnapshot);
      const audioDelivery: GameAudioDelivery =
        message.type === 'resync'
          ? 'resync'
          : roomAudioNeedsBaselineRef.current
            ? 'baseline'
            : 'live';
      roomAudioNeedsBaselineRef.current = false;
      const receivedAt = Date.now();
      terminalSessionRetiredRef.current = false;
      setClientNow(receivedAt);
      setServerClockOffset(
        Number.isFinite(joinedRoom.serverNow) ? receivedAt - Number(joinedRoom.serverNow) : 0
      );
      const recoveryHint = resetRecoveryHintRef.current;
      if (message.type === 'resync' && message.reason === 'room-reset') {
        clearResetRecoveryHint(typeof message.commandId === 'string' ? message.commandId : undefined);
      } else if (
        message.type === 'resync' &&
        recoveryHint &&
        message.commandId === recoveryHint.commandId &&
        joinedRoom.code === recoveryHint.fromCode &&
        joinedPlayerId === recoveryHint.playerId
      ) {
        clearResetRecoveryHint(recoveryHint.commandId);
      }
      setPlayerId(joinedPlayerId);
      playerIdRef.current = joinedPlayerId;
      window.localStorage.setItem('skyjo-player-id', joinedPlayerId);
      setRoomCode(joinedRoom.code);
      roomCodeRef.current = joinedRoom.code;
      window.localStorage.setItem('skyjo-room-code', joinedRoom.code);
      setJoinCode(joinedRoom.code);
      setRoomAudioDelivery(audioDelivery);
      setRoom(joinedRoom);
      setError(
        message.type === 'resync' && message.reason !== 'room-reset'
          ? 'The room changed before that action was accepted. Review the table and try again.'
          : ''
      );
      return;
    }
    if (message.type === 'ack') {
      if (message.result === 'room-left') retireTerminalRoomSession();
      return;
    }
    if (message.type === 'upgrade-required') {
      setError(typeof message.message === 'string' ? message.message : 'Refresh Flipvale to continue multiplayer.');
      return;
    }
    if (message.type === 'error') {
      const recoveryHint = resetRecoveryHintRef.current;
      const correlatedResetError = recoveryHint && message.commandId === recoveryHint.commandId;
      const terminalBootRecoveryError = recoveryHint &&
        roomCodeRef.current === recoveryHint.fromCode &&
        playerIdRef.current === recoveryHint.playerId &&
        ['stale-room', 'seat-forbidden', 'room-not-found', 'game-started'].includes(String(message.code));
      if (correlatedResetError || terminalBootRecoveryError) {
        clearResetRecoveryHint(recoveryHint.commandId);
      }
      if (message.code === 'room-reset') {
        clearResetRecoveryHint();
        connectionControllerRef.current?.disconnect();
        window.localStorage.removeItem('skyjo-player-id');
        window.localStorage.removeItem('skyjo-room-code');
        playerIdRef.current = '';
        roomCodeRef.current = '';
        setPlayerId('');
        setRoomCode('');
        setRoom(null);
      }
      if (message.code === 'seat-removed' || message.code === 'stale-seat') {
        retireTerminalRoomSession(
          typeof message.message === 'string' ? message.message : 'That saved room seat is no longer available.'
        );
        return;
      }
      setError(typeof message.message === 'string' ? message.message : 'Room error.');
      return;
    }
  }

  useEffect(() => {
    const handleResume = () => {
      if (document.visibilityState !== 'visible') return;
      connectionControllerRef.current?.resume();
    };
    const handleVisibilityChange = () =>
      connectionControllerRef.current?.setVisible(document.visibilityState === 'visible');
    const handlePageHide = () => connectionControllerRef.current?.setVisible(false);
    const handlePageShow = () => connectionControllerRef.current?.setVisible(true);
    const handleOffline = () => connectionControllerRef.current?.setOnline(false);
    const handleOnline = () => connectionControllerRef.current?.setOnline(true);

    window.addEventListener('focus', handleResume);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleResume);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  function send(payload: RoomConnectionFrame): boolean {
    const sent = connectionControllerRef.current?.send(payload) === true;
    if (!sent) {
      setError('Room connection is not open.');
    }
    return sent;
  }

  function sendCommand(action: GameCommand) {
    if (!room) {
      setError('Join a room before sending an action.');
      return;
    }
    let commandId: string;
    try {
      commandId = createMultiplayerCommandId();
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : 'Secure command ids are unavailable in this browser.');
      return;
    }
    const command: ClientCommand = {
      type: 'command',
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      commandId,
      expectedRevision: room.revision,
      action
    };
    let resetRecoveryHint: ResetRecoveryHint | null = null;
    let previousResetRecoveryHint: ResetRecoveryHint | null = null;
    if (action.type === 'reset-room') {
      resetRecoveryHint = {
        fromCode: room.code,
        playerId: playerIdRef.current || playerId,
        commandId,
        expectedRevision: room.revision
      };
      try {
        const previousHint = parseResetRecoveryHint(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY));
        previousResetRecoveryHint = previousHint &&
          previousHint.fromCode === room.code &&
          previousHint.playerId === resetRecoveryHint.playerId
          ? previousHint
          : null;
        window.localStorage.setItem(
          RESET_RECOVERY_STORAGE_KEY,
          serializeResetRecoveryHint(resetRecoveryHint)
        );
        resetRecoveryHintRef.current = resetRecoveryHint;
      } catch {
        setError('Flipvale could not save reset recovery data. The room was not reset.');
        return;
      }
    }
    if (!send(command as unknown as RoomConnectionFrame) && resetRecoveryHint) {
      try {
        if (previousResetRecoveryHint) {
          window.localStorage.setItem(
            RESET_RECOVERY_STORAGE_KEY,
            serializeResetRecoveryHint(previousResetRecoveryHint)
          );
        } else {
          window.localStorage.removeItem(RESET_RECOVERY_STORAGE_KEY);
        }
      } catch {
        // The command was not sent, so the in-memory recovery state can still be retired safely.
      }
      resetRecoveryHintRef.current = previousResetRecoveryHint;
    }
  }

  function retrySavedRoom() {
    const code = roomCodeRef.current;
    const savedPlayerId = playerIdRef.current;
    if (!code || !savedPlayerId || !accountUser) {
      setError('No saved room seat is available to retry.');
      return;
    }
    setError('');
    const recoveryHint = resetRecoveryHintRef.current;
    connectionControllerRef.current?.recover({
      action: 'join-room',
      code,
      name: accountUser.displayName,
      playerId: savedPlayerId,
      ...(recoveryHint
        ? {
            recoveryCommandId: recoveryHint.commandId,
            recoveryExpectedRevision: recoveryHint.expectedRevision
          }
        : {})
    });
  }

  function leaveSavedRoom() {
    clearResetRecoveryHint();
    connectionControllerRef.current?.disconnect();
    window.localStorage.removeItem('skyjo-player-id');
    window.localStorage.removeItem('skyjo-room-code');
    playerIdRef.current = '';
    roomCodeRef.current = '';
    setPlayerId('');
    setRoomCode('');
    setJoinCode('');
    setRoom(null);
    setError('');
  }

  function startRoomGame() {
    if (!room || room.players.length < 2) return;
    sendCommand({ type: 'start-game' });
  }

  function sendChatMessage(text: string) {
    sendCommand({ type: 'send-chat-message', text });
    setChatOpen(true);
  }

  function handleCard(index: number) {
    if (!room?.state || (room.state.phase !== 'opening-reveal' && room.state.phase !== 'choose-replacement')) return;
    const active = room.state.players[room.state.currentPlayerIndex];
    if (active.id !== playerId) return;
    if (room.state.phase === 'opening-reveal') {
      sendCommand({ type: 'reveal-opening-card', cardIndex: index });
      return;
    }
    sendCommand(
      drawIntent === 'discard' && room.state.selectedSource === 'draw' && room.state.drawnCard
        ? { type: 'discard-and-reveal', cardIndex: index }
        : { type: 'replace-card', cardIndex: index }
    );
  }

  function handleNextRound() {
    if (!room?.state) return;
    if (!allPlayersReadyForNextRound) return;
    sendCommand({ type: 'start-game' });
  }

  function toggleNextRoundReady() {
    if (!roomScoringPhase) return;
    sendCommand({ type: 'set-next-round-ready', ready: !localReadyForNextRound });
  }

  function setTemporaryShareStatus(message: string) {
    setShareStatus(message);
    if (shareStatusTimerRef.current !== null) window.clearTimeout(shareStatusTimerRef.current);
    shareStatusTimerRef.current = window.setTimeout(() => {
      setShareStatus('');
      shareStatusTimerRef.current = null;
    }, 2200);
  }

  async function copyRoomLink(text: string, status = 'Link copied') {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard is not available.');
    await navigator.clipboard.writeText(text);
    setTemporaryShareStatus(status);
  }

  async function shareRoomLink() {
    if (!room) return;
    setError('');
    let fallbackText = `Flipvale room code: ${room.code}`;
    let fallbackStatus = 'Room code copied';
    let inviteCreated = false;

    try {
      const invite = await createRoomInvite(room.code);
      const url = absoluteShareUrl(invite.path);
      const text = `Join my Flipvale room ${room.code}: ${url}`;
      fallbackText = text;
      fallbackStatus = 'Link copied';
      inviteCreated = true;
      if (navigator.share) {
        await navigator.share({
          title: 'Flipvale room',
          text: `Join my Flipvale room ${room.code}.`,
          url
        });
        setTemporaryShareStatus('Share opened');
        return;
      }
      await copyRoomLink(text);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      try {
        await copyRoomLink(fallbackText, fallbackStatus);
        if (!inviteCreated) {
          setError(error instanceof Error ? `${error.message} Room code copied instead.` : 'Could not create invite link. Room code copied instead.');
        }
      } catch {
        setError('Sharing is not available in this browser. Copy the room code manually.');
      }
    }
  }

  const localTurn = Boolean(room?.state && room.state.players[room.state.currentPlayerIndex]?.id === playerId);
  const localPlayer = room?.players.find((player) => player.id === playerId);
  const localIsHost = Boolean(room && localPlayer?.id === room.hostId);
  const connectedHumanPlayerCount = room?.players.filter(
    (player) => player.connected && (player.controller || 'human') === 'human'
  ).length ?? 0;
  const estimatedServerNow = clientNow - serverClockOffset;
  const lifecycleDeadlines = room
    ? [room.hostTransferAt, ...room.players.map((player) => player.aiTakeoverAt)].filter(
        (deadline): deadline is number => Number.isFinite(deadline)
      )
    : [];
  const hasActiveLifecycleCountdown = lifecycleDeadlines.some((deadline) => deadline > estimatedServerNow);
  const hostTransferDeadline = room?.hostTransferAt;
  const hostTransferCopy = room && Number.isFinite(hostTransferDeadline)
    ? Number(hostTransferDeadline) > estimatedServerNow
      ? `${room.status === 'waiting' ? 'Waiting-room' : 'Active-game'} host handoff in ${formatLifecycleCountdown(
          Number(hostTransferDeadline),
          estimatedServerNow
        )}. The oldest connected player will become host.`
      : `${room.status === 'waiting' ? 'Waiting-room' : 'Active-game'} host handoff is pending. The oldest connected player will become host when available.`
    : '';
  const roomState = room?.state;
  const activePhoneLayout = phoneLayout && Boolean(roomState);
  const roomInteractionDisabledReason =
    room && (localPlayer?.controller || 'human') === 'ai'
      ? 'AI is controlling your seat. Keep this tab visible to reclaim it.'
      : room && commandPending
      ? 'Waiting for the server to confirm the previous action.'
      : room && connection !== 'connected'
      ? connection === 'offline'
        ? 'Multiplayer actions are unavailable while offline.'
        : 'Multiplayer actions are paused until the room is synchronized.'
      : '';
  const connectionRequestDisabled =
    connection === 'connecting' || connection === 'reconnecting' || connection === 'offline';
  const startGameDisabledReason =
    roomInteractionDisabledReason ||
    (room && connectedHumanPlayerCount < 2 ? 'Need at least two connected players to start.' : '');
  const leaveRoomDisabledReason =
    roomInteractionDisabledReason ||
    (room && localIsHost && room.players.length > 1 && connectedHumanPlayerCount < 2
      ? 'Remove disconnected seats or wait for another connected player before leaving.'
      : '');
  const roomScoringPhase = roomState?.phase === 'round-over' || roomState?.phase === 'game-over';
  const readyForNextRoundPlayerIds = room?.readyForNextRoundPlayerIds ?? [];
  const roundReadyPlayerIds = roomState?.players.map((player) => player.id) ?? [];
  const readyForNextRoundCount = roundReadyPlayerIds.filter((id) => readyForNextRoundPlayerIds.includes(id)).length;
  const allPlayersReadyForNextRound =
    roundReadyPlayerIds.length > 0 && readyForNextRoundCount === roundReadyPlayerIds.length;
  const localReadyForNextRound = readyForNextRoundPlayerIds.includes(playerId);
  const readySummary = roomScoringPhase ? `${readyForNextRoundCount}/${roundReadyPlayerIds.length} ready` : undefined;
  const summaryModalOpen = Boolean(roomScoringPhase && roundSummaryOpen);

  useEffect(() => {
    if (!hasActiveLifecycleCountdown) return;
    const timer = window.setInterval(() => setClientNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasActiveLifecycleCountdown]);

  useEffect(() => {
    if (!activePhoneLayout) setRoomOptionsOpen(false);
  }, [activePhoneLayout]);

  useGameAudio(
    roomState,
    room && playerId
      ? {
          delivery: roomAudioDelivery,
          localPlayerId: playerId,
          revision: room.revision,
          sessionId: room.code
        }
      : undefined
  );

  function chooseDiscardForRoom() {
    if (!roomState) return;
    sendCommand({ type: 'choose-discard' });
  }

  function cancelDiscardForRoom() {
    if (!roomState) return;
    sendCommand({ type: 'cancel-discard' });
  }

  function drawForRoom() {
    if (!roomState) return;
    sendCommand({ type: 'draw-blind' });
  }

  const roomChat = room ? (
    <Suspense fallback={null}>
      <RoomChat
        interactionDisabledReason={roomInteractionDisabledReason}
        isOpen={chatOpen}
        messages={chatMessages}
        onSend={sendChatMessage}
        onToggle={() => setChatOpen((current) => !current)}
        playerId={playerId}
        state={roomState}
        unreadCount={unreadChatCount}
        variant={activePhoneLayout ? 'dock' : 'panel'}
      />
    </Suspense>
  ) : null;

  if (accountLoading) return null;
  if (!accountUser) return <RequireAccountPanel next={`/lobby${location.search}`} title="Sign in to play multiplayer" />;

  return (
    <main
      className={`skyjo-surface px-4 py-8 ${activePhoneLayout ? 'skyjo-active-phone-surface' : ''} ${summaryModalOpen ? 'skyjo-round-summary-surface' : ''}`}
      data-testid="game-table"
    >
      <div className={`skyjo-shell ${roomState ? 'skyjo-active-mobile-shell' : ''} ${activePhoneLayout ? 'skyjo-active-phone-shell' : ''} ${summaryModalOpen ? 'skyjo-round-summary-mode' : ''} space-y-5`}>
        {roomScoringPhase && roomState && !roundSummaryOpen ? (
          <RoundSummaryRestoreButton meta={readySummary} state={roomState} onRestore={() => setRoundSummaryOpen(true)} />
        ) : null}

        {activePhoneLayout && room ? (
          <header className="skyjo-active-room-toolbar" data-connection-state={connection} data-testid="active-room-toolbar">
            <h1 className="sr-only">Flipvale multiplayer room {room.code}</h1>
            <Link aria-label="Back to home" className="skyjo-back-link" to="/">
              Back
            </Link>
            <div className="skyjo-active-room-identity">
              <strong aria-label={`Room code ${room.code}`}>{room.code}</strong>
              <span>
                {multiplayerConnectionCopy[connection].label}{pwaUpdate.available ? ' · Update ready' : ''}
              </span>
              <span aria-live="polite" className="sr-only" role="status">
                {pwaUpdate.available ? 'Flipvale update ready. This active game will not reload.' : ''}
              </span>
            </div>
            <button
              aria-label={`Share room ${room.code}`}
              className="skyjo-button skyjo-icon-button skyjo-toolbar-share"
              onClick={shareRoomLink}
              title="Share room"
              type="button"
            >
            </button>
            <button
              aria-controls="skyjo-room-options-dialog"
              aria-expanded={roomOptionsOpen}
              aria-haspopup="dialog"
              aria-label="Open room options"
              className="skyjo-button skyjo-icon-button skyjo-toolbar-more"
              onClick={() => setRoomOptionsOpen(true)}
              ref={roomOptionsTriggerRef}
              title="Room options"
              type="button"
            >
            </button>
            <Suspense fallback={<GameSettingsButtonPendingFallback state={roomState} />}>
              <GameSettingsButton state={roomState} />
            </Suspense>
            {shareStatus ? <span className="skyjo-active-share-status" role="status">{shareStatus}</span> : null}
          </header>
        ) : (
          <div className="skyjo-game-header flex flex-wrap items-start justify-between gap-3">
            <div className="skyjo-game-heading min-w-0">
              <Link aria-label="Back to home" className="skyjo-back-link text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/">
                Back
              </Link>
              <h1 className="skyjo-title skyjo-game-title mt-2 text-5xl">Multiplayer Lobby</h1>
              <p className="skyjo-game-subtitle mt-1 text-[#f5e6c8]/55">Create a private room and share the code with friends.</p>
            </div>
            <div className="skyjo-header-actions flex items-start justify-end gap-2">
              <Suspense fallback={<GameSettingsButtonPendingFallback state={roomState} />}>
                <GameSettingsButton state={roomState} />
              </Suspense>
            </div>
          </div>
        )}

        {!activePhoneLayout || connection !== 'connected' ? (
          <div className={activePhoneLayout ? 'skyjo-active-room-notice' : undefined}>
            <MultiplayerConnectionStatus roomActive={Boolean(room)} state={connection} />
          </div>
        ) : null}

        {room && (connection === 'error' || connection === 'idle') ? (
          <section className={`skyjo-panel flex flex-wrap items-center justify-between gap-3 p-4 ${activePhoneLayout ? 'skyjo-active-room-recovery' : ''}`} aria-label="Room recovery actions">
            <p className="text-sm font-bold text-[#f5e6c8]/72">Your last synchronized room is still visible and read-only.</p>
            <div className="flex flex-wrap gap-2">
              <button className="skyjo-button skyjo-button-primary px-4 py-2" onClick={retrySavedRoom} type="button">
                Retry Saved Seat
              </button>
              <button className="skyjo-button px-4 py-2" onClick={leaveSavedRoom} type="button">
                Leave Room
              </button>
            </div>
          </section>
        ) : null}

        {!room ? (
          <section className="skyjo-panel grid gap-4 p-5 md:grid-cols-[1fr_1fr_auto]">
            <div className="grid gap-2 text-sm font-semibold text-[#f5e6c8]/75">
              Signed in
              <div className="skyjo-input flex items-center px-3 py-2">{accountUser.displayName}</div>
            </div>
            <label className="grid gap-2 text-sm font-semibold text-[#f5e6c8]/75">
              Room code
              <input
                className="skyjo-input px-3 py-2 uppercase"
                onChange={(event) => setJoinCode(cleanRoomCode(event.target.value))}
                placeholder="ABCDE"
                value={joinCode}
              />
            </label>
            <div className="flex flex-wrap items-end gap-2">
              <button
                className="skyjo-button skyjo-button-primary px-4 py-2"
                disabled={connectionRequestDisabled}
                onClick={() => connect('create-room')}
                title={connectionRequestDisabled ? multiplayerConnectionCopy[connection].detail : 'Create a private room.'}
                type="button"
              >
                Create Room
              </button>
              <button
                className="skyjo-button px-4 py-2"
                disabled={connectionRequestDisabled}
                onClick={() => connect('join-room')}
                title={connectionRequestDisabled ? multiplayerConnectionCopy[connection].detail : 'Join the room code.'}
                type="button"
              >
                Join
              </button>
            </div>
          </section>
        ) : null}

        {error ? (
          <div
            aria-live="assertive"
            className={`rounded-xl border border-red-400/40 bg-red-950/70 px-4 py-3 text-red-100 ${activePhoneLayout ? 'skyjo-active-room-error' : ''}`}
            role="alert"
          >
            {error}
          </div>
        ) : null}

        {room ? (
          <div className="skyjo-active-room-grid grid gap-5">
            <section className="skyjo-room-primary-stack space-y-4">
              <Suspense fallback={null}>
                <ActiveRoomOptionsDialog
                  active={activePhoneLayout}
                  onDismiss={() => setRoomOptionsOpen(false)}
                  open={roomOptionsOpen}
                  roomCode={room.code}
                  triggerRef={roomOptionsTriggerRef}
                >
                <div className={`skyjo-panel skyjo-room-status-panel ${roomState ? 'skyjo-room-status-panel-active' : ''}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="skyjo-kicker">Room code</div>
                    <div className="skyjo-serif skyjo-room-code text-5xl font-black tracking-normal text-[#f5e6c8]">{room.code}</div>
                  </div>
                  <div className="skyjo-room-actions flex flex-wrap gap-2">
                    <button
                      className="skyjo-button px-4 py-2"
                      onClick={shareRoomLink}
                      title="Share or copy a join link for this room."
                      type="button"
                    >
                      Share
                    </button>
                    {localIsHost && room.status === 'waiting' ? (
                      <button
                        className="skyjo-button skyjo-button-primary px-4 py-2"
                        disabled={Boolean(startGameDisabledReason)}
                        onClick={startRoomGame}
                        title={startGameDisabledReason || 'Start the multiplayer game.'}
                        type="button"
                      >
                        Start Game
                      </button>
                    ) : null}
                    {room.status === 'waiting' && connection === 'connected' ? (
                      <button
                        className="skyjo-button min-h-11 px-4 py-2"
                        disabled={Boolean(leaveRoomDisabledReason)}
                        onClick={() => sendCommand({ type: 'leave-room' })}
                        title={leaveRoomDisabledReason || 'Leave this waiting room.'}
                        type="button"
                      >
                        Leave Room
                      </button>
                    ) : null}
                    {localIsHost ? (
                      <button
                        className="skyjo-button px-4 py-2"
                        disabled={Boolean(roomInteractionDisabledReason)}
                        onClick={() => {
                          if (!window.confirm('Reset this room for every player? The current game will be discarded.')) return;
                          sendCommand({ type: 'reset-room' });
                        }}
                        title={roomInteractionDisabledReason || 'Reset this room.'}
                        type="button"
                      >
                        Reset Room
                      </button>
                    ) : null}
                  </div>
                </div>
                {shareStatus ? <p className="skyjo-share-status mt-3 text-sm font-extrabold text-[#f5e6c8]/72" role="status">{shareStatus}</p> : null}
                {hostTransferCopy ? (
                  <p className="mt-3 text-sm font-bold text-amber-100" data-testid="host-transfer-status">
                    {hostTransferCopy}
                  </p>
                ) : null}
                <ul aria-label="Room players" className="skyjo-room-roster mt-4 grid gap-2">
                  {room.players.map((player) => {
                    const controller = player.controller || 'human';
                    const isHost = player.id === room.hostId;
                    const takeoverDeadline = player.aiTakeoverAt;
                    const takeoverEligible = Boolean(
                      localIsHost &&
                      room.status !== 'waiting' &&
                      !player.connected &&
                      controller === 'human' &&
                      Number.isFinite(takeoverDeadline) &&
                      Number(takeoverDeadline) <= estimatedServerNow
                    );
                    const reconnectCopy = !player.connected && controller === 'human' && Number.isFinite(takeoverDeadline)
                      ? Number(takeoverDeadline) > estimatedServerNow
                        ? `Reconnect window ${formatLifecycleCountdown(Number(takeoverDeadline), estimatedServerNow)}`
                        : 'Reconnect window ended'
                      : '';
                    return (
                      <li
                        className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-xl border border-[#f5e6c8]/15 bg-white/[0.025] px-3 py-2 text-sm text-[#f5e6c8]/75"
                        key={player.id}
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="font-bold">
                            {player.name} {isHost ? 'host ' : ''}{player.connected ? 'online' : 'away'}
                          </span>
                          <span className="rounded-full border border-[#f5e6c8]/15 px-2 py-0.5 text-xs font-extrabold">
                            {player.connected ? 'Connected' : 'Disconnected'}
                          </span>
                          <span className="rounded-full border border-[#f5e6c8]/15 px-2 py-0.5 text-xs font-extrabold">
                            {controller === 'ai' ? 'AI controlled' : 'Human controlled'}
                          </span>
                          {reconnectCopy ? (
                            <span className="text-xs font-bold text-amber-100" data-testid={`seat-countdown-${player.id}`}>
                              {reconnectCopy}
                            </span>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {localIsHost && room.status === 'waiting' && !isHost ? (
                            <button
                              aria-label={`Remove ${player.name} from room`}
                              className="skyjo-button min-h-11 px-3 py-2 text-xs"
                              disabled={Boolean(roomInteractionDisabledReason)}
                              onClick={() => sendCommand({ type: 'remove-player', playerId: player.id })}
                              title={roomInteractionDisabledReason || `Remove ${player.name} from this waiting room.`}
                              type="button"
                            >
                              Remove
                            </button>
                          ) : null}
                          {takeoverEligible ? (
                            <button
                              aria-label={`Hand ${player.name}'s seat to AI`}
                              className="skyjo-button min-h-11 px-3 py-2 text-xs"
                              disabled={Boolean(roomInteractionDisabledReason)}
                              onClick={() => sendCommand({ type: 'takeover-player-with-ai', playerId: player.id })}
                              title={roomInteractionDisabledReason || `Let AI continue ${player.name}'s unchanged seat.`}
                              type="button"
                            >
                              Hand to AI
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {localIsHost && startGameDisabledReason ? (
                  <p className="skyjo-disabled-note mt-3">
                    <span>Action unavailable:</span> {startGameDisabledReason}
                  </p>
                ) : null}
                </div>
                </ActiveRoomOptionsDialog>
              </Suspense>

              {roomState ? (
                <GameTableLayout
                  centerStartAccessory={activePhoneLayout ? roomChat : undefined}
                  containBoardScroll={activePhoneLayout}
                  drawIntent={drawIntent}
                  interactionDisabledReason={roomInteractionDisabledReason}
                  localPlayerId={playerId}
                  localTurn={localTurn}
                  onCancelDiscard={cancelDiscardForRoom}
                  onCardClick={handleCard}
                  onChooseDiscard={chooseDiscardForRoom}
                  onDraw={drawForRoom}
                  onSetDrawIntent={setDrawIntent}
                  state={roomState}
                />
              ) : (
                <div className="skyjo-panel p-6 text-[#f5e6c8]/70">
                  Waiting for players. The host can start once at least two people are connected.
                </div>
              )}
            </section>

            {roomState ? (
              <aside className={`skyjo-secondary-stack ${chatOpen ? 'skyjo-secondary-stack-chat-open' : ''} space-y-4`}>
                  {!activePhoneLayout ? roomChat : null}
                  {roomScoringPhase && roundSummaryOpen ? (
                    <Suspense fallback={null}>
                      <RoundSummary
                      actionDisabledReason={
                        roomInteractionDisabledReason ||
                        (localIsHost
                          ? allPlayersReadyForNextRound
                            ? undefined
                            : `Waiting for ${roundReadyPlayerIds.length - readyForNextRoundCount} player${
                                roundReadyPlayerIds.length - readyForNextRoundCount === 1 ? '' : 's'
                              } to confirm.`
                          : roomState.phase === 'game-over'
                            ? 'Only the host can restart the game.'
                            : 'Only the host can start the next round.')
                      }
                      actionLabel={roomState.phase === 'game-over' ? 'Restart Game' : 'Next Round'}
                      onMinimize={() => setRoundSummaryOpen(false)}
                      onAction={localIsHost ? handleNextRound : undefined}
                      restoreFocusFallback={() => document.querySelector<HTMLElement>('[aria-label="Action guidance"]')}
                      state={roomState}
                    >
                      <div className="skyjo-ready-panel mt-4">
                        <div className="min-w-0">
                          <div className="skyjo-kicker">Ready check</div>
                          <div className="text-sm font-extrabold text-[#f5e6c8]">{readySummary}</div>
                          <p className="mt-1 text-xs leading-5 text-[#f5e6c8]/58">
                            Review the finished board and chat it through. The host can advance after everyone confirms.
                          </p>
                        </div>
                        <button
                          className={`skyjo-button ${localReadyForNextRound ? 'skyjo-button-primary' : ''} px-3 py-2 text-sm`}
                          disabled={Boolean(roomInteractionDisabledReason)}
                          onClick={toggleNextRoundReady}
                          title={roomInteractionDisabledReason || (localReadyForNextRound ? 'Mark not ready.' : 'Mark ready.')}
                          type="button"
                        >
                          {localReadyForNextRound ? 'Ready' : "I'm Ready"}
                        </button>
                      </div>
                      </RoundSummary>
                    </Suspense>
                  ) : null}
              </aside>
            ) : (
              <aside className="skyjo-secondary-stack space-y-4">
                <section className="skyjo-panel skyjo-waiting-note-panel text-sm text-[#f5e6c8]/70">Keep this tab open while friends join.</section>
                {roomChat}
              </aside>
            )}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function App() {
  useAudioSettings();

  return (
    <Router>
      <AccountProvider>
        <PwaUpdateBanner />
        <Routes>
          <Route element={<Suspense fallback={<RouteLoadFallback />}><Home /></Suspense>} path="/" />
          <Route element={<Suspense fallback={<RouteLoadFallback />}><AccountPage /></Suspense>} path="/account" />
          <Route element={<Suspense fallback={<RouteLoadFallback />}><PrivacyPolicyPage /></Suspense>} path="/privacy" />
          <Route element={<Suspense fallback={<RouteLoadFallback />}><SupportPage /></Suspense>} path="/support" />
          <Route element={<StatsPage />} path="/stats" />
          <Route element={<GameDetailPage />} path="/stats/games/:gameId" />
          <Route element={<PlayerStatsPage />} path="/stats/players/:playerId" />
          <Route element={<AdminPage />} path="/admin" />
          <Route element={<SinglePlayer />} path="/single-player" />
          <Route element={<Lobby />} path="/lobby" />
        </Routes>
      </AccountProvider>
    </Router>
  );
}

function PwaUpdateBanner() {
  const location = useLocation();
  const update = useSyncExternalStore(subscribeToPwaUpdates, getPwaUpdateSnapshot, getPwaUpdateSnapshot);
  if (!update.available) return null;
  const deferred = isPwaUpdateDeferredPath(location.pathname);
  return (
    <aside aria-atomic aria-live="polite" className="skyjo-update-banner" data-deferred={deferred ? 'true' : 'false'} data-testid="pwa-update-banner">
      <div>
        <strong>Update ready</strong>
        <span>{deferred ? ' After this game.' : update.reloadRequired ? ' Reload once.' : ' Apply.'}</span>
      </div>
      {deferred ? (
        <span className="skyjo-update-deferred">Game protected</span>
      ) : (
        <button
          className="skyjo-button skyjo-button-primary"
          disabled={update.activating}
          onClick={() => activatePwaUpdate()}
          type="button"
        >
          {update.activating ? 'Updating...' : update.reloadRequired ? 'Reload now' : 'Update now'}
        </button>
      )}
    </aside>
  );
}

export default App;
