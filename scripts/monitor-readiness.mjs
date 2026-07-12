import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeReadiness, writeMonitorResult } from './readiness-monitor-lib.mjs';

function parseArguments(argv) {
  const values = new Map();
  let failUnhealthy = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--fail-unhealthy') {
      if (failUnhealthy) throw new Error('Duplicate --fail-unhealthy flag.');
      failUnhealthy = true;
      continue;
    }
    if (!['--monitor', '--base-url', '--attempts', '--timeout-ms', '--output'].includes(argument)) {
      throw new Error('Unknown readiness-monitor argument.');
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--') || values.has(argument)) throw new Error('Invalid readiness-monitor argument.');
    values.set(argument, value);
    index += 1;
  }
  for (const required of ['--monitor', '--base-url', '--output']) {
    if (!values.has(required)) throw new Error('Missing required readiness-monitor argument.');
  }
  return {
    monitor: values.get('--monitor'),
    baseUrl: values.get('--base-url'),
    attempts: values.has('--attempts') ? Number(values.get('--attempts')) : 1,
    timeoutMs: values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : 10_000,
    output: values.get('--output'),
    failUnhealthy
  };
}

export async function runReadinessMonitor(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(argv);
  const result = await probeReadiness({ ...options, ...dependencies });
  await writeMonitorResult(options.output, result);
  process.stdout.write(`${JSON.stringify({ monitor: result.monitor, status: result.status, checkedAt: result.checkedAt })}\n`);
  if (options.failUnhealthy && result.status !== 'healthy') process.exitCode = 1;
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await runReadinessMonitor();
  } catch {
    const argv = process.argv.slice(2);
    const monitorIndex = argv.indexOf('--monitor');
    const outputIndex = argv.indexOf('--output');
    const monitor = argv[monitorIndex + 1];
    const output = argv[outputIndex + 1];
    if (['local', 'public'].includes(monitor) && output && !output.startsWith('--')) {
      const fallback = {
        formatVersion: 1,
        monitor,
        status: 'unhealthy',
        checkedAt: new Date().toISOString(),
        attempts: 1,
        failureClass: 'internal',
        httpStatus: null,
        releaseSha: null,
        schemaVersion: null,
        protocolVersion: null
      };
      try {
        await writeMonitorResult(output, fallback);
        process.stderr.write('Readiness monitor recorded a sanitized internal failure.\n');
        process.exitCode = monitor === 'local' ? 1 : 0;
      } catch {
        process.stderr.write('Readiness monitor failed before producing trusted evidence.\n');
        process.exitCode = 2;
      }
    } else {
      process.stderr.write('Readiness monitor failed before producing trusted evidence.\n');
      process.exitCode = 2;
    }
  }
}
