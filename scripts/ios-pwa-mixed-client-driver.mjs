#!/usr/bin/env node

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_HEADER_NAME = 'x-skyjo-ios-mixed-control';
export const CONTROL_HEADER_VALUE = '1';
export const MAXIMUM_CONTROL_REQUEST_BYTES = 16_384;
export const MAXIMUM_CONTROL_RESPONSE_BYTES = 8_192;

const SYNTHETIC_ACCESS_FIXTURE = 'skyjo-ios-contract-access-v1';
const operationNames = new Set([
  'reset',
  'provision',
  'create-room',
  'join-room',
  'wait-player',
  'wait-connection',
  'send-chat',
  'hold-chat',
  'release-held-command',
  'wait-chat',
  'set-visible',
  'set-offline',
  'close-page',
  'reopen-page',
  'start-game',
  'reveal-opening',
]);

const chatCases = Object.freeze({
  duplicate: 'mixed duplicate marker',
  fresh: 'mixed fresh marker',
  stale: 'mixed stale marker',
  advance: 'mixed native advance marker',
  heartbeat: 'mixed native heartbeat marker',
  // The shipping v0.3.2 PWA and protocol-v2 ingress bound chat by UTF-16
  // length. 140 astral symbols are therefore the cross-version-safe maximum.
  'maximum-astral': '🃏'.repeat(140),
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isLoopbackOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:'
      && url.hostname === '127.0.0.1'
      && Number.isInteger(Number(url.port))
      && Number(url.port) >= 1
      && Number(url.port) <= 65_535
      && url.username === ''
      && url.password === ''
      && url.pathname === '/'
      && url.search === ''
      && url.hash === ''
      && url.origin === value;
  } catch {
    return false;
  }
}

export function parseStartupMessage(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new TypeError('invalid-startup');
  }
  if (!isRecord(value)
      || !hasExactKeys(value, ['version', 'type', 'serverOrigin'])
      || value.version !== CONTROL_PROTOCOL_VERSION
      || value.type !== 'start'
      || !isLoopbackOrigin(value.serverOrigin)) {
    throw new TypeError('invalid-startup');
  }
  return Object.freeze({ serverOrigin: value.serverOrigin });
}

export function parseControlCommand(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0
      || bytes.byteLength > MAXIMUM_CONTROL_REQUEST_BYTES) {
    throw new TypeError('invalid-request');
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new TypeError('invalid-request');
  }
  if (!isRecord(value)
      || !hasExactKeys(value, ['version', 'id', 'operation', 'arguments'])
      || value.version !== CONTROL_PROTOCOL_VERSION
      || typeof value.id !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.id)
      || typeof value.operation !== 'string'
      || !operationNames.has(value.operation)
      || !isRecord(value.arguments)
      || Object.values(value.arguments).some((item) => typeof item !== 'string')) {
    throw new TypeError('invalid-request');
  }
  return Object.freeze({
    id: value.id,
    operation: value.operation,
    arguments: Object.freeze({ ...value.arguments }),
  });
}

export function controlErrorResponse(id, code) {
  return {
    version: CONTROL_PROTOCOL_VERSION,
    id: typeof id === 'string' ? id : '00000000-0000-4000-8000-000000000000',
    ok: false,
    error: { code },
  };
}

function requireExactArguments(command, expected) {
  if (!hasExactKeys(command.arguments, expected)) throw new TypeError('invalid-arguments');
  return command.arguments;
}

function booleanArgument(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new TypeError('invalid-arguments');
}

function chatText(alias) {
  const text = chatCases[alias];
  if (typeof text !== 'string') throw new TypeError('invalid-arguments');
  return text;
}

async function waitUntil(predicate, timeoutMilliseconds = 12_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed-out');
}

