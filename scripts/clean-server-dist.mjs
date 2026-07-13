import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(root, 'server-dist');
if (path.dirname(target) !== root || path.basename(target) !== 'server-dist') {
  throw new Error('Refusing to clean an unexpected server build directory.');
}
await fs.rm(target, { force: true, recursive: true });
