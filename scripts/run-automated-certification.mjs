import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import {
  CERTIFICATION_LIMITS,
  CERTIFICATION_RELEASE_VERSION,
  K6_LINUX_AMD64_SHA256,
  K6_VERSION,
  createAutomatedCertificationEvidence,
  validateEightClientPersonaEvidence,
  validateK6CertificationSummary,
  writeCertificationEvidence
} from './certification-lib.mjs';
import { loadReleaseIdentity } from '../server-release.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsDirectory = path.join(root, 'test-results', 'certification');
const personaEvidencePath = path.join(resultsDirectory, 'eight-client-personas.json');
const k6SummaryPath = path.join(resultsDirectory, 'k6-summary.json');
const automatedEvidencePath = path.join(resultsDirectory, 'automated.json');
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const siteCookieName = 'skyjo_cert_site';
const accountCookieName = 'skyjo_cert_account';
const accessPassword = 'isolated-certification-access-password';
const sessionSecret = 'isolated-certification-session-secret-2026';
const inviteSecret = 'isolated-certification-invite-secret-2026';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fullSha(value, label) {
  const sha = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`${label} must be a full lowercase commit SHA.`);
  return sha;
}

async function sourceIdentity() {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const checkoutSha = fullSha(stdout, 'Checked-out source identity');
  const configured = process.env.SKYJO_RELEASE_SHA
    ? fullSha(process.env.SKYJO_RELEASE_SHA, 'Configured source identity')
    : checkoutSha;
  if (checkoutSha !== configured) throw new Error('Configured source identity does not match the checked-out commit.');
  return configured;
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, 'close'),
    delay(timeoutMs).then(() => {
      throw new Error('A certification child process did not stop within its bounded timeout.');
    })
  ]);
}

async function runVisibleProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: options.env || process.env,
    stdio: 'inherit',
    windowsHide: true
  });
  const [code, signal] = await once(child, 'close');
  if (code !== 0) throw new Error(`${options.label || 'Certification command'} failed (${signal || code}).`);
}

function serverEnvironment(dataDirectory, sourceSha) {
  return {
    ...process.env,
    HOST: '127.0.0.1',
    NODE_ENV: 'test',
    PORT: '0',
    SKYJO_ACCESS_PASSWORD: accessPassword,
    SKYJO_ACCOUNT_COOKIE_NAME: accountCookieName,
    SKYJO_ADMIN_INITIAL_PASSWORD: '',
    SKYJO_COOKIE_NAME: siteCookieName,
    SKYJO_DB_FILE: path.join(dataDirectory, 'skyjo.sqlite'),
    SKYJO_INVITE_SECRET: inviteSecret,
    SKYJO_RELEASE_SHA: sourceSha,
    SKYJO_ROOMS_FILE: path.join(dataDirectory, 'rooms.json'),
    SKYJO_SECURE_COOKIES: 'false',
    SKYJO_SESSION_SECRET: sessionSecret,
    SKYJO_VAPID_PRIVATE_KEY: '',
    SKYJO_VAPID_PUBLIC_KEY: ''
  };
}

async function spawnCertificationServer(dataDirectory, sourceSha) {
  await fs.mkdir(dataDirectory, { recursive: true });
  const startedAt = Date.now();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: serverEnvironment(dataDirectory, sourceSha),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let output = '';
  let resolvePort;
  let rejectPort;
  const portPromise = new Promise((resolve, reject) => {
    resolvePort = resolve;
    rejectPort = reject;
  });
  const onOutput = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-64_000);
    const match = output.match(/Listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match && resolvePort) {
      resolvePort(Number(match[1]));
      resolvePort = null;
      rejectPort = null;
    }
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  child.once('exit', (code) => {
    if (rejectPort) rejectPort(new Error(`Isolated certification server exited before listening (${code}).`));
  });
  const startupTimer = setTimeout(() => {
    if (rejectPort) rejectPort(new Error('Isolated certification server did not report its port.'));
  }, CERTIFICATION_LIMITS.restartRtoMs);

  try {
    const port = await portPromise;
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = startedAt + CERTIFICATION_LIMITS.restartRtoMs;
    let ready = null;
    while (Date.now() <= deadline) {
      if (child.exitCode !== null) throw new Error('Isolated certification server exited during readiness.');
      try {
        const response = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(1_000) });
        if (response.status === 200) {
          ready = await response.json();
          break;
        }
      } catch {
        // The isolated process is still loading its database and room snapshot.
      }
      await delay(50);
    }
    if (!ready) throw new Error('Isolated certification server did not become ready within 15 seconds.');
    if (ready.releaseSha !== sourceSha || ready.schemaVersion !== 2 || ready.protocolVersion !== 2) {
      throw new Error('Isolated certification server reported a mismatched release identity.');
    }
    return {
      baseUrl,
      child,
      output: () => output,
      readyAt: Date.now(),
      startedAt
    };
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGKILL');
    await waitForExit(child).catch(() => {});
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
}

