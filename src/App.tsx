import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BrowserRouter as Router, Routes, Route, Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  cancelDiscardSelection,
  chooseDiscard,
  discardDrawnAndReveal,
  drawBlind,
  getBestAiMove,
  replaceCard,
  revealOpeningCard,
  singlePlayerAiOpponentRange,
  startFreshGame,
  startNextRound
} from './game';
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
import { playAudioCue, playAudioTestCue, primeAudio, useAudioSettings, useGameAudio, type AudioSettings } from './audio';
import { disablePushNotifications, enablePushNotifications, loadPushNotificationStatus, type PushUiStatus } from './push';
import {
  createRoomConnection,
  type RoomConnectionController,
  type RoomConnectionFrame,
  type RoomConnectionSocket,
  type RoomConnectionState
} from './roomConnection';
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
import type { Card, GameState, MultiplayerRoom, Player, RoomChatMessage } from './types';

const rows = [0, 1, 2];
const columns = [0, 1, 2, 3];
const singlePlayerAiCounts = Array.from(
  { length: singlePlayerAiOpponentRange.max - singlePlayerAiOpponentRange.min + 1 },
  (_, index) => singlePlayerAiOpponentRange.min + index
);
type DrawIntent = 'place' | 'discard';
type TurnStatusTone = 'local' | 'waiting' | 'neutral';
type BoardGridEntry = {
  player: Player;
  isLocal: boolean;
};
type RulesHelpSection = {
  title: string;
  items: string[];
};
type TurnStatus = {
  eyebrow: string;
  title: string;
  description: string;
  tone: TurnStatusTone;
};

const responsiveBoardGridClass = 'grid gap-4';
const opponentBoardGridClass = 'skyjo-opponent-stack grid gap-4 xl:grid-cols-2';
const fourPlayerDesktopBoardGridClass = 'skyjo-four-player-board-grid hidden gap-4 md:grid md:grid-cols-2';
const fourPlayerMobileOpponentGridClass = 'skyjo-opponent-stack grid gap-3 md:hidden';
const currentPlayerScrollPauseMs = 1800;
const rulesHelpSections: RulesHelpSection[] = [
  {
    title: 'Starting a round',
    items: [
      'Everyone gets 12 face-down cards and chooses two opening cards to reveal.',
      'For the first round, the highest shown opening-card sum starts.',
      'After later rounds, the player who ended the previous round starts once opening cards are revealed.'
    ]
  },
  {
    title: 'Taking a turn',
    items: [
      'Take the top discard if you want that card, or draw blind from the deck.',
      'If you draw blind, either place it on your board or discard it and reveal one hidden card.'
    ]
  },
  {
    title: 'Clearing columns',
    items: ['Three matching values in one column clear that column. Cleared cards stop counting against you.']
  },
  {
    title: 'Ending and scoring',
    items: [
      'When someone reveals their last card, everyone else gets one final turn.',
      "If the closer's positive round score is not strictly lowest, that score doubles.",
      'The game ends when someone reaches 100 or more total points. Lowest total wins.'
    ]
  }
];

