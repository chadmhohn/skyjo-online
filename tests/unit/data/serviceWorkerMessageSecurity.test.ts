import fs from 'node:fs';
import vm from 'node:vm';

type WorkerMessage = {
  data: { type: string };
  origin: string;
  ports?: Array<{ postMessage: ReturnType<typeof vi.fn> }>;
  source: object | null;
};

type WorkerMessageHandler = (event: WorkerMessage & { waitUntil: (promise: Promise<unknown>) => void }) => void;

const appOrigin = 'https://skyjo.example';
const activationType = 'SKYJO_ACTIVATE_UPDATE';
const sanitizerType = 'SKYJO_SANITIZE_CACHE';

function loadMessageHandler() {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const skipWaiting = vi.fn(() => Promise.resolve());
  const cache = {
    delete: vi.fn(() => Promise.resolve(true)),
    keys: vi.fn(() => Promise.resolve([]))
  };
  const caches = {
    open: vi.fn(() => Promise.resolve(cache))
  };
  const self = {
    __WB_MANIFEST: [],
    addEventListener: vi.fn((type: string, handler: (...args: never[]) => unknown) => handlers.set(type, handler)),
    location: { origin: appOrigin },
    skipWaiting
  };
  const source = fs.readFileSync('src/service-worker.js', 'utf8');
  vm.runInNewContext(source, { caches, self });
  const handler = handlers.get('message') as WorkerMessageHandler | undefined;
  if (!handler) throw new Error('Service worker message handler was not registered.');
  return { cache, caches, handler, skipWaiting };
}

async function dispatchMessage(handler: WorkerMessageHandler, message: WorkerMessage) {
  const pending: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => pending.push(Promise.resolve(promise)));
  handler({ ...message, ports: message.ports || [], waitUntil });
  await Promise.all(pending);
  return { waitUntil };
}

describe('service worker message trust boundary', () => {
  it('allows same-origin activation when WebKit supplies a null source', async () => {
    const { caches, handler, skipWaiting } = loadMessageHandler();
    const { waitUntil } = await dispatchMessage(handler, {
      data: { type: activationType },
      origin: appOrigin,
      source: null
    });

    expect(skipWaiting).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(caches.open).not.toHaveBeenCalled();
  });

  it.each(['https://attacker.example', 'null'])('rejects null-source activation from origin %s', async (origin) => {
    const { caches, handler, skipWaiting } = loadMessageHandler();
    const { waitUntil } = await dispatchMessage(handler, {
      data: { type: activationType },
      origin,
      source: null
    });

    expect(skipWaiting).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(caches.open).not.toHaveBeenCalled();
  });

  it('allows only the WebKit empty-origin and null-source activation shape', async () => {
    const { handler, skipWaiting } = loadMessageHandler();
    const { waitUntil } = await dispatchMessage(handler, {
      data: { type: activationType },
      origin: '',
      source: null
    });

    expect(skipWaiting).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('rejects empty-origin activation when a source is present', async () => {
    const { handler, skipWaiting } = loadMessageHandler();
    const { waitUntil } = await dispatchMessage(handler, {
      data: { type: activationType },
      origin: '',
      source: { id: 'unexpected-source' }
    });

    expect(skipWaiting).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each([
    { origin: '', source: null },
    { origin: '', source: { id: 'unexpected-source' } },
    { origin: appOrigin, source: null },
    { origin: 'https://attacker.example', source: { id: 'attacker-source' } },
    { origin: 'null', source: { id: 'opaque-source' } }
  ])('rejects sanitizer without both same origin and a source: $origin/$source', async ({ origin, source }) => {
    const postMessage = vi.fn();
    const { caches, handler } = loadMessageHandler();
    const { waitUntil } = await dispatchMessage(handler, {
      data: { type: sanitizerType },
      origin,
      ports: [{ postMessage }],
      source
    });

    expect(caches.open).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('allows same-origin sanitizer when a source is present', async () => {
    const postMessage = vi.fn();
    const { cache, caches, handler } = loadMessageHandler();
    const { waitUntil } = await dispatchMessage(handler, {
      data: { type: sanitizerType },
      origin: appOrigin,
      ports: [{ postMessage }],
      source: { id: 'same-origin-client' }
    });

    expect(caches.open).toHaveBeenCalledTimes(1);
    expect(cache.keys).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith('ok');
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});
