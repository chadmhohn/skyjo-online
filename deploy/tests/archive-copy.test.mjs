import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyArchive } from '../release-controller.mjs';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function withinDeadline(operation, milliseconds = 3000) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Archive copy exceeded its deadline.')), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function instrumentedOpen({ sourcePath, destinationPath, maxWriteBytes, failWriteAt = Infinity, observations }) {
  return async (targetPath, flags, mode) => {
    const handle = await fs.open(targetPath, flags, mode);
    if (targetPath === sourcePath) {
      return {
        stat: () => handle.stat(),
        read: (buffer, offset, length, position) => {
          observations.maxReadBytes = Math.max(observations.maxReadBytes, length);
          return handle.read(buffer, offset, length, position);
        },
        close: async () => {
          observations.sourceCloses += 1;
          await handle.close();
        }
      };
    }
    assert.equal(targetPath, destinationPath);
    return {
      write: (buffer, offset, length, position) => {
        observations.writeCalls += 1;
        if (observations.writeCalls === failWriteAt) throw observations.writeFailure;
        const partialLength = Math.min(length, maxWriteBytes);
        observations.maxWriteBytes = Math.max(observations.maxWriteBytes, partialLength);
        return handle.write(buffer, offset, partialLength, position);
      },
      sync: () => handle.sync(),
      close: async () => {
        observations.destinationCloses += 1;
        await handle.close();
      }
    };
  };
}

async function fixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-archive-copy-'));
  try { await callback(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('archive copy handles multiple chunks and partial writes without stream handles', async () => fixture(async (root) => {
  const sourcePath = path.join(root, 'source.tar.gz');
  const destinationPath = path.join(root, 'destination.tar.gz');
  const payload = crypto.randomBytes((64 * 1024 * 3) + 9173);
  await fs.writeFile(sourcePath, payload);
  const observations = {
    maxReadBytes: 0,
    maxWriteBytes: 0,
    writeCalls: 0,
    sourceCloses: 0,
    destinationCloses: 0,
    writeFailure: null
  };
  const copied = await withinDeadline(copyArchive(sourcePath, destinationPath, {
    openFile: instrumentedOpen({ sourcePath, destinationPath, maxWriteBytes: 7001, observations })
  }));
  const actual = await fs.readFile(destinationPath);
  assert.equal(copied, payload.length);
  assert.equal(actual.length, payload.length);
  assert.equal(digest(actual), digest(payload));
  assert(observations.writeCalls > Math.ceil(payload.length / (64 * 1024)), 'short writes must be retried');
  assert(observations.maxReadBytes <= 64 * 1024);
  assert(observations.maxWriteBytes <= 7001);
  assert.equal(observations.sourceCloses, 1);
  assert.equal(observations.destinationCloses, 1);

  await fs.rename(sourcePath, path.join(root, 'source-closed.tar.gz'));
  await fs.rename(destinationPath, path.join(root, 'destination-closed.tar.gz'));
}));

test('archive copy closes both handles and removes a partial destination on write failure', async () => fixture(async (root) => {
  const sourcePath = path.join(root, 'source.tar.gz');
  const destinationPath = path.join(root, 'destination.tar.gz');
  const payload = crypto.randomBytes((64 * 1024) + 31);
  await fs.writeFile(sourcePath, payload);
  const writeFailure = new Error('injected archive write failure');
  const observations = {
    maxReadBytes: 0,
    maxWriteBytes: 0,
    writeCalls: 0,
    sourceCloses: 0,
    destinationCloses: 0,
    writeFailure
  };
  await assert.rejects(withinDeadline(copyArchive(sourcePath, destinationPath, {
    openFile: instrumentedOpen({ sourcePath, destinationPath, maxWriteBytes: 4096, failWriteAt: 3, observations })
  })), (error) => error === writeFailure);
  assert.equal(observations.sourceCloses, 1);
  assert.equal(observations.destinationCloses, 1);
  assert.equal(digest(await fs.readFile(sourcePath)), digest(payload));
  await assert.rejects(fs.lstat(destinationPath), (error) => error.code === 'ENOENT');
}));

test('the production archive copy no longer creates FileHandle streams', async () => {
  const source = await fs.readFile(path.resolve(import.meta.dirname, '..', 'release-controller.mjs'), 'utf8');
  assert.doesNotMatch(source, /createReadStream|createWriteStream|pipeline\s*\(/);
});
