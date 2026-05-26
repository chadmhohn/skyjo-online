export type PushUiStatus = 'checking' | 'unsupported' | 'unconfigured' | 'prompt' | 'denied' | 'subscribed' | 'error';

type PushConfig = {
  enabled: boolean;
  publicKey?: string;
};

function isPushCapable() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function fetchJson<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(payload.error || 'Request failed.');
  return payload as T;
}

export async function loadPushNotificationStatus(): Promise<PushUiStatus> {
  if (!isPushCapable()) return 'unsupported';
  const config = await fetchJson<PushConfig>('/api/push/config');
  if (!config.enabled || !config.publicKey) return 'unconfigured';
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) return 'subscribed';
  if (Notification.permission === 'denied') return 'denied';
  return 'prompt';
}

export async function enablePushNotifications() {
  if (!isPushCapable()) throw new Error('Push notifications are not available on this device.');
  const config = await fetchJson<PushConfig>('/api/push/config');
  if (!config.enabled || !config.publicKey) throw new Error('Push notifications are not configured yet.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed.');
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ||
    (await registration.pushManager.subscribe({
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      userVisibleOnly: true
    }));
  await fetchJson<{ ok: boolean }>('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ subscription: subscription.toJSON() })
  });
}

export async function disablePushNotifications() {
  if (!isPushCapable()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await fetchJson<{ ok: boolean }>('/api/push/unsubscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint: subscription.endpoint })
  });
  await subscription.unsubscribe();
}