function installControlledWebSocket() {
  const NativeWebSocket = window.WebSocket;
  let mode = 'pass';
  let socketCount = 0;
  let heldPayload = null;
  let heldSocket = null;

  class ControlledWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      if (protocols === undefined) super(url);
      else super(url, protocols);
      socketCount += 1;
    }

    send(payload) {
      let isCommand = false;
      if (typeof payload === 'string') {
        try {
          isCommand = JSON.parse(payload)?.type === 'command';
        } catch {
          isCommand = false;
        }
      }
      if (isCommand && mode === 'duplicate') {
        mode = 'pass';
        NativeWebSocket.prototype.send.call(this, payload);
        NativeWebSocket.prototype.send.call(this, payload);
        return;
      }
      if (isCommand && mode === 'hold') {
        heldPayload = payload;
        heldSocket = this;
        mode = 'holding';
        return;
      }
      NativeWebSocket.prototype.send.call(this, payload);
    }
  }

  Object.defineProperty(window, 'WebSocket', {
    configurable: false,
    enumerable: true,
    value: ControlledWebSocket,
    writable: false,
  });
  Object.defineProperty(window, '__skyjoMixedWebSocketControl', {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      setMode(nextMode) {
        if ((nextMode !== 'duplicate' && nextMode !== 'hold') || mode !== 'pass') return false;
        mode = nextMode;
        return true;
      },
      release() {
        if (mode !== 'holding' || heldPayload === null || heldSocket === null
            || heldSocket.readyState !== NativeWebSocket.OPEN) return false;
        const payload = heldPayload;
        const socket = heldSocket;
        heldPayload = null;
        heldSocket = null;
        mode = 'pass';
        NativeWebSocket.prototype.send.call(socket, payload);
        return true;
      },
      status() {
        return Object.freeze({ mode, socketCount });
      },
    }),
    writable: false,
  });
}

class MixedPWADriver {
  constructor(browser, serverOrigin) {
    this.browser = browser;
    this.serverOrigin = serverOrigin;
    this.context = null;
    this.page = null;
    this.displayName = null;
    this.rememberedSeat = null;
    this.heldMessageBox = null;
  }

  async dispose() {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.displayName = null;
    this.rememberedSeat = null;
    this.heldMessageBox = null;
    if (context) await context.close().catch(() => {});
  }