async function stopCertificationServer(server, signal = 'SIGTERM') {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill(signal);
  try {
    await waitForExit(server.child, signal === 'SIGKILL' ? 5_000 : 8_000);
  } catch (error) {
    if (signal !== 'SIGKILL' && server.child.exitCode === null) {
      server.child.kill('SIGKILL');
      await waitForExit(server.child, 5_000);
    }
    throw error;
  }
}

function cookieFrom(response, name) {
  const headers = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  for (const header of headers) {
    const match = header.match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;]+)`));
    if (match) return `${name}=${match[1]}`;
  }
  throw new Error('Isolated certification authentication did not set its expected cookie.');
}

async function createRecoveryAccount(baseUrl, trial) {
  const access = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    body: new URLSearchParams({ next: '/', password: accessPassword }),
    redirect: 'manual'
  });
  if (access.status !== 303) throw new Error('Recovery access login failed.');
  const siteCookie = cookieFrom(access, siteCookieName);
  const signup = await fetch(`${baseUrl}/api/account/signup`, {
    method: 'POST',
    headers: { Cookie: siteCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `recovery-trial-${trial}@example.test`,
      displayName: `Recovery Trial ${trial}`,
      password: 'recovery-certification-password',
      confirmPassword: 'recovery-certification-password'
    })
  });
  if (signup.status !== 201) throw new Error('Recovery account provisioning failed.');
  return `${siteCookie}; ${cookieFrom(signup, accountCookieName)}`;
}

class RecoverySocket {
  constructor(socket) {
    this.socket = socket;
    this.frames = [];
    this.waiters = [];
    this.revision = null;
    this.playerId = '';
    this.room = null;
    socket.on('message', (raw) => this.receive(raw));
    socket.on('error', (error) => this.rejectAll(error));
  }

  receive(raw) {
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      this.rejectAll(new Error('Recovery socket received invalid JSON.'));
      return;
    }
    if ((frame.type === 'snapshot' || frame.type === 'resync') && frame.room) {
      this.revision = frame.revision;
      this.playerId = frame.playerId;
      this.room = frame.room;
    } else if (frame.type === 'ack' && Number.isSafeInteger(frame.revision)) {
      this.revision = frame.revision;
    }
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(frame));
    if (waiterIndex >= 0) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else {
      this.frames.push(frame);
      if (this.frames.length > 256) this.frames.shift();
    }
  }

  rejectAll(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  waitFor(predicate, label, timeoutMs = 5_000) {
    const frameIndex = this.frames.findIndex(predicate);
    if (frameIndex >= 0) return Promise.resolve(this.frames.splice(frameIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Recovery socket timed out waiting for ${label}.`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async admit(message) {
    const snapshot = this.waitFor((frame) => frame.type === 'snapshot' || frame.type === 'resync', 'admission snapshot');
    this.socket.send(JSON.stringify({ ...message, protocolVersion: 2 }));
    return snapshot;
  }

  async command(commandId, action) {
    if (!Number.isSafeInteger(this.revision)) throw new Error('Recovery socket has no authoritative revision.');
    const expectedRevision = this.revision;
    const nextRevision = expectedRevision + 1;
    const snapshot = this.waitFor(
      (frame) => (frame.type === 'snapshot' || frame.type === 'resync') && frame.revision === nextRevision,
      'command snapshot'
    );
    const acknowledgement = this.waitFor(
      (frame) => frame.type === 'ack' && frame.commandId === commandId,
      'command acknowledgement'
    );
    this.socket.send(JSON.stringify({
      type: 'command',
      protocolVersion: 2,
      commandId,
      expectedRevision,
      action
    }));
    const [snapshotFrame, ackFrame] = await Promise.all([snapshot, acknowledgement]);
    if (snapshotFrame.revision !== nextRevision || ackFrame.revision !== nextRevision) {
      throw new Error('Recovery command did not advance exactly one revision.');
    }
    return { acknowledgedAt: Date.now(), commandId, revision: nextRevision };
  }

  close() {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

async function openRecoverySocket(baseUrl, cookie) {
  const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/rooms`, { headers: { Cookie: cookie } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Recovery WebSocket did not open.'));
    }, 5_000);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
  return new RecoverySocket(socket);
}

function recoveryCommandId(trial, sequence) {
  return `74000000-0000-4000-8000-${String(trial * 1_000_000 + sequence).padStart(12, '0')}`;
}

async function readPersistedRoom(roomsFile, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const document = JSON.parse(await fs.readFile(roomsFile, 'utf8'));
      const room = document.rooms?.find(predicate);
      if (room) return room;
    } catch {
      // The debounced atomic write has not published a complete snapshot yet.
    }
    await delay(25);
  }
  throw new Error('The expected recovery room was not durably persisted.');
}

async function runRecoveryTrial(trial, parentDirectory, sourceSha) {
  const dataDirectory = path.join(parentDirectory, `recovery-${trial}`);
  const roomsFile = path.join(dataDirectory, 'rooms.json');
  const killOffsets = [325, 475, 625];
  const commandSpacing = [25, 40, 50];
  let server = null;
  let socket = null;
  let restarted = null;
  let reconnectSocket = null;
  try {
    server = await spawnCertificationServer(dataDirectory, sourceSha);
    const cookie = await createRecoveryAccount(server.baseUrl, trial);
    socket = await openRecoverySocket(server.baseUrl, cookie);
    const admission = await socket.admit({ type: 'create-room', name: `Recovery Trial ${trial}` });
    const roomCode = admission.room.code;
    const playerId = admission.playerId;
    await readPersistedRoom(roomsFile, (room) => room.code === roomCode && room.revision === 0);

    const acknowledgements = [];
    const baseline = await socket.command(
      recoveryCommandId(trial, 1),
      { type: 'send-chat-message', text: `Recovery baseline ${trial}` }
    );
    acknowledgements.push(baseline);
    await readPersistedRoom(
      roomsFile,
      (room) => room.code === roomCode && room.recentCommandIds?.some((receipt) => receipt.commandId === baseline.commandId)
    );

    const measuredStart = Date.now();
    let sequence = 2;
    while (Date.now() - measuredStart < killOffsets[trial - 1]) {
      acknowledgements.push(await socket.command(
        recoveryCommandId(trial, sequence),
        { type: 'send-chat-message', text: `Recovery marker ${trial}-${sequence}` }
      ));
      sequence += 1;
      await delay(commandSpacing[trial - 1]);
    }
    if (acknowledgements.length < 2) throw new Error('Recovery trial produced too few acknowledged commands.');
    await stopCertificationServer(server, 'SIGKILL');
    server = null;
    socket = null;

    const persisted = await readPersistedRoom(roomsFile, (room) => room.code === roomCode, 1_000);
    const persistedIds = new Set((persisted.recentCommandIds || []).map((receipt) => receipt.commandId));
    const durable = acknowledgements.filter((acknowledgement) => persistedIds.has(acknowledgement.commandId));
    if (durable.length === 0) throw new Error('Recovery trial retained no acknowledged command.');
    const lastAcknowledgedAt = Math.max(...acknowledgements.map((acknowledgement) => acknowledgement.acknowledgedAt));
    const lastDurableAt = Math.max(...durable.map((acknowledgement) => acknowledgement.acknowledgedAt));
    const persistenceRpoMs = Math.max(0, lastAcknowledgedAt - lastDurableAt);
    if (persistenceRpoMs > CERTIFICATION_LIMITS.persistenceRpoMs) throw new Error('Persistence RPO exceeded 500ms.');

    restarted = await spawnCertificationServer(dataDirectory, sourceSha);
    const restartRtoMs = restarted.readyAt - restarted.startedAt;
    reconnectSocket = await openRecoverySocket(restarted.baseUrl, cookie);
    const recovered = await reconnectSocket.admit({
      type: 'join-room',
      code: roomCode,
      name: `Recovery Trial ${trial}`,
      playerId
    });
    const reconnectRtoMs = Date.now() - restarted.startedAt;
    if (recovered.playerId !== playerId || recovered.room.code !== roomCode || recovered.revision < persisted.revision) {
      throw new Error('Recovery restart did not restore the same authoritative seat.');
    }
    if (restartRtoMs > CERTIFICATION_LIMITS.restartRtoMs || reconnectRtoMs > CERTIFICATION_LIMITS.reconnectRtoMs) {
      throw new Error('Recovery restart or reconnect exceeded 15 seconds.');
    }

    reconnectSocket.close();
    reconnectSocket = null;
    await stopCertificationServer(restarted);
    restarted = null;
    return {
      trial,
      acknowledgedCommands: acknowledgements.length,
      durableCommands: durable.length,
      persistenceRpoMs,
      restartRtoMs,
      reconnectRtoMs
    };
  } finally {
    reconnectSocket?.close();
    socket?.close();
    await stopCertificationServer(restarted).catch(() => {});
    await stopCertificationServer(server, 'SIGKILL').catch(() => {});
  }
}

async function runRecoveryCertification(parentDirectory, sourceSha) {
  const trials = [];
  for (let trial = 1; trial <= CERTIFICATION_LIMITS.recoveryTrials; trial += 1) {
    trials.push(await runRecoveryTrial(trial, parentDirectory, sourceSha));
  }
  return {
    trials,
    maxPersistenceRpoMs: Math.max(...trials.map((trial) => trial.persistenceRpoMs)),
    maxRestartRtoMs: Math.max(...trials.map((trial) => trial.restartRtoMs)),
    maxReconnectRtoMs: Math.max(...trials.map((trial) => trial.reconnectRtoMs))
  };
}

async function readVmRssKib(pid) {
  const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
  const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  if (!match) throw new Error('Application RSS was unavailable from procfs.');
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Application RSS sample was invalid.');
  return value;
}

async function runK6Certification(parentDirectory, sourceSha, k6Binary) {
  const dataDirectory = path.join(parentDirectory, 'load');
  const server = await spawnCertificationServer(dataDirectory, sourceSha);
  let k6Output = '';
  let sampling = true;
  let samplingError = null;
  let maxRssKib = 0;
  try {
    const child = spawn(k6Binary, ['run', '--quiet', path.join(root, 'tests', 'load', 'skyjo-realtime.k6.js')], {
      cwd: root,
      env: {
        ...process.env,
        SKYJO_K6_SUMMARY_FILE: k6SummaryPath,
        SKYJO_LOAD_ACCESS_PASSWORD: accessPassword,
        SKYJO_LOAD_ACCOUNT_COOKIE_NAME: accountCookieName,
        SKYJO_LOAD_BASE_URL: server.baseUrl,
        SKYJO_LOAD_CLIENTS_PER_ROOM: String(CERTIFICATION_LIMITS.clientsPerRoom),
        SKYJO_LOAD_DURATION_SECONDS: String(CERTIFICATION_LIMITS.durationSeconds),
        SKYJO_LOAD_ROOMS: String(CERTIFICATION_LIMITS.rooms),
        SKYJO_LOAD_SITE_COOKIE_NAME: siteCookieName,
        SKYJO_RELEASE_SHA: sourceSha
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        k6Output = `${k6Output}${chunk}`.slice(-64_000);
      });
    }
    const sampler = (async () => {
      while (sampling) {
        maxRssKib = Math.max(maxRssKib, await readVmRssKib(server.child.pid));
        await delay(100);
      }
    })().catch((error) => {
      samplingError = error;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    const [code, signal] = await once(child, 'close');
    sampling = false;
    await sampler;
    if (samplingError) throw samplingError;
    let summary;
    try {
      summary = JSON.parse(await fs.readFile(k6SummaryPath, 'utf8'));
    } catch {
      throw new Error('k6 did not produce a valid sanitized summary.');
    }
    validateK6CertificationSummary(summary);
    if (code !== 0) {
      if (k6Output) process.stderr.write(k6Output);
      throw new Error(`k6 certification failed (${signal || code}).`);
    }
    if (maxRssKib >= CERTIFICATION_LIMITS.rssKibExclusive) throw new Error('Application RSS reached 256 MiB.');
    return { summary, maxRssKib };
  } finally {
    sampling = false;
    await stopCertificationServer(server).catch(async () => {
      await stopCertificationServer(server, 'SIGKILL').catch(() => {});
    });
  }
}

async function resolveK6Binary() {
  const configured = String(process.env.SKYJO_K6_BIN || '').trim();
  if (!configured || !path.isAbsolute(configured)) throw new Error('SKYJO_K6_BIN must name the pinned absolute k6 executable.');
  const stat = await fs.stat(configured);
  if (!stat.isFile()) throw new Error('The configured k6 executable is not a regular file.');
  const { stdout } = await execFileAsync(configured, ['version'], { encoding: 'utf8' });
  if (!new RegExp(`^k6(?:\\.exe)? v${K6_VERSION.replaceAll('.', '\\.')}(?: |$)`).test(stdout)) {
    throw new Error('The configured k6 executable is not v2.0.0.');
  }
  return configured;
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Full certification requires Linux SIGKILL and procfs semantics.');
  if (!/^v24\.\d+\.\d+$/.test(process.version)) throw new Error('Full certification requires Node 24.');
  const sourceSha = await sourceIdentity();
  const packageDocument = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (packageDocument.version !== CERTIFICATION_RELEASE_VERSION) throw new Error('package.json is not version 0.2.0.');
  const releaseIdentity = await loadReleaseIdentity(path.join(root, 'dist'), {
    allowDevelopment: false,
    requireFullSha: true
  });
  if (
    releaseIdentity.releaseSha !== sourceSha ||
    releaseIdentity.schemaVersion !== 2 ||
    releaseIdentity.protocolVersion !== 2
  ) {
    throw new Error('Built release identity does not match the certification source.');
  }
  const k6Binary = await resolveK6Binary();
  await fs.rm(resultsDirectory, { recursive: true, force: true });
  await fs.mkdir(resultsDirectory, { recursive: true });
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-certification-'));
  try {
    await runVisibleProcess(npmExecutable, ['run', 'test:e2e:certification'], {
      label: 'Eight-client browser persona certification',
      env: {
        ...process.env,
        SKYJO_CERTIFICATION_PERSONA_EVIDENCE: personaEvidencePath,
        SKYJO_RELEASE_SHA: sourceSha
      }
    });
    const persona = JSON.parse(await fs.readFile(personaEvidencePath, 'utf8'));
    validateEightClientPersonaEvidence(persona);
    const { summary: k6Summary, maxRssKib } = await runK6Certification(temporaryDirectory, sourceSha, k6Binary);
    const recovery = await runRecoveryCertification(temporaryDirectory, sourceSha);
    const evidence = createAutomatedCertificationEvidence({
      release: {
        version: packageDocument.version,
        sourceSha,
        buildTimestamp: releaseIdentity.buildTimestamp,
        schemaVersion: releaseIdentity.schemaVersion,
        protocolVersion: releaseIdentity.protocolVersion,
        nodeVersion: process.version,
        k6Version: K6_VERSION,
        k6ArchiveSha256: K6_LINUX_AMD64_SHA256
      },
      k6Summary,
      maxRssKib,
      recovery,
      persona
    });
    const { digest } = await writeCertificationEvidence(automatedEvidencePath, evidence);
    console.log(`Automated v0.2.0 certification passed for ${sourceSha} (${digest}).`);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Automated certification failed.');
  process.exitCode = 1;
});