function opponentBoardClass(entryCount: number, mobileOnly = false) {
  const baseClass = mobileOnly ? fourPlayerMobileOpponentGridClass : opponentBoardGridClass;
  if (entryCount < 2) return baseClass;
  return `${baseClass} skyjo-opponent-stack-multi ${entryCount % 2 === 1 ? 'skyjo-opponent-stack-odd' : ''}`.trim();
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

function accountPath(next?: string) {
  return next ? `/account?next=${encodeURIComponent(next)}` : '/account';
}

function AccountLinks() {
  const { loading, user } = useAccount();
  if (loading) return null;
  return (
    <div className="skyjo-home-account-links mt-6 flex flex-wrap items-center gap-2 text-sm font-bold">
      {user ? (
        <>
          <span className="text-[#f5e6c8]/64">Signed in as {user.displayName}</span>
          <Link className="skyjo-button px-3 py-2" to="/stats">
            Stats
          </Link>
          <Link className="skyjo-button px-3 py-2" to="/account">
            Account
          </Link>
          {user.role === 'admin' ? (
            <Link className="skyjo-button px-3 py-2" to="/admin">
              Admin
            </Link>
          ) : null}
        </>
      ) : (
        <>
          <span className="text-[#f5e6c8]/64">Sign in to save stats and play multiplayer.</span>
          <Link className="skyjo-button px-3 py-2" to="/account">
            Account
          </Link>
        </>
      )}
    </div>
  );
}

function RequireAccountPanel({ next, title = 'Sign in to continue' }: { next: string; title?: string }) {
  return (
    <main className="skyjo-surface px-4 py-8">
      <section className="skyjo-shell mx-auto flex min-h-[70vh] max-w-2xl items-center">
        <div className="skyjo-panel w-full p-6">
          <p className="skyjo-kicker">Account required</p>
          <h1 className="skyjo-serif mt-2 text-3xl font-black text-[#f5e6c8]">{title}</h1>
          <p className="mt-3 leading-7 text-[#f5e6c8]/68">Single-player is open for casual play, but multiplayer and saved stats need a Skyjo account.</p>
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

function GearIcon() {
  return (
    <svg aria-hidden="true" className="skyjo-icon" focusable="false" viewBox="0 0 24 24">
      <path d="M12 15.25A3.25 3.25 0 1 0 12 8.75a3.25 3.25 0 0 0 0 6.5Z" />
      <path d="M18.45 13.45c.08-.47.08-.93 0-1.4l2.02-1.57-1.92-3.32-2.38.95a7.03 7.03 0 0 0-1.22-.7L14.6 4.85h-3.84l-.36 2.56c-.43.18-.84.41-1.22.7l-2.38-.95-1.92 3.32 2.02 1.57a7.2 7.2 0 0 0 0 1.4l-2.02 1.57 1.92 3.32 2.38-.95c.38.29.79.52 1.22.7l.36 2.56h3.84l.35-2.56c.44-.18.85-.41 1.22-.7l2.38.95 1.92-3.32-2.02-1.57Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" className="skyjo-icon" focusable="false" viewBox="0 0 24 24">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function AudioSettingsControls() {
  const [settings, setSettings, audioStatus] = useAudioSettings();
  const audioStatusMessage =
    audioStatus === 'ready'
      ? 'Audio is ready.'
      : audioStatus === 'blocked'
        ? 'Audio is blocked. Tap Test sound or interact with the page to unlock it.'
        : audioStatus === 'unavailable'
          ? 'This browser cannot play audio assets.'
          : 'Tap Test sound to enable audio.';

  function updateVolume(key: keyof Pick<AudioSettings, 'ambienceVolume' | 'soundVolume'>, value: string) {
    const volume = Number(value) / 100;
    if (key === 'ambienceVolume') {
      setSettings({ ambienceVolume: volume });
      return;
    }
    setSettings({ soundVolume: volume });
  }

  return (
    <div className="skyjo-audio-controls" onPointerDown={() => void primeAudio()}>
      <div className="skyjo-audio-settings-grid">
        <label className="skyjo-audio-setting-row">
          <span>
            <span className="skyjo-audio-setting-title">Sound effects</span>
          </span>
          <input
            checked={settings.soundEffects}
            className="skyjo-audio-toggle"
            onChange={(event) => setSettings({ soundEffects: event.target.checked })}
            type="checkbox"
          />
        </label>
        <label className="skyjo-audio-setting-slider">
          <span>Effects volume</span>
          <input
            className="skyjo-audio-range"
            disabled={!settings.soundEffects}
            max="100"
            min="0"
            onChange={(event) => updateVolume('soundVolume', event.target.value)}
            type="range"
            value={Math.round(settings.soundVolume * 100)}
          />
        </label>
        <label className="skyjo-audio-setting-row">
          <span>
            <span className="skyjo-audio-setting-title">Ambience</span>
            <span className="block text-xs font-bold text-[#f5e6c8]/50">Quiet room tone</span>
          </span>
          <input
            checked={settings.ambience}
            className="skyjo-audio-toggle"
            onChange={(event) => setSettings({ ambience: event.target.checked })}
            type="checkbox"
          />
        </label>
        <label className="skyjo-audio-setting-slider">
          <span>Ambience volume</span>
          <input
            className="skyjo-audio-range"
            disabled={!settings.ambience}
            max="100"
            min="0"
            onChange={(event) => updateVolume('ambienceVolume', event.target.value)}
            type="range"
            value={Math.round(settings.ambienceVolume * 100)}
          />
        </label>
      </div>
      <button
        className="skyjo-button skyjo-audio-test-button px-3 py-2 text-sm"
        disabled={!settings.soundEffects}
        onClick={() => void playAudioTestCue()}
        onPointerDown={() => void primeAudio()}
        type="button"
      >
        Test sound
      </button>
      <p className="skyjo-audio-status text-xs font-bold leading-5 text-[#f5e6c8]/58">{audioStatusMessage}</p>
    </div>
  );
}

function AudioSettingsPanel() {
  return (
    <section aria-labelledby="skyjo-audio-settings-title" className="skyjo-panel skyjo-home-audio-panel mt-7">
      <div>
        <p className="skyjo-kicker">Settings</p>
        <h2 className="skyjo-serif mt-1 text-2xl font-bold text-[#f5e6c8]" id="skyjo-audio-settings-title">
          Audio
        </h2>
      </div>
      <div className="mt-4">
        <AudioSettingsControls />
      </div>
    </section>
  );
}

function PushSettingsControls() {
  const [status, setStatus] = useState<PushUiStatus>('checking');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    loadPushNotificationStatus()
      .then(setStatus)
      .catch(() => setStatus('error'));
  }, []);

  const enabled = status === 'subscribed';
  const statusText =
    status === 'subscribed'
      ? 'Enabled'
      : status === 'denied'
        ? 'Blocked'
        : status === 'unsupported'
          ? 'Unavailable'
          : status === 'unconfigured'
            ? 'Not configured'
            : status === 'error'
              ? 'Could not check'
              : 'Off';

  async function handleToggle() {
    setBusy(true);
    setMessage('');
    try {
      if (enabled) {
        await disablePushNotifications();
        setStatus('prompt');
        setMessage('Notifications disabled.');
      } else {
        await enablePushNotifications();
        setStatus('subscribed');
        setMessage('Notifications enabled.');
      }
    } catch (requestError) {
      setStatus(status === 'checking' ? 'error' : status);
      setMessage(requestError instanceof Error ? requestError.message : 'Notification request failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="skyjo-account-card">
      <div>
        <div className="skyjo-kicker">Notifications</div>
        <div className="text-xl font-black text-[#f5e6c8]">Turn alerts</div>
        <div className="text-sm font-bold text-[#f5e6c8]/58">{statusText}</div>
      </div>
      <div className="flex flex-col items-start gap-2 sm:items-end">
        <button
          className={`skyjo-button px-3 py-2 ${enabled ? '' : 'skyjo-button-primary'}`}
          disabled={busy || status === 'checking' || status === 'unsupported' || status === 'unconfigured' || status === 'denied'}
          onClick={handleToggle}
          type="button"
        >
          {enabled ? 'Disable' : 'Enable'}
        </button>
        {message ? <div className="text-xs font-bold text-[#f5e6c8]/58">{message}</div> : null}
      </div>
    </div>
  );
}

function Home() {
  return (
    <main className="skyjo-surface">
      <section className="skyjo-shell flex min-h-screen flex-col justify-center px-5 py-10">
        <div className="max-w-2xl">
          <p className="skyjo-kicker mb-3">Private game table</p>
          <h1 className="skyjo-title text-7xl sm:text-9xl">Skyjo</h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-[#f5e6c8]/70">
            Play solo against the house AI or create a private room for friends at the multiplayer table.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link className="skyjo-button skyjo-button-primary px-5 py-3" to="/single-player">
              Single Player
            </Link>
            <Link className="skyjo-button px-5 py-3" to="/lobby">
              Multiplayer Lobby
            </Link>
          </div>
          <AccountLinks />
          <AudioSettingsPanel />
        </div>
      </section>
    </main>
  );
}

function AccountPage() {
  const account = useAccount();
  const location = useLocation();
  const navigate = useNavigate();
  const next = new URLSearchParams(location.search).get('next') || '/';
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [profileDisplayName, setProfileDisplayName] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (account.user) setProfileDisplayName(account.user.displayName);
  }, [account.user]);

  async function handleAuth(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (mode === 'login') await account.login(email, password);
      else await account.signup(email, displayName, password, confirmPassword);
      navigate(next.startsWith('/') ? next : '/');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Account request failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handlePasswordChange(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await account.changePassword(currentPassword, password, confirmPassword);
      setCurrentPassword('');
      setPassword('');
      setConfirmPassword('');
      setMessage('Password changed. Sign in again with the new password.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Password change failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleProfileUpdate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await account.updateProfile(profileDisplayName);
      setMessage('Display name updated.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Profile update failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    setBusy(true);
    setError('');
    try {
      await account.logout();
      navigate('/');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Logout failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="skyjo-surface px-4 py-8">
      <section className="skyjo-shell mx-auto max-w-3xl space-y-5">
        <Link className="skyjo-back-link text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/">
          Back
        </Link>
        <div className="skyjo-panel p-5">
          <p className="skyjo-kicker">Skyjo account</p>
          <h1 className="skyjo-serif mt-2 text-4xl font-black text-[#f5e6c8]">{account.user ? 'Account' : mode === 'login' ? 'Sign In' : 'Create Account'}</h1>
          {account.user ? (
            <div className="mt-5 space-y-4">
              <div className="skyjo-account-card">
                <div>
                  <div className="skyjo-kicker">Signed in</div>
                  <div className="text-xl font-black text-[#f5e6c8]">{account.user.displayName}</div>
                  <div className="text-sm text-[#f5e6c8]/58">{account.user.email}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link className="skyjo-button px-3 py-2" to="/stats">
                    Stats
                  </Link>
                  {account.user.role === 'admin' ? (
                    <Link className="skyjo-button px-3 py-2" to="/admin">
                      Admin
                    </Link>
                  ) : null}
                  <button className="skyjo-button px-3 py-2" disabled={busy} onClick={handleLogout} type="button">
                    Logout
                  </button>
                </div>
              </div>
              <form className="skyjo-account-form" onSubmit={handleProfileUpdate}>
                <label>
                  Display name
                  <input
                    className="skyjo-input px-3 py-2"
                    maxLength={24}
                    onChange={(event) => setProfileDisplayName(event.target.value)}
                    value={profileDisplayName}
                  />
                </label>
                <button
                  className="skyjo-button skyjo-button-primary px-4 py-2"
                  disabled={busy || profileDisplayName.trim() === account.user.displayName}
                  type="submit"
                >
                  Save Display Name
                </button>
              </form>
              <PushSettingsControls />
              <form className="skyjo-account-form" onSubmit={handlePasswordChange}>
                <label>
                  Current password
                  <input className="skyjo-input px-3 py-2" onChange={(event) => setCurrentPassword(event.target.value)} type="password" value={currentPassword} />
                </label>
                <label>
                  New password
                  <input className="skyjo-input px-3 py-2" onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
                </label>
                <label>
                  Confirm new password
                  <input className="skyjo-input px-3 py-2" onChange={(event) => setConfirmPassword(event.target.value)} type="password" value={confirmPassword} />
                </label>
                <button className="skyjo-button skyjo-button-primary px-4 py-2" disabled={busy} type="submit">
                  Change Password
                </button>
              </form>
            </div>
          ) : (
            <form className="skyjo-account-form mt-5" onSubmit={handleAuth}>
              <label>
                Email
                <input className="skyjo-input px-3 py-2" onChange={(event) => setEmail(event.target.value)} type="email" value={email} />
              </label>
              {mode === 'signup' ? (
                <label>
                  Display name
                  <input className="skyjo-input px-3 py-2" onChange={(event) => setDisplayName(event.target.value)} value={displayName} />
                </label>
              ) : null}
              <label>
                Password
                <input className="skyjo-input px-3 py-2" onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
              </label>
              {mode === 'signup' ? (
                <label>
                  Confirm password
                  <input className="skyjo-input px-3 py-2" onChange={(event) => setConfirmPassword(event.target.value)} type="password" value={confirmPassword} />
                </label>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button className="skyjo-button skyjo-button-primary px-4 py-2" disabled={busy} type="submit">
                  {mode === 'login' ? 'Sign In' : 'Create Account'}
                </button>
                <button className="skyjo-button px-4 py-2" disabled={busy} onClick={() => setMode(mode === 'login' ? 'signup' : 'login')} type="button">
                  {mode === 'login' ? 'Create Account' : 'Use Sign In'}
                </button>
              </div>
            </form>
          )}
          {message ? <div className="skyjo-success-note mt-4">{message}</div> : null}
          {error ? <div className="skyjo-error-note mt-4">{error}</div> : null}
        </div>
      </section>
    </main>
  );
}

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

type GameSettingsButtonProps = {
  aiOpponentCount?: number;
  aiOpponentSummary?: string;
  onAiOpponentCountChange?: (count: number) => void;
  onNewGame?: () => void;
  state?: GameState | null;
};
type GameSettingsPanel = 'audio' | 'game' | 'rules' | 'log';

function GameSettingsButton({
  aiOpponentCount,
  aiOpponentSummary,
  onAiOpponentCountChange,
  onNewGame,
  state
}: GameSettingsButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<GameSettingsPanel>('audio');
  const dialogRef = useRef<HTMLElement | null>(null);
  const hasAiSettings = typeof aiOpponentCount === 'number' && Boolean(aiOpponentSummary && onAiOpponentCountChange && onNewGame);
  const hasMoveLog = Boolean(state);
  const settingsPanels = useMemo(
    () => [
      { key: 'audio' as const, label: 'Audio' },
      ...(hasAiSettings ? [{ key: 'game' as const, label: 'Game' }] : []),
      { key: 'rules' as const, label: 'Rules' },
      ...(hasMoveLog ? [{ key: 'log' as const, label: 'Log' }] : [])
    ],
    [hasAiSettings, hasMoveLog]
  );

  useEffect(() => {
    if (!isOpen) return undefined;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsOpen(false);
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    window.setTimeout(() => dialogRef.current?.focus({ preventScroll: true }), 0);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (!settingsPanels.some((panel) => panel.key === activePanel)) setActivePanel('audio');
  }, [activePanel, isOpen, settingsPanels]);

  return (
    <>
      <button
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label="Open game settings"
        className="skyjo-button skyjo-icon-button"
        onClick={() => setIsOpen(true)}
        title="Game settings"
        type="button"
      >
        <GearIcon />
      </button>

      {isOpen
        ? createPortal(
            <div
              className="skyjo-settings-overlay fixed inset-0 flex items-end justify-center bg-black/70 px-3 py-4 backdrop-blur-sm sm:items-center sm:px-5"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setIsOpen(false);
              }}
            >
              <section
                aria-describedby="skyjo-game-settings-intro"
                aria-labelledby="skyjo-game-settings-title"
                aria-modal="true"
                className="skyjo-panel skyjo-settings-dialog w-full max-w-3xl overflow-hidden rounded-2xl bg-[#09110e]/95 shadow-2xl"
                ref={dialogRef}
                role="dialog"
                tabIndex={-1}
              >
                <div className="skyjo-settings-dialog-header flex items-start justify-between gap-3 border-b border-[#f5e6c8]/10 p-4 sm:p-5">
                  <div className="min-w-0">
                    <p className="skyjo-kicker">Game</p>
                    <h2 className="skyjo-serif mt-1 text-2xl font-black leading-tight text-[#f5e6c8] sm:text-3xl" id="skyjo-game-settings-title">
                      Settings
                    </h2>
                    <p className="skyjo-settings-intro mt-2 text-sm leading-6" id="skyjo-game-settings-intro">
                      Audio, table options, rules, and the move log.
                    </p>
                  </div>
                  <button
                    aria-label="Close game settings"
                    className="skyjo-button skyjo-icon-button shrink-0"
                    onClick={() => setIsOpen(false)}
                    type="button"
                  >
                    <CloseIcon />
                  </button>
                </div>

                <div className="skyjo-settings-body overflow-y-auto p-4 sm:p-5">
                  <div className={`skyjo-settings-tabs skyjo-settings-tabs-${settingsPanels.length}`} role="tablist" aria-label="Settings sections">
                    {settingsPanels.map((panel) => (
                      <button
                        aria-controls={`skyjo-settings-panel-${panel.key}`}
                        aria-selected={activePanel === panel.key}
                        className={`skyjo-settings-tab ${activePanel === panel.key ? 'skyjo-settings-tab-active' : ''}`}
                        id={`skyjo-settings-tab-${panel.key}`}
                        key={panel.key}
                        onClick={() => setActivePanel(panel.key)}
                        role="tab"
                        type="button"
                      >
                        {panel.label}
                      </button>
                    ))}
                  </div>

                  <div
                    aria-labelledby={`skyjo-settings-tab-${activePanel}`}
                    className="skyjo-settings-panel"
                    id={`skyjo-settings-panel-${activePanel}`}
                    role="tabpanel"
                  >
                    {activePanel === 'audio' ? (
                      <section className="skyjo-settings-section">
                        <div className="skyjo-settings-section-heading">
                          <p className="skyjo-kicker">Audio</p>
                          <h3 className="skyjo-serif text-xl font-bold leading-tight text-[#f5e6c8]">Sound</h3>
                        </div>
                        <AudioSettingsControls />
                      </section>
                    ) : null}

                    {activePanel === 'game' && hasAiSettings ? (
                      <section className="skyjo-settings-section">
                        <div className="skyjo-settings-section-heading">
                          <p className="skyjo-kicker">Single player</p>
                          <h3 className="skyjo-serif text-xl font-bold leading-tight text-[#f5e6c8]">AI opponents</h3>
                        </div>
                        <div className="skyjo-settings-ai-toolbar">
                          <div className="text-sm font-bold text-[#f5e6c8]/75">{aiOpponentSummary}</div>
                          <button className="skyjo-button skyjo-new-game-button text-sm" onClick={onNewGame} type="button">
                            New Game
                          </button>
                        </div>
                        <div className="skyjo-settings-ai-grid mt-3" role="group" aria-label="Choose AI opponent count">
                          {singlePlayerAiCounts.map((count) => (
                            <button
                              aria-pressed={count === aiOpponentCount}
                              className={`skyjo-button h-9 min-w-0 px-0 text-sm tabular-nums ${count === aiOpponentCount ? 'skyjo-button-primary' : ''}`}
                              key={count}
                              onClick={() => onAiOpponentCountChange?.(count)}
                              type="button"
                            >
                              {count}
                            </button>
                          ))}
                        </div>
                      </section>
                    ) : null}

                    {activePanel === 'rules' ? (
                      <section className="skyjo-settings-section">
                        <div className="skyjo-settings-section-heading">
                          <p className="skyjo-kicker">Help</p>
                          <h3 className="skyjo-serif text-xl font-bold leading-tight text-[#f5e6c8]">Rules</h3>
                        </div>
                        <div className="skyjo-settings-rules-list">
                          {rulesHelpSections.map((section) => (
                            <section className="skyjo-rule-card rounded-xl border p-3" key={section.title}>
                              <h4 className="skyjo-serif text-base font-bold leading-tight text-[#f5e6c8]">{section.title}</h4>
                              <ul className="skyjo-rule-list mt-2 list-disc space-y-1.5 pl-5 text-sm leading-6">
                                {section.items.map((item) => (
                                  <li className="break-words" key={item}>
                                    {item}
                                  </li>
                                ))}
                              </ul>
                            </section>
                          ))}
                        </div>
                      </section>
                    ) : null}

                    {activePanel === 'log' && state ? (
                      <section className="skyjo-settings-section">
                        <div className="skyjo-settings-section-heading">
                          <p className="skyjo-kicker">Table</p>
                          <h3 className="skyjo-serif text-xl font-bold leading-tight text-[#f5e6c8]">Move Log</h3>
                        </div>
                        <MoveLogList state={state} />
                      </section>
                    ) : null}
                  </div>
                </div>

                <div className="skyjo-settings-footer border-t border-[#f5e6c8]/10 p-4 sm:p-5">
                  <button className="skyjo-button skyjo-button-primary w-full px-4 py-2 text-sm sm:w-auto" onClick={() => setIsOpen(false)} type="button">
                    Done
                  </button>
                </div>
              </section>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function cardLabel(card: Card) {
  if (card.removed) return '';
  if (card.faceUp) return card.value < 0 ? `-${Math.abs(card.value)}` : String(card.value);
  return 'SKYJO';
}

function cardClass(card: Card, isSelectable: boolean) {
  const base = `skyjo-card ${isSelectable ? 'skyjo-card-selectable cursor-pointer' : 'cursor-default'}`;
  if (card.removed) return `${base} skyjo-card-removed`;
  if (!card.faceUp) return `${base} skyjo-card-hidden`;
  if (card.value === -2) return `${base} skyjo-card-blue-dark`;
  if (card.value === -1) return `${base} skyjo-card-blue`;
  if (card.value === 0) return `${base} skyjo-card-cyan`;
  if (card.value <= 4) return `${base} skyjo-card-green`;
  if (card.value <= 8) return `${base} skyjo-card-gold`;
  return `${base} skyjo-card-red`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function hiddenCardCount(player: Player) {
  return player.grid.filter((card) => !card.faceUp && !card.removed).length;
}

function knownCardCount(player: Player) {
  return player.grid.filter((card) => card.faceUp || card.removed).length;
}

function openingRevealCount(state: GameState, player: Player) {
  return Math.min(state.openingRevealCounts[player.id] ?? 0, 2);
}

function getTurnStatus(state: GameState, localTurn: boolean): TurnStatus {
  const activePlayer = state.players[state.currentPlayerIndex];
  const activeName = activePlayer?.name || 'Current player';

  if (state.phase === 'round-over') {
    return {
      eyebrow: 'Round over',
      title: 'Round scoring is complete',
      description: 'Check the round score and total score, then start the next round when ready.',
      tone: 'neutral'
    };
  }

  if (state.phase === 'game-over') {
    return {
      eyebrow: 'Game over',
      title: 'Final totals are in',
      description: 'The lowest total score wins the game.',
      tone: 'neutral'
    };
  }

  if (state.phase === 'opening-reveal') {
    const remaining = Math.max(0, 2 - openingRevealCount(state, activePlayer));
    return localTurn
      ? {
          eyebrow: 'Your move',
          title: 'Choose two face-down cards',
          description: `${pluralize(remaining, 'opening card')} left. Each player reveals exactly two cards before the round starts.`,
          tone: 'local'
        }
      : {
          eyebrow: 'Waiting',
          title: `Waiting on ${activeName}`,
          description: `${activeName} is choosing two face-down cards. Each player reveals exactly two cards before the round starts.`,
          tone: 'waiting'
        };
  }

  if (state.phase === 'choose-source') {
    return localTurn
      ? {
          eyebrow: 'Your turn',
          title: 'Choose a source',
          description: 'Take the visible discard card or draw blind from the deck.',
          tone: 'local'
        }
      : {
          eyebrow: 'Waiting',
          title: `Waiting on ${activeName}`,
          description: `${activeName} is choosing the discard pile or the deck.`,
          tone: 'waiting'
        };
  }

  if (state.selectedSource === 'draw' && state.drawnCard) {
    return localTurn
      ? {
          eyebrow: 'Your turn',
          title: 'Drawn card waiting',
          description: 'Place the drawn card on your board, or discard it and reveal one hidden card.',
          tone: 'local'
        }
      : {
          eyebrow: 'Waiting',
          title: `Waiting on ${activeName}`,
          description: `${activeName} must place the drawn card or discard it and reveal a hidden card.`,
          tone: 'waiting'
        };
  }

  return localTurn
    ? {
        eyebrow: 'Your turn',
        title: 'Place the discard card',
        description: 'Select any highlighted card to replace, or tap discard again to put it back.',
        tone: 'local'
      }
    : {
        eyebrow: 'Waiting',
        title: `Waiting on ${activeName}`,
        description: `${activeName} is choosing which board card to replace.`,
        tone: 'waiting'
      };
}

function sourceDisabledReason(state: GameState, localTurn: boolean, source: 'deck' | 'discard') {
  const activePlayer = state.players[state.currentPlayerIndex];

  if (state.phase === 'opening-reveal') return 'Opening reveals must finish before the piles are available.';
  if (state.phase === 'round-over') return 'Round scoring is complete.';
  if (state.phase === 'game-over') return 'Game is complete.';
  if (state.phase === 'choose-replacement') {
    return state.selectedSource === 'draw' && state.drawnCard
      ? 'Choose whether to place the drawn card or discard it first.'
      : 'Select a highlighted board card to finish this move.';
  }
  if (!localTurn) return `Waiting for ${activePlayer?.name || 'the current player'}.`;
  if (source === 'discard' && !state.discardPile[0]) return 'The discard pile is empty.';
  return '';
}

function cardAffordanceLabel({
  card,
  canSelectOpening,
  canSelectReplacement,
  drawIntent,
  index,
  isCurrent,
  isLocal,
  player,
  selectable,
  state
}: {
  card: Card;
  canSelectOpening: boolean;
  canSelectReplacement: boolean;
  drawIntent: DrawIntent;
  index: number;
  isCurrent: boolean;
  isLocal: boolean;
  player: Player;
  selectable: boolean;
  state: GameState;
}) {
  if (card.removed) return `Cleared slot ${index + 1} on ${player.name}'s board.`;
  if (selectable && canSelectOpening) return `Reveal opening card ${index + 1}.`;
  if (selectable && state.selectedSource === 'discard') return `Replace card ${index + 1} with the discard card.`;
  if (selectable && drawIntent === 'discard') return `Reveal hidden card ${index + 1} after discarding the drawn card.`;
  if (selectable) return `Replace card ${index + 1} with the drawn card.`;
  if (!isLocal) return `${player.name}'s card is not on your board.`;
  if (!isCurrent) return 'Waiting for your turn.';
  if (canSelectOpening && card.faceUp) return 'Already revealed. Choose a face-down card.';
  if (canSelectReplacement && drawIntent === 'discard' && card.faceUp) return 'Choose a hidden card to reveal after discarding.';
  if (state.phase === 'choose-source') return 'Choose the deck or discard pile first.';
  return 'This card is not selectable right now.';
}

interface GridProps {
  player: Player;
  isCurrent: boolean;
  isLocal: boolean;
  state: GameState;
  drawIntent?: DrawIntent;
  interactionDisabledReason?: string;
  onCardClick?: (index: number) => void;
}

function PlayerGrid({
  player,
  isCurrent,
  isLocal,
  state,
  drawIntent = 'place',
  interactionDisabledReason,
  onCardClick
}: GridProps) {
  const canSelectOpening =
    isLocal &&
    isCurrent &&
    state.phase === 'opening-reveal' &&
    (state.openingRevealCounts[player.id] ?? 0) < 2;
  const canSelectReplacement =
    isLocal &&
    isCurrent &&
    state.phase === 'choose-replacement' &&
    (state.selectedSource === 'discard' || state.selectedSource === 'draw');
  const selectionMode = !interactionDisabledReason && (canSelectOpening || canSelectReplacement);
  const playerRole = player.kind === 'ai' ? 'AI opponent' : isLocal ? 'You' : 'Player';
  const playerStatus = isCurrent ? (isLocal ? 'Your move now' : 'Current turn') : isLocal ? 'Waiting for your turn' : 'Waiting';
  const openingRemaining = Math.max(0, 2 - openingRevealCount(state, player));
  const knownCards = knownCardCount(player);

  return (
    <section
      className={`skyjo-panel skyjo-player-grid ${
        isLocal ? 'skyjo-player-grid-local' : 'skyjo-player-grid-opponent'
      } ${isCurrent ? 'skyjo-panel-current' : ''}`}
      data-player-id={player.id}
    >
      <div className="skyjo-player-grid-header mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="skyjo-serif text-xl font-semibold text-[#f5e6c8]">{player.name}</h2>
            <span
              aria-label={`${knownCards} of 12 cards flipped`}
              className="skyjo-flipped-pill"
              data-tooltip={`${knownCards} of 12 cards flipped`}
              tabIndex={0}
              title={`${knownCards} of 12 cards flipped`}
            >
              <span>{knownCards}/12</span>
              <span className="skyjo-flipped-info" aria-hidden="true">i</span>
              <span className="sr-only"> cards flipped</span>
            </span>
            {isCurrent || isLocal ? (
              <span
                className={`skyjo-turn-pill ${isCurrent && isLocal ? 'skyjo-turn-pill-local' : ''} ${
                  isLocal && !isCurrent ? 'skyjo-turn-pill-muted' : ''
                }`}
              >
                {isCurrent ? (isLocal ? 'Your turn' : 'Current turn') : 'Waiting'}
              </span>
            ) : null}
            {canSelectOpening ? <span className="skyjo-selection-pill">{openingRemaining}/2 opening picks</span> : null}
          </div>
          <p className="skyjo-player-grid-subtitle mt-1 text-sm text-[#f5e6c8]/55">
            {playerRole} - {playerStatus}
          </p>
        </div>
        <div className="skyjo-player-grid-scores flex items-baseline gap-2 text-right text-sm">
          <span className="skyjo-kicker">Shown</span>
          <span className="font-bold tabular-nums text-[#f5e6c8]">{player.roundScore}</span>
          <span className="skyjo-kicker ml-1">Total</span>
          <span className="font-bold tabular-nums text-[#f5e6c8]">{player.totalScore}</span>
        </div>
      </div>
      <div className="skyjo-player-card-rows grid">
        {rows.map((row) => (
          <div className="skyjo-player-card-row grid" key={row}>
            {columns.map((column) => {
              const index = row * 4 + column;
              const card = player.grid[index];
              const revealAfterDiscard = state.selectedSource === 'draw' && state.drawnCard && drawIntent === 'discard';
              const domainSelectable = Boolean(
                !card.removed &&
                  ((canSelectOpening && !card.faceUp) || (canSelectReplacement && (!revealAfterDiscard || !card.faceUp)))
              );
              const selectable = !interactionDisabledReason && domainSelectable;
              const dimDuringSelection = selectionMode && !selectable && !card.removed;
              const affordanceLabel = cardAffordanceLabel({
                card,
                canSelectOpening,
                canSelectReplacement,
                drawIntent,
                index,
                isCurrent,
                isLocal,
                player,
                selectable: domainSelectable,
                state
              });
              return (
                <button
                  aria-label={affordanceLabel}
                  className={`${cardClass(card, selectable)} ${selectable ? 'skyjo-card-eligible' : ''} ${
                    dimDuringSelection ? 'skyjo-card-ineligible' : ''
                  }`}
                  disabled={!selectable}
                  key={card.id}
                  onClick={() => onCardClick?.(index)}
                  title={interactionDisabledReason || affordanceLabel}
                  type="button"
                >
                  {cardLabel(card)}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

interface PlayerBoardGridProps {
  entries: BoardGridEntry[];
  state: GameState;
  drawIntent: DrawIntent;
  className?: string;
  interactionDisabledReason?: string;
  onCardClick: (index: number) => void;
}

function PlayerBoardGrid({
  entries,
  state,
  drawIntent,
  className = responsiveBoardGridClass,
  interactionDisabledReason,
  onCardClick
}: PlayerBoardGridProps) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const userScrollPausedUntilRef = useRef(0);
  const isOpponentStack = className.includes('skyjo-opponent-stack');
  const currentPlayer = state.players[state.currentPlayerIndex];
  const currentOpponentId =
    isOpponentStack && currentPlayer && entries.some(({ player, isLocal }) => !isLocal && player.id === currentPlayer.id)
      ? currentPlayer.id
      : '';

  useEffect(() => {
    if (!isOpponentStack) return undefined;

    const element = boardRef.current;
    if (!element) return undefined;

    const pauseCurrentPlayerScroll = () => {
      userScrollPausedUntilRef.current = Date.now() + currentPlayerScrollPauseMs;
    };

    element.addEventListener('wheel', pauseCurrentPlayerScroll, { passive: true });
    element.addEventListener('touchstart', pauseCurrentPlayerScroll, { passive: true });
    element.addEventListener('pointerdown', pauseCurrentPlayerScroll, { passive: true });

    return () => {
      element.removeEventListener('wheel', pauseCurrentPlayerScroll);
      element.removeEventListener('touchstart', pauseCurrentPlayerScroll);
      element.removeEventListener('pointerdown', pauseCurrentPlayerScroll);
    };
  }, [isOpponentStack]);

  useEffect(() => {
    if (!isOpponentStack || !currentOpponentId) return undefined;

    const element = boardRef.current;
    if (!element || Date.now() < userScrollPausedUntilRef.current) return undefined;

    const target = Array.from(element.querySelectorAll<HTMLElement>('[data-player-id]')).find(
      (item) => item.dataset.playerId === currentOpponentId
    );
    if (!target) return undefined;

    const frame = window.requestAnimationFrame(() => {
      if (Date.now() < userScrollPausedUntilRef.current) return;
      target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [currentOpponentId, isOpponentStack, state.log.length, state.phase]);

  return (
    <div className={className} data-testid={isOpponentStack ? 'opponent-rail' : 'local-board'} ref={boardRef}>
      {entries.map(({ player, isLocal }) => {
        const index = state.players.findIndex((item) => item.id === player.id);
        return (
          <PlayerGrid
            drawIntent={drawIntent}
            interactionDisabledReason={interactionDisabledReason}
            isCurrent={index === state.currentPlayerIndex}
            isLocal={isLocal}
            key={player.id}
            onCardClick={onCardClick}
            player={player}
            state={state}
          />
        );
      })}
    </div>
  );
}

interface TableControlsProps {
  state: GameState;
  localTurn: boolean;
  drawIntent: DrawIntent;
  interactionDisabledReason?: string;
  localPlayerId?: string;
  onChooseDiscard: () => void;
  onCancelDiscard: () => void;
  onDraw: () => void;
  onSetDrawIntent: (intent: DrawIntent) => void;
}

function TableControls({
  state,
  localTurn,
  drawIntent,
  interactionDisabledReason,
  localPlayerId,
  onChooseDiscard,
  onCancelDiscard,
  onDraw,
  onSetDrawIntent
}: TableControlsProps) {
  const topDiscard = state.discardPile[0];
  const activePlayer = state.players[state.currentPlayerIndex];
  const hasHiddenCard = hiddenCardCount(activePlayer) > 0;
  const status = getTurnStatus(state, localTurn);
  const deckDisabledReason = interactionDisabledReason || sourceDisabledReason(state, localTurn, 'deck');
  const discardDisabledReason = interactionDisabledReason || sourceDisabledReason(state, localTurn, 'discard');
  const commonDisabledReason =
    deckDisabledReason && discardDisabledReason && deckDisabledReason === discardDisabledReason ? deckDisabledReason : '';
  const selectedDiscard = localTurn && state.phase === 'choose-replacement' && state.selectedSource === 'discard';
  const hasLocalDrawnDecision = Boolean(state.drawnCard && localTurn);
  const discardButtonDisabled = Boolean(interactionDisabledReason || (discardDisabledReason && !selectedDiscard));
  const discardButtonTitle = selectedDiscard
    ? 'Put the discard card back.'
    : discardDisabledReason || 'Take the top discard card.';

  return (
    <section className="skyjo-panel skyjo-table-controls skyjo-table-glow" data-testid="table-center">
      <div className="skyjo-table-header mb-4 flex items-center justify-between gap-3">
        <h2 className="skyjo-serif text-xl font-semibold">Table</h2>
        <span className="skyjo-kicker text-right">Round {state.round}</span>
      </div>

      <div className={`skyjo-turn-status skyjo-turn-status-${status.tone}`} aria-live="polite">
        <div className="skyjo-kicker">{status.eyebrow}</div>
        <h3 className="skyjo-serif mt-1 text-2xl font-bold leading-tight text-[#f5e6c8]">{status.title}</h3>
        <p className="mt-2 text-sm leading-6 text-[#f5e6c8]/72">{status.description}</p>
      </div>

      {state.phase === 'opening-reveal' ? (
        <div className="skyjo-opening-tracker mt-3" aria-label="Opening reveal progress">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="skyjo-kicker">Opening reveal</div>
              <p className="mt-1 text-sm font-bold text-[#f5e6c8]">Each player chooses two face-down cards.</p>
            </div>
            <span className="rounded-full border border-[#f5e6c8]/18 px-3 py-1 text-xs font-extrabold text-[#f5e6c8]/70">
              {activePlayer.name}'s pick
            </span>
          </div>
          <div className="mt-3 grid gap-2">
            {state.players.map((player) => {
              const count = openingRevealCount(state, player);
              const active = player.id === activePlayer.id;
              const local = player.id === localPlayerId;
              return (
                <div className={`skyjo-opening-row ${active ? 'skyjo-opening-row-active' : ''}`} key={player.id}>
                  <span className="min-w-0 truncate">
                    {player.name}
                    {local ? ' (you)' : ''}
                  </span>
                  <span className="tabular-nums">{count}/2</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="skyjo-table-piles mt-4 grid grid-cols-2 gap-4">
        <button
          className="skyjo-button skyjo-pile-button text-center"
          disabled={Boolean(deckDisabledReason)}
          onClick={onDraw}
          title={deckDisabledReason || 'Draw blind from the deck.'}
          type="button"
        >
          <div className="skyjo-kicker">Deck</div>
          <div className="skyjo-card skyjo-card-hidden skyjo-table-card mx-auto mt-2">SKYJO</div>
          <div className="skyjo-table-count mt-2 text-sm font-bold tabular-nums text-[#f5e6c8]/65">{state.drawPile.length} cards</div>
        </button>
        <button
          aria-label={selectedDiscard ? 'Put the discard card back.' : undefined}
          aria-pressed={selectedDiscard}
          className={`skyjo-button skyjo-pile-button text-center ${selectedDiscard ? 'skyjo-pile-button-active' : ''}`}
          disabled={discardButtonDisabled}
          onClick={selectedDiscard ? onCancelDiscard : onChooseDiscard}
          title={discardButtonTitle}
          type="button"
        >
          <div className="skyjo-kicker">{selectedDiscard ? 'Undo' : 'Discard'}</div>
          {topDiscard ? (
            <div className={`${cardClass(topDiscard, false)} skyjo-table-card mx-auto mt-2`}>{cardLabel(topDiscard)}</div>
          ) : (
            <div className="skyjo-card skyjo-card-removed skyjo-table-card mx-auto mt-2" />
          )}
          <div className="skyjo-table-count mt-2 text-sm font-bold tabular-nums text-[#f5e6c8]/65">
            {selectedDiscard ? 'Tap to put back' : `${state.discardPile.length} cards`}
          </div>
        </button>
      </div>
      {!selectedDiscard && !hasLocalDrawnDecision && commonDisabledReason ? (
        <p className="skyjo-disabled-note mt-3">
          <span>Action unavailable:</span> {commonDisabledReason}
        </p>
      ) : !selectedDiscard && !hasLocalDrawnDecision && !commonDisabledReason && discardDisabledReason && !deckDisabledReason ? (
        <p className="skyjo-disabled-note mt-3">
          <span>Discard unavailable:</span> {discardDisabledReason}
        </p>
      ) : null}

      {hasLocalDrawnDecision && state.drawnCard ? (
        <div className="skyjo-drawn-decision mt-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="skyjo-kicker">Drawn card waiting</div>
              <h3 className="skyjo-serif mt-1 text-xl font-bold text-[#f5e6c8]">Place it or discard it</h3>
              <p className="skyjo-drawn-description mt-2 text-sm leading-6 text-[#f5e6c8]/72">Choose a mode, then select a highlighted card on your board.</p>
            </div>
            <div className={`${cardClass(state.drawnCard, false)} skyjo-drawn-card shrink-0`}>{cardLabel(state.drawnCard)}</div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <button
              aria-pressed={drawIntent === 'place'}
              className={`skyjo-choice-button ${drawIntent === 'place' ? 'skyjo-choice-button-active' : ''}`}
              disabled={Boolean(interactionDisabledReason)}
              onClick={() => onSetDrawIntent('place')}
              title={interactionDisabledReason || 'Replace a card with the drawn card.'}
              type="button"
            >
              <span>Place drawn card</span>
              <small className="skyjo-choice-help">Replace any non-cleared card.</small>
            </button>
            <button
              aria-pressed={drawIntent === 'discard'}
              className={`skyjo-choice-button ${drawIntent === 'discard' ? 'skyjo-choice-button-active' : ''}`}
              disabled={Boolean(interactionDisabledReason) || !hasHiddenCard}
              onClick={() => onSetDrawIntent('discard')}
              title={
                interactionDisabledReason ||
                (hasHiddenCard ? 'Discard the drawn card and reveal a hidden card.' : 'No hidden cards remain to reveal.')
              }
              type="button"
            >
              <span>Discard + reveal</span>
              <small className="skyjo-choice-help">{hasHiddenCard ? 'Reveal one hidden card.' : 'No hidden cards remain.'}</small>
            </button>
          </div>
          <p className="skyjo-action-hint mt-3">
            {drawIntent === 'discard'
              ? 'Discard mode: select a highlighted hidden card.'
              : 'Place mode: select a highlighted card.'}
          </p>
        </div>
      ) : null}

      {selectedDiscard ? (
        <p className="sr-only" aria-live="polite">
          Discard selected. Tap discard again to put it back, or select a highlighted card.
        </p>
      ) : null}
    </section>
  );
}

interface MobilePlaySurfaceProps {
  state: GameState;
  localEntries: BoardGridEntry[];
  drawIntent: DrawIntent;
  interactionDisabledReason?: string;
  localPlayerId?: string;
  localTurn: boolean;
  onCardClick: (index: number) => void;
  onChooseDiscard: () => void;
  onCancelDiscard: () => void;
  onDraw: () => void;
  onSetDrawIntent: (intent: DrawIntent) => void;
}

function MobilePlaySurface({
  state,
  localEntries,
  drawIntent,
  interactionDisabledReason,
  localPlayerId,
  localTurn,
  onCardClick,
  onChooseDiscard,
  onCancelDiscard,
  onDraw,
  onSetDrawIntent
}: MobilePlaySurfaceProps) {
  return (
    <section className="skyjo-mobile-play-surface" aria-label="Your board and table piles">
      <PlayerBoardGrid
        className="skyjo-mobile-local-board"
        drawIntent={drawIntent}
        entries={localEntries}
        interactionDisabledReason={interactionDisabledReason}
        onCardClick={onCardClick}
        state={state}
      />
      <div className="skyjo-mobile-table-rail">
        <TableControls
          drawIntent={drawIntent}
          interactionDisabledReason={interactionDisabledReason}
          localPlayerId={localPlayerId}
          localTurn={localTurn}
          onCancelDiscard={onCancelDiscard}
          onChooseDiscard={onChooseDiscard}
          onDraw={onDraw}
          onSetDrawIntent={onSetDrawIntent}
          state={state}
        />
      </div>
    </section>
  );
}

function FinalTurnCallout({ state, localPlayerId }: { state: GameState; localPlayerId?: string }) {
  const activeFinalLap =
    Boolean(state.roundCloserId) && (state.phase === 'choose-source' || state.phase === 'choose-replacement');
  if (!activeFinalLap) return null;

  const closer = state.players.find((player) => player.id === state.roundCloserId);
  const currentPlayer = state.players[state.currentPlayerIndex];
  const currentPlayerHasFinalTurn = Boolean(currentPlayer && state.finalTurnPlayerIds.includes(currentPlayer.id));
  const localPlayerHasFinalTurn = Boolean(localPlayerId && state.finalTurnPlayerIds.includes(localPlayerId));
  const closerName = closer?.name || 'A player';
  let turnMessage = 'Everyone else gets one final turn before scoring.';

  if (currentPlayerHasFinalTurn && currentPlayer?.id === localPlayerId) {
    turnMessage = 'This is your last move of the round.';
  } else if (currentPlayerHasFinalTurn && currentPlayer) {
    turnMessage = `${currentPlayer.name} is taking a final turn.`;
  } else if (localPlayerHasFinalTurn) {
    turnMessage = 'Your final turn is still coming up.';
  }

  return (
    <section aria-live="polite" className="skyjo-panel skyjo-final-turn-callout" role="status">
      <div className="flex items-start gap-3">
        <div className="skyjo-final-turn-mark" aria-hidden="true">
          !
        </div>
        <div className="min-w-0">
          <div className="skyjo-kicker text-amber-100/75">Final lap active</div>
          <h2 className="skyjo-serif mt-1 text-xl font-bold leading-tight text-[#fff6df]">{closerName} went out.</h2>
          <p className="mt-2 text-sm font-extrabold leading-5 text-amber-100">{turnMessage}</p>
          <p className="mt-1 text-xs leading-5 text-[#f5e6c8]/68">
            {closerName} revealed their last card. No full turns remain after this final lap.
          </p>
        </div>
      </div>
    </section>
  );
}

function MoveLogList({ state }: { state: GameState }) {
  return (
    <div className="skyjo-move-log-list space-y-2 text-sm text-[#f5e6c8]/72">
      {state.log.length > 0 ? (
        state.log.map((entry, index) => (
          <div className="rounded-lg border border-white/[0.04] bg-white/[0.025] px-3 py-2" key={`${index}-${entry}`}>
            {entry}
          </div>
        ))
      ) : (
        <div className="rounded-lg border border-dashed border-[#f5e6c8]/14 px-3 py-5 text-center text-sm font-bold text-[#f5e6c8]/45">
          No moves yet.
        </div>
      )}
    </div>
  );
}

function formatChatTime(createdAt: number) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(createdAt));
}

interface RoomChatProps {
  messages: RoomChatMessage[];
  playerId: string;
  isOpen: boolean;
  state?: GameState | null;
  unreadCount: number;
  interactionDisabledReason?: string;
  onToggle: () => void;
  onSend: (text: string) => void;
}

function RoomChat({
  messages,
  playerId,
  isOpen,
  state,
  unreadCount,
  interactionDisabledReason,
  onToggle,
  onSend
}: RoomChatProps) {
  const [draft, setDraft] = useState('');
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const latestMessage = messages[messages.length - 1];

  useEffect(() => {
    if (!isOpen) return;
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [isOpen, messages.length]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (interactionDisabledReason) return;
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  }

  function flippedSummaryForPlayer(messagePlayerId: string) {
    const player = state?.players.find((item) => item.id === messagePlayerId);
    return player ? `${knownCardCount(player)}/12` : '';
  }

  function handleInputFocus() {
    window.requestAnimationFrame(() => {
      panelRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  return (
    <section
      className={`skyjo-panel skyjo-room-chat-panel ${isOpen ? 'skyjo-room-chat-panel-open' : 'skyjo-room-chat-panel-closed'}`}
      ref={panelRef}
    >
      <button
        aria-expanded={isOpen}
        className="skyjo-chat-toggle flex w-full items-center justify-between gap-3 text-left"
        onClick={onToggle}
        type="button"
      >
        <span className="min-w-0">
          <span className="skyjo-serif block text-xl font-semibold text-[#f5e6c8]">Table Chat</span>
          <span className="mt-1 block truncate text-sm text-[#f5e6c8]/55">
            {latestMessage ? `${latestMessage.playerName}: ${latestMessage.text}` : 'No messages yet'}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {unreadCount > 0 ? (
            <span className="rounded-full border border-amber-200/35 bg-amber-400/18 px-2 py-1 text-xs font-black text-amber-100">
              {unreadCount}
            </span>
          ) : null}
          <span className="skyjo-kicker">{isOpen ? 'Hide' : 'Open'}</span>
          <span className={`skyjo-disclosure-caret ${isOpen ? 'skyjo-disclosure-caret-open' : ''}`} aria-hidden="true" />
        </span>
      </button>

      {isOpen ? (
        <div className="skyjo-chat-body mt-3 grid gap-3">
          <div
            aria-live="polite"
            className="skyjo-chat-messages max-h-64 space-y-2 overflow-y-auto rounded-xl border border-[#f5e6c8]/10 bg-black/10 p-2"
            ref={messagesRef}
          >
            {messages.length > 0 ? (
              messages.map((message) => {
                const mine = message.playerId === playerId;
                const flippedSummary = flippedSummaryForPlayer(message.playerId);
                return (
                  <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`} key={message.id}>
                    <div
                      className={`max-w-[88%] rounded-xl border px-3 py-2 text-sm ${
                        mine
                          ? 'border-amber-200/24 bg-amber-300/12 text-amber-50'
                          : 'border-[#f5e6c8]/10 bg-white/[0.035] text-[#f5e6c8]/82'
                      }`}
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="font-black text-[#f5e6c8]">{mine ? 'You' : message.playerName}</span>
                        {flippedSummary ? (
                          <span className="skyjo-chat-flipped-pill" title={`${flippedSummary} cards flipped`} aria-label={`${flippedSummary} cards flipped`}>
                            {flippedSummary}
                          </span>
                        ) : null}
                        <time className="text-xs font-bold text-[#f5e6c8]/42" dateTime={new Date(message.createdAt).toISOString()}>
                          {formatChatTime(message.createdAt)}
                        </time>
                      </div>
                      <p className="mt-1 break-words leading-5">{message.text}</p>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="rounded-lg border border-dashed border-[#f5e6c8]/14 px-3 py-5 text-center text-sm font-bold text-[#f5e6c8]/45">
                Say hello when people join the table.
              </div>
            )}
          </div>

          <form className="skyjo-chat-form flex gap-2" onSubmit={handleSubmit}>
            <input
              aria-label="Message"
              className="skyjo-input min-w-0 flex-1 px-3 py-2 text-sm"
              disabled={Boolean(interactionDisabledReason)}
              maxLength={280}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={handleInputFocus}
              placeholder="Message players"
              title={interactionDisabledReason || 'Message players'}
              value={draft}
            />
            <button
              className="skyjo-button skyjo-button-primary px-4 py-2 text-sm"
              disabled={Boolean(interactionDisabledReason) || !draft.trim()}
              title={interactionDisabledReason || 'Send message'}
              type="submit"
            >
              Send
            </button>
          </form>
        </div>
      ) : null}
    </section>
  );
}

interface RoundSummaryProps {
  state: GameState;
  actionLabel?: string;
  actionDisabledReason?: string;
  onAction?: () => void;
  onMinimize?: () => void;
  children?: ReactNode;
}

function RoundSummary({ state, actionLabel, actionDisabledReason, onAction, onMinimize, children }: RoundSummaryProps) {
  const rankedPlayers = [...state.players].sort((a, b) => a.totalScore - b.totalScore || a.roundScore - b.roundScore);
  const leader = rankedPlayers[0];
  const winner = state.winnerId ? state.players.find((player) => player.id === state.winnerId) : null;
  const headline = state.phase === 'game-over' ? `${winner?.name || leader.name} wins the game.` : 'Round complete.';
  const outcome =
    state.phase === 'game-over'
      ? `${winner?.name || leader.name} finished lowest at ${(winner || leader).totalScore} total.`
      : `${leader.name} leads at ${leader.totalScore} total.`;
  const latestScoringNote = state.log[0];

  return (
    <section className="skyjo-panel skyjo-score-panel skyjo-round-summary-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="skyjo-kicker">{state.phase === 'game-over' ? 'Final totals' : 'Round scoring'}</div>
          <h2 className="skyjo-serif mt-1 text-2xl font-bold leading-tight text-[#f5e6c8]">{headline}</h2>
          <p className="mt-2 text-sm font-bold text-[#f5e6c8]/78">{outcome}</p>
          {latestScoringNote ? <p className="mt-1 text-xs leading-5 text-[#f5e6c8]/58">{latestScoringNote}</p> : null}
        </div>
        {onMinimize ? (
          <button className="skyjo-button skyjo-round-summary-minimize px-3 py-2 text-xs" onClick={onMinimize} type="button">
            Minimize
          </button>
        ) : null}
      </div>

      <div className="skyjo-score-list mt-4" aria-label="Round score and total score">
        {rankedPlayers.map((player, index) => {
          const isWinner = winner ? player.id === winner.id : index === 0;
          return (
            <div className={`skyjo-score-row ${isWinner ? 'skyjo-score-row-leader' : ''}`} key={player.id}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="skyjo-score-rank">#{index + 1}</span>
                  <span className="truncate font-extrabold text-[#f5e6c8]">{player.name}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-right tabular-nums">
                <div>
                  <div className="skyjo-score-label">Round score</div>
                  <div className="font-black text-[#f5e6c8]">{player.roundScore}</div>
                </div>
                <div>
                  <div className="skyjo-score-label">Total score</div>
                  <div className="font-black text-[#f5e6c8]">{player.totalScore}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {children}

      {actionLabel && onAction ? (
        <button
          className="skyjo-button skyjo-button-primary mt-4 w-full px-4 py-3"
          disabled={Boolean(actionDisabledReason)}
          onClick={onAction}
          title={actionDisabledReason || actionLabel}
          type="button"
        >
          {actionLabel}
        </button>
      ) : null}
      {actionDisabledReason ? (
        <p className="skyjo-disabled-note mt-4">
          <span>Action unavailable:</span> {actionDisabledReason}
        </p>
      ) : null}
    </section>
  );
}

function RoundSummaryRestoreButton({ state, meta, onRestore }: { state: GameState; meta?: string; onRestore: () => void }) {
  return (
    <button className="skyjo-round-summary-chip" onClick={onRestore} type="button">
      <span className="min-w-0">
        <span className="skyjo-kicker block">{state.phase === 'game-over' ? 'Final totals' : 'Round scoring'}</span>
        <span className="block truncate text-sm font-black text-[#f5e6c8]">{meta || 'Review scores'}</span>
      </span>
      <span className="skyjo-summary-meta">
        <span className="skyjo-kicker">Open</span>
        <span className="skyjo-disclosure-caret skyjo-disclosure-caret-open" aria-hidden="true" />
      </span>
    </button>
  );
}

function SinglePlayer() {
  const { user } = useAccount();
  const [aiOpponentCount, setAiOpponentCount] = useState<number>(singlePlayerAiOpponentRange.min);
  const [state, setState] = useState<GameState>(() => startFreshGame({ aiOpponentCount: singlePlayerAiOpponentRange.min }));
  const [drawIntent, setDrawIntent] = useState<DrawIntent>('place');
  const [roundSummaryOpen, setRoundSummaryOpen] = useState(false);
  const [statsSaveStatus, setStatsSaveStatus] = useState('');
  const savedSingleGameKeyRef = useRef('');
  const activePlayer = state.players[state.currentPlayerIndex];
  const humanTurn = activePlayer.kind === 'human';
  const localPlayers = state.players.filter((player) => player.kind === 'human');
  const opponentPlayers = state.players.filter((player) => player.kind !== 'human');
  const localBoardEntries = localPlayers.map((player) => ({ player, isLocal: true }));
  const opponentBoardEntries = opponentPlayers.map((player) => ({ player, isLocal: false }));
  const hasFourPlayerDesktopGrid = state.players.length === 4;
  const fourPlayerBoardEntries = [...opponentBoardEntries, ...localBoardEntries];
  const aiOpponentSummary = `${aiOpponentCount} AI opponent${aiOpponentCount === 1 ? '' : 's'}`;
  const isScoringPhase = state.phase === 'round-over' || state.phase === 'game-over';
  const summaryModalOpen = isScoringPhase && roundSummaryOpen;

  useGameAudio(state);

  useEffect(() => {
    if (state.phase !== 'choose-replacement' || state.selectedSource !== 'draw' || !state.drawnCard) {
      setDrawIntent('place');
    }
  }, [state.drawnCard, state.phase, state.selectedSource]);

  useEffect(() => {
    if (activePlayer.kind !== 'ai' || state.phase === 'round-over' || state.phase === 'game-over') return;
    const timer = window.setTimeout(() => {
      setState((current) => {
        if (current.phase === 'opening-reveal') {
          const aiPlayer = current.players[current.currentPlayerIndex];
          const index = aiPlayer.grid.findIndex((card) => !card.faceUp && !card.removed);
          return revealOpeningCard(current, index);
        }
        const move = getBestAiMove(current);
        if (move.action === 'discard') return chooseDiscard(current);
        if (move.action === 'draw') return drawBlind(current);
        if (move.action === 'replace') return replaceCard(current, move.index || 0);
        return discardDrawnAndReveal(current, move.index || 0);
      });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [activePlayer.kind, state]);

  useEffect(() => {
    setRoundSummaryOpen(isScoringPhase);
  }, [isScoringPhase, state.round]);

  useEffect(() => {
    if (state.phase !== 'game-over') {
      savedSingleGameKeyRef.current = '';
      setStatsSaveStatus('');
      return;
    }
    if (!user) return;
    const key = `${state.round}:${state.winnerId}:${state.players.map((player) => `${player.id}:${player.totalScore}`).join('|')}`;
    if (savedSingleGameKeyRef.current === key) return;
    savedSingleGameKeyRef.current = key;
    saveSinglePlayerGame(state, key)
      .then(() => setStatsSaveStatus('Game saved to your stats.'))
      .catch((error) => {
        savedSingleGameKeyRef.current = '';
        setStatsSaveStatus(error instanceof Error ? error.message : 'Could not save stats.');
      });
  }, [state, user]);

  function handleCard(index: number) {
    if (!humanTurn || (state.phase !== 'opening-reveal' && state.phase !== 'choose-replacement')) return;
    if (state.phase === 'opening-reveal') {
      void playAudioCue('flip');
      setState((current) => revealOpeningCard(current, index));
      return;
    }
    void playAudioCue('place');
    setState((current) =>
      drawIntent === 'discard' && current.selectedSource === 'draw' && current.drawnCard
        ? discardDrawnAndReveal(current, index)
        : replaceCard(current, index)
    );
  }

  function chooseDiscardForSinglePlayer() {
    void playAudioCue('pickup');
    setState((current) => chooseDiscard(current));
  }

  function drawForSinglePlayer() {
    void playAudioCue('pickup');
    setState((current) => drawBlind(current));
  }

  function startSelectedGame() {
    setState(startFreshGame({ aiOpponentCount }));
  }

  return (
    <main
      className={`skyjo-surface px-4 py-5 ${summaryModalOpen ? 'skyjo-round-summary-surface' : ''}`}
      data-testid="game-table"
    >
      <div
        className={`skyjo-shell skyjo-active-mobile-shell ${
          summaryModalOpen ? 'skyjo-round-summary-mode' : ''
        } grid gap-5 lg:grid-cols-[1fr_330px]`}
      >
        {isScoringPhase && !roundSummaryOpen ? (
          <RoundSummaryRestoreButton state={state} onRestore={() => setRoundSummaryOpen(true)} />
        ) : null}

        <section
          className={`skyjo-mobile-game-stack space-y-4 ${
            hasFourPlayerDesktopGrid ? 'lg:col-span-2 lg:row-start-1' : 'lg:col-start-1 lg:row-start-1'
          }`}
        >
          <div className="skyjo-game-header flex flex-wrap items-start justify-between gap-3">
            <div className="skyjo-game-heading min-w-0">
              <Link aria-label="Back to home" className="skyjo-back-link text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/">
                Back
              </Link>
              <h1 className="skyjo-title skyjo-game-title mt-2 text-5xl">Single Player</h1>
              <p className="skyjo-game-subtitle mt-1 text-[#f5e6c8]/55">Round {state.round}. Lowest score wins; first to 100 ends the game.</p>
              {statsSaveStatus ? <p className="mt-2 text-sm font-bold text-[#f5e6c8]/62">{statsSaveStatus}</p> : null}
            </div>
            <div className="skyjo-header-controls flex w-auto items-start justify-end">
              <div className="skyjo-header-actions flex items-start justify-end gap-2">
                <GameSettingsButton
                  aiOpponentCount={aiOpponentCount}
                  aiOpponentSummary={aiOpponentSummary}
                  onAiOpponentCountChange={setAiOpponentCount}
                  onNewGame={startSelectedGame}
                  state={state}
                />
              </div>
            </div>
          </div>

          <div className="skyjo-mobile-final-lap-slot">
            <FinalTurnCallout localPlayerId={localPlayers[0]?.id} state={state} />
          </div>

          {hasFourPlayerDesktopGrid ? (
            <PlayerBoardGrid
              className={fourPlayerDesktopBoardGridClass}
              drawIntent={drawIntent}
              entries={fourPlayerBoardEntries}
              onCardClick={handleCard}
              state={state}
            />
          ) : null}

          <MobilePlaySurface
            drawIntent={drawIntent}
            localEntries={localBoardEntries}
            localPlayerId={localPlayers[0]?.id}
            localTurn={humanTurn}
            onCardClick={handleCard}
            onCancelDiscard={() => setState((current) => cancelDiscardSelection(current))}
            onChooseDiscard={chooseDiscardForSinglePlayer}
            onDraw={drawForSinglePlayer}
            onSetDrawIntent={setDrawIntent}
            state={state}
          />

          {opponentBoardEntries.length > 0 ? (
            <PlayerBoardGrid
              className={`${opponentBoardClass(opponentBoardEntries.length, hasFourPlayerDesktopGrid)} skyjo-main-opponent-stack`}
              drawIntent={drawIntent}
              entries={opponentBoardEntries}
              onCardClick={handleCard}
              state={state}
            />
          ) : null}
        </section>

        <div
          className={`skyjo-desktop-table-stack space-y-4 ${
            hasFourPlayerDesktopGrid ? 'lg:col-start-2 lg:row-start-2' : 'lg:col-start-2 lg:row-start-1'
          }`}
        >
          <FinalTurnCallout localPlayerId={localPlayers[0]?.id} state={state} />
          <TableControls
            drawIntent={drawIntent}
            localPlayerId={localPlayers[0]?.id}
            localTurn={humanTurn}
            onCancelDiscard={() => setState((current) => cancelDiscardSelection(current))}
            onChooseDiscard={chooseDiscardForSinglePlayer}
            onDraw={drawForSinglePlayer}
            onSetDrawIntent={setDrawIntent}
            state={state}
          />
        </div>

        <section className={hasFourPlayerDesktopGrid ? 'skyjo-desktop-local-board md:hidden lg:col-start-1 lg:row-start-2' : 'skyjo-desktop-local-board lg:col-start-1 lg:row-start-2'}>
          <PlayerBoardGrid
            className={responsiveBoardGridClass}
            drawIntent={drawIntent}
            entries={localBoardEntries}
            onCardClick={handleCard}
            state={state}
          />
        </section>

        <aside className={`skyjo-secondary-stack space-y-4 ${hasFourPlayerDesktopGrid ? 'lg:col-start-1 lg:row-start-2' : 'lg:col-start-2 lg:row-start-2'}`}>
          {isScoringPhase && roundSummaryOpen ? (
            <RoundSummary
              actionLabel={state.phase === 'game-over' ? 'Start New Game' : 'Next Round'}
              onMinimize={() => setRoundSummaryOpen(false)}
              onAction={() => setState(state.phase === 'game-over' ? startFreshGame({ aiOpponentCount }) : startNextRound(state))}
              state={state}
            />
          ) : null}
        </aside>
      </div>
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
  const location = useLocation();
  const initialLobbyRef = useRef<InitialLobbySession | null>(null);
  if (!initialLobbyRef.current) initialLobbyRef.current = getInitialLobbySession();
  const initialLobby = initialLobbyRef.current;
  const connectionControllerRef = useRef<RoomConnectionController | null>(null);
  const frameHandlerRef = useRef<(frame: RoomConnectionFrame) => void>(() => {});
  const shareStatusTimerRef = useRef<number | null>(null);
  const roomCodeRef = useRef(initialLobby.roomCode);
  const playerIdRef = useRef(initialLobby.playerId);
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
  const [commandPending, setCommandPending] = useState(false);
  const [error, setError] = useState('');
  const [shareStatus, setShareStatus] = useState('');
  const [drawIntent, setDrawIntent] = useState<DrawIntent>('place');
  const [chatOpen, setChatOpen] = useState(false);
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
    clearResetRecoveryHint();
    try {
      window.localStorage.removeItem('skyjo-player-id');
      window.localStorage.removeItem('skyjo-room-code');
    } catch {
      // The in-memory terminal state must still retire when browser storage is unavailable.
    }
    playerIdRef.current = '';
    roomCodeRef.current = '';
    setPlayerId('');
    setRoomCode('');
    setJoinCode('');
    setRoom(null);
    setError(message);
  }, [clearResetRecoveryHint]);
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
    if (!accountUser) return;
    setName(accountUser.displayName);
    window.localStorage.setItem('skyjo-player-name', accountUser.displayName);
  }, [accountUser]);

  useEffect(() => {
    if (!accountUser) return;
    const controller = createRoomConnection({
      url: roomSocketUrl(),
      createSocket: (url) => new WebSocket(url) as unknown as RoomConnectionSocket,
      onFrame: (frame) => frameHandlerRef.current(frame),
      onStateChange: (state) => setConnection(state),
      onPendingCommandChange: setCommandPending,
      onError: (message) => setError(message)
    });
    connectionControllerRef.current = controller;
    if (roomCodeRef.current && playerIdRef.current) {
      const recoveryHint = resetRecoveryHintRef.current;
      controller.recover({
        action: 'join-room',
        code: roomCodeRef.current,
        name: accountUser.displayName,
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
    return () => {
      if (connectionControllerRef.current === controller) connectionControllerRef.current = null;
      controller.dispose();
    };
  }, [accountUser]);

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
      setError('Sign in to your Skyjo account before joining multiplayer.');
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
      setError(typeof message.message === 'string' ? message.message : 'Refresh Skyjo to continue multiplayer.');
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
        setError('Skyjo could not save reset recovery data. The room was not reset.');
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
      void playAudioCue('flip');
      sendCommand({ type: 'reveal-opening-card', cardIndex: index });
      return;
    }
    void playAudioCue('place');
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
    let fallbackText = `Skyjo room code: ${room.code}`;
    let fallbackStatus = 'Room code copied';
    let inviteCreated = false;

    try {
      const invite = await createRoomInvite(room.code);
      const url = absoluteShareUrl(invite.path);
      const text = `Join my Skyjo room ${room.code}: ${url}`;
      fallbackText = text;
      fallbackStatus = 'Link copied';
      inviteCreated = true;
      if (navigator.share) {
        await navigator.share({
          title: 'Skyjo room',
          text: `Join my Skyjo room ${room.code}.`,
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
  const roomLocalPlayers = roomState?.players.filter((player) => player.id === playerId) || [];
  const roomOpponentPlayers = roomState?.players.filter((player) => player.id !== playerId) || [];
  const roomLocalBoardEntries = roomLocalPlayers.map((player) => ({ player, isLocal: true }));
  const roomOpponentBoardEntries = roomOpponentPlayers.map((player) => ({ player, isLocal: false }));
  const hasFourPlayerRoomDesktopGrid = roomState?.players.length === 4;
  const fourPlayerRoomBoardEntries = [...roomOpponentBoardEntries, ...roomLocalBoardEntries];
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

  useGameAudio(roomState);

  function chooseDiscardForRoom() {
    if (!roomState) return;
    void playAudioCue('pickup');
    sendCommand({ type: 'choose-discard' });
  }

  function cancelDiscardForRoom() {
    if (!roomState) return;
    sendCommand({ type: 'cancel-discard' });
  }

  function drawForRoom() {
    if (!roomState) return;
    void playAudioCue('pickup');
    sendCommand({ type: 'draw-blind' });
  }

  if (accountLoading) return null;
  if (!accountUser) return <RequireAccountPanel next={`/lobby${location.search}`} title="Sign in to play multiplayer" />;

  return (
    <main
      className={`skyjo-surface px-4 py-8 ${summaryModalOpen ? 'skyjo-round-summary-surface' : ''}`}
      data-testid="game-table"
    >
      <div className={`skyjo-shell ${roomState ? 'skyjo-active-mobile-shell' : ''} ${summaryModalOpen ? 'skyjo-round-summary-mode' : ''} space-y-5`}>
        {roomScoringPhase && roomState && !roundSummaryOpen ? (
          <RoundSummaryRestoreButton meta={readySummary} state={roomState} onRestore={() => setRoundSummaryOpen(true)} />
        ) : null}

        <div className="skyjo-game-header flex flex-wrap items-start justify-between gap-3">
          <div className="skyjo-game-heading min-w-0">
            <Link aria-label="Back to home" className="skyjo-back-link text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/">
              Back
            </Link>
            <h1 className="skyjo-title skyjo-game-title mt-2 text-5xl">Multiplayer Lobby</h1>
            <p className="skyjo-game-subtitle mt-1 text-[#f5e6c8]/55">Create a private room and share the code with friends.</p>
          </div>
          <div className="skyjo-header-actions flex items-start justify-end gap-2">
            <GameSettingsButton state={roomState} />
          </div>
        </div>

        <MultiplayerConnectionStatus roomActive={Boolean(room)} state={connection} />

        {room && (connection === 'error' || connection === 'idle') ? (
          <section className="skyjo-panel flex flex-wrap items-center justify-between gap-3 p-4" aria-label="Room recovery actions">
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
            className="rounded-xl border border-red-400/40 bg-red-950/70 px-4 py-3 text-red-100"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        {room ? (
          <div className="skyjo-active-room-grid grid gap-5 lg:grid-cols-[1fr_330px]">
            <section
              className={`skyjo-mobile-game-stack space-y-4 ${
                hasFourPlayerRoomDesktopGrid ? 'lg:col-span-2 lg:row-start-1' : 'lg:col-start-1 lg:row-start-1'
              }`}
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
                        onClick={() => sendCommand({ type: 'reset-room' })}
                        title={roomInteractionDisabledReason || 'Reset this room.'}
                        type="button"
                      >
                        Reset Room
                      </button>
                    ) : null}
                  </div>
                </div>
                {shareStatus ? <p className="skyjo-share-status mt-3 text-sm font-extrabold text-[#f5e6c8]/72">{shareStatus}</p> : null}
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

              {roomState ? (
                <>
                  <div className="skyjo-mobile-final-lap-slot">
                    <FinalTurnCallout localPlayerId={playerId} state={roomState} />
                  </div>

                  {hasFourPlayerRoomDesktopGrid ? (
                    <PlayerBoardGrid
                      className={fourPlayerDesktopBoardGridClass}
                      drawIntent={drawIntent}
                      entries={fourPlayerRoomBoardEntries}
                      interactionDisabledReason={roomInteractionDisabledReason}
                      onCardClick={handleCard}
                      state={roomState}
                    />
                  ) : null}

                  <MobilePlaySurface
                    drawIntent={drawIntent}
                    interactionDisabledReason={roomInteractionDisabledReason}
                    localEntries={roomLocalBoardEntries}
                    localPlayerId={playerId}
                    localTurn={localTurn}
                    onCardClick={handleCard}
                    onCancelDiscard={cancelDiscardForRoom}
                    onChooseDiscard={chooseDiscardForRoom}
                    onDraw={drawForRoom}
                    onSetDrawIntent={setDrawIntent}
                    state={roomState}
                  />

                  <PlayerBoardGrid
                    className={`${opponentBoardClass(roomOpponentBoardEntries.length, hasFourPlayerRoomDesktopGrid)} skyjo-main-opponent-stack`}
                    drawIntent={drawIntent}
                    entries={roomOpponentBoardEntries}
                    interactionDisabledReason={roomInteractionDisabledReason}
                    onCardClick={handleCard}
                    state={roomState}
                  />
                </>
              ) : (
                <div className="skyjo-panel p-6 text-[#f5e6c8]/70">
                  Waiting for players. The host can start once at least two people are connected.
                </div>
              )}
            </section>

            {roomState ? (
              <>
                <div
                  className={`skyjo-desktop-table-stack space-y-4 ${
                    hasFourPlayerRoomDesktopGrid ? 'lg:col-start-2 lg:row-start-2' : 'lg:col-start-2 lg:row-start-1'
                  }`}
                >
                  <FinalTurnCallout localPlayerId={playerId} state={roomState} />
                  <TableControls
                    drawIntent={drawIntent}
                    interactionDisabledReason={roomInteractionDisabledReason}
                    localPlayerId={playerId}
                    localTurn={localTurn}
                    onCancelDiscard={cancelDiscardForRoom}
                    onChooseDiscard={chooseDiscardForRoom}
                    onDraw={drawForRoom}
                    onSetDrawIntent={setDrawIntent}
                    state={roomState}
                  />
                </div>

                <section
                  className={
                    hasFourPlayerRoomDesktopGrid
                      ? 'skyjo-desktop-local-board md:hidden lg:col-start-1 lg:row-start-2'
                      : 'skyjo-desktop-local-board lg:col-start-1 lg:row-start-2'
                  }
                >
                  <PlayerBoardGrid
                    className={responsiveBoardGridClass}
                    drawIntent={drawIntent}
                    entries={roomLocalBoardEntries}
                    interactionDisabledReason={roomInteractionDisabledReason}
                    onCardClick={handleCard}
                    state={roomState}
                  />
                </section>

                <aside
                  className={`skyjo-secondary-stack ${chatOpen ? 'skyjo-secondary-stack-chat-open' : ''} space-y-4 ${
                    hasFourPlayerRoomDesktopGrid ? 'lg:col-start-1 lg:row-start-2' : 'lg:col-start-2 lg:row-start-2'
                  }`}
                >
                  <RoomChat
                    isOpen={chatOpen}
                    interactionDisabledReason={roomInteractionDisabledReason}
                    messages={chatMessages}
                    onSend={sendChatMessage}
                    onToggle={() => setChatOpen((current) => !current)}
                    playerId={playerId}
                    state={roomState}
                    unreadCount={unreadChatCount}
                  />
                  {roomScoringPhase && roundSummaryOpen ? (
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
                  ) : null}
                </aside>
              </>
            ) : (
              <aside className="skyjo-secondary-stack space-y-4 lg:col-start-2 lg:row-start-1">
                <section className="skyjo-panel skyjo-waiting-note-panel text-sm text-[#f5e6c8]/70">Keep this tab open while friends join.</section>
                <RoomChat
                  isOpen={chatOpen}
                  interactionDisabledReason={roomInteractionDisabledReason}
                  messages={chatMessages}
                  onSend={sendChatMessage}
                  onToggle={() => setChatOpen((current) => !current)}
                  playerId={playerId}
                  unreadCount={unreadChatCount}
                />
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
        <Routes>
          <Route element={<Home />} path="/" />
          <Route element={<AccountPage />} path="/account" />
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

export default App;
