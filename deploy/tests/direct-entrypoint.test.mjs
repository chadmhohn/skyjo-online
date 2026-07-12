import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { invokeDirectController } from '../release-controller.mjs';

const execFileAsync = promisify(execFile);

function createProofDatabase(sourcePath) {
  const source = new DatabaseSync(sourcePath);
  try {
    source.exec('CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES (\'completed\');');
  } finally {
    source.close();
  }
}

test('the controller lifecycle keepalive is explicitly refed and cleared', async () => {
  const calls = [];
  const timer = { ref: () => calls.push('ref') };
  const result = await invokeDirectController(
    async () => { calls.push('main'); return 'complete'; },
    ['node', 'release-controller.mjs', 'verify'],
    {
      setIntervalImpl: (callback, milliseconds) => {
        assert.equal(typeof callback, 'function');
        assert.equal(milliseconds, 60_000);
        calls.push('set');
        return timer;
      },
      clearIntervalImpl: (value) => {
        assert.equal(value, timer);
        calls.push('clear');
      }
    }
  );
  assert.equal(result, 'complete');
  assert.deepEqual(calls, ['set', 'ref', 'main', 'clear']);
});

test('the direct controller keepalive spans SQLite backup, later cleanup, and terminal output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-direct-controller-'));
  try {
    const sourcePath = path.join(root, 'source.sqlite');
    const backupPath = path.join(root, 'backup.sqlite');
    const ledgerPath = path.join(root, 'ledger.json');
    createProofDatabase(sourcePath);

    const fixture = path.join(import.meta.dirname, 'fixtures', 'direct-await-sqlite.mjs');
    const execution = await execFileAsync(process.execPath, [fixture, sourcePath, backupPath, ledgerPath], { timeout: 5000 });
    assert.equal(execution.stdout, `${JSON.stringify({ verified: 'a'.repeat(40), activated: false })}\n`);
    assert.deepEqual(JSON.parse(await fs.readFile(ledgerPath, 'utf8')), { status: 'completed' });
    await assert.rejects(fs.lstat(`${backupPath}.run-residue`), (error) => error.code === 'ENOENT');

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

test('the child-process baseline exits 13 when top-level await has no referenced work', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-unsettled-controller-'));
  try {
    const fixture = path.join(import.meta.dirname, 'fixtures', 'direct-await-sqlite.mjs');
    const ledgerPath = path.join(root, 'ledger.json');
    await assert.rejects(
      execFileAsync(process.execPath, [fixture, path.join(root, 'unused.sqlite'), path.join(root, 'unused-backup.sqlite'), ledgerPath, 'unsettled'], { timeout: 5000 }),
      (error) => {
        assert.equal(error.code, 13);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /unsettled top-level await/i);
        return true;
      }
    );
    assert.deepEqual(JSON.parse(await fs.readFile(ledgerPath, 'utf8')), { status: 'started' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a post-backup failure cleans residue, terminalizes the ledger, and exits without a leaked timer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-direct-controller-failure-'));
  try {
    const fixture = path.join(import.meta.dirname, 'fixtures', 'direct-await-sqlite.mjs');
    const sourcePath = path.join(root, 'source.sqlite');
    const backupPath = path.join(root, 'backup.sqlite');
    const ledgerPath = path.join(root, 'ledger.json');
    createProofDatabase(sourcePath);
    await assert.rejects(
      execFileAsync(process.execPath, [fixture, sourcePath, backupPath, ledgerPath, 'cleanup-fail'], { timeout: 5000 }),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /Release controller failed:.*injected post-backup cleanup failure/);
        return true;
      }
    );
    assert.deepEqual(JSON.parse(await fs.readFile(ledgerPath, 'utf8')), { status: 'failed' });
    await assert.rejects(fs.lstat(`${backupPath}.run-residue`), (error) => error.code === 'ENOENT');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
