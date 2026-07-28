#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const V032_RELEASE_SHA = '130114e745c66c9f72305f05a0366e3f0ca10915';
export const V032_ROOM_CONNECTION_SHA256 = 'f298980f1020f7d201628e51be68227b842caeacfe7b79c16860980ccc99acd9';
export const V032_PROTOCOL_V2_SHA256 = 'd57283c7ea9b4662bd316d1fe1d3dc5d043dbccfb2ddd00b477266d9c26f334b';

function git(repositoryRoot, ...arguments_) {
  return execFileSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1_024 * 1_024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactTaggedSource(repositoryRoot, file, expectedDigest) {
  const source = git(repositoryRoot, 'show', `${V032_RELEASE_SHA}:${file}`);
  if (digest(source) !== expectedDigest) throw new Error('tagged-source-mismatch');
  return source;
}

async function loadExactTaggedCommandParser(protocolSource) {
  const start = protocolSource.indexOf('export const MULTIPLAYER_PROTOCOL_VERSION');
  const end = protocolSource.indexOf('export function reduceAuthoritativeGameCommand');
  if (start < 0 || end <= start) throw new Error('tagged-parser-missing');
  const parserSource = protocolSource.slice(start, end);
  const javascript = ts.transpileModule(parserSource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  if (javascript.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    throw new Error('tagged-parser-invalid');
  }
  const encoded = Buffer.from(javascript.outputText).toString('base64');
  const taggedModule = await import(`data:text/javascript;base64,${encoded}`);
  if (typeof taggedModule.parseClientCommand !== 'function') throw new Error('tagged-parser-invalid');
  return taggedModule.parseClientCommand;
}

async function loadExactTaggedSnapshotValidator(roomConnectionSource, snapshotLimits) {
  const start = roomConnectionSource.indexOf('function isRecord');
  const end = roomConnectionSource.indexOf('function isAuthoritativeSnapshot');
  if (start < 0 || end <= start) throw new Error('tagged-snapshot-validator-missing');
  const validatorSource = [
    `const PUBLIC_SNAPSHOT_LIMITS = Object.freeze(${JSON.stringify(snapshotLimits)});`,
    roomConnectionSource.slice(start, end),
  ].join('\n');
  const javascript = ts.transpileModule(validatorSource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  if (javascript.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    throw new Error('tagged-snapshot-validator-invalid');
  }
  const encoded = Buffer.from(javascript.outputText).toString('base64');
  const taggedModule = await import(`data:text/javascript;base64,${encoded}`);
  if (typeof taggedModule.isMultiplayerRoomSnapshot !== 'function') {
    throw new Error('tagged-snapshot-validator-invalid');
  }
  return taggedModule.isMultiplayerRoomSnapshot;
}

function command(text) {
  return {
    type: 'command',
    protocolVersion: 2,
    commandId: '40000000-0000-4000-8000-000000000032',
    expectedRevision: 0,
    action: { type: 'send-chat-message', text },
  };
}

function representativeCurrentServerSnapshot(text) {
  const playerID = '10000000-0000-4000-8000-000000000001';
  return {
    code: 'ABCDE',
    hostId: playerID,
    players: [{
      id: playerID,
      name: 'PWA Guest',
      connected: true,
      host: true,
      controller: 'human',
      disconnectedAt: null,
      aiTakeoverAt: null,
    }],
    chatMessages: [{
      id: '20000000-0000-4000-8000-000000000002',
      playerId: playerID,
      playerName: 'PWA Guest',
      text,
      createdAt: 1_784_998_800_000,
    }],
    readyForNextRoundPlayerIds: [],
    state: null,
    status: 'waiting',
    updatedAt: 1_784_998_800_000,
    completedGameId: null,
    finishedByAi: false,
    hostTransferAt: null,
    revision: 1,
    serverNow: 1_784_998_800_000,
  };
}

export async function verifyV032PWACompatibility(repositoryRoot) {
  const release = git(repositoryRoot, 'rev-parse', 'v0.3.2^{commit}').trim();
  if (release !== V032_RELEASE_SHA) throw new Error('tagged-release-mismatch');
  const roomConnectionSource = exactTaggedSource(
    repositoryRoot,
    'src/roomConnection.ts',
    V032_ROOM_CONNECTION_SHA256
  );
  if (!roomConnectionSource.includes("const parsedCommand = frame.type === 'command' ? parseClientCommand(frame) : null;")) {
    throw new Error('tagged-client-boundary-missing');
  }
  const protocolSource = exactTaggedSource(
    repositoryRoot,
    'src/protocolV2.ts',
    V032_PROTOCOL_V2_SHA256
  );
  const parseClientCommand = await loadExactTaggedCommandParser(protocolSource);
  const protocolModuleStart = protocolSource.indexOf('export const MULTIPLAYER_PROTOCOL_VERSION');
  const protocolModuleEnd = protocolSource.indexOf('export function reduceAuthoritativeGameCommand');
  const protocolJavaScript = ts.transpileModule(
    protocolSource.slice(protocolModuleStart, protocolModuleEnd),
    { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  const protocolModule = await import(
    `data:text/javascript;base64,${Buffer.from(protocolJavaScript).toString('base64')}`
  );
  const validateSnapshot = await loadExactTaggedSnapshotValidator(
    roomConnectionSource,
    protocolModule.PUBLIC_SNAPSHOT_LIMITS
  );
  const accepted = parseClientCommand(command('🃏'.repeat(140)));
  const rejected = parseClientCommand(command('🃏'.repeat(141)));
  const inboundAccepted = validateSnapshot(
    representativeCurrentServerSnapshot('🃏'.repeat(140)),
    'ABCDE'
  );
  const inboundRejected = validateSnapshot(
    representativeCurrentServerSnapshot('🃏'.repeat(141)),
    'ABCDE'
  );
  if (accepted?.ok !== true || rejected?.ok !== false
      || inboundAccepted !== true || inboundRejected !== false) {
    throw new Error('tagged-chat-boundary-mismatch');
  }
  return Object.freeze({
    release: V032_RELEASE_SHA,
    maximumAstralScalars: 140,
    maximumUTF16Units: 280,
    nextAstralScalarsRejected: 141,
    inboundSnapshotValidated: true,
  });
}

async function main() {
  try {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    await verifyV032PWACompatibility(repositoryRoot);
    process.stdout.write('Verified immutable v0.3.2 PWA wire compatibility.\n');
  } catch {
    process.stderr.write('ERROR: Immutable v0.3.2 PWA compatibility verification failed.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