  async reset() {
    await this.dispose();
    this.context = await this.browser.newContext({
      baseURL: this.serverOrigin,
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 800 },
    });
    await this.context.addInitScript(installControlledWebSocket);
    this.page = await this.context.newPage();
    return { state: 'idle' };
  }

  requireContext() {
    if (!this.context) throw new TypeError('invalid-state');
    return this.context;
  }

  requirePage() {
    if (!this.page || this.page.isClosed()) throw new TypeError('invalid-state');
    return this.page;
  }

  async provision(displayName) {
    if (!/^\S(?:[\s\S]{0,22}\S)?$/u.test(displayName)
        || [...displayName].length > 24) throw new TypeError('invalid-arguments');
    const context = this.requireContext();
    const access = await context.request.post(`${this.serverOrigin}/login`, {
      form: { next: '/', password: SYNTHETIC_ACCESS_FIXTURE },
    });
    if (!access.ok()) throw new Error('provision-failed');
    const credential = randomUUID();
    const signup = await context.request.post(`${this.serverOrigin}/api/account/signup`, {
      data: {
        email: `mixed-${credential}@example.invalid`,
        displayName,
        password: credential,
        confirmPassword: credential,
      },
    });
    if (signup.status() !== 201) throw new Error('provision-failed');
    const page = this.requirePage();
    await page.goto(`${this.serverOrigin}/lobby`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Multiplayer Lobby' }).waitFor();
    await this.waitConnection('idle');
    this.displayName = displayName;
    return { state: 'idle' };
  }

  async waitConnection(state) {
    if (!['idle', 'connecting', 'connected', 'reconnecting', 'offline', 'error'].includes(state)) {
      throw new TypeError('invalid-arguments');
    }
    const status = this.requirePage().getByTestId('connection-status');
    await waitUntil(async () => await status.getAttribute('data-connection-state') === state);
    return { matched: true };
  }

  async createRoom() {
    const page = this.requirePage();
    await page.getByRole('button', { name: 'Create Room' }).click();
    await this.waitConnection('connected');
    const code = (await page.locator('.skyjo-room-code').innerText()).trim();
    if (!/^[A-Z0-9]{5}$/.test(code)) throw new Error('operation-failed');
    return { roomCode: code };
  }

  async joinRoom(roomCode) {
    if (!/^[A-Z0-9]{5}$/.test(roomCode)) throw new TypeError('invalid-arguments');
    const page = this.requirePage();
    await page.getByLabel('Room code').fill(roomCode);
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await this.waitConnection('connected');
    await waitUntil(async () => (await page.locator('.skyjo-room-code').innerText()).trim() === roomCode);
    return { joined: true };
  }

  async waitPlayer(displayName, connected, controller, host) {
    if (!displayName || [...displayName].length > 24
        || (connected !== '' && connected !== 'true' && connected !== 'false')
        || (controller !== '' && controller !== 'human' && controller !== 'ai')
        || (host !== '' && host !== 'true' && host !== 'false')) {
      throw new TypeError('invalid-arguments');
    }
    const player = this.requirePage().locator('.skyjo-room-roster li').filter({ hasText: displayName }).first();
    await waitUntil(async () => {
      if (!await player.isVisible()) return false;
      const text = await player.innerText();
      if (connected !== '' && text.includes(connected === 'true' ? 'Connected' : 'Disconnected') === false) return false;
      if (controller !== '' && text.includes(controller === 'ai' ? 'AI controlled' : 'Human controlled') === false) return false;
      if (host !== '') {
        const nameLine = text.split('\n')[0] || '';
        if ((host === 'true') !== nameLine.includes('host')) return false;
      }
      return true;
    });
    return { matched: true };
  }

  async ensureChatOpen() {
    const page = this.requirePage();
    const log = page.getByRole('log', { name: 'Table chat messages' });
    if (!await log.isVisible()) {
      await page.getByRole('button', { name: /Table Chat|Open table chat/i }).first().click();
      await log.waitFor();
    }
    return log;
  }

  async webSocketStatus() {
    return this.requirePage().evaluate(() => window.__skyjoMixedWebSocketControl?.status() ?? null);
  }

  async armFault(mode) {
    const armed = await this.requirePage().evaluate((nextMode) => (
      window.__skyjoMixedWebSocketControl?.setMode(nextMode) === true
    ), mode);
    if (!armed) throw new Error('operation-failed');
  }

  async sendChat(alias, delivery) {
    if (delivery !== 'normal' && delivery !== 'duplicate') throw new TypeError('invalid-arguments');
    const message = chatText(alias);
    if (delivery === 'duplicate') await this.armFault('duplicate');
    const page = this.requirePage();
    await this.ensureChatOpen();
    await page.getByRole('textbox', { name: 'Message' }).fill(message);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await this.waitChat(alias);
    return { sent: true };
  }

  async holdChat(alias) {
    const message = chatText(alias);
    await this.armFault('hold');
    const page = this.requirePage();
    await this.ensureChatOpen();
    const messageBox = page.getByRole('textbox', { name: 'Message' });
    await messageBox.fill(message);
    const sendButton = page.getByRole('button', { name: 'Send', exact: true });
    await sendButton.click();
    await waitUntil(async () => (await this.webSocketStatus())?.mode === 'holding');
    await waitUntil(async () => await messageBox.isDisabled());
    this.heldMessageBox = messageBox;
    return { held: true };
  }

  async releaseHeldCommand() {
    const page = this.requirePage();
    const messageBox = this.heldMessageBox;
    if (!messageBox) throw new TypeError('invalid-state');
    const released = await page.evaluate(() => window.__skyjoMixedWebSocketControl?.release() === true);
    if (!released) throw new Error('operation-failed');
    // Re-enabled input is the PWA controller's behavioral convergence signal.
    // The Swift peer separately proves the held stale mutation was not applied,
    // avoiding dependence on transient presentation copy or accessibility timing.
    await waitUntil(async () => await messageBox.isEnabled());
    this.heldMessageBox = null;
    return { resynchronized: true };
  }

  async waitChat(alias) {
    const message = chatText(alias);
    const log = await this.ensureChatOpen();
    await waitUntil(async () => {
      const messages = await log.locator('p').allTextContents();
      return messages.some((candidate) => candidate === message);
    });
    return { matched: true };
  }

  async setVisible(visible) {
    const page = this.requirePage();
    const before = await this.webSocketStatus();
    if (!before) throw new Error('operation-failed');
    await page.evaluate((nextVisible) => {
      window.dispatchEvent(new Event(nextVisible ? 'pageshow' : 'pagehide'));
    }, visible);
    if (this.displayName) await this.waitPlayer(this.displayName, String(visible), '', '');
    const after = await this.webSocketStatus();
    return { sameSocket: Boolean(after && after.socketCount === before.socketCount) };
  }

  async setOffline(offline) {
    const context = this.requireContext();
    const page = this.requirePage();
    const seatBefore = await page.evaluate(() => localStorage.getItem('skyjo-player-id'));
    await context.setOffline(offline);
    await this.waitConnection(offline ? 'offline' : 'connected');
    const seatAfter = await page.evaluate(() => localStorage.getItem('skyjo-player-id'));
    return { sameSeat: seatBefore !== null && seatAfter === seatBefore };
  }

  async closePage() {
    const page = this.requirePage();
    this.rememberedSeat = await page.evaluate(() => localStorage.getItem('skyjo-player-id'));
    await page.close({ runBeforeUnload: false });
    this.page = null;
    return { closed: true };
  }

  async reopenPage() {
    const context = this.requireContext();
    this.page = await context.newPage();
    await this.page.goto(`${this.serverOrigin}/lobby`, { waitUntil: 'domcontentloaded' });
    await this.waitConnection('connected');
    await this.page.locator('.skyjo-room-code').waitFor();
    const restoredSeat = await this.page.evaluate(() => localStorage.getItem('skyjo-player-id'));
    const sameSeat = this.rememberedSeat !== null && restoredSeat === this.rememberedSeat;
    this.rememberedSeat = null;
    return { sameSeat };
  }

  async startGame() {
    await this.requirePage().getByRole('button', { name: 'Start Game' }).click();
    await this.requirePage().getByTestId('shared-game-table').waitFor();
    return { started: true };
  }

  async revealOpening(count) {
    if (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 2) {
      throw new TypeError('invalid-arguments');
    }
    for (let index = 0; index < Number(count); index += 1) {
      const card = this.requirePage()
        .locator('button[aria-label*="Reveal this opening card"]:visible:not([disabled])')
        .first();
      await card.click();
    }
    return { revealed: true };
  }

  async execute(command) {
    switch (command.operation) {
    case 'reset':
      requireExactArguments(command, []);
      return this.reset();
    case 'provision': {
      const args = requireExactArguments(command, ['displayName']);
      return this.provision(args.displayName);
    }
    case 'create-room':
      requireExactArguments(command, []);
      return this.createRoom();
    case 'join-room': {
      const args = requireExactArguments(command, ['roomCode']);
      return this.joinRoom(args.roomCode);
    }
    case 'wait-player': {
      const args = requireExactArguments(command, ['displayName', 'connected', 'controller', 'host']);
      return this.waitPlayer(args.displayName, args.connected, args.controller, args.host);
    }
    case 'wait-connection': {
      const args = requireExactArguments(command, ['state']);
      return this.waitConnection(args.state);
    }
    case 'send-chat': {
      const args = requireExactArguments(command, ['case', 'delivery']);
      return this.sendChat(args.case, args.delivery);
    }
    case 'hold-chat': {
      const args = requireExactArguments(command, ['case']);
      return this.holdChat(args.case);
    }
    case 'release-held-command':
      requireExactArguments(command, []);
      return this.releaseHeldCommand();
    case 'wait-chat': {
      const args = requireExactArguments(command, ['case']);
      return this.waitChat(args.case);
    }
    case 'set-visible': {
      const args = requireExactArguments(command, ['visible']);
      return this.setVisible(booleanArgument(args.visible));
    }
    case 'set-offline': {
      const args = requireExactArguments(command, ['offline']);
      return this.setOffline(booleanArgument(args.offline));
    }
    case 'close-page':
      requireExactArguments(command, []);
      return this.closePage();
    case 'reopen-page':
      requireExactArguments(command, []);
      return this.reopenPage();
    case 'start-game':
      requireExactArguments(command, []);
      return this.startGame();
    case 'reveal-opening': {
      const args = requireExactArguments(command, ['count']);
      return this.revealOpening(args.count);
    }
    default:
      throw new TypeError('invalid-request');
    }
  }
}

