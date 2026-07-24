/* global self, caches, clients, setTimeout */

const precacheEntries = self.__WB_MANIFEST;
const cachePrefix = 'skyjo-pwa-v2-';
const legacyCachePrefixes = ['skyjo-online-v', 'skyjo-static-v'];
const skipWaitingGraceMs = 50;
const workerBuildId = '__SKYJO_WORKER_BUILD_ID__';

function requestImmediateActivation(event) {
  // WebKit may finish this message event before its queued skipWaiting task; the independent 50ms grace keeps one bounded scheduling window.
  void self.skipWaiting().catch(() => {});
  event.waitUntil(new Promise((resolve) => setTimeout(resolve, skipWaitingGraceMs)));
}

function manifestFingerprint(entries) {
  let hash = 2166136261;
  const material = entries
    .map((entry) => `${typeof entry === 'string' ? entry : entry.url}:${typeof entry === 'string' ? '' : entry.revision || ''}`)
    .sort()
    .join('|');
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const cacheName = `${cachePrefix}${manifestFingerprint(precacheEntries)}`;
const offlineShellPath = '/offline.html';
const hashedAssetPattern = /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:css|js)$/;
const audioCuePattern = /^\/audio\/card-(?:flip|pickup|place)\.mp3$/;
const iconPattern = /^\/skyjo-icon(?:-v2)?(?:-(?:180|192|512))?\.(?:png|svg)$/;
const precachePaths = new Set(precacheEntries.map((entry) => {
  const value = typeof entry === 'string' ? entry : entry.url;
  const url = new URL(value, self.location.origin);
  if (url.origin !== self.location.origin || !safePrecachePath(url.pathname) || url.search || url.hash) {
    throw new Error('Unsafe URL reached the injected Skyjo manifest.');
  }
  return url.pathname;
}));

function safePrecachePath(pathname) {
  return pathname === offlineShellPath ||
    hashedAssetPattern.test(pathname) ||
    audioCuePattern.test(pathname) ||
    iconPattern.test(pathname);
}

function safePrecacheUrl(value) {
  const url = new URL(value, self.location.origin);
  return url.origin === self.location.origin && safePrecachePath(url.pathname) && !url.search && !url.hash;
}

function expectedContentType(pathname) {
  if (pathname === offlineShellPath) return /^text\/html\b/i;
  if (pathname.endsWith('.css')) return /^text\/css\b/i;
  if (pathname.endsWith('.js')) return /^(?:application|text)\/javascript\b/i;
  if (pathname.endsWith('.mp3')) return /^audio\/mpeg\b/i;
  if (pathname.endsWith('.png')) return /^image\/png\b/i;
  if (pathname.endsWith('.svg')) return /^image\/svg\+xml\b/i;
  return /$a/;
}

function safeResponse(response, expectedUrl) {
  if (!response || !response.ok || response.redirected) return false;
  try {
    const responseUrl = new URL(response.url);
    return responseUrl.origin === self.location.origin &&
      responseUrl.pathname === expectedUrl.pathname &&
      expectedContentType(expectedUrl.pathname).test(response.headers.get('content-type') || '') &&
      !response.headers.has('set-cookie');
  } catch {
    return false;
  }
}

async function cacheSafeResource(cache, value) {
  if (!safePrecacheUrl(value)) throw new Error('Unsafe URL reached the Skyjo precache.');
  const url = new URL(value, self.location.origin);
  const request = new Request(url.href, {
    cache: 'reload',
    credentials: 'omit',
    redirect: 'error'
  });
  const response = await fetch(request);
  if (!safeResponse(response, url)) throw new Error('Unsafe response reached the Skyjo precache.');
  await cache.put(url.pathname, response);
}

async function sanitizeCache(cache) {
  const requests = await cache.keys();
  await Promise.all(requests.map(async (request) => {
    const url = new URL(request.url);
    const response = await cache.match(request);
    const keep = url.origin === self.location.origin &&
      precachePaths.has(url.pathname) &&
      !url.search &&
      safeResponse(response, url);
    if (!keep) await cache.delete(request);
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await sanitizeCache(cache);
    await Promise.all(precacheEntries.map((entry) => cacheSafeResource(cache, typeof entry === 'string' ? entry : entry.url)));
  })());
});

self.addEventListener('message', (event) => {
  const isActivation = event.data?.type === 'SKYJO_ACTIVATE_UPDATE';
  const isBuildIdentityRequest = event.data?.type === 'SKYJO_GET_BUILD_ID';
  const identityRequestId = event.data?.requestId;
  if (event.origin !== self.location.origin) return;
  if (isActivation) {
    requestImmediateActivation(event);
    return;
  }
  if (
    isBuildIdentityRequest &&
    event.data?.version === 1 &&
    typeof identityRequestId === 'string' &&
    /^[a-z0-9-]{3,64}$/.test(identityRequestId) &&
    event.ports?.length === 1
  ) {
    const replyPort = event.ports[0];
    try {
      replyPort.postMessage({
        type: 'SKYJO_BUILD_ID',
        version: 1,
        requestId: identityRequestId,
        buildId: workerBuildId
      });
    } finally {
      replyPort.close();
    }
    return;
  }
  if (!event.source) return;
  if (event.data?.type === 'SKYJO_SANITIZE_CACHE') {
    event.waitUntil(caches.open(cacheName).then(sanitizeCache).then(() => event.ports[0]?.postMessage('ok')));
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const currentCache = await caches.open(cacheName);
    await sanitizeCache(currentCache);
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => (
        key !== cacheName &&
        (key.startsWith(cachePrefix) || legacyCachePrefixes.some((prefix) => key.startsWith(prefix)))
      ))
      .map((key) => caches.delete(key)));
    await clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    if ((url.pathname !== '/' && url.pathname !== '/single-player') || url.search) return;
    event.respondWith(fetch(request)
      .then((response) => {
        if (!response.ok) throw new Error('Navigation request was unavailable.');
        return response;
      })
      .catch(async () => {
        const cached = await caches.open(cacheName).then((cache) => cache.match(offlineShellPath));
        return cached || Response.error();
      }));
    return;
  }

  if (!precachePaths.has(url.pathname) || url.search || url.hash) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(url.pathname);
    if (cached) return cached;
    try {
      const response = await fetch(new Request(request, { credentials: 'omit', redirect: 'error' }));
      if (safeResponse(response, url)) await cache.put(url.pathname, response.clone());
      return response;
    } catch {
      return Response.error();
    }
  })());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || 'Skyjo';
  const options = {
    badge: '/skyjo-icon-v2-192.png',
    body: payload.body || 'There is a Skyjo update.',
    data: { url: payload.url || '/' },
    icon: '/skyjo-icon-v2-192.png',
    tag: payload.tag || 'skyjo',
    renotify: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const requestedUrl = new URL(event.notification.data?.url || '/', self.location.origin);
  const targetUrl = requestedUrl.origin === self.location.origin ? requestedUrl.href : self.location.origin;
  event.waitUntil(self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((windowClients) => {
    const matchingClient = windowClients.find((client) => client.url.startsWith(self.location.origin));
    if (matchingClient) {
      matchingClient.navigate(targetUrl);
      return matchingClient.focus();
    }
    return self.clients.openWindow(targetUrl);
  }));
});
