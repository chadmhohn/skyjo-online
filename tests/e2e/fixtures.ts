import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

type SkyjoServer = {
  accessPassword: string;
  baseURL: string;
  dataDir: string;
};

type WorkerFixtures = {
  skyjoServer: SkyjoServer;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 48);
}

async function waitForHealthyServer(baseURL: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/healthz`);
      if (response.ok) return;
      lastError = new Error(`Health check returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${baseURL}/healthz: ${String(lastError)}`);
}

export const test = base.extend<object, WorkerFixtures>({
  page: async ({ context, page, skyjoServer }, use) => {
    const response = await context.request.post(`${skyjoServer.baseURL}/login`, {
      form: { next: '/', password: skyjoServer.accessPassword }
    });
    if (!response.ok()) throw new Error(`Test access login failed with ${response.status()}.`);
    await use(page);
  },
  skyjoServer: [
    // Playwright requires fixture dependencies to use object destructuring, even when there are none.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      const runId = safePart(process.env.GITHUB_RUN_ID || `local-${process.pid}`);
      const project = safePart(workerInfo.project.name);
      const accessPassword = `test-access-${runId}-${project}-${workerInfo.workerIndex}`;
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `skyjo-${runId}-${project}-${workerInfo.workerIndex}-`));
      const resultsDir = path.join(repoRoot, 'test-results', 'server');
      await fs.mkdir(resultsDir, { recursive: true });
      const logPath = path.join(resultsDir, `${runId}-${project}-worker-${workerInfo.workerIndex}.log`);
      const child = spawn(process.execPath, ['server.mjs'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          HOST: '127.0.0.1',
          PORT: '0',
          SKYJO_ACCESS_PASSWORD: accessPassword,
          SKYJO_ACCOUNT_COOKIE_NAME: `skyjo_account_${workerInfo.workerIndex}`,
          SKYJO_ADMIN_INITIAL_PASSWORD: '',
          SKYJO_COOKIE_NAME: `skyjo_session_${workerInfo.workerIndex}`,
          SKYJO_DB_FILE: path.join(dataDir, 'skyjo.sqlite'),
          SKYJO_INVITE_SECRET: `test-invite-${runId}-${project}-${workerInfo.workerIndex}`,
          SKYJO_ROOMS_FILE: path.join(dataDir, 'rooms.json'),
          SKYJO_SECURE_COOKIES: 'false',
          SKYJO_SESSION_SECRET: `test-session-${runId}-${project}-${workerInfo.workerIndex}`,
          SKYJO_TEST_PWA_NETWORK_FAULTS: 'true',
          SKYJO_TEST_PWA_VARIANTS: 'true',
          SKYJO_VAPID_PRIVATE_KEY: '',
          SKYJO_VAPID_PUBLIC_KEY: ''
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      let log = '';
      let resolvePort: ((port: number) => void) | undefined;
      let rejectPort: ((error: Error) => void) | undefined;
      const portPromise = new Promise<number>((resolve, reject) => {
        resolvePort = resolve;
        rejectPort = reject;
      });
      const onOutput = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        log += text;
        const match = log.match(/Listening on http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) {
          resolvePort?.(Number(match[1]));
          resolvePort = undefined;
          rejectPort = undefined;
        }
      };
      child.stdout.on('data', onOutput);
      child.stderr.on('data', onOutput);
      child.once('exit', (code) => {
        rejectPort?.(new Error(`Skyjo test server exited with code ${String(code)}.\n${log}`));
      });

      const startupTimeout = setTimeout(() => {
        rejectPort?.(new Error(`Skyjo test server did not report a port.\n${log}`));
      }, 15_000);

      try {
        const port = await portPromise;
        clearTimeout(startupTimeout);
        const baseURL = `http://127.0.0.1:${port}`;
        await waitForHealthyServer(baseURL);
        await use({ accessPassword, baseURL, dataDir });
      } finally {
        clearTimeout(startupTimeout);
        if (child.exitCode === null) child.kill('SIGTERM');
        if (child.exitCode === null) {
          await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
        }
        if (child.exitCode === null) child.kill();
        await fs.writeFile(logPath, log, 'utf8');
        await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
    { scope: 'worker', timeout: 25_000 }
  ]
});

export async function installSeededBrowserRuntime(page: Page, seed = 42) {
  await page.addInitScript((initialSeed: number) => {
    let value = initialSeed >>> 0;
    Math.random = () => {
      value += 0x6d2b79f5;
      let mixed = value;
      mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  }, seed);
}

export { expect };
