import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const scryptAsync = promisify(crypto.scrypt);
const defaultDbFile = path.join('.data', 'skyjo.sqlite');
const validRoles = new Set(['admin', 'player']);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function normalizeEmail(email) {
  return stringValue(email).trim().toLowerCase();
}

function normalizeDisplayName(name) {
  return stringValue(name, 'Player').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Player';
}

function assertEmail(email) {
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('Enter a valid email address.');
  }
}

function assertPassword(password) {
  if (stringValue(password).length < 8) throw new Error('Use a password with at least 8 characters.');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  assertPassword(password);
  const derived = await scryptAsync(String(password), salt, 64);
  return {
    salt,
    hash: Buffer.from(derived).toString('base64url')
  };
}

async function verifyPassword(password, user) {
  if (!user?.password_salt || !user?.password_hash) return false;
  const { hash } = await hashPassword(String(password), user.password_salt);
  const left = Buffer.from(hash);
  const right = Buffer.from(user.password_hash);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? null
  };
}

function normalizeBool(value) {
  return value === true || value === 1 ? 1 : 0;
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

export function resolveAccountDatabasePath(env = process.env) {
  const configuredPath = stringValue(env.SKYJO_DB_FILE).trim();
  if (configuredPath) return path.resolve(configuredPath);

  const roomsFile = stringValue(env.SKYJO_ROOMS_FILE).trim();
  if (path.isAbsolute(roomsFile)) return path.join(path.dirname(roomsFile), 'skyjo.sqlite');

  return path.resolve(defaultDbFile);
}

export class AccountStore {
  constructor(filePath = resolveAccountDatabasePath(), options = {}) {
    this.filePath = filePath;
    this.now = options.now || Date.now;
    this.db = null;
  }

  async open() {
    if (this.db) return this;
    if (this.filePath !== ':memory:') await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
    return this;
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'player')),
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS account_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        source_key TEXT UNIQUE,
        mode TEXT NOT NULL CHECK (mode IN ('single', 'multi')),
        room_code TEXT,
        completed_at INTEGER NOT NULL,
        round_count INTEGER NOT NULL,
        winner_player_id TEXT,
        winner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        winner_name TEXT NOT NULL,
        created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        final_state_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS game_participants (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        player_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('human', 'ai')),
        rank INTEGER NOT NULL,
        round_score INTEGER NOT NULL,
        total_score INTEGER NOT NULL,
        won INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS game_round_scores (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        round_number INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        display_name TEXT NOT NULL,
        round_score INTEGER NOT NULL,
        total_score INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subscription_json TEXT NOT NULL,
        user_agent TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user_expires ON account_sessions(user_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_games_completed ON games(completed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_games_source ON games(source_key);
      CREATE INDEX IF NOT EXISTS idx_participants_user ON game_participants(user_id);
      CREATE INDEX IF NOT EXISTS idx_participants_game ON game_participants(game_id);
      CREATE INDEX IF NOT EXISTS idx_round_scores_game ON game_round_scores(game_id, round_number);
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
    `);
  }

  async bootstrapAdmin({ email, password }) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;
    assertEmail(normalizedEmail);
    const existing = this.getUserRowByEmail(normalizedEmail);
    if (existing) {
      if (existing.role !== 'admin' || existing.disabled === 1) {
        this.db.prepare('UPDATE users SET role = ?, disabled = 0, updated_at = ? WHERE id = ?').run('admin', this.now(), existing.id);
      }
      return publicUser(this.getUserRowById(existing.id));
    }
    if (!password) return null;
    return this.createUser({
      email: normalizedEmail,
      displayName: normalizedEmail.split('@')[0],
      password,
      role: 'admin'
    });
  }

  getUserRowByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email));
  }

  getUserRowById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(String(id));
  }

  async createUser({ email, displayName, password, role = 'player' }) {
    const normalizedEmail = normalizeEmail(email);
    assertEmail(normalizedEmail);
    if (!validRoles.has(role)) throw new Error('Invalid account role.');
    const cleanName = normalizeDisplayName(displayName || normalizedEmail.split('@')[0]);
    const { hash, salt } = await hashPassword(password);
    const timestamp = this.now();
    const id = crypto.randomUUID();

    try {
      this.db
        .prepare(
          `INSERT INTO users (id, email, display_name, password_hash, password_salt, role, disabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .run(id, normalizedEmail, cleanName, hash, salt, role, timestamp, timestamp);
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) throw new Error('An account already exists for that email.');
      throw error;
    }

    return publicUser(this.getUserRowById(id));
  }

  async authenticate(email, password) {
    const row = this.getUserRowByEmail(email);
    if (!row || row.disabled === 1) return null;
    if (!(await verifyPassword(password, row))) return null;
    const timestamp = this.now();
    this.db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(timestamp, timestamp, row.id);
    return publicUser(this.getUserRowById(row.id));
  }

  createSession(userId, ttlMs) {
    const user = this.getUserRowById(userId);
    if (!user || user.disabled === 1) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashSessionToken(token);
    const timestamp = this.now();
    const expiresAt = timestamp + ttlMs;
    this.db
      .prepare('INSERT INTO account_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, user.id, timestamp, expiresAt);
    return { token, expiresAt, user: publicUser(user) };
  }

  getUserBySessionToken(token) {
    const tokenHash = hashSessionToken(String(token || ''));
    const timestamp = this.now();
    this.db.prepare('DELETE FROM account_sessions WHERE expires_at < ?').run(timestamp);
    const row = this.db
      .prepare(
        `SELECT users.*
         FROM account_sessions
         JOIN users ON users.id = account_sessions.user_id
         WHERE account_sessions.token_hash = ? AND account_sessions.expires_at >= ? AND users.disabled = 0`
      )
      .get(tokenHash, timestamp);
    return publicUser(row);
  }

  deleteSession(token) {
    if (!token) return;
    this.db.prepare('DELETE FROM account_sessions WHERE token_hash = ?').run(hashSessionToken(token));
  }

  async changePassword(userId, currentPassword, nextPassword) {
    const row = this.getUserRowById(userId);
    if (!row || row.disabled === 1) throw new Error('Account not found.');
    if (!(await verifyPassword(currentPassword, row))) throw new Error('Current password did not match.');
    await this.setUserPassword(userId, nextPassword);
    this.db.prepare('DELETE FROM account_sessions WHERE user_id = ?').run(userId);
  }

  async setUserPassword(userId, nextPassword) {
    const row = this.getUserRowById(userId);
    if (!row) throw new Error('Account not found.');
    const { hash, salt } = await hashPassword(nextPassword);
    this.db
      .prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?')
      .run(hash, salt, this.now(), userId);
  }

  listUsers() {
    const rows = this.db
      .prepare(
        `SELECT users.*,
          COUNT(DISTINCT game_participants.game_id) AS games_played,
          COALESCE(SUM(game_participants.won), 0) AS wins
         FROM users
         LEFT JOIN game_participants ON game_participants.user_id = users.id
         GROUP BY users.id
         ORDER BY users.created_at DESC`
      )
      .all();
    return rows.map((row) => ({
      ...publicUser(row),
      gamesPlayed: Number(row.games_played || 0),
      wins: Number(row.wins || 0)
    }));
  }

  patchUser(userId, patch) {
    const row = this.getUserRowById(userId);
    if (!row) throw new Error('Account not found.');
    const nextName = patch.displayName === undefined ? row.display_name : normalizeDisplayName(patch.displayName);
    const nextRole = patch.role === undefined ? row.role : String(patch.role);
    const nextDisabled = patch.disabled === undefined ? row.disabled : normalizeBool(patch.disabled);
    if (!validRoles.has(nextRole)) throw new Error('Invalid account role.');
    if ((row.role === 'admin' && nextRole !== 'admin') || (row.role === 'admin' && nextDisabled === 1)) {
      const adminCount = this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0").get();
      if (Number(adminCount?.count || 0) <= 1) throw new Error('Keep at least one active admin.');
    }
    this.db
      .prepare('UPDATE users SET display_name = ?, role = ?, disabled = ?, updated_at = ? WHERE id = ?')
      .run(nextName, nextRole, nextDisabled, this.now(), userId);
    return publicUser(this.getUserRowById(userId));
  }

  savePushSubscription(userId, subscription, userAgent = '') {
    const row = this.getUserRowById(userId);
    if (!row || row.disabled === 1) throw new Error('Account not found.');
    if (!isRecord(subscription) || typeof subscription.endpoint !== 'string' || !subscription.endpoint.startsWith('https://')) {
      throw new Error('Push subscription is invalid.');
    }
    if (!isRecord(subscription.keys) || typeof subscription.keys.p256dh !== 'string' || typeof subscription.keys.auth !== 'string') {
      throw new Error('Push subscription is missing keys.');
    }
    const timestamp = this.now();
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, user_id, subscription_json, user_agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           subscription_json = excluded.subscription_json,
           user_agent = excluded.user_agent,
           updated_at = excluded.updated_at`
      )
      .run(subscription.endpoint, userId, JSON.stringify(subscription), stringValue(userAgent).slice(0, 240), timestamp, timestamp);
  }

  deletePushSubscriptionForUser(userId, endpoint) {
    if (!endpoint) return;
    this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint));
  }

  deletePushSubscription(endpoint) {
    if (!endpoint) return;
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(endpoint));
  }

  listPushSubscriptionsForUsers(userIds) {
    const uniqueIds = [...new Set(userIds.filter(Boolean).map(String))];
    if (uniqueIds.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM push_subscriptions WHERE user_id IN (${placeholders(uniqueIds)})`)
      .all(...uniqueIds);
    return rows.flatMap((row) => {
      try {
        return [{
          endpoint: row.endpoint,
          userId: row.user_id,
          subscription: JSON.parse(row.subscription_json)
        }];
      } catch {
        this.deletePushSubscription(row.endpoint);
        return [];
      }
    });
  }

  recordCompletedGame({ mode, state, roomCode = null, createdByUserId = null, playerAccounts = {}, sourceKey = null }) {
    if (!isRecord(state) || !Array.isArray(state.players) || state.phase !== 'game-over') {
      throw new Error('Only completed games can be recorded.');
    }
    if (sourceKey) {
      const existing = this.db.prepare('SELECT id FROM games WHERE source_key = ?').get(sourceKey);
      if (existing?.id) return this.getGame(existing.id);
    }

    const gameId = crypto.randomUUID();
    const completedAt = this.now();
    const rankedPlayers = [...state.players].sort((left, right) => left.totalScore - right.totalScore || left.roundScore - right.roundScore);
    const winner = state.winnerId ? state.players.find((player) => player.id === state.winnerId) : rankedPlayers[0];
    const winnerUserId = winner ? playerAccounts[winner.id] || null : null;
    const roundHistory = Array.isArray(state.roundHistory) && state.roundHistory.length > 0
      ? state.roundHistory
      : [
          {
            round: Number(state.round) || 1,
            closerId: '',
            scores: state.players.map((player) => ({
              playerId: player.id,
              name: player.name,
              roundScore: Number(player.roundScore) || 0,
              totalScore: Number(player.totalScore) || 0
            }))
          }
        ];

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO games (
            id, source_key, mode, room_code, completed_at, round_count, winner_player_id, winner_user_id,
            winner_name, created_by_user_id, final_state_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          gameId,
          sourceKey,
          mode,
          roomCode,
          completedAt,
          roundHistory.length,
          winner?.id || null,
          winnerUserId,
          winner?.name || 'Unknown',
          createdByUserId,
          JSON.stringify(state)
        );

      const participantInsert = this.db.prepare(
        `INSERT INTO game_participants (
          id, game_id, user_id, player_id, display_name, kind, rank, round_score, total_score, won
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      rankedPlayers.forEach((player, index) => {
        participantInsert.run(
          crypto.randomUUID(),
          gameId,
          playerAccounts[player.id] || null,
          player.id,
          player.name,
          player.kind || 'human',
          index + 1,
          Number(player.roundScore) || 0,
          Number(player.totalScore) || 0,
          player.id === winner?.id ? 1 : 0
        );
      });

      const roundInsert = this.db.prepare(
        `INSERT INTO game_round_scores (
          id, game_id, round_number, player_id, user_id, display_name, round_score, total_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const round of roundHistory) {
        const scores = Array.isArray(round.scores) ? round.scores : [];
        for (const score of scores) {
          roundInsert.run(
            crypto.randomUUID(),
            gameId,
            Number(round.round) || 1,
            score.playerId,
            playerAccounts[score.playerId] || null,
            score.name,
            Number(score.roundScore) || 0,
            Number(score.totalScore) || 0
          );
        }
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return this.getGame(gameId);
  }

  getGame(gameId) {
    const row = this.db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!row) return null;
    return this.formatGame(row);
  }

  getGameRowsForUser(user) {
    if (user.role === 'admin') return this.db.prepare('SELECT * FROM games ORDER BY completed_at DESC').all();
    return this.db
      .prepare(
        `SELECT games.*
         FROM games
         JOIN game_participants ON game_participants.game_id = games.id
         WHERE game_participants.user_id = ?
         GROUP BY games.id
         ORDER BY games.completed_at DESC`
      )
      .all(user.id);
  }

  listVisibleGames(user) {
    return this.getGameRowsForUser(user).map((row) => this.formatGame(row));
  }

  getVisibleGame(user, gameId) {
    const game = this.getGame(gameId);
    if (!game) return null;
    if (user.role === 'admin' || game.participants.some((participant) => participant.userId === user.id)) return game;
    return null;
  }

  canViewUserStats(viewer, targetUserId) {
    if (viewer.role === 'admin' || viewer.id === targetUserId) return true;
    const row = this.db
      .prepare(
        `SELECT 1 AS ok
         FROM game_participants viewer_participant
         JOIN game_participants target_participant ON target_participant.game_id = viewer_participant.game_id
         WHERE viewer_participant.user_id = ? AND target_participant.user_id = ?
         LIMIT 1`
      )
      .get(viewer.id, targetUserId);
    return Boolean(row?.ok);
  }

  getVisiblePlayerStats(viewer, targetUserId) {
    const target = publicUser(this.getUserRowById(targetUserId));
    if (!target || !this.canViewUserStats(viewer, targetUserId)) return null;
    const games = this.listVisibleGames(viewer).filter((game) =>
      game.participants.some((participant) => participant.userId === targetUserId)
    );
    const participantRows = games
      .flatMap((game) => game.participants.map((participant) => ({ ...participant, game })))
      .filter((participant) => participant.userId === targetUserId);
    return {
      user: target,
      summary: summarizeParticipants(participantRows),
      games
    };
  }

  getStatsSummary(user) {
    const games = this.listVisibleGames(user);
    const selfParticipants = games
      .flatMap((game) => game.participants.map((participant) => ({ ...participant, game })))
      .filter((participant) => participant.userId === user.id);
    const coPlayers = new Map();
    for (const game of games) {
      const selfInGame = game.participants.some((participant) => participant.userId === user.id);
      if (!selfInGame && user.role !== 'admin') continue;
      for (const participant of game.participants) {
        if (!participant.userId || participant.userId === user.id || participant.kind !== 'human') continue;
        const current = coPlayers.get(participant.userId) || {
          userId: participant.userId,
          displayName: participant.displayName,
          gamesTogether: 0,
          wins: 0,
          totalScoreSum: 0,
          latestAt: 0
        };
        current.gamesTogether += 1;
        current.wins += participant.won ? 1 : 0;
        current.totalScoreSum += participant.totalScore;
        current.latestAt = Math.max(current.latestAt, game.completedAt);
        coPlayers.set(participant.userId, current);
      }
    }

    return {
      self: summarizeParticipants(selfParticipants),
      coPlayers: [...coPlayers.values()]
        .map((player) => ({
          ...player,
          averageTotalScore: player.gamesTogether ? Math.round((player.totalScoreSum / player.gamesTogether) * 10) / 10 : 0
        }))
        .sort((left, right) => right.gamesTogether - left.gamesTogether || left.averageTotalScore - right.averageTotalScore),
      recentGames: games.slice(0, 8),
      admin: user.role === 'admin'
        ? {
            users: Number(this.db.prepare('SELECT COUNT(*) AS count FROM users').get()?.count || 0),
            games: Number(this.db.prepare('SELECT COUNT(*) AS count FROM games').get()?.count || 0)
          }
        : null
    };
  }

  formatGame(row) {
    const participants = this.db
      .prepare('SELECT * FROM game_participants WHERE game_id = ? ORDER BY rank ASC')
      .all(row.id)
      .map((participant) => ({
        id: participant.id,
        userId: participant.user_id ?? null,
        playerId: participant.player_id,
        displayName: participant.display_name,
        kind: participant.kind,
        rank: Number(participant.rank),
        roundScore: Number(participant.round_score),
        totalScore: Number(participant.total_score),
        won: participant.won === 1
      }));
    const rounds = this.db
      .prepare('SELECT * FROM game_round_scores WHERE game_id = ? ORDER BY round_number ASC, rowid ASC')
      .all(row.id)
      .map((score) => ({
        id: score.id,
        round: Number(score.round_number),
        playerId: score.player_id,
        userId: score.user_id ?? null,
        displayName: score.display_name,
        roundScore: Number(score.round_score),
        totalScore: Number(score.total_score)
      }));
    return {
      id: row.id,
      mode: row.mode,
      roomCode: row.room_code ?? null,
      completedAt: Number(row.completed_at),
      roundCount: Number(row.round_count),
      winnerPlayerId: row.winner_player_id ?? null,
      winnerUserId: row.winner_user_id ?? null,
      winnerName: row.winner_name,
      createdByUserId: row.created_by_user_id ?? null,
      participants,
      rounds
    };
  }
}

function summarizeParticipants(participants) {
  const gamesPlayed = participants.length;
  const wins = participants.filter((participant) => participant.won).length;
  const multiplayerGames = participants.filter((participant) => participant.game?.mode === 'multi').length;
  const singlePlayerGames = participants.filter((participant) => participant.game?.mode === 'single').length;
  const scores = participants.map((participant) => participant.totalScore);
  const scoreSum = scores.reduce((total, score) => total + score, 0);
  return {
    gamesPlayed,
    wins,
    multiplayerGames,
    singlePlayerGames,
    winRate: gamesPlayed ? Math.round((wins / gamesPlayed) * 1000) / 10 : 0,
    averageTotalScore: gamesPlayed ? Math.round((scoreSum / gamesPlayed) * 10) / 10 : 0,
    bestTotalScore: scores.length ? Math.min(...scores) : null
  };
}

export async function createAccountStore(options = {}) {
  const store = new AccountStore(options.filePath || resolveAccountDatabasePath(options.env), { now: options.now });
  await store.open();
  return store;
}