function sendJSON(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.byteLength > MAXIMUM_CONTROL_RESPONSE_BYTES) {
    response.writeHead(500, { 'Cache-Control': 'no-store', Connection: 'close' });
    response.end();
    return;
  }
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    Connection: 'close',
    'Content-Length': String(bytes.byteLength),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(bytes);
}

export function classifyControlRequest({ remoteAddress, method, url, headers }) {
  const hasUnexpectedControlHeader = Object.keys(headers).some((name) => (
    name.startsWith('x-skyjo-') && name !== CONTROL_HEADER_NAME
  ));
  const allowed = (remoteAddress === '127.0.0.1' || remoteAddress === '::ffff:127.0.0.1')
    && headers[CONTROL_HEADER_NAME] === CONTROL_HEADER_VALUE
    && headers['content-type'] === 'application/json'
    && headers.origin === undefined
    && headers.cookie === undefined
    && headers.authorization === undefined
    && headers['proxy-authorization'] === undefined
    && !hasUnexpectedControlHeader;
  if (!allowed) return 'forbidden';
  if (method === 'GET' && url === '/v1/health') return 'health';
  if (method === 'POST' && url === '/v1/command') return 'command';
  return 'not-found';
}

async function readBoundedBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAXIMUM_CONTROL_REQUEST_BYTES) throw new TypeError('request-too-large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen-failed');
  return address.port;
}

