import fs from 'node:fs/promises';
import path from 'node:path';
import { getManifest, injectManifest } from 'workbox-build';

const manifestOptions = {
  globDirectory: path.resolve('dist'),
  globPatterns: [
    'offline.html',
    'assets/*.{css,js}',
    'audio/*.mp3',
    'skyjo-icon*.{png,svg}'
  ],
  maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
  dontCacheBustURLsMatching: /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:css|js)$/
};
const manifest = await getManifest(manifestOptions);
const safePathPattern = /^(?:offline\.html|assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:css|js)|audio\/[A-Za-z0-9_.-]+\.mp3|skyjo-icon(?:-v2)?(?:-(?:180|192|512))?\.(?:png|svg))$/;
const precacheUrls = manifest.manifestEntries.map((entry) => entry.url).sort();
if (!precacheUrls.includes('offline.html') || precacheUrls.some((url) => !safePathPattern.test(url))) {
  throw new Error(`Unsafe service-worker precache manifest: ${precacheUrls.join(', ')}`);
}
const result = await injectManifest({
  ...manifestOptions,
  swSrc: path.resolve('src/service-worker.js'),
  swDest: path.resolve('dist/sw.js')
});

if (result.count < 5 || result.size < 1) throw new Error('Service worker precache manifest is unexpectedly empty.');
const output = await fs.readFile(path.resolve('dist/sw.js'), 'utf8');
if (output.includes('self.__WB_MANIFEST')) throw new Error('Workbox manifest injection did not complete.');
if (!output.includes("addEventListener('push'") || !output.includes("addEventListener('notificationclick'")) {
  throw new Error('Generated service worker lost push notification handlers.');
}
console.log(`Injected ${result.count} safe PWA resources (${result.size} bytes): ${precacheUrls.join(', ')}`);
