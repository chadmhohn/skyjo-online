import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createStateBackup,
  resolveStateSourcePaths,
  restoreStateBackup,
  verifyStateBackup
} from '../server-state-backup.mjs';

export const RETENTION = Object.freeze({ daily: 30, monthly: 12 });
const backupNamePattern = /^(daily|monthly)-([0-9]{8}T[0-9]{6}Z)$/;
const drillNamePattern = /^monthly-([0-9]{8}T[0-9]{6}Z)\.json$/;

function normalizedDate(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('Scheduled backup timestamp is invalid.');
  return date;
}

function timestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function scheduledBackupName(kind, now) {
  if (!(kind in RETENTION)) throw new Error('Scheduled backup kind must be daily or monthly.');
  return `${kind}-${timestamp(normalizedDate(now))}`;
}

async function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Operations path must be a real directory.');
  await fs.chmod(resolved, 0o700);
  return resolved;
}

function pathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function listBackups(categoryDirectory, kind) {
  const entries = await fs.readdir(categoryDirectory, { withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    const match = entry.name.match(backupNamePattern);
    if (!match || match[1] !== kind || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Unexpected entry in the ${kind} scheduled-backup namespace.`);
    }
    matches.push(entry.name);
  }
  return matches.sort().reverse();
}

export async function enforceBackupRetention(categoryDirectory, kind, keep = RETENTION[kind]) {
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 366) throw new Error('Scheduled-backup retention is invalid.');
  const root = path.resolve(categoryDirectory);
  const names = await listBackups(root, kind);
  const pruned = [];
  for (const name of names.slice(keep)) {
    const candidate = path.resolve(root, name);
    if (!pathInside(root, candidate) || path.basename(candidate) !== name) throw new Error('Scheduled-backup prune target escaped its namespace.');
    await verifyStateBackup(candidate);
    await fs.rm(candidate, { recursive: true, force: false });
    pruned.push(name);
  }
  return { retained: names.slice(0, keep), pruned };
}

async function writeDrillEvidence(directory, backupName, manifest, now) {
  const match = backupName.match(/^monthly-([0-9]{8}T[0-9]{6}Z)$/);
  if (!match) throw new Error('Restore drill requires a monthly backup.');
  const evidence = {
    formatVersion: 1,
    status: 'verified',
    backup: backupName,
    checkedAt: normalizedDate(now).toISOString(),
    manifestSha256: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    releaseSha: manifest.metadata.releaseSha,
    schemaVersion: manifest.metadata.schemaVersion,
    protocolVersion: manifest.metadata.protocolVersion
  };
  const finalPath = path.join(directory, `monthly-${match[1]}.json`);
  const temporary = `${finalPath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, finalPath);
  await fs.chmod(finalPath, 0o600);
  return evidence;
}

async function enforceDrillRetention(directory, keep = RETENTION.monthly) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!drillNamePattern.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('Unexpected entry in the restore-drill evidence namespace.');
    }
    names.push(entry.name);
  }
  names.sort().reverse();
  for (const name of names.slice(keep)) {
    const target = path.resolve(directory, name);
    if (!pathInside(path.resolve(directory), target)) throw new Error('Restore-drill prune target escaped its namespace.');
    await fs.rm(target, { force: false });
  }
  return names.slice(0, keep);
}

export async function runScheduledBackup(options = {}) {
  const kind = options.kind;
  if (!(kind in RETENTION)) throw new Error('Scheduled backup kind must be daily or monthly.');
  const date = normalizedDate(options.now);
  const name = scheduledBackupName(kind, date);
  const backupRoot = await ensurePrivateDirectory(options.backupRoot || '/var/backups/skyjo-online/scheduled');
  const categoryDirectory = await ensurePrivateDirectory(path.join(backupRoot, kind));
  const drillDirectory = await ensurePrivateDirectory(path.join(backupRoot, 'drills'));
  const restoreRoot = kind === 'monthly'
    ? await ensurePrivateDirectory(options.restoreRoot || '/var/tmp/skyjo-restore-drills')
    : null;
  const sourcePaths = resolveStateSourcePaths(options.env || process.env);
  const destinationDirectory = path.join(categoryDirectory, name);

  const manifest = await createStateBackup({
    destinationDirectory,
    ...sourcePaths,
    now: date
  });
  await verifyStateBackup(destinationDirectory);

  let drill = null;
  if (kind === 'monthly') {
    const restoreDirectory = path.join(restoreRoot, `.restore-${name}-${process.pid}`);
    if (!pathInside(restoreRoot, restoreDirectory)) throw new Error('Restore-drill target escaped its namespace.');
    try {
      const restored = await restoreStateBackup(destinationDirectory, {
        destinationDirectory: restoreDirectory,
        livePaths: Object.values(sourcePaths)
      });
      if (restored.manifest.metadata.releaseSha !== manifest.metadata.releaseSha) {
        throw new Error('Restored backup release identity changed during the drill.');
      }
      drill = await writeDrillEvidence(drillDirectory, name, manifest, date);
    } finally {
      await fs.rm(restoreDirectory, { recursive: true, force: true });
    }
  }

  const retention = await enforceBackupRetention(categoryDirectory, kind, options.keep || RETENTION[kind]);
  if (kind === 'monthly') await enforceDrillRetention(drillDirectory, options.keep || RETENTION.monthly);
  return {
    formatVersion: 1,
    kind,
    backup: name,
    createdAt: manifest.createdAt,
    releaseSha: manifest.metadata.releaseSha,
    schemaVersion: manifest.metadata.schemaVersion,
    protocolVersion: manifest.metadata.protocolVersion,
    restoreDrill: drill?.status || null,
    retained: retention.retained.length,
    pruned: retention.pruned.length
  };
}
