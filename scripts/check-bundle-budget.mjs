import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const distDir = path.resolve('dist');
const htmlPath = path.join(distDir, 'index.html');
const budgets = {
  js: 90 * 1024,
  css: 17 * 1024,
  total: 115 * 1024
};

const html = await fs.readFile(htmlPath, 'utf8').catch((error) => {
  throw new Error(`Build output is missing at ${htmlPath}. Run npm run build first. ${error.message}`);
});
const assets = new Set(
  [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)].map((match) => match[1].replace(/^\//, ''))
);
if (assets.size === 0) throw new Error('No initial JavaScript or CSS assets were found in dist/index.html.');

const report = { js: 0, css: 0, total: 0, files: [] };
for (const asset of [...assets].sort()) {
  const contents = await fs.readFile(path.join(distDir, asset));
  const gzipBytes = gzipSync(contents, { level: 9 }).byteLength;
  const type = asset.endsWith('.css') ? 'css' : 'js';
  report[type] += gzipBytes;
  report.total += gzipBytes;
  report.files.push({ asset, gzipBytes, type });
}

await fs.mkdir(path.resolve('test-results', 'bundle'), { recursive: true });
await fs.writeFile(
  path.resolve('test-results', 'bundle', 'budget.json'),
  `${JSON.stringify({ budgets, actual: report }, null, 2)}\n`,
  'utf8'
);

const failures = Object.entries(budgets)
  .filter(([key, limit]) => report[key] > limit)
  .map(([key, limit]) => `${key}: ${report[key]} bytes exceeds ${limit} bytes`);

console.log(
  `Bundle gzip: JS ${(report.js / 1024).toFixed(2)} KiB, CSS ${(report.css / 1024).toFixed(2)} KiB, total ${(report.total / 1024).toFixed(2)} KiB.`
);
if (failures.length > 0) throw new Error(`Bundle budget exceeded:\n${failures.join('\n')}`);
