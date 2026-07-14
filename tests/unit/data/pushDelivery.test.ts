import crypto from 'node:crypto';
import { createAccountStore } from '../../../server-account-store.mjs';
import {
  createWebPushDeliveryDiagnostic,
  deliverWebPushNotifications,
  resolveWebPushConfiguration,
  validateVapidSubject
} from '../../../server-push.mjs';

function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  const publicKey = ecdh.generateKeys();
  return {
    publicKey: publicKey.toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url')
  };
}

type DeliveryDiagnostic = {
  statusCode: number | null;
  providerReason: string | null;
  endpointOrigin: string | null;
};

describe('Web Push configuration', () => {
  test.each([
    'https://skyjo.groundworkrevops.com',
    'https://skyjo.groundworkrevops.com/push/contact?source=vapid#operations',
    'mailto:alerts@groundworkrevops.com',
    'mailto:push.team+skyjo@groundworkrevops.com?subject=Skyjo%20Web%20Push',
    'https://8.8.8.8/push-contact',
    'https://[2606:4700:4700::1111]/push-contact',
    'https://skyjo.xn--bcher-kva.de/push-contact'
  ])('accepts a public VAPID contact URI: %s', (subject) => {
    expect(validateVapidSubject(` ${subject} `)).toBe(subject);
  });

  test.each([
    '',
    'not-a-uri',
    'http://skyjo.groundworkrevops.com',
    'https://user:secret@skyjo.groundworkrevops.com',
    'mailto:',
    'mailto:no-domain',
    'mailto:.alerts@groundworkrevops.com',
    'mailto:alerts..push@groundworkrevops.com',
    'mailto:alerts@groundworkrevops.com#private',
    'https://localhost',
    'https://skyjo.localhost',
    'https://skyjo.test',
    'mailto:alerts@skyjo.example',
    'https://skyjo.invalid',
    'https://skyjo.internal',
    'https://skyjo.lan',
    'https://skyjo.home.arpa',
    'https://skyjo.onion',
    'https://example.com',
    'https://skyjo.example.net',
    'https://single-label',
    'https://999.999.999.999',
    'https://-bad.groundworkrevops.com',
    'https://bad-.groundworkrevops.com',
    'https://10.0.0.1',
    'https://100.64.0.1',
    'https://127.0.0.1',
    'https://169.254.1.1',
    'https://172.31.255.255',
    'https://192.0.0.1',
    'https://192.0.2.1',
    'https://192.88.99.1',
    'https://192.168.1.1',
    'https://198.18.0.1',
    'https://198.51.100.1',
    'https://203.0.113.1',
    'https://224.0.0.1',
    'https://[::1]',
    'https://[fc00::1]',
    'https://[fe80::1]',
    'https://[ff00::1]',
    'https://[2001:db8::1]'
  ])('rejects a reserved, private, or malformed VAPID contact URI: %s', (subject) => {
    expect(() => validateVapidSubject(subject)).toThrow(/public HTTPS or mailto/i);
  });

  it('supports an explicitly disabled configuration and rejects either partial key', () => {
    expect(resolveWebPushConfiguration({ publicKey: '', privateKey: ' ', subject: 'https://skyjo.test' })).toEqual({
      enabled: false,
      publicKey: '',
      privateKey: '',
      subject: ''
    });
    expect(() => resolveWebPushConfiguration({ publicKey: 'public-only', privateKey: '', subject: 'https://skyjo.groundworkrevops.com' }))
      .toThrow(/both be set or both be empty/i);
    expect(() => resolveWebPushConfiguration({ publicKey: '', privateKey: 'private-only', subject: 'https://skyjo.groundworkrevops.com' }))
      .toThrow(/both be set or both be empty/i);
  });

  it('accepts only a coherent canonical P-256 VAPID key pair', () => {
    const valid = generateVapidKeys();
    expect(resolveWebPushConfiguration({
      publicKey: ` ${valid.publicKey} `,
      privateKey: ` ${valid.privateKey} `,
      subject: 'https://skyjo.groundworkrevops.com'
    })).toEqual({
      enabled: true,
      ...valid,
      subject: 'https://skyjo.groundworkrevops.com'
    });

    const different = generateVapidKeys();
    expect(() => resolveWebPushConfiguration({
      publicKey: valid.publicKey,
      privateKey: different.privateKey,
      subject: 'mailto:alerts@groundworkrevops.com'
    })).toThrow(/coherent P-256 key pair/i);
    for (const malformed of [
      { publicKey: 'not+base64url', privateKey: valid.privateKey },
      { publicKey: `${valid.publicKey}=`, privateKey: valid.privateKey },
      { publicKey: valid.publicKey, privateKey: 'short' }
    ]) {
      expect(() => resolveWebPushConfiguration({
        ...malformed,
        subject: 'mailto:alerts@groundworkrevops.com'
      })).toThrow(/coherent P-256 key pair/i);
    }
  });
});

