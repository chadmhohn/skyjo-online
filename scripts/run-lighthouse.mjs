import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { preview } from 'vite';
import { isIgnorableWindowsChromeCleanupError } from './lighthouse-gate-lib.mjs';

const require = createRequire(import.meta.url);
const lighthouseConfig = require('../.lighthouserc.cjs');
const { getAllAssertionResults } = require('@lhci/utils/src/assertions.js');
const { computeRepresentativeRuns } = require('@lhci/utils/src/representative-runs.js');

const projectRoot = process.cwd();
const outputDirectory = path.resolve('test-results', 'lighthouse');
const compatibilityDirectory = path.resolve('.lighthouseci');
const collect = lighthouseConfig.ci.collect;
const assertionConfig = lighthouseConfig.ci.assert;
const chromeFlags = String(collect.settings?.chromeFlags || '')
  .split(/\s+/)
  .filter(Boolean);
const lighthouseSettings = { ...collect.settings };
delete lighthouseSettings.chromeFlags;

function routeName(url) {
  const pathname = new URL(url).pathname;
  return pathname === '/'
    ? 'home'
    : pathname.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

function getMetric(lhr, key) {
  if (key.startsWith('categories:')) {
    return lhr.categories[key.slice('categories:'.length)]?.score ?? null;
  }
  return lhr.audits[key]?.numericValue ?? null;
}

function formatFailure(failure) {
  const actual = Number.isFinite(failure.actual) ? failure.actual : 'unavailable';
  return `${failure.url} ${failure.auditId}: expected ${failure.operator} ${failure.expected}, got ${actual}`;
}

await fs.access(path.resolve('dist', 'index.html')).catch(() => {
  throw new Error('Lighthouse requires the shared production build. Run npm run build first.');
});
await Promise.all([
  fs.rm(outputDirectory, { recursive: true, force: true }),
  fs.rm(compatibilityDirectory, { recursive: true, force: true })
]);
await Promise.all([
  fs.mkdir(outputDirectory, { recursive: true }),
  fs.mkdir(compatibilityDirectory, { recursive: true })
]);

let previewServer;
let chrome;
const summaries = [];
const failures = [];

try {
  previewServer = await preview({
    root: projectRoot,
    preview: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true
    }
  });
  const address = previewServer.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite preview did not expose a TCP port.');
  const origin = `http://127.0.0.1:${address.port}`;

  chrome = await launch({
    chromePath: process.env.CHROME_PATH || chromium.executablePath(),
    chromeFlags
  });

  for (const configuredUrl of collect.url) {
    const configured = new URL(configuredUrl);
    const targetUrl = new URL(`${configured.pathname}${configured.search}`, origin).href;
    const name = routeName(targetUrl);
    const reports = [];

    process.stdout.write(`Running Lighthouse ${collect.numberOfRuns} time(s) on ${targetUrl}\n`);
    for (let index = 0; index < collect.numberOfRuns; index += 1) {
      process.stdout.write(`Run #${index + 1}...`);
      const result = await lighthouse(targetUrl, {
        ...lighthouseSettings,
        logLevel: 'error',
        output: 'html',
        port: chrome.port
      });
      if (!result) throw new Error(`Lighthouse returned no result for ${targetUrl}.`);

      const reportIndex = index + 1;
      const json = `${JSON.stringify(result.lhr, null, 2)}\n`;
      await Promise.all([
        fs.writeFile(path.join(outputDirectory, `${name}-${reportIndex}.report.json`), json),
        fs.writeFile(path.join(outputDirectory, `${name}-${reportIndex}.report.html`), String(result.report)),
        fs.writeFile(path.join(compatibilityDirectory, `${name}-${reportIndex}.lhr.json`), json)
      ]);
      reports.push({ lhr: result.lhr, html: String(result.report), reportIndex });
      process.stdout.write('done.\n');
    }

    const representativeIndex = computeRepresentativeRuns([
      reports.map((report, index) => [index, report.lhr])
    ])[0];
    const representative = reports[representativeIndex];
    const routeFailures = getAllAssertionResults(assertionConfig, reports.map((report) => report.lhr));
    failures.push(...routeFailures);

    await Promise.all([
      fs.writeFile(
        path.join(outputDirectory, `${name}.median.report.json`),
        `${JSON.stringify(representative.lhr, null, 2)}\n`
      ),
      fs.writeFile(path.join(outputDirectory, `${name}.median.report.html`), representative.html)
    ]);

    summaries.push({
      route: configured.pathname,
      finalUrl: representative.lhr.finalUrl,
      representativeRun: representative.reportIndex,
      metrics: Object.fromEntries(
        Object.keys(assertionConfig.assertions).map((key) => [key, getMetric(representative.lhr, key)])
      ),
      failures: routeFailures.map(formatFailure)
    });
  }
} finally {
  let cleanupError;
  try {
    if (chrome) await chrome.kill();
  } catch (error) {
    if (isIgnorableWindowsChromeCleanupError(error)) {
      process.stderr.write(`Chrome cleanup warning: ${error.message}\n`);
    } else {
      cleanupError = error;
    }
  }
  try {
    if (previewServer) await previewServer.close();
  } catch (error) {
    cleanupError ||= error;
  }
  if (cleanupError) throw cleanupError;
}

await fs.writeFile(
  path.join(outputDirectory, 'summary.json'),
  `${JSON.stringify({ releaseSha: process.env.GITHUB_SHA || 'local', routes: summaries }, null, 2)}\n`
);

for (const summary of summaries) {
  process.stdout.write(`${summary.route}: ${JSON.stringify(summary.metrics)}\n`);
}
if (failures.length) {
  for (const failure of failures) process.stderr.write(`Lighthouse assertion failed: ${formatFailure(failure)}\n`);
  process.exitCode = 1;
}
