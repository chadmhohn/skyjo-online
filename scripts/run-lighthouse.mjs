import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

await fs.access(path.resolve('dist', 'index.html')).catch(() => {
  throw new Error('Lighthouse requires the shared production build. Run npm run build first.');
});
await fs.rm(path.resolve('test-results', 'lighthouse'), { recursive: true, force: true });

const cliPath = path.resolve('node_modules', '@lhci', 'cli', 'src', 'cli.js');
const child = spawn(process.execPath, [cliPath, 'autorun', '--config=.lighthouserc.cjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CHROME_PATH: process.env.CHROME_PATH || chromium.executablePath(),
    LHCI_BUILD_CONTEXT__CURRENT_HASH: process.env.GITHUB_SHA || 'local'
  },
  stdio: 'inherit',
  windowsHide: true
});

const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => resolve(code ?? 1));
});
if (exitCode !== 0) process.exitCode = Number(exitCode);
