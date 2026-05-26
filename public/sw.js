const skyjoCacheName = 'skyjo-online-v5';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== skyjoCacheName).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/rooms') return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (!response.ok || response.type !== 'basic') return response;
        if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/audio/') || url.pathname.startsWith('/skyjo-icon') || url.pathname === '/manifest.webmanifest') {
          const responseClone = response.clone();
          caches.open(skyjoCacheName).then((cache) => cache.put(request, responseClone));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || Response.error()))
  );
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
    badge: '/skyjo-icon-192.png',
    body: payload.body || 'There is a Skyjo update.',
    data: {
      url: payload.url || '/'
    },
    icon: '/skyjo-icon-192.png',
    tag: payload.tag || 'skyjo',
    renotify: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
      const matchingClient = clients.find((client) => client.url.startsWith(self.location.origin));
      if (matchingClient) {
        matchingClient.navigate(targetUrl);
        return matchingClient.focus();
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
