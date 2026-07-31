import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  RELEASE_FORMAT_VERSION,
  writeReleaseIdentity
} from '../../../server-release.mjs';
import { sensitiveBinaryLogRepresentations } from '../../../server-apns-rollback-proof.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const helperUrl = pathToFileURL(path.join(root, 'server-apns-rollback-proof.mjs')).href;
const releaseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
await writeReleaseIdentity(path.join(root, 'dist'), {
  formatVersion: RELEASE_FORMAT_VERSION,
  releaseSha,
  buildTimestamp: '2026-07-28T00:00:00.000Z',
  schemaVersion: CURRENT_SCHEMA_VERSION,
  protocolVersion: CURRENT_PROTOCOL_VERSION
});
const markerPrefix = 'APNS_PROOF_TEST_READY=';
const forcedMismatchValue = 'FORCED-APNS-ROW-MISMATCH-ACTUAL';
const fixedNow = Date.parse('2026-07-28T00:00:00.000Z');
const rowNeedles = [
  'APNS-ROW-MUST-NEVER-REACH-LOGS',
  '30000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000203',
  'APNS-APP-VERSION-MUST-NEVER-REACH-LOGS',
  'apns-locale-must-never-reach-logs',
  String(fixedNow),
  String(fixedNow + 1),
  ...sensitiveBinaryLogRepresentations(
    Buffer.from('APNS-ROW-MUST-NEVER-REACH-LOGS', 'utf8').toString('hex')
  ),
  ...sensitiveBinaryLogRepresentations('000102030405060708090a0b'),
  ...sensitiveBinaryLogRepresentations('00112233445566778899aabbccddeeff'),
  ...sensitiveBinaryLogRepresentations('ef'.repeat(32))
];

const driverSource = `
import { DatabaseSync } from 'node:sqlite';
import { runApnsRollbackProof } from ${JSON.stringify(helperUrl)};

const mode = process.argv[1];
const expectedReleaseSha = process.argv[2];
const markerPrefix = ${JSON.stringify(markerPrefix)};
const forcedMismatchValue = ${JSON.stringify(forcedMismatchValue)};
const holdForTermination = ({ childProcessIds, signal, temporaryDirectory }) => {
  process.stdout.write(markerPrefix + JSON.stringify({ childProcessIds, temporaryDirectory }) + '\\n');
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', resolve, { once: true });
  });
};

try {
  await runApnsRollbackProof({
    expectedReleaseSha,
    proofTimeoutMs: mode === 'timeout' ? 250 : 60_000,
    testHooks: {
      afterServersStarted: mode === 'signal' || mode === 'timeout' ? holdForTermination : undefined,
      beforeFirstRowVerification: mode === 'mismatch'
        ? ({ copiedDatabase }) => {
            const database = new DatabaseSync(copiedDatabase);
            try {
              database.prepare('UPDATE apns_devices SET locale = ?').run(forcedMismatchValue);
            } finally {
              database.close();
            }
          }
        : undefined
    }
  });
} catch (error) {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : 'APNs rollback proof failed.';
  process.stderr.write(name + ': ' + message + '\\n');
  process.exitCode = Number.isSafeInteger(error?.exitCode) ? error.exitCode : 1;
}
`;

type Driver = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  close: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  marker: Promise<{ childProcessIds: number[]; temporaryDirectory: string }>;
  output: { stdout: string; stderr: string };
};

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds);
    })
  ]);
}

function startDriver(mode: 'mismatch' | 'signal' | 'timeout'): Driver {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', driverSource, mode, releaseSha],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk: string) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { output.stderr += chunk; });

  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const marker = new Promise<{ childProcessIds: number[]; temporaryDirectory: string }>((resolve, reject) => {
    const inspect = () => {
      const line = output.stdout
        .split('\n')
        .find((candidate) => candidate.startsWith(markerPrefix));
      if (!line) return;
      child.stdout.off('data', inspect);
      try {
        resolve(JSON.parse(line.slice(markerPrefix.length)));
      } catch (error) {
        reject(error);
      }
    };
    child.stdout.on('data', inspect);
    close.then(
      () => {
        inspect();
        reject(new Error('APNs rollback proof exited before the nested-server marker.'));
      },
      reject
    );
  });
  void marker.catch(() => {});
  return { child, close, marker, output };
}

async function stopDriver(driver: Driver) {
  if (driver.child.exitCode === null && driver.child.signalCode === null) {
    driver.child.kill('SIGTERM');
  }
  await withTimeout(driver.close, 15_000, 'APNs rollback proof cleanup');
}

async function waitForPidExit(pid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Nested APNs rollback proof server ${pid} remained alive.`);
}

function expectNoRowNeedles(output: string) {
  expect(output).not.toContain(forcedMismatchValue);
  for (const needle of rowNeedles) expect(output).not.toContain(needle);
}

async function expectSyntheticResourcesRemoved(marker: Awaited<Driver['marker']>) {
  expect(marker.childProcessIds).toHaveLength(2);
  expect(marker.childProcessIds.every(Number.isSafeInteger)).toBe(true);
  await Promise.all(marker.childProcessIds.map(waitForPidExit));
  await expect(fs.stat(marker.temporaryDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('APNs rollback proof failure containment', () => {
  it('reports a forced row mismatch without rendering expected or actual row contents', async () => {
    const driver = startDriver('mismatch');
    try {
      const result = await withTimeout(driver.close, 30_000, 'forced APNs row mismatch');
      expect(result).toEqual({ code: 1, signal: null });
      expect(driver.output.stdout).toBe('');
      expect(driver.output.stderr).toContain(
        'Error: APNs rollback proof detected a row preservation mismatch.'
      );
      expect(driver.output.stderr).toContain('diagnostics withheld');
      expect(driver.output.stderr).not.toContain('AssertionError');
      expectNoRowNeedles(driver.output.stderr);
    } finally {
      await stopDriver(driver);
    }
  }, 40_000);

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ] as const)('reaps both servers and deletes synthetic state after %s', async (signal, exitCode) => {
    const driver = startDriver('signal');
    let marker: Awaited<Driver['marker']> | undefined;
    try {
      marker = await withTimeout(driver.marker, 15_000, `${signal} APNs nested-server marker`);
      expect(driver.child.kill(signal)).toBe(true);
      const result = await withTimeout(driver.close, 15_000, `${signal} APNs cleanup`);
      expect(result).toEqual({ code: exitCode, signal: null });
      expect(driver.output.stderr).toContain('synthetic resources were cleaned up');
      expectNoRowNeedles(`${driver.output.stdout}\n${driver.output.stderr}`);
      await expectSyntheticResourcesRemoved(marker);
    } finally {
      await stopDriver(driver);
      if (marker) await expectSyntheticResourcesRemoved(marker);
    }
  }, 40_000);

  it('reaps both servers and deletes synthetic state after the bounded proof timeout', async () => {
    const driver = startDriver('timeout');
    let marker: Awaited<Driver['marker']> | undefined;
    try {
      marker = await withTimeout(driver.marker, 15_000, 'timed APNs nested-server marker');
      const result = await withTimeout(driver.close, 15_000, 'bounded APNs proof timeout cleanup');
      expect(result).toEqual({ code: 1, signal: null });
      expect(driver.output.stderr).toContain(
        'APNs rollback proof timed out; synthetic resources were cleaned up.'
      );
      expectNoRowNeedles(`${driver.output.stdout}\n${driver.output.stderr}`);
      await expectSyntheticResourcesRemoved(marker);
    } finally {
      await stopDriver(driver);
      if (marker) await expectSyntheticResourcesRemoved(marker);
    }
  }, 40_000);
});
