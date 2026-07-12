import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('the direct controller waits for asynchronous SQLite backup and terminal output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-direct-controller-'));
  try {
    const sourcePath = path.join(root, 'source.sqlite');
    const backupPath = path.join(root, 'backup.sqlite');
    const ledgerPath = path.join(root, 'ledger.json');
    const source = new DatabaseSync(sourcePath);
    source.exec('CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES (\'completed\');');
    source.close();

    const fixture = path.join(import.meta.dirname, 'fixtures', 'direct-await-sqlite.mjs');
    const execution = await execFileAsync(process.execPath, [fixture, sourcePath, backupPath, ledgerPath]);
    assert.equal(execution.stdout, `${JSON.stringify({ verified: 'a'.repeat(40), activated: false })}\n`);
    assert.deepEqual(JSON.parse(await fs.readFile(ledgerPath, 'utf8')), { status: 'completed' });

    const restored = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(restored.prepare('SELECT value FROM proof').get().value, 'completed');
    } finally {
      restored.close();
    }

    const controller = await fs.readFile(path.resolve(import.meta.dirname, '..', 'release-controller.mjs'), 'utf8');
    assert.match(controller, /if \(isDirectExecution\) \{\s*await invokeDirectController\(\);\s*\}/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a failed direct controller exits nonzero and never emits a completion envelope', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-direct-controller-failure-'));
  try {
    const fixture = path.join(import.meta.dirname, 'fixtures', 'direct-await-sqlite.mjs');
    await assert.rejects(
      execFileAsync(process.execPath, [fixture, path.join(root, 'unused.sqlite'), path.join(root, 'unused-backup.sqlite'), path.join(root, 'ledger.json'), 'fail']),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /Release controller failed:.*injected direct controller failure/);
        return true;
      }
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
