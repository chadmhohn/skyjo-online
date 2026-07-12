import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const scryptAsync = promisify(crypto.scrypt);
const defaultDbFile = path.join('.data', 'skyjo.sqlite');
const validRoles = new Set(['admin', 'player']);
const publicApiErrors = new Map([
  ['INVALID_EMAIL', Object.freeze({ status: 400, message: 'Enter a valid email address.' })],
  ['WEAK_PASSWORD', Object.freeze({ status: 400, message: 'Use a password with at least 8 characters.' })],
  ['INVALID_ROLE', Object.freeze({ status: 400, message: 'Invalid account role.' })],
  ['ACCOUNT_EXISTS', Object.freeze({ status: 400, message: 'An account already exists for that email.' })],
  ['ACCOUNT_NOT_FOUND', Object.freeze({ status: 400, message: 'Account not found.' })],
  ['CURRENT_PASSWORD_MISMATCH', Object.freeze({ status: 400, message: 'Current password did not match.' })],
  ['LAST_ADMIN', Object.freeze({ status: 400, message: 'Keep at least one active admin.' })],
  ['INVALID_PUSH_SUBSCRIPTION', Object.freeze({ status: 400, message: 'Push subscription is invalid.' })],
  ['MISSING_PUSH_KEYS', Object.freeze({ status: 400, message: 'Push subscription is missing keys.' })],
  ['INCOMPLETE_GAME', Object.freeze({ status: 400, message: 'Only completed games can be recorded.' })],
  ['INVALID_ROOM_CODE', Object.freeze({ status: 400, message: 'Room code is not valid.' })],
  ['PASSWORDS_MUST_MATCH', Object.freeze({ status: 400, message: 'Passwords must match.' })],
  ['MISSING_HUMAN_PLAYER', Object.freeze({ status: 400, message: 'Single-player game is missing a human player.' })],
  ['REQUEST_TOO_LARGE', Object.freeze({ status: 413, message: 'Request body too large.' })],
  ['INVALID_JSON', Object.freeze({ status: 400, message: 'Request body must be valid JSON.' })],
  ['EXPECTED_JSON_OBJECT', Object.freeze({ status: 400, message: 'Expected a JSON object.' })],
  ['CODE_ALLOCATION_FAILED', Object.freeze({ status: 503, message: 'A secure code could not be created. Try again.' })]
]);
const unknownApiError = Object.freeze({ status: 500, message: 'Request failed.' });

export class PublicApiError extends Error {
  constructor(code) {
    super(publicApiErrors.get(code)?.message || unknownApiError.message);
    if (!publicApiErrors.has(code)) throw new TypeError('Unknown public API error code.');
    this.name = 'PublicApiError';
    this.code = code;
  }
}

export function publicApiErrorResponse(error) {
  if (!(error instanceof PublicApiError)) return unknownApiError;
  return publicApiErrors.get(error.code) || unknownApiError;
}

export function createUniqueRandomCode({
  alphabet,
  length,
  isTaken = () => false,
  randomInt = (maximum) => crypto.randomInt(maximum),
  maxAttempts = 128
}) {
  if (typeof alphabet !== 'string' || alphabet.length < 2 || new Set(alphabet).size !== alphabet.length) {
    throw new TypeError('Secure code alphabet must contain unique characters.');
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > 128) {
    throw new TypeError('Secure code length is invalid.');
  }
  if (typeof isTaken !== 'function' || typeof randomInt !== 'function') {
    throw new TypeError('Secure code callbacks are invalid.');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 4096) {
    throw new TypeError('Secure code attempt limit is invalid.');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let code = '';
    for (let index = 0; index < length; index += 1) {
      const alphabetIndex = randomInt(alphabet.length);
      if (!Number.isSafeInteger(alphabetIndex) || alphabetIndex < 0 || alphabetIndex >= alphabet.length) {
        throw new TypeError('Secure random source returned an invalid index.');
      }
      code += alphabet[alphabetIndex];
    }
    if (!isTaken(code)) return code;
  }

  throw new PublicApiError('CODE_ALLOCATION_FAILED');
}

const baseSchemaSql = `
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
`;

const inviteCodesSchemaSql = `
  CREATE TABLE invite_codes (
    code_lookup_hash TEXT PRIMARY KEY,
    room_code TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    redeemed_at INTEGER,
    CHECK (length(code_lookup_hash) = 64),
    CHECK (length(room_code) = 5)
  );
  CREATE INDEX idx_invite_codes_expires ON invite_codes(expires_at);
`;

function migrationChecksum(version, name, sql) {
  return crypto.createHash('sha256').update(`${version}:${name}\n${sql.trim()}\n`).digest('hex');
}

