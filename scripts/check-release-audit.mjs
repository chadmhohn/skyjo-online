import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateReleaseAudit } from './release-audit-lib.mjs';

const execFileAsync = promisify(execFile);
const npmCli = String(process.env.npm_execpath || '').trim();
const executable = npmCli ? process.execPath : 'npm';
const arguments_ = npmCli ? [npmCli, 'audit', '--json'] : ['audit', '--json'];

let stdout;
try {
  ({ stdout } = await execFileAsync(executable, arguments_, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  }));
} catch (error) {
  stdout = error?.stdout;
  if (typeof stdout !== 'string' || stdout.trim().length === 0) {
    throw new Error('npm audit did not return a readable report.', { cause: error });
  }
}

let report;
try {
  report = JSON.parse(stdout);
} catch {
  throw new Error('npm audit returned invalid JSON.');
}
const result = validateReleaseAudit(report);
console.log(`Release audit passed: zero moderate/high/critical; ${result.lowCount} low.`);
