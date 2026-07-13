/* global __ENV, __VU, open */
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import { WebSocket } from 'k6/websockets';

const rooms = integerEnvironment('SKYJO_LOAD_ROOMS', 20, 1, 20);
const clientsPerRoom = integerEnvironment('SKYJO_LOAD_CLIENTS_PER_ROOM', 8, 8, 8);
const durationSeconds = integerEnvironment('SKYJO_LOAD_DURATION_SECONDS', 600, 1, 600);
const expectedClients = rooms * clientsPerRoom;
const expectedMarkers = rooms * durationSeconds;
const expectedObservations = expectedMarkers * clientsPerRoom;
const authenticationDocument = loadAuthenticationDocument();

const clientsConnected = new Counter('skyjo_clients_connected');
const errorCount = new Counter('skyjo_load_errors');
const operationErrorRate = new Rate('skyjo_operation_error_rate');
const markerObservations = new Counter('skyjo_marker_observations');
const markersSent = new Counter('skyjo_markers_sent');
const privacyViolations = new Counter('skyjo_privacy_violations');
const propagation = new Trend('skyjo_propagation_ms', true);
const revisionDivergences = new Counter('skyjo_revision_divergences');
const roomsCompleted = new Counter('skyjo_rooms_completed');
const roomsStarted = new Counter('skyjo_rooms_started');
const sessionsVerified = new Counter('skyjo_sessions_verified');

export const options = {
  discardResponseBodies: false,
  scenarios: {
    roomControllers: {
      executor: 'per-vu-iterations',
      vus: rooms,
      iterations: 1,
      maxDuration: `${durationSeconds + 120}s`,
      gracefulStop: '5s'
    }
  },
  summaryTrendStats: ['min', 'avg', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    iterations: [`count==${rooms}`],
    skyjo_clients_connected: [`count==${expectedClients}`],
    skyjo_load_errors: ['count==0'],
    skyjo_marker_observations: [`count==${expectedObservations}`],
    skyjo_markers_sent: [`count==${expectedMarkers}`],
    skyjo_operation_error_rate: ['rate<0.001'],
    skyjo_privacy_violations: ['count==0'],
    skyjo_propagation_ms: ['p(95)<=250'],
    skyjo_revision_divergences: ['count==0'],
    skyjo_rooms_completed: [`count==${rooms}`],
    skyjo_rooms_started: [`count==${rooms}`],
    skyjo_sessions_verified: [`count==${expectedClients}`]
  }
};

