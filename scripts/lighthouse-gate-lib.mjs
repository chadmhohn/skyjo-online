import os from 'node:os';
import path from 'node:path';

function normalizeWindowsPath(value) {
  return path.win32.resolve(String(value).replace(/^\\\\\?\\/, '')).toLowerCase();
}

export function isIgnorableWindowsChromeCleanupError(
  error,
  { platform = process.platform, tempDirectory = os.tmpdir() } = {}
) {
  if (platform !== 'win32' || !error || !['EBUSY', 'EPERM'].includes(error.code)) return false;
  if (error.syscall !== 'rm' || typeof error.path !== 'string') return false;

  const cleanupPath = normalizeWindowsPath(error.path);
  const tempPath = normalizeWindowsPath(tempDirectory);
  return path.win32.dirname(cleanupPath) === tempPath
    && /^lighthouse\.[a-z0-9_-]+$/i.test(path.win32.basename(cleanupPath));
}