describe('Web Push delivery diagnostics', () => {
  it('delivers serialized payloads without invoking cleanup or diagnostics', async () => {
    const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201 });
    const deleteSubscription = vi.fn();
    const reportFailure = vi.fn();
    const subscription = {
      endpoint: 'https://web.push.apple.com/device/success-token',
      keys: { p256dh: 'public-key', auth: 'auth-key' }
    };
    await expect(deliverWebPushNotifications({
      subscriptions: [{ endpoint: subscription.endpoint, subscription }],
      payload: { title: 'Your turn', roomId: 'private-room-id' },
      sendNotification,
      deleteSubscription,
      reportFailure
    })).resolves.toEqual([{ delivered: true, deleted: false }]);
    expect(sendNotification).toHaveBeenCalledWith(subscription, JSON.stringify({ title: 'Your turn', roomId: 'private-room-id' }));
    expect(deleteSubscription).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('deletes only 404/410 subscriptions and reports fixed, redacted diagnostics', async () => {
    const failures = [
      { endpoint: 'https://web.push.apple.com/device/stale-404?token=private', statusCode: 404, reason: 'Unregistered' },
      { endpoint: 'https://fcm.googleapis.com/push/stale-410', statusCode: 410, reason: null },
      { endpoint: 'https://web.push.apple.com/device/bad-request', statusCode: 400, reason: 'BadDeviceToken' },
      { endpoint: 'https://web.push.apple.com/device/current-token', statusCode: 403, reason: 'BadJwtToken' },
      { endpoint: 'https://fcm.googleapis.com/push/retry', statusCode: 429, reason: 'TooManyRequests' },
      { endpoint: 'https://push.example-provider.com/transient', statusCode: 503, reason: 'secret-provider-detail' }
    ];
    const deleteSubscription = vi.fn();
    const diagnostics: unknown[] = [];
    const payload = { roomId: 'secret-room', userId: 'secret-user', jwt: 'secret-jwt', title: 'Your turn' };
    const results = await deliverWebPushNotifications({
      subscriptions: failures.map(({ endpoint }, index) => ({
        endpoint,
        subscription: { endpoint, keys: { p256dh: `secret-key-${index}`, auth: `secret-auth-${index}` } }
      })),
      payload,
      sendNotification: async (subscription: { endpoint: string }) => {
        const failure = failures.find(({ endpoint }) => endpoint === subscription.endpoint)!;
        throw {
          statusCode: failure.statusCode,
          body: failure.reason ? JSON.stringify({ reason: failure.reason, detail: 'secret-body' }) : 'not-json secret-body',
          message: 'secret endpoint token key JWT payload room account user'
        };
      },
      deleteSubscription,
      reportFailure: (diagnostic: DeliveryDiagnostic) => diagnostics.push(diagnostic)
    });

    expect(deleteSubscription.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      failures[0].endpoint,
      failures[1].endpoint
    ]);
    expect(results.map(({ delivered, deleted }: { delivered: boolean; deleted: boolean }) => ({ delivered, deleted }))).toEqual([
      { delivered: false, deleted: true },
      { delivered: false, deleted: true },
      { delivered: false, deleted: false },
      { delivered: false, deleted: false },
      { delivered: false, deleted: false },
      { delivered: false, deleted: false }
    ]);
    expect(diagnostics).toEqual([
      { statusCode: 404, providerReason: 'Unregistered', endpointOrigin: 'https://web.push.apple.com' },
      { statusCode: 410, providerReason: null, endpointOrigin: 'https://fcm.googleapis.com' },
      { statusCode: 400, providerReason: 'BadDeviceToken', endpointOrigin: 'https://web.push.apple.com' },
      { statusCode: 403, providerReason: 'BadJwtToken', endpointOrigin: 'https://web.push.apple.com' },
      { statusCode: 429, providerReason: 'TooManyRequests', endpointOrigin: 'https://fcm.googleapis.com' },
      { statusCode: 503, providerReason: null, endpointOrigin: 'https://push.example-provider.com' }
    ]);
    const exposed = JSON.stringify({ diagnostics, results });
    expect(exposed).not.toMatch(/secret-|secret body|device\/|push\/|token=|private-room|private-account|private-user|private-jwt|p256dh|auth-key/i);
  });

  it('sanitizes malformed errors and endpoints without allowing diagnostics to interrupt stale cleanup', async () => {
    const errorWithThrowingProperties = {} as Record<string, unknown>;
    Object.defineProperty(errorWithThrowingProperties, 'statusCode', { get: () => { throw new Error('secret status'); } });
    Object.defineProperty(errorWithThrowingProperties, 'body', { get: () => { throw new Error('secret body'); } });
    expect(createWebPushDeliveryDiagnostic(errorWithThrowingProperties, 'not a URL/private-token')).toEqual({
      statusCode: null,
      providerReason: null,
      endpointOrigin: null
    });
    expect(createWebPushDeliveryDiagnostic({ statusCode: 99, body: { reason: 'BadJwtToken' } }, 'http://private.test/token')).toEqual({
      statusCode: null,
      providerReason: 'BadJwtToken',
      endpointOrigin: null
    });
    expect(createWebPushDeliveryDiagnostic({ statusCode: 600, body: { reason: 42 } }, null)).toEqual({
      statusCode: null,
      providerReason: null,
      endpointOrigin: null
    });

    const deleteSubscription = vi.fn();
    await expect(deliverWebPushNotifications({
      subscriptions: [{ endpoint: 'https://web.push.apple.com/device/stale-secret', subscription: {} }],
      payload: { private: 'payload' },
      sendNotification: async () => { throw { statusCode: 410, body: { reason: 'Unregistered' } }; },
      deleteSubscription,
      reportFailure: () => { throw new Error('logging unavailable'); }
    })).resolves.toEqual([{
      delivered: false,
      deleted: true,
      diagnostic: { statusCode: 410, providerReason: 'Unregistered', endpointOrigin: 'https://web.push.apple.com' }
    }]);
    expect(deleteSubscription).toHaveBeenCalledWith('https://web.push.apple.com/device/stale-secret');
  });

  it('integrates delivery cleanup with the persisted subscription store', async () => {
    const store = await createAccountStore({ filePath: ':memory:' });
    try {
      const user = await store.createUser({
        email: 'push-integration@example.com',
        displayName: 'Push Integration',
        password: 'integration-password'
      });
      const staleEndpoint = 'https://web.push.apple.com/device/stale';
      const retainedEndpoint = 'https://web.push.apple.com/device/retained';
      for (const endpoint of [staleEndpoint, retainedEndpoint]) {
        store.savePushSubscription(user.id, { endpoint, keys: { p256dh: 'public-key', auth: 'auth-key' } });
      }
      await deliverWebPushNotifications({
        subscriptions: store.listPushSubscriptionsForUsers([user.id]),
        payload: { title: 'Your turn' },
        sendNotification: async (subscription: { endpoint: string }) => {
          throw { statusCode: subscription.endpoint === staleEndpoint ? 410 : 403, body: '{"reason":"BadJwtToken"}' };
        },
        deleteSubscription: (endpoint: string) => store.deletePushSubscription(endpoint),
        reportFailure: vi.fn()
      });
      expect(store.listPushSubscriptionsForUsers([user.id]).map(({ endpoint }: { endpoint: string }) => endpoint)).toEqual([retainedEndpoint]);
    } finally {
      store.close();
    }
  });
});