export const SCHEMA_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'adopt-account-schema',
    checksum: migrationChecksum(1, 'adopt-account-schema', baseSchemaSql)
  }),
  Object.freeze({
    version: 2,
    name: 'invite-codes-and-ai-finish',
    checksum: migrationChecksum(
      2,
      'invite-codes-and-ai-finish',
      `${inviteCodesSchemaSql}\nALTER TABLE games ADD COLUMN finished_by_ai INTEGER NOT NULL DEFAULT 0;`
    )
  })
]);

export const CURRENT_SCHEMA_VERSION = SCHEMA_MIGRATIONS.at(-1).version;

const baselineColumns = Object.freeze({
  users: ['id', 'email', 'display_name', 'password_hash', 'password_salt', 'role', 'disabled', 'created_at', 'updated_at', 'last_login_at'],
  account_sessions: ['token_hash', 'user_id', 'created_at', 'expires_at'],
  games: [
    'id',
    'source_key',
    'mode',
    'room_code',
    'completed_at',
    'round_count',
    'winner_player_id',
    'winner_user_id',
    'winner_name',
    'created_by_user_id',
    'final_state_json'
  ],
  game_participants: ['id', 'game_id', 'user_id', 'player_id', 'display_name', 'kind', 'rank', 'round_score', 'total_score', 'won'],
  game_round_scores: ['id', 'game_id', 'round_number', 'player_id', 'user_id', 'display_name', 'round_score', 'total_score'],
  push_subscriptions: ['endpoint', 'user_id', 'subscription_json', 'user_agent', 'created_at', 'updated_at']
});

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName)?.found);
}

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all();
}

function validateBaselineSchema(db, { allowMigrationTables = false } = {}) {
  const expectedTables = new Set(Object.keys(baselineColumns));
  const allowedExtraTables = allowMigrationTables ? new Set(['schema_migrations', 'invite_codes']) : new Set();
  const existingTables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);

  for (const tableName of expectedTables) {
    if (!existingTables.includes(tableName)) throw new Error('Legacy database does not match the expected baseline schema.');
    const columns = new Map(tableColumns(db, tableName).map((column) => [column.name, column]));
    for (const columnName of baselineColumns[tableName]) {
      if (!columns.has(columnName)) throw new Error('Legacy database does not match the expected baseline schema.');
    }
  }
  if (existingTables.some((tableName) => !expectedTables.has(tableName) && !allowedExtraTables.has(tableName))) {
    throw new Error('Legacy database contains an unsupported table.');
  }

  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('Database integrity validation failed.');
  if (db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('Database foreign key validation failed.');
}

function validateMigrationRows(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    const expected = SCHEMA_MIGRATIONS[index];
    const row = rows[index];
    if (!expected || row.version !== expected.version) throw new Error('Unsupported or non-contiguous database migration history.');
    if (row.name !== expected.name || row.checksum !== expected.checksum) throw new Error('Database migration checksum validation failed.');
  }
}

function validateCurrentSchema(db) {
  validateBaselineSchema(db, { allowMigrationTables: true });
  const gamesColumn = tableColumns(db, 'games').find((column) => column.name === 'finished_by_ai');
  if (!gamesColumn || gamesColumn.type !== 'INTEGER' || gamesColumn.notnull !== 1 || String(gamesColumn.dflt_value) !== '0') {
    throw new Error('Database finished-by-AI schema validation failed.');
  }
  const inviteColumns = tableColumns(db, 'invite_codes');
  const inviteColumnNames = inviteColumns.map((column) => column.name);
  const expectedInviteColumns = ['code_lookup_hash', 'room_code', 'created_at', 'expires_at', 'redeemed_at'];
  if (
    expectedInviteColumns.some((column) => !inviteColumnNames.includes(column)) ||
    inviteColumnNames.includes('code') ||
    inviteColumnNames.includes('invite_token')
  ) {
    throw new Error('Database invite-code schema validation failed.');
  }
}

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
    throw new PublicApiError('INVALID_EMAIL');
  }
}