export function createControlServer(driver) {
  let commandQueue = Promise.resolve();
  return http.createServer(async (request, response) => {
    const route = classifyControlRequest({
      remoteAddress: request.socket.remoteAddress,
      method: request.method,
      url: request.url,
      headers: request.headers,
    });
    if (route === 'forbidden') {
      sendJSON(response, 403, controlErrorResponse(undefined, 'forbidden'));
      return;
    }
    if (route === 'health') {
      sendJSON(response, 200, { version: CONTROL_PROTOCOL_VERSION, ready: true });
      return;
    }
    if (route === 'not-found') {
      sendJSON(response, 404, controlErrorResponse(undefined, 'not-found'));
      return;
    }
    let command;
    try {
      command = parseControlCommand(await readBoundedBody(request));
    } catch (error) {
      const code = error instanceof TypeError && error.message === 'request-too-large'
        ? 'request-too-large'
        : 'invalid-request';
      sendJSON(response, code === 'request-too-large' ? 413 : 400, controlErrorResponse(undefined, code));
      return;
    }
    try {
      const operation = commandQueue.then(() => driver.execute(command));
      commandQueue = operation.catch(() => {});
      const result = await operation;
      sendJSON(response, 200, {
        version: CONTROL_PROTOCOL_VERSION,
        id: command.id,
        ok: true,
        result,
      });
    } catch (error) {
      const code = error instanceof TypeError
        && ['invalid-arguments', 'invalid-state'].includes(error.message)
        ? error.message
        : 'operation-failed';
      sendJSON(response, code === 'invalid-arguments' ? 400 : 409, controlErrorResponse(command.id, code));
    }
  });
}

async function readStartupLine() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAXIMUM_CONTROL_REQUEST_BYTES) throw new TypeError('invalid-startup');
    chunks.push(chunk);
  }
  const buffered = Buffer.concat(chunks, length).toString('utf8');
  if (!buffered.endsWith('\n') || buffered.indexOf('\n') !== buffered.length - 1) {
    throw new TypeError('invalid-startup');
  }
  return buffered.slice(0, -1);
}

async function run() {
  let browser;
  let driver;
  let controlServer;
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (controlServer) {
      await new Promise((resolve) => controlServer.close(() => resolve()));
    }
    if (driver) await driver.dispose();
    if (browser) await browser.close().catch(() => {});
  };

  process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
  process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });

  try {
    const startup = parseStartupMessage(await readStartupLine());
    browser = await chromium.launch({ headless: true });
    driver = new MixedPWADriver(browser, startup.serverOrigin);
    controlServer = createControlServer(driver);
    const controlPort = await listen(controlServer);
    process.stdout.write(`${JSON.stringify({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'ready',
      controlPort,
    })}\n`);
    await new Promise((resolve) => controlServer.once('close', resolve));
  } catch {
    process.stderr.write('ERROR: mixed PWA driver startup failed.\n');
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await run();
}
