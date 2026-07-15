import fs from 'node:fs/promises';
import path from 'node:path';
import { getManifest, injectManifest } from 'workbox-build';
import {
  bindServiceWorkerIdentity,
  computeServiceWorkerBuildId
} from './service-worker-build-identity.mjs';

const manifestOptions = {
  globDirectory: path.resolve('dist'),
  globPatterns: [
    'offline.html',
    'assets/*.{css,js}',
    'skyjo-icon*.{png,svg}'
  ],
  maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
  dontCacheBustURLsMatching: /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:css|js)$/
};
const manifest = await getManifest(manifestOptions);
const sourcePath = path.resolve('src/service-worker.js');
const outputPath = path.resolve('dist/sw.js');
const safePathPattern = /^(?:offline\.html|assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:css|js)|skyjo-icon(?:-v2)?(?:-(?:180|192|512))?\.(?:png|svg))$/;
const precacheUrls = manifest.manifestEntries.map((entry) => entry.url).sort();
if (!precacheUrls.includes('offline.html') || precacheUrls.some((url) => !safePathPattern.test(url))) {
  throw new Error(`Unsafe service-worker precache manifest: ${precacheUrls.join(', ')}`);
}
const result = await injectManifest({
  ...manifestOptions,
  swSrc: sourcePath,
  swDest: outputPath
});

if (result.count < 5 || result.size < 1) throw new Error('Service worker precache manifest is unexpectedly empty.');
const generated = await fs.readFile(outputPath, 'utf8');
const buildId = computeServiceWorkerBuildId(generated);
const output = bindServiceWorkerIdentity(generated, buildId);
await fs.writeFile(outputPath, output, 'utf8');
if (output.includes('self.__WB_MANIFEST')) throw new Error('Workbox manifest injection did not complete.');
if (!output.includes("addEventListener('push'") || !output.includes("addEventListener('notificationclick'")) {
  throw new Error('Generated service worker lost push notification handlers.');
}
console.log(`Injected ${result.count} safe PWA resources (${result.size} bytes): ${precacheUrls.join(', ')}`);
console.log(`Bound generated service-worker build ${buildId}.`);
