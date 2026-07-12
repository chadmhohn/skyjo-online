import { vi } from 'vitest';
import { disablePushNotifications, enablePushNotifications, loadPushNotificationStatus } from '../../../src/push';

type FakeSubscription = {
  endpoint: string;
  toJSON: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('push notification lifecycle', () => {
  let subscription: FakeSubscription | null;
  let getSubscription: ReturnType<typeof vi.fn>;
  let subscribe: ReturnType<typeof vi.fn>;
  let requestPermission: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    subscription = null;
    getSubscription = vi.fn(async () => subscription);
    subscribe = vi.fn(async () => {
      subscription = {
        endpoint: 'https://push.example.test/subscription',
        toJSON: vi.fn(() => ({ endpoint: 'https://push.example.test/subscription' })),
        unsubscribe: vi.fn(async () => true)
      };
      return subscription;
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }) }
    });
    vi.stubGlobal('PushManager', class PushManager {});
    requestPermission = vi.fn(async () => 'granted');
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ enabled: true, publicKey: 'AQIDBA' })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('reports unsupported, unconfigured, prompt, denied, and subscribed states', async () => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    expect(await loadPushNotificationStatus()).toBe('unsupported');

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }) }
    });
    vi.stubGlobal('PushManager', class PushManager {});
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ enabled: false })));
    expect(await loadPushNotificationStatus()).toBe('unconfigured');

    vi.mocked(fetch).mockImplementation(async () => jsonResponse({ enabled: true, publicKey: 'AQIDBA' }));
    expect(await loadPushNotificationStatus()).toBe('prompt');

    vi.stubGlobal('Notification', { permission: 'denied', requestPermission });
    expect(await loadPushNotificationStatus()).toBe('denied');

    subscription = {
      endpoint: 'https://push.example.test/existing',
      toJSON: vi.fn(() => ({ endpoint: 'https://push.example.test/existing' })),
      unsubscribe: vi.fn(async () => true)
    };
    expect(await loadPushNotificationStatus()).toBe('subscribed');
  });

  it('subscribes with a decoded VAPID key and sends the subscription', async () => {
    await enablePushNotifications();

    expect(requestPermission).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith({
      applicationServerKey: new Uint8Array([1, 2, 3, 4]),
      userVisibleOnly: true
    });
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription: { endpoint: 'https://push.example.test/subscription' } }),
      headers: { 'Content-Type': 'application/json' }
    });
  });

  it('reuses an existing subscription', async () => {
    subscription = {
      endpoint: 'https://push.example.test/existing',
      toJSON: vi.fn(() => ({ endpoint: 'https://push.example.test/existing' })),
      unsubscribe: vi.fn(async () => true)
    };
    await enablePushNotifications();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('rejects unsupported, unconfigured, denied, and failed configuration requests', async () => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    await expect(enablePushNotifications()).rejects.toThrow('not available');

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }) }
    });
    vi.stubGlobal('PushManager', class PushManager {});
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ enabled: false })));
    await expect(enablePushNotifications()).rejects.toThrow('not configured');

    vi.mocked(fetch).mockImplementation(async () => jsonResponse({ enabled: true, publicKey: 'AQIDBA' }));
    requestPermission.mockResolvedValueOnce('denied');
    await expect(enablePushNotifications()).rejects.toThrow('not allowed');

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: 'Configuration failed' }, 500));
    await expect(loadPushNotificationStatus()).rejects.toThrow('Configuration failed');
    vi.mocked(fetch).mockResolvedValueOnce(new Response('not-json', { status: 500 }));
    await expect(loadPushNotificationStatus()).rejects.toThrow('Request failed.');
  });

  it('unsubscribes server-side before releasing the browser subscription', async () => {
    subscription = {
      endpoint: 'https://push.example.test/existing',
      toJSON: vi.fn(() => ({ endpoint: 'https://push.example.test/existing' })),
      unsubscribe: vi.fn(async () => true)
    };
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }));
    await disablePushNotifications();

    expect(fetch).toHaveBeenCalledWith('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
      headers: { 'Content-Type': 'application/json' }
    });
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  });

  it('treats unsupported devices and absent subscriptions as no-ops', async () => {
    await disablePushNotifications();
    expect(fetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    await disablePushNotifications();
  });
});