function integerEnvironment(name, fallback, minimum, maximum) {
  const raw = __ENV[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside its bounded certification range.`);
  }
  return value;
}

function requiredEnvironment(name) {
  const value = String(__ENV[name] || '');
  if (!value || /[\r\n]/.test(value)) throw new Error(`${name} is required.`);
  return value;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function loadAuthenticationDocument() {
  let document;
  try {
    document = JSON.parse(open(requiredEnvironment('SKYJO_LOAD_AUTH_FILE')));
  } catch {
    throw new Error('Load authentication bootstrap document is unavailable or invalid.');
  }
  return document;
}

function assertHttpStatus(response, expected, label) {
  if (response.status !== expected) throw new Error(`${label} returned status ${response.status}.`);
}

export function setup() {
  const baseUrl = requiredEnvironment('SKYJO_LOAD_BASE_URL').replace(/\/$/, '');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw new Error('Load certification may target only an isolated localhost server.');
  const sourceSha = requiredEnvironment('SKYJO_RELEASE_SHA');
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Load certification requires a full source SHA.');
  const siteCookieName = requiredEnvironment('SKYJO_LOAD_SITE_COOKIE_NAME');
  const accountCookieName = requiredEnvironment('SKYJO_LOAD_ACCOUNT_COOKIE_NAME');

  if (
    !exactKeys(authenticationDocument, ['clientCookies', 'formatVersion', 'kind', 'releaseSha', 'topology']) ||
    authenticationDocument.formatVersion !== 1 ||
    authenticationDocument.kind !== 'skyjo-load-authentication' ||
    authenticationDocument.releaseSha !== sourceSha ||
    !exactKeys(authenticationDocument.topology, ['clients', 'clientsPerRoom', 'rooms']) ||
    authenticationDocument.topology.rooms !== rooms ||
    authenticationDocument.topology.clientsPerRoom !== clientsPerRoom ||
    authenticationDocument.topology.clients !== expectedClients ||
    !Array.isArray(authenticationDocument.clientCookies) ||
    authenticationDocument.clientCookies.length !== expectedClients
  ) {
    throw new Error('Load authentication bootstrap identity or topology is invalid.');
  }

  const versionResponse = http.get(`${baseUrl}/version`, { redirects: 0, tags: { operation: 'release-identity' } });
  assertHttpStatus(versionResponse, 200, 'Release identity');
  const version = versionResponse.json();
  if (version.releaseSha !== sourceSha || version.protocolVersion !== 2) {
    throw new Error('Load target release identity does not match the tested source.');
  }

  const clientCookies = authenticationDocument.clientCookies;
  const userIds = {};
  for (let index = 0; index < expectedClients; index += 1) {
    const cookie = clientCookies[index];
    if (
      typeof cookie !== 'string' ||
      cookie.length > 4096 ||
      /[\r\n]/.test(cookie) ||
      !cookie.includes(`${siteCookieName}=`) ||
      !cookie.includes(`${accountCookieName}=`)
    ) {
      throw new Error('Load authentication bootstrap contains an invalid session.');
    }
    const proof = http.get(`${baseUrl}/api/account/me`, {
      redirects: 0,
      headers: { Cookie: cookie },
      tags: { operation: 'account-session-proof' }
    });
    assertHttpStatus(proof, 200, 'Account session proof');
    const userId = proof.json()?.user?.id;
    if (typeof userId !== 'string' || !userId || userIds[userId]) {
      throw new Error('Load authentication sessions are not distinct accounts.');
    }
    userIds[userId] = true;
    sessionsVerified.add(1);
  }

  return {
    baseUrl,
    clientCookies,
    sourceSha
  };
}

function commandId(vu, sequence) {
  const tail = String(vu * 1_000_000 + sequence).padStart(12, '0');
  return `73000000-0000-4000-8000-${tail}`;
}

function collectKeys(value, keys = {}) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (!value || typeof value !== 'object') return keys;
  for (const key of Object.keys(value)) {
    keys[key] = true;
    collectKeys(value[key], keys);
  }
  return keys;
}

function publicSnapshotIsRedacted(frame) {
  const keys = collectKeys(frame.room);
  for (const forbidden of ['clients', 'drawPile', 'gameSessionId', 'recentCommandIds', 'resetAliases', 'userId']) {
    if (keys[forbidden]) return false;
  }
  const state = frame.room?.state;
  if (!state) return true;
  if (!Number.isSafeInteger(state.drawPileCount) || state.drawPileCount < 0 || state.drawPile !== undefined) return false;
  if (state.drawnCard !== null) return false;
  for (const player of state.players || []) {
    for (const card of player.grid || []) {
      if (!card.faceUp && !card.removed && card.value !== null) return false;
    }
  }
  return true;
}

function safeMetricValues(data, name) {
  const values = data?.metrics?.[name]?.values;
  return values && typeof values === 'object' ? values : {};
}

function finiteMetric(data, name, key, fallback) {
  const value = safeMetricValues(data, name)[key];
  return Number.isFinite(value) ? value : fallback;
}

function allExpectedThresholdsPassed(data) {
  return Object.keys(options.thresholds).every((name) => {
    const thresholds = data?.metrics?.[name]?.thresholds;
    const results = thresholds && typeof thresholds === 'object' ? Object.values(thresholds) : [];
    return results.length > 0 && results.every((result) => result?.ok === true);
  });
}

export function handleSummary(data) {
  const iterations = finiteMetric(data, 'iterations', 'count', -1);
  const summary = {
    formatVersion: 1,
    kind: 'skyjo-k6-summary',
    loadDurationSeconds: durationSeconds,
    topology: { rooms, clientsPerRoom },
    metrics: {
      clientsConnected: finiteMetric(data, 'skyjo_clients_connected', 'count', -1),
      errorCount: finiteMetric(data, 'skyjo_load_errors', 'count', -1),
      errorRate: finiteMetric(data, 'skyjo_operation_error_rate', 'rate', -1),
      interruptedIterations: Number.isFinite(iterations) ? Math.max(0, rooms - iterations) : -1,
      iterations,
      markerObservations: finiteMetric(data, 'skyjo_marker_observations', 'count', -1),
      markersSent: finiteMetric(data, 'skyjo_markers_sent', 'count', -1),
      privacyViolations: finiteMetric(data, 'skyjo_privacy_violations', 'count', -1),
      propagationP95Ms: finiteMetric(data, 'skyjo_propagation_ms', 'p(95)', -1),
      revisionDivergences: finiteMetric(data, 'skyjo_revision_divergences', 'count', -1),
      roomsCompleted: finiteMetric(data, 'skyjo_rooms_completed', 'count', -1),
      roomsStarted: finiteMetric(data, 'skyjo_rooms_started', 'count', -1),
      sessionsVerified: finiteMetric(data, 'skyjo_sessions_verified', 'count', -1)
    },
    thresholdsPassed: allExpectedThresholdsPassed(data)
  };
  const destination = requiredEnvironment('SKYJO_K6_SUMMARY_FILE');
  return { [destination]: `${JSON.stringify(summary, null, 2)}\n` };
}

export default function roomController(data) {
  const roomIndex = __VU - 1;
  if (roomIndex < 0 || roomIndex >= rooms) throw new Error('Unexpected virtual-user identity.');
  const websocketUrl = `${data.baseUrl.replace('http:', 'ws:')}/rooms`;
  const state = {
    failed: false,
    finished: false,
    guestSocketsOpened: false,
    hostPlayerId: '',
    lastRooms: Array(clientsPerRoom).fill(null),
    loadStartedAt: 0,
    markerSequence: 0,
    pending: null,
    roomCode: '',
    sockets: Array(clientsPerRoom).fill(null),
    startSent: false,
    timeoutId: 0
  };

  function closeAll() {
    for (const socket of state.sockets) {
      if (socket && socket.readyState < 2) socket.close();
    }
  }

  function failRoom({ privacy = false, revision = false } = {}) {
    if (state.failed || state.finished) return;
    state.failed = true;
    errorCount.add(1);
    operationErrorRate.add(true);
    if (privacy) privacyViolations.add(1);
    if (revision) revisionDivergences.add(1);
    clearTimeout(state.timeoutId);
    closeAll();
  }

  function sendCommand(socket, expectedRevision, sequence, action) {
    socket.send(JSON.stringify({
      type: 'command',
      protocolVersion: 2,
      commandId: commandId(__VU, sequence),
      expectedRevision,
      action
    }));
  }

  function maybeFinishMarker() {
    const pending = state.pending;
    if (!pending || !pending.acked || pending.observedCount !== clientsPerRoom || state.failed) return;
    operationErrorRate.add(false);
    state.pending = null;
    if (pending.sequence === durationSeconds) {
      const elapsed = Date.now() - state.loadStartedAt;
      if (elapsed < durationSeconds * 1000) {
        setTimeout(maybeFinishRoom, durationSeconds * 1000 - elapsed);
      } else {
        maybeFinishRoom();
      }
      return;
    }
    const nextSequence = pending.sequence + 1;
    const target = state.loadStartedAt + nextSequence * 1000;
    setTimeout(() => sendMarker(nextSequence), Math.max(0, target - Date.now()));
  }

  function maybeFinishRoom() {
    if (state.failed || state.finished || state.pending) return;
    if (Date.now() - state.loadStartedAt < durationSeconds * 1000) return;
    state.finished = true;
    clearTimeout(state.timeoutId);
    roomsCompleted.add(1);
    closeAll();
  }

  function sendMarker(sequence) {
    if (state.failed || state.finished || state.pending) return;
    const hostRoom = state.lastRooms[0];
    if (!hostRoom || !Number.isSafeInteger(hostRoom.revision)) return failRoom({ revision: true });
    const marker = `cert-v${String(__VU).padStart(2, '0')}-m${String(sequence).padStart(3, '0')}`;
    const id = commandId(__VU, 1000 + sequence);
    state.pending = {
      acked: false,
      expectedRevision: hostRoom.revision + 1,
      id,
      marker,
      observed: {},
      observedCount: 0,
      sendAt: Date.now(),
      sequence
    };
    markersSent.add(1);
    state.sockets[0].send(JSON.stringify({
      type: 'command',
      protocolVersion: 2,
      commandId: id,
      expectedRevision: hostRoom.revision,
      action: { type: 'send-chat-message', text: marker }
    }));
  }

  function beginLoadIfReady() {
    if (state.loadStartedAt || state.failed || !state.startSent) return;
    const roomsSeen = state.lastRooms;
    if (roomsSeen.some((room) => !room || room.status !== 'playing' || !room.state)) return;
    const revisions = roomsSeen.map((room) => room.revision);
    if (new Set(revisions).size !== 1) return;
    state.loadStartedAt = Date.now();
    roomsStarted.add(1);
    setTimeout(() => sendMarker(1), 1000);
  }

  function openGuests() {
    if (state.guestSocketsOpened || !state.roomCode) return;
    state.guestSocketsOpened = true;
    for (let seat = 1; seat < clientsPerRoom; seat += 1) openSeat(seat);
  }

  function inspectSnapshot(frame, seat) {
    if (frame.protocolVersion !== 2 || !frame.room || frame.revision !== frame.room.revision) {
      failRoom({ revision: true });
      return;
    }
    if (!publicSnapshotIsRedacted(frame)) {
      failRoom({ privacy: true });
      return;
    }
    state.lastRooms[seat] = frame.room;
    if (seat === 0 && !state.roomCode) {
      state.roomCode = frame.room.code;
      state.hostPlayerId = frame.playerId;
      openGuests();
    }
    if (
      seat === 0 &&
      !state.startSent &&
      frame.room.status === 'waiting' &&
      frame.room.players?.length === clientsPerRoom
    ) {
      state.startSent = true;
      sendCommand(state.sockets[0], frame.room.revision, 1, { type: 'start-game' });
    }

    const pending = state.pending;
    if (pending) {
      const observed = frame.room.chatMessages?.some((message) => message.text === pending.marker);
      if (observed && !pending.observed[seat]) {
        if (frame.revision !== pending.expectedRevision) {
          failRoom({ revision: true });
          return;
        }
        pending.observed[seat] = true;
        pending.observedCount += 1;
        markerObservations.add(1);
        propagation.add(Date.now() - pending.sendAt);
        operationErrorRate.add(false);
      }
    }
    beginLoadIfReady();
    maybeFinishMarker();
  }

  function inspectFrame(raw, seat) {
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      failRoom();
      return;
    }
    if (frame.type === 'snapshot' || frame.type === 'resync') {
      inspectSnapshot(frame, seat);
      return;
    }
    if (frame.type === 'ack') {
      const pending = state.pending;
      if (pending && frame.commandId === pending.id) {
        if (frame.revision !== pending.expectedRevision) {
          failRoom({ revision: true });
          return;
        }
        pending.acked = true;
        maybeFinishMarker();
      }
      return;
    }
    if (frame.type === 'error' || frame.type === 'upgrade-required') failRoom();
  }

  function openSeat(seat) {
    const cookie = data.clientCookies[roomIndex * clientsPerRoom + seat];
    const socket = new WebSocket(websocketUrl, null, {
      headers: { Cookie: cookie },
      tags: { room: String(roomIndex + 1), seat: String(seat + 1) }
    });
    state.sockets[seat] = socket;
    socket.addEventListener('open', () => {
      clientsConnected.add(1);
      if (seat === 0) {
        socket.send(JSON.stringify({ type: 'create-room', protocolVersion: 2, name: `Room ${__VU} Host` }));
      } else {
        socket.send(JSON.stringify({
          type: 'join-room',
          protocolVersion: 2,
          code: state.roomCode,
          name: `Room ${__VU} Seat ${seat + 1}`
        }));
      }
    });
    socket.addEventListener('message', (event) => inspectFrame(event.data, seat));
    socket.addEventListener('error', () => failRoom());
    socket.addEventListener('close', () => {
      if (!state.finished && !state.failed) failRoom();
    });
  }

  state.timeoutId = setTimeout(() => failRoom(), (durationSeconds + 90) * 1000);
  openSeat(0);
}