function assertPassword(password) {
  if (stringValue(password).length < 8) throw new PublicApiError('WEAK_PASSWORD');
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
    try {
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.migrate();
      return this;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  migrate() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const hadMigrationTable = tableExists(this.db, 'schema_migrations');
      if (!hadMigrationTable) {
        this.db.exec(`
          CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_at INTEGER NOT NULL
          );
        `);
      }

      const rows = this.db.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').all();
      validateMigrationRows(rows);

      if (rows.length === 0) {
        const applicationTables = this.db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'")
          .all();
        if (applicationTables.length > 0) validateBaselineSchema(this.db, { allowMigrationTables: true });
        this.db.exec(baseSchemaSql);
        validateBaselineSchema(this.db, { allowMigrationTables: true });
        const migration = SCHEMA_MIGRATIONS[0];
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
          .run(migration.version, migration.name, migration.checksum, this.now());
        rows.push({ ...migration, applied_at: this.now() });
      } else {
        validateBaselineSchema(this.db, { allowMigrationTables: true });
      }

      if (rows.length === 1) {
        if (tableColumns(this.db, 'games').some((column) => column.name === 'finished_by_ai') || tableExists(this.db, 'invite_codes')) {
          throw new Error('Database contains a partially applied migration.');
        }
        this.db.exec('ALTER TABLE games ADD COLUMN finished_by_ai INTEGER NOT NULL DEFAULT 0');
        this.db.exec(inviteCodesSchemaSql);
        const migration = SCHEMA_MIGRATIONS[1];
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
          .run(migration.version, migration.name, migration.checksum, this.now());
        rows.push({ ...migration, applied_at: this.now() });
      }

      validateMigrationRows(rows);
      if (rows.length !== CURRENT_SCHEMA_VERSION) throw new Error('Database schema is not current.');
      validateCurrentSchema(this.db);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getSchemaVersion() {
    const row = this.db?.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
    return Number(row?.version || 0);
  }

  checkReadiness() {
    try {
      if (!this.db || this.getSchemaVersion() !== CURRENT_SCHEMA_VERSION) return false;
      if (this.db.prepare('SELECT 1 AS ready').get()?.ready !== 1) return false;
      return this.db.prepare('PRAGMA quick_check').all().every((row) => row.quick_check === 'ok');
    } catch {
      return false;
    }
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
    if (!validRoles.has(role)) throw new PublicApiError('INVALID_ROLE');
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
      if (String(error?.message || '').includes('UNIQUE')) throw new PublicApiError('ACCOUNT_EXISTS');
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
    if (!row || row.disabled === 1) throw new PublicApiError('ACCOUNT_NOT_FOUND');
    if (!(await verifyPassword(currentPassword, row))) throw new PublicApiError('CURRENT_PASSWORD_MISMATCH');
    await this.setUserPassword(userId, nextPassword);
    this.db.prepare('DELETE FROM account_sessions WHERE user_id = ?').run(userId);
  }

  async setUserPassword(userId, nextPassword) {
    const row = this.getUserRowById(userId);
    if (!row) throw new PublicApiError('ACCOUNT_NOT_FOUND');
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
    if (!row) throw new PublicApiError('ACCOUNT_NOT_FOUND');
    const nextName = patch.displayName === undefined ? row.display_name : normalizeDisplayName(patch.displayName);
    const nextRole = patch.role === undefined ? row.role : String(patch.role);
    const nextDisabled = patch.disabled === undefined ? row.disabled : normalizeBool(patch.disabled);
    if (!validRoles.has(nextRole)) throw new PublicApiError('INVALID_ROLE');
    if ((row.role === 'admin' && nextRole !== 'admin') || (row.role === 'admin' && nextDisabled === 1)) {
      const adminCount = this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0").get();
      if (Number(adminCount?.count || 0) <= 1) throw new PublicApiError('LAST_ADMIN');
    }
    this.db
      .prepare('UPDATE users SET display_name = ?, role = ?, disabled = ?, updated_at = ? WHERE id = ?')
      .run(nextName, nextRole, nextDisabled, this.now(), userId);
    return publicUser(this.getUserRowById(userId));
  }

  savePushSubscription(userId, subscription, userAgent = '') {
    const row = this.getUserRowById(userId);
    if (!row || row.disabled === 1) throw new PublicApiError('ACCOUNT_NOT_FOUND');
    if (!isRecord(subscription) || typeof subscription.endpoint !== 'string' || !subscription.endpoint.startsWith('https://')) {
      throw new PublicApiError('INVALID_PUSH_SUBSCRIPTION');
    }
    if (!isRecord(subscription.keys) || typeof subscription.keys.p256dh !== 'string' || typeof subscription.keys.auth !== 'string') {
      throw new PublicApiError('MISSING_PUSH_KEYS');
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

  recordCompletedGame({
    mode,
    state,
    roomCode = null,
    createdByUserId = null,
    playerAccounts = {},
    sourceKey = null,
    finishedByAi = false
  }) {
    if (!isRecord(state) || !Array.isArray(state.players) || state.phase !== 'game-over') {
      throw new PublicApiError('INCOMPLETE_GAME');
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
            winner_name, created_by_user_id, final_state_json, finished_by_ai
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          JSON.stringify(state),
          normalizeBool(finishedByAi)
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
      finishedByAi: row.finished_by_ai === 1,
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
