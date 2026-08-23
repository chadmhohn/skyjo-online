import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDirectory = path.join(repositoryRoot, 'contracts', 'v1', 'fixtures');
const fixtureRelativePath = path.relative(repositoryRoot, fixtureDirectory);
const mode = process.argv[2] || '--check';
const allowedModes = new Set(['--check', '--write']);
const fixedEpoch = 1_784_998_800_000;
const fullSha = '0123456789abcdef0123456789abcdef01234567';
const hostId = '10000000-0000-4000-8000-000000000001';
const guestId = '20000000-0000-4000-8000-000000000002';
const accountId = '30000000-0000-4000-8000-000000000003';
const commandIds = Array.from(
  { length: 48 },
  (_, index) => `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
);

if (!allowedModes.has(mode) || process.argv.length > 3) {
  throw new Error('Usage: node scripts/generate-contract-fixtures.mjs [--check|--write]');
}

const [
  gameModule,
  protocolModule,
  runtimeModule,
  serverProtocolModule,
  accountModule,
  readinessModule,
  roomInviteModule,
  aiStrategyModule,
  aiProjectionModule,
  soloAiSetupModule
] = await Promise.all([
  import('../server-dist/game.js'),
  import('../server-dist/protocolV2.js'),
  import('../server-dist/runtime.js'),
  import('../server-dist/serverProtocolV2.js'),
  import('../server-account-store.mjs'),
  import('../server-readiness.mjs'),
  import('../server-room-invites.mjs'),
  import('../server-dist/aiStrategy.js'),
  import('../server-dist/aiProjection.js'),
  import('../server-dist/soloAiSetup.js')
]);

const {
  chooseDiscard,
  cancelDiscardSelection,
  createMultiplayerGame,
  discardDrawnAndReveal,
  drawBlind,
  replaceCard,
  revealOpeningCard,
  startFreshGame,
  startNextRound
} = gameModule;
const {
  createRoomSnapshot,
  redactGameState,
  MULTIPLAYER_PROTOCOL_VERSION,
  PUBLIC_SNAPSHOT_LIMITS,
  SHARED_SNAPSHOT_ENVELOPE_VERSION,
  EXPLICIT_PRESENCE_VERSION
} = protocolModule;
const { createSeededRandom } = runtimeModule;
const { createProtocolV2MessageHandler } = serverProtocolModule;
const { AccountStore, PublicApiError, publicApiErrorResponse } = accountModule;
const { createReadinessResult, createVersionResult } = readinessModule;
const { createAppleAppSiteAssociation, SYNTHETIC_APPLE_APPLICATION_IDENTIFIER } = roomInviteModule;
const { chooseAiMove, soloAiStrategyVersion } = aiStrategyModule;
const { projectAiKnowledge } = aiProjectionModule;
const { createSoloGameSetup, resolveSoloGameSetup } = soloAiSetupModule;

function clone(value) {
  return structuredClone(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])])
  );
}

function serialize(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function scriptedSource(label, values) {
  let index = 0;
  return {
    next() {
      if (index >= values.length) throw new Error(`${label} consumed more values than scripted.`);
      const value = values[index];
      index += 1;
      return value;
    },
    assertConsumed() {
      if (index !== values.length) {
        throw new Error(`${label} consumed ${index} of ${values.length} scripted values.`);
      }
    }
  };
}

function exactSeededRandom(label, seed, expectedCalls = 149) {
  const seeded = createSeededRandom(seed);
  let calls = 0;
  return {
    next() {
      if (calls >= expectedCalls) throw new Error(`${label} consumed more than ${expectedCalls} random values.`);
      calls += 1;
      return seeded();
    },
    assertConsumed() {
      if (calls !== expectedCalls) throw new Error(`${label} consumed ${calls} of ${expectedCalls} random values.`);
    }
  };
}

function generatedGame(players, seed) {
  const random = exactSeededRandom(`game seed ${seed}`, seed);
  const state = createMultiplayerGame(players, 1, null, random.next);
  random.assertConsumed();
  return state;
}

function finishOpening(input) {
  let state = input;
  for (let moves = 0; state.phase === 'opening-reveal' && moves < 32; moves += 1) {
    const player = state.players[state.currentPlayerIndex];
    const cardIndex = player.grid.findIndex((card) => !card.faceUp && !card.removed);
    if (cardIndex < 0) throw new Error('Opening fixture could not find a legal card.');
    state = revealOpeningCard(state, cardIndex);
  }
  if (state.phase !== 'choose-source') throw new Error('Opening fixture did not reach source selection.');
  return state;
}

function playToScoring(input) {
  let state = input;
  let finalTurnState = null;
  const noRecycle = () => {
    throw new Error('Fixture autoplay unexpectedly exhausted the draw pile.');
  };
  for (let moves = 0; moves < 128; moves += 1) {
    if (state.phase === 'round-over' || state.phase === 'game-over') {
      return { finalTurnState, scoredState: state };
    }
    if (state.phase === 'choose-source') state = drawBlind(state, noRecycle);
    if (state.phase === 'choose-replacement') {
      const player = state.players[state.currentPlayerIndex];
      const hiddenIndex = player.grid.findIndex((card) => !card.faceUp && !card.removed);
      const replaceIndex = player.grid.findIndex((card) => !card.removed);
      state = hiddenIndex >= 0
        ? discardDrawnAndReveal(state, hiddenIndex)
        : replaceCard(state, replaceIndex);
      if (!finalTurnState && state.roundCloserId && state.finalTurnPlayerIds.length > 0) finalTurnState = state;
    }
  }
  throw new Error('Fixture autoplay did not reach scoring.');
}

function roomSource(state, overrides = {}) {
  const players = state.players.map((player, index) => ({
    id: player.id,
    userId: index === 0 ? accountId : `30000000-0000-4000-8000-${String(index + 4).padStart(12, '0')}`,
    name: player.name,
    connected: true,
    host: index === 0,
    joinedAt: fixedEpoch - 10_000 + index,
    lastSeenAt: fixedEpoch - 100 + index,
    disconnectedAt: null,
    controller: 'human',
    aiTakeoverAt: null
  }));
  return {
    code: 'ABCDE',
    hostId: players[0].id,
    players,
    chatMessages: [],
    readyForNextRoundPlayerIds: [],
    state,
    status: state.phase === 'game-over' ? 'finished' : 'playing',
    updatedAt: fixedEpoch,
    completedGameId: state.phase === 'game-over' ? commandIds[40] : null,
    finishedByAi: false,
    hostTransferAt: null,
    revision: 7,
    serverNow: fixedEpoch,
    ...overrides
  };
}

function command(commandId, expectedRevision, action) {
  return {
    type: 'command',
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    commandId,
    expectedRevision,
    action
  };
}

function fixtureCase(name, schema, value, extra = {}) {
  return { name, schema, ...extra, value };
}

function createGameFixtures() {
  const openingState = generatedGame([
    { id: hostId, name: 'Host' },
    { id: guestId, name: 'Guest' }
  ], 0x51a70001);
  const chooseSourceState = finishOpening(openingState);
  const discardState = chooseDiscard(chooseSourceState);
  const blindState = drawBlind(chooseSourceState, () => {
    throw new Error('Initial blind draw must not recycle the deck.');
  });
  const { finalTurnState, scoredState: roundOverState } = playToScoring(chooseSourceState);
  if (!finalTurnState || roundOverState.phase !== 'round-over') throw new Error('Round fixture phases are incomplete.');

  const gameOverOpening = generatedGame([
    { id: hostId, name: 'Host', totalScore: 150 },
    { id: guestId, name: 'Guest', totalScore: 150 }
  ], 0x51a70002);
  const { scoredState: gameOverState } = playToScoring(finishOpening(gameOverOpening));
  if (gameOverState.phase !== 'game-over') throw new Error('Game-over fixture did not finish the game.');

  const eightPlayers = Array.from({ length: 8 }, (_, index) => ({
    id: index === 7
      ? `8${'p'.repeat(PUBLIC_SNAPSHOT_LIMITS.identifierLength - 1)}`
      : `${index + 1}0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: index === 7 ? 'N'.repeat(64) : `Player ${index + 1}`
  }));
  const eightPlayerState = generatedGame(eightPlayers, 0x51a70003);

  const contextFor = (state, status = 'playing') => ({
    rosterPlayerIds: state.players.map((player) => player.id),
    roomStatus: status,
    readyForNextRoundPlayerIds: []
  });
  const valid = [
    fixtureCase('opening reveal', 'game-state.schema.json', openingState, { context: contextFor(openingState) }),
    fixtureCase('choose source', 'game-state.schema.json', chooseSourceState, { context: contextFor(chooseSourceState) }),
    fixtureCase('discard replacement', 'game-state.schema.json', discardState, { context: contextFor(discardState) }),
    fixtureCase('private blind draw', 'game-state.schema.json', blindState, { context: contextFor(blindState) }),
    fixtureCase('active final turn', 'game-state.schema.json', finalTurnState, { context: contextFor(finalTurnState) }),
    fixtureCase('round over', 'game-state.schema.json', roundOverState, { context: contextFor(roundOverState) }),
    fixtureCase('game over', 'game-state.schema.json', gameOverState, { context: contextFor(gameOverState, 'finished') }),
    fixtureCase('eight player bounds', 'game-state.schema.json', eightPlayerState, { context: contextFor(eightPlayerState) })
  ];

  const extraKey = clone(openingState);
  extraKey.internal = true;
  const illegalValue = clone(openingState);
  illegalValue.drawPile[0].value = 13;
  const shortGrid = clone(openingState);
  shortGrid.players[0].grid.pop();
  const duplicateCard = clone(openingState);
  duplicateCard.drawPile[0].id = duplicateCard.players[0].grid[0].id;
  duplicateCard.drawPile[0].value = duplicateCard.players[0].grid[0].value;
  const incoherentSource = clone(chooseSourceState);
  incoherentSource.selectedSource = 'draw';
  const foreignWinner = clone(gameOverState);
  foreignWinner.winnerId = 'foreign-player';
  const wrongHistory = clone(roundOverState);
  wrongHistory.roundHistory[0].scores.reverse();

  const invalid = [
    fixtureCase('unexpected top-level property', 'game-state.schema.json', extraKey, { expectedLayer: 'schema', context: contextFor(openingState) }),
    fixtureCase('card value above twelve', 'game-state.schema.json', illegalValue, { expectedLayer: 'schema', context: contextFor(openingState) }),
    fixtureCase('short player grid', 'game-state.schema.json', shortGrid, { expectedLayer: 'schema', context: contextFor(openingState) }),
    fixtureCase('duplicate physical card id', 'game-state.schema.json', duplicateCard, { expectedLayer: 'semantic', context: contextFor(openingState) }),
    fixtureCase('source outside replacement phase', 'game-state.schema.json', incoherentSource, { expectedLayer: 'semantic', context: contextFor(chooseSourceState) }),
    fixtureCase('winner outside roster', 'game-state.schema.json', foreignWinner, { expectedLayer: 'semantic', context: contextFor(gameOverState, 'finished') }),
    fixtureCase('history order differs from roster', 'game-state.schema.json', wrongHistory, { expectedLayer: 'semantic', context: contextFor(roundOverState) })
  ];

  return {
    valid,
    invalid,
    states: { openingState, chooseSourceState, blindState, roundOverState, gameOverState, eightPlayerState }
  };
}

function domainCard(id, value, faceUp = true, removed = false) {
  return { id, value, faceUp, removed };
}

function domainGrid(prefix, values, { hidden = [], removed = [] } = {}) {
  const hiddenIndexes = new Set(hidden);
  const removedIndexes = new Set(removed);
  return Array.from({ length: 12 }, (_, index) => domainCard(
    `${prefix}-${index}`,
    values[index] ?? 1,
    !hiddenIndexes.has(index),
    removedIndexes.has(index)
  ));
}

function domainPlayer(
  id,
  name,
  values,
  { hidden = [], removed = [], totalScore = 0, kind = 'human' } = {}
) {
  const grid = domainGrid(`${id}-card`, values, { hidden, removed });
  return {
    id,
    name,
    kind,
    grid,
    totalScore,
    roundScore: grid.reduce(
      (total, card) => total + (card.faceUp && !card.removed ? card.value : 0),
      0
    )
  };
}

function domainState(players, overrides = {}) {
  return {
    players,
    drawPile: [domainCard('domain-draw-0', 2, false)],
    discardPile: [domainCard('domain-discard-0', 3)],
    currentPlayerIndex: 0,
    phase: 'choose-source',
    selectedSource: null,
    drawnCard: null,
    round: 1,
    log: [],
    winnerId: null,
    nextStarterId: null,
    roundCloserId: null,
    finalTurnPlayerIds: [],
    openingRevealCounts: {},
    roundHistory: [],
    ...overrides
  };
}

function domainReplacementState(players, drawnCard, overrides = {}) {
  return domainState(players, {
    phase: 'choose-replacement',
    selectedSource: 'draw',
    drawnCard,
    ...overrides
  });
}

function applyDomainAction(state, action) {
  switch (action.type) {
    case 'reveal-opening-card':
      return revealOpeningCard(state, action.cardIndex);
    case 'choose-discard':
      return chooseDiscard(state);
    case 'cancel-discard':
      return cancelDiscardSelection(state);
    case 'draw-blind':
      return drawBlind(state, createSeededRandom(action.randomSeed));
    case 'replace-card':
      return replaceCard(state, action.cardIndex);
    case 'discard-and-reveal':
      return discardDrawnAndReveal(state, action.cardIndex);
    case 'start-next-round':
      return startNextRound(state, createSeededRandom(action.randomSeed));
    default:
      throw new Error(`Unknown domain fixture action ${String(action.type)}.`);
  }
}

function domainScenario(name, initialState, actions) {
  let state = clone(initialState);
  const expectedStates = [];
  for (const action of actions) {
    state = applyDomainAction(state, action);
    expectedStates.push(clone(state));
  }
  return { name, initialState, actions, expectedStates };
}

function aiGrid(values = [], faceUpIndexes = []) {
  const visible = new Set(faceUpIndexes);
  return Array.from({ length: 12 }, (_, index) => ({
    faceUp: visible.has(index),
    removed: false,
    value: visible.has(index) ? (values[index] ?? 0) : null
  }));
}

function aiKnowledge(overrides = {}) {
  return {
    players: [
      {
        id: 'bot',
        totalScore: 0,
        grid: aiGrid([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], [0, 1])
      },
      {
        id: 'human',
        totalScore: 0,
        grid: aiGrid()
      }
    ],
    currentPlayerIndex: 0,
    phase: 'choose-source',
    selectedSource: null,
    drawnCardValue: null,
    discardTopValue: 2,
    discardPileCount: 1,
    drawPileCount: 100,
    knownValues: [12, 11, 2],
    roundCloserId: null,
    finalTurnPlayerIds: [],
    ...overrides
  };
}

function aiFixtureCase(name, difficulty, decisionKey, knowledge) {
  return {
    name,
    difficulty,
    decisionKey,
    playerId: 'bot',
    knowledge,
    expectedMove: chooseAiMove(knowledge, { playerId: 'bot', difficulty, decisionKey })
  };
}

function createDomainParityFixtures() {
  const seededGames = [];
  const seededSoloStates = new Map();
  for (let aiOpponentCount = 1; aiOpponentCount <= 7; aiOpponentCount += 1) {
    const seed = 0x51030000 + aiOpponentCount;
    const expectedState = startFreshGame({
      aiOpponentCount,
      random: createSeededRandom(seed)
    });
    const name = `solo roster with ${aiOpponentCount} bot${aiOpponentCount === 1 ? '' : 's'}`;
    seededGames.push({
      name,
      input: { kind: 'solo', seed, aiOpponentCount },
      expectedState
    });
    seededSoloStates.set(aiOpponentCount, { name, state: expectedState });
  }

  for (const [name, seed, players] of [
    [
      'two-player multiplayer deck',
      0x51031002,
      [{ id: 'fixture-player-1', name: 'Ada' }, { id: 'fixture-player-2', name: 'Grace' }]
    ],
    [
      'eight-player multiplayer deck',
      0x51031008,
      Array.from({ length: 8 }, (_, index) => ({
        id: `fixture-player-${index + 1}`,
        name: `Player ${index + 1}`
      }))
    ]
  ]) {
    seededGames.push({
      name,
      input: { kind: 'multiplayer', seed, players, round: 1, previousCloserId: null },
      expectedState: createMultiplayerGame(players, 1, null, createSeededRandom(seed))
    });
  }

  const openingInitial = createMultiplayerGame(
    [{ id: 'opening-ada', name: 'Ada' }, { id: 'opening-grace', name: 'Grace' }],
    1,
    null,
    createSeededRandom(0x51032001)
  );
  const openingActions = [
    { type: 'reveal-opening-card', cardIndex: 0 },
    { type: 'reveal-opening-card', cardIndex: 1 },
    { type: 'reveal-opening-card', cardIndex: 0 },
    { type: 'reveal-opening-card', cardIndex: 1 },
    { type: 'choose-discard' },
    { type: 'cancel-discard' },
    { type: 'draw-blind', randomSeed: 0x51032002 },
    { type: 'discard-and-reveal', cardIndex: 2 },
    { type: 'choose-discard' },
    { type: 'replace-card', cardIndex: 0 },
    { type: 'draw-blind', randomSeed: 0x51032003 },
    { type: 'replace-card', cardIndex: 1 }
  ];

  const columnPlayer = domainPlayer(
    'column-ada',
    'Ada',
    [5, 1, 2, 3, 5, 2, 3, 4, 9, 3, 4, 5],
    { hidden: [8, 11] }
  );
  const columnOther = domainPlayer(
    'column-grace',
    'Grace',
    Array(12).fill(4),
    { hidden: [0, 1] }
  );
  const columnInitial = domainReplacementState(
    [columnPlayer, columnOther],
    domainCard('column-drawn-five', 5),
    { drawPile: [domainCard('column-draw', -1, false)] }
  );

  const tieValues = [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const tieInitial = domainReplacementState(
    [
      domainPlayer('tie-closer', 'James', tieValues, { hidden: [11] }),
      domainPlayer('tie-final', 'Grace', tieValues, { hidden: [11] })
    ],
    domainCard('tie-drawn-nine', 9),
    { drawPile: [] }
  );
  const tieActions = [
    { type: 'replace-card', cardIndex: 11 },
    { type: 'choose-discard' },
    { type: 'replace-card', cardIndex: 11 },
    { type: 'start-next-round', randomSeed: 0x51033001 },
    { type: 'reveal-opening-card', cardIndex: 0 },
    { type: 'reveal-opening-card', cardIndex: 1 },
    { type: 'reveal-opening-card', cardIndex: 0 },
    { type: 'reveal-opening-card', cardIndex: 1 }
  ];

  const orderedFinalTurnsInitial = domainReplacementState(
    [
      domainPlayer('ordered-closer', 'Ada', tieValues, { hidden: [11] }),
      domainPlayer('ordered-second', 'Grace', tieValues, { hidden: [11] }),
      domainPlayer('ordered-third', 'James', tieValues, { hidden: [11] })
    ],
    domainCard('ordered-drawn-nine', 9),
    { drawPile: [] }
  );
  const orderedFinalTurnActions = [
    { type: 'replace-card', cardIndex: 11 },
    { type: 'choose-discard' },
    { type: 'replace-card', cardIndex: 11 },
    { type: 'choose-discard' },
    { type: 'replace-card', cardIndex: 11 }
  ];

  const strictLowInitial = domainReplacementState(
    [
      domainPlayer('low-closer', 'Ada', tieValues, { hidden: [11] }),
      domainPlayer(
        'high-final',
        'Grace',
        [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
        { hidden: [11] }
      )
    ],
    domainCard('low-drawn-minus-two', -2),
    { drawPile: [] }
  );

  const nonpositiveValues = [-2, -2, -2, -2, -1, -1, -1, -1, 1, 1, 1, 1];
  const nonpositiveInitial = domainReplacementState(
    [
      domainPlayer('nonpositive-closer', 'You', nonpositiveValues, { hidden: [11] }),
      domainPlayer('nonpositive-final', 'Ada', nonpositiveValues, { hidden: [11] })
    ],
    domainCard('nonpositive-drawn-one', 1),
    { drawPile: [] }
  );

  const thresholdInitial = domainReplacementState(
    [
      domainPlayer('threshold-closer', 'James', tieValues, { hidden: [11], totalScore: 95 }),
      domainPlayer('threshold-winner', 'Grace', tieValues, { hidden: [11], totalScore: 10 })
    ],
    domainCard('threshold-drawn-nine', 9),
    { drawPile: [] }
  );

  const recycleInitial = domainState(
    [domainPlayer('recycle-player', 'Ada', tieValues, { hidden: [0, 1] })],
    {
      drawPile: [],
      discardPile: [
        domainCard('recycle-top', 1),
        domainCard('recycle-a', 4),
        domainCard('recycle-b', 8)
      ]
    }
  );

  const finalTurnActions = [
    { type: 'replace-card', cardIndex: 11 },
    { type: 'choose-discard' },
    { type: 'replace-card', cardIndex: 11 }
  ];
  const scenarios = [
    domainScenario('opening, discard cancellation, blind reveal, and replacement', openingInitial, openingActions),
    domainScenario('matching column clears above the replaced card in discard order', columnInitial, [
      { type: 'replace-card', cardIndex: 8 }
    ]),
    domainScenario('every opponent gets a final turn, tied closer doubles, and closer starts next round', tieInitial, tieActions),
    domainScenario(
      'three-player final turns advance in seat order before scoring',
      orderedFinalTurnsInitial,
      orderedFinalTurnActions
    ),
    domainScenario('strict-low positive closer does not double', strictLowInitial, finalTurnActions),
    domainScenario('nonpositive tied closer does not double', nonpositiveInitial, finalTurnActions),
    domainScenario('game threshold selects the lowest-total winner', thresholdInitial, finalTurnActions),
    domainScenario('empty draw pile deterministically recycles below the discard top', recycleInitial, [
      { type: 'draw-blind', randomSeed: 0 }
    ])
  ];

  const openingKnowledge = aiKnowledge({
    phase: 'opening-reveal',
    discardTopValue: null,
    discardPileCount: 0,
    players: [
      { id: 'bot', totalScore: 0, grid: aiGrid() },
      { id: 'human', totalScore: 0, grid: aiGrid() }
    ],
    knownValues: []
  });
  const placementKnowledge = aiKnowledge({
    phase: 'choose-replacement',
    selectedSource: 'draw',
    drawnCardValue: -2,
    knownValues: [12, 11, 2, -2]
  });
  const discardPlacementKnowledge = aiKnowledge({
    phase: 'choose-replacement',
    selectedSource: 'discard',
    drawnCardValue: null,
    discardTopValue: 2
  });
  const riskyGrid = aiGrid(Array(12).fill(0), Array.from({ length: 12 }, (_, index) => index));
  riskyGrid[0] = { faceUp: false, removed: false, value: null };
  riskyGrid[1] = { faceUp: true, removed: false, value: 4 };
  const riskyKnowledge = aiKnowledge({
    phase: 'choose-replacement',
    selectedSource: 'draw',
    drawnCardValue: 12,
    players: [
      { id: 'bot', totalScore: 0, grid: riskyGrid },
      {
        id: 'human',
        totalScore: 0,
        grid: aiGrid(Array(12).fill(0), Array.from({ length: 12 }, (_, index) => index))
      }
    ],
    knownValues: [4, ...Array(23).fill(0), 12]
  });
  const aiCases = [];
  for (const difficulty of ['easy', 'medium', 'hard', 'ultra']) {
    aiCases.push(
      aiFixtureCase(`opening ${difficulty}`, difficulty, `fixture-opening-${difficulty}`, openingKnowledge),
      aiFixtureCase(`source ${difficulty}`, difficulty, `fixture-source-${difficulty}`, aiKnowledge()),
      aiFixtureCase(`blind placement ${difficulty}`, difficulty, `fixture-placement-${difficulty}`, placementKnowledge),
      aiFixtureCase(
        `discard placement ${difficulty}`,
        difficulty,
        `fixture-discard-placement-${difficulty}`,
        discardPlacementKnowledge
      )
    );
  }
  aiCases.push(
    aiFixtureCase('hard risky closer reveal', 'hard', 'fixture-risky-close', riskyKnowledge),
    aiFixtureCase('ultra risky closer replacement', 'ultra', 'fixture-risky-close', riskyKnowledge)
  );

  const redactionState = domainState(
    [
      domainPlayer(
        'redaction-bot',
        '😀'.repeat(16) + 'Bot',
        [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
        { hidden: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], kind: 'ai' }
      ),
      domainPlayer(
        'redaction-human',
        'e\u0301'.repeat(16) + 'Human',
        [6, 5, 4, 3, 2, 1, 0, -1, -2, 7, 8, 9],
        { hidden: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
      )
    ],
    {
      phase: 'choose-replacement',
      selectedSource: 'draw',
      drawnCard: domainCard('redaction-private-draw', 6),
      drawPile: [domainCard('redaction-hidden-draw-a', 12, false), domainCard('redaction-hidden-draw-b', -2, false)],
      discardPile: [domainCard('redaction-public-discard', 1)],
      log: ['Bot drew a 6.', '😀'.repeat(170), 'e\u0301'.repeat(170)],
      roundHistory: [{
        round: 1,
        closerId: 'redaction-bot',
        scores: [
          {
            playerId: 'redaction-bot',
            name: '😀'.repeat(16) + 'Bot',
            roundScore: 1,
            totalScore: 1
          },
          {
            playerId: 'redaction-human',
            name: 'e\u0301'.repeat(16) + 'Human',
            roundScore: 2,
            totalScore: 2
          }
        ]
      }]
    }
  );
  const redactionCases = ['redaction-bot', 'redaction-human'].map((viewerId) => ({
    name: viewerId === 'redaction-bot' ? 'current drawer sees only its blind draw' : 'non-drawer cannot see the blind draw',
    viewerId,
    authoritativeState: redactionState,
    expectedKnowledge: projectAiKnowledge(redactionState, viewerId),
    expectedPublicSnapshot: redactGameState(redactionState, viewerId)
  }));

  const soloSetupCases = [];
  for (let aiOpponentCount = 1; aiOpponentCount <= 7; aiOpponentCount += 1) {
    const seeded = seededSoloStates.get(aiOpponentCount);
    if (!seeded) throw new Error(`Missing seeded solo fixture for ${aiOpponentCount} bots.`);
    const inputSetup = createSoloGameSetup(aiOpponentCount, 'mixed');
    const gameId = `51030000-0000-4000-8000-${String(aiOpponentCount).padStart(12, '0')}`;
    soloSetupCases.push({
      name: `balanced Mixed setup with ${aiOpponentCount} bot${aiOpponentCount === 1 ? '' : 's'}`,
      seededGame: seeded.name,
      aiPlayerIds: seeded.state.players.filter((player) => player.kind === 'ai').map((player) => player.id).sort(),
      gameId,
      inputSetup,
      expectedSetup: resolveSoloGameSetup(inputSetup, seeded.state, gameId)
    });
  }
  const fixedState = seededSoloStates.get(1);
  if (!fixedState) throw new Error('Missing seeded one-bot solo fixture.');
  for (const difficulty of ['easy', 'medium', 'hard', 'ultra']) {
    const inputSetup = createSoloGameSetup(1, difficulty);
    soloSetupCases.push({
      name: `fixed ${difficulty} setup`,
      seededGame: fixedState.name,
      aiPlayerIds: ['ai-1'],
      gameId: '51030000-0000-4000-8000-000000000099',
      inputSetup,
      expectedSetup: resolveSoloGameSetup(inputSetup, fixedState.state, 'fixed-setup')
    });
  }

  return {
    contractVersion: 1,
    domainRulesVersion: 1,
    aiStrategyVersion: soloAiStrategyVersion,
    seededGames,
    scenarios,
    aiCases,
    redactionCases,
    soloSetupCases
  };
}

function createBoundedPublicRoom(eightPlayerState) {
  const state = clone(eightPlayerState);
  state.log = Array.from({ length: 10 }, (_, index) => `${index}:${'L'.repeat(400)}`);
  state.roundHistory = Array.from({ length: 105 }, (_, index) => ({
    round: index + 1,
    closerId: state.players[0].id,
    scores: state.players.map((player) => ({
      playerId: player.id,
      name: `${player.name}${'N'.repeat(80)}`,
      roundScore: index,
      totalScore: index
    }))
  }));
  const source = roomSource(state, {
    chatMessages: Array.from({ length: 85 }, (_, index) => ({
      id: `${String(index).padStart(3, '0')}${'c'.repeat(125)}`,
      playerId: state.players[index % state.players.length].id,
      playerName: `${state.players[index % state.players.length].name}${'P'.repeat(40)}`,
      text: `${String(index).padStart(3, '0')}${'T'.repeat(320)}`,
      createdAt: fixedEpoch + index
    }))
  });
  return createRoomSnapshot(source, state.players[1].id, fixedEpoch + 500);
}

function createProtocolFixtures(states) {
  const ids = scriptedSource('protocol fixture UUIDs', commandIds.slice(0, 15));
  const actions = [
    { type: 'reveal-opening-card', cardIndex: 0 },
    { type: 'choose-discard' },
    { type: 'cancel-discard' },
    { type: 'draw-blind' },
    { type: 'replace-card', cardIndex: 11 },
    { type: 'discard-and-reveal', cardIndex: 5 },
    { type: 'set-next-round-ready', ready: true },
    { type: 'start-game' },
    { type: 'reset-room' },
    { type: 'leave-room' },
    { type: 'remove-player', playerId: guestId },
    { type: 'takeover-player-with-ai', playerId: guestId },
    { type: 'send-chat-message', text: 'Fixture hello' },
    { type: 'send-chat-message', text: '🃏'.repeat(140) }
  ];
  const clientValid = [
    fixtureCase('create room', 'protocol-v2-client-frame.schema.json', {
      type: 'create-room', protocolVersion: 2, snapshotEnvelopeVersion: 2, name: 'Host'
    }),
    fixtureCase('fresh join', 'protocol-v2-client-frame.schema.json', {
      type: 'join-room', protocolVersion: 2, presenceVersion: 1, snapshotEnvelopeVersion: 2, code: 'ABCDE', name: 'Guest'
    }),
    fixtureCase('seat rejoin', 'protocol-v2-client-frame.schema.json', {
      type: 'join-room', protocolVersion: 2, presenceVersion: 1, snapshotEnvelopeVersion: 2, code: 'ABCDE', name: 'Host', playerId: hostId
    }),
    fixtureCase('reset recovery join', 'protocol-v2-client-frame.schema.json', {
      type: 'join-room', protocolVersion: 2, presenceVersion: 1, snapshotEnvelopeVersion: 2, code: 'ABCDE', name: 'Host', playerId: hostId, recoveryCommandId: ids.next()
    }),
    fixtureCase('presence visible', 'protocol-v2-client-frame.schema.json', { type: 'set-presence', visible: true }),
    fixtureCase('presence hidden', 'protocol-v2-client-frame.schema.json', { type: 'set-presence', visible: false }),
    ...actions.map((action, index) => fixtureCase(
      action.type === 'send-chat-message' && index === actions.length - 1
        ? 'command send-chat-message at UTF-16 compatibility bound'
        : `command ${action.type}`,
      'protocol-v2-client-frame.schema.json',
      command(ids.next(), 7, action)
    ))
  ];
  ids.assertConsumed();

  const drawerRoom = createRoomSnapshot(roomSource(states.blindState), hostId, fixedEpoch + 1);
  const publicRoom = createRoomSnapshot(roomSource(states.blindState), guestId, fixedEpoch + 1);
  const boundedRoom = createBoundedPublicRoom(states.eightPlayerState);
  const astralChatRoom = clone(publicRoom);
  astralChatRoom.chatMessages = [{
    id: commandIds[38],
    playerId: guestId,
    playerName: astralChatRoom.players.find((player) => player.id === guestId).name,
    text: '🃏'.repeat(140),
    createdAt: fixedEpoch
  }];
  const serverValid = [
    fixtureCase('personalized snapshot', 'protocol-v2-server-frame.schema.json', { type: 'snapshot', protocolVersion: 2, playerId: hostId, revision: 7, room: drawerRoom }),
    fixtureCase('shared public snapshot', 'protocol-v2-server-frame.schema.json', { type: 'snapshot', protocolVersion: 2, revision: 7, room: publicRoom }),
    fixtureCase('bounded shared snapshot', 'protocol-v2-server-frame.schema.json', { type: 'snapshot', protocolVersion: 2, revision: 7, room: boundedRoom }),
    fixtureCase('UTF-16 astral chat at compatibility bound', 'protocol-v2-server-frame.schema.json', { type: 'snapshot', protocolVersion: 2, revision: 7, room: astralChatRoom }),
    fixtureCase('stale revision resync', 'protocol-v2-server-frame.schema.json', { type: 'resync', protocolVersion: 2, playerId: hostId, revision: 7, room: drawerRoom, reason: 'stale-revision', commandId: commandIds[20] }),
    fixtureCase('future revision resync', 'protocol-v2-server-frame.schema.json', { type: 'resync', protocolVersion: 2, playerId: hostId, revision: 7, room: drawerRoom, reason: 'future-revision', commandId: commandIds[21] }),
    fixtureCase('room reset resync', 'protocol-v2-server-frame.schema.json', { type: 'resync', protocolVersion: 2, playerId: hostId, revision: 8, room: { ...drawerRoom, code: 'FGHIJ', revision: 8 }, reason: 'room-reset', commandId: commandIds[22] }),
    fixtureCase('acknowledgement', 'protocol-v2-server-frame.schema.json', { type: 'ack', protocolVersion: 2, commandId: commandIds[23], revision: 8 }),
    fixtureCase('room left acknowledgement', 'protocol-v2-server-frame.schema.json', { type: 'ack', protocolVersion: 2, commandId: commandIds[24], revision: 8, result: 'room-left' }),
    fixtureCase('correlated error', 'protocol-v2-server-frame.schema.json', { type: 'error', protocolVersion: 2, code: 'illegal-move', message: 'That move is not legal.', commandId: commandIds[25] }),
    fixtureCase('uncorrelated error', 'protocol-v2-server-frame.schema.json', { type: 'error', protocolVersion: 2, code: 'room-required', message: 'Join or create a room first.' }),
    fixtureCase('upgrade required', 'protocol-v2-server-frame.schema.json', { type: 'upgrade-required', protocolVersion: 2, message: 'Refresh Flipvale to use multiplayer protocol 2.' }),
    fixtureCase('correlated upgrade required', 'protocol-v2-server-frame.schema.json', { type: 'upgrade-required', protocolVersion: 2, message: 'Refresh Flipvale to use multiplayer protocol 2.', commandId: commandIds[26] })
  ];

  const oversizedCreate = { type: 'create-room', protocolVersion: 2, name: 'X'.repeat(17_000) };
  const clientInvalid = [
    fixtureCase('legacy update state', 'protocol-v2-client-frame.schema.json', { type: 'update-state', state: {} }, { expectedLayer: 'schema' }),
    fixtureCase('wrong protocol version', 'protocol-v2-client-frame.schema.json', { ...command(commandIds[27], 7, { type: 'start-game' }), protocolVersion: 1 }, { expectedLayer: 'schema' }),
    fixtureCase('null optional marker', 'protocol-v2-client-frame.schema.json', { type: 'join-room', protocolVersion: 2, code: 'ABCDE', name: 'Guest', presenceVersion: null }, { expectedLayer: 'schema' }),
    fixtureCase('unexpected envelope key', 'protocol-v2-client-frame.schema.json', { ...command(commandIds[28], 7, { type: 'start-game' }), extra: true }, { expectedLayer: 'schema' }),
    fixtureCase('malformed command UUID', 'protocol-v2-client-frame.schema.json', command('not-a-uuid', 7, { type: 'start-game' }), { expectedLayer: 'schema' }),
    fixtureCase('negative revision', 'protocol-v2-client-frame.schema.json', command(commandIds[29], -1, { type: 'start-game' }), { expectedLayer: 'schema' }),
    fixtureCase('fractional revision', 'protocol-v2-client-frame.schema.json', command(commandIds[30], 1.5, { type: 'start-game' }), { expectedLayer: 'schema' }),
    fixtureCase('unsafe revision', 'protocol-v2-client-frame.schema.json', command(commandIds[31], 9007199254740992, { type: 'start-game' }), { expectedLayer: 'schema' }),
    fixtureCase('negative card index', 'protocol-v2-client-frame.schema.json', command(commandIds[32], 7, { type: 'replace-card', cardIndex: -1 }), { expectedLayer: 'schema' }),
    fixtureCase('card index twelve', 'protocol-v2-client-frame.schema.json', command(commandIds[33], 7, { type: 'replace-card', cardIndex: 12 }), { expectedLayer: 'schema' }),
    fixtureCase('chat over bound', 'protocol-v2-client-frame.schema.json', command(commandIds[34], 7, { type: 'send-chat-message', text: 'C'.repeat(281) }), { expectedLayer: 'schema' }),
    fixtureCase('UTF-16 astral chat over compatibility bound', 'protocol-v2-client-frame.schema.json', command(commandIds[39], 7, { type: 'send-chat-message', text: '🃏'.repeat(141) }), { expectedLayer: 'consumer' }),
    fixtureCase('identifier over bound', 'protocol-v2-client-frame.schema.json', command(commandIds[35], 7, { type: 'remove-player', playerId: 'P'.repeat(129) }), { expectedLayer: 'schema' }),
    fixtureCase('canonical presence missing visible', 'protocol-v2-client-frame.schema.json', { type: 'set-presence' }, { expectedLayer: 'schema' }),
    fixtureCase('frame byte limit exceeded', 'protocol-v2-client-frame.schema.json', oversizedCreate, { expectedLayer: 'wire', wireBytes: Buffer.byteLength(JSON.stringify(oversizedCreate), 'utf8') })
  ];

  const leakedFaceDown = clone(publicRoom);
  leakedFaceDown.state.players[0].grid.find((card) => !card.faceUp).value = 12;
  const wrongGridIdentity = clone(publicRoom);
  wrongGridIdentity.state.players[0].grid[0].id = 'grid-7-11';
  const leakedSharedDraw = clone(publicRoom);
  leakedSharedDraw.state.drawnCard = clone(drawerRoom.state.drawnCard);
  const revisionMismatch = clone(serverValid[0].value);
  revisionMismatch.revision = 6;
  const rosterMismatch = clone(publicRoom);
  rosterMismatch.state.players.pop();
  const astralChatOverBound = clone(astralChatRoom);
  astralChatOverBound.chatMessages[0].text = '🃏'.repeat(141);
  const leakedBlindDrawLog = clone(publicRoom);
  leakedBlindDrawLog.state.log[0] = 'Host drew a -2.';
  const serverInvalid = [
    fixtureCase('unexpected server key', 'protocol-v2-server-frame.schema.json', { ...serverValid[0].value, internal: true }, { expectedLayer: 'schema' }),
    fixtureCase('face-down value leak', 'protocol-v2-server-frame.schema.json', { type: 'snapshot', protocolVersion: 2, revision: 7, room: leakedFaceDown }, { expectedLayer: 'schema' }),
    fixtureCase('grid identity does not match position', 'protocol-v2-server-frame.schema.json', { type: 'snapshot', protocolVersion: 2, revision: 7, room: wrongGridIdentity }, { expectedLayer: 'consumer' }),
    fixtureCase('private draw leaked in shared frame', 'protocol-v2-server-frame.schema.json', { type: 'snapshot', protocolVersion: 2, revision: 7, room: leakedSharedDraw }, { expectedLayer: 'privacy' }),
    fixtureCase('frame and room revisions differ', 'protocol-v2-server-frame.schema.json', revisionMismatch, { expectedLayer: 'consumer' }),
    fixtureCase('room and game rosters differ', 'protocol-v2-server-frame.schema.json', { type: 'snapshot', protocolVersion: 2, revision: 7, room: rosterMismatch }, { expectedLayer: 'consumer' }),
    fixtureCase('UTF-16 astral snapshot chat over compatibility bound', 'protocol-v2-server-frame.schema.json', { type: 'snapshot', protocolVersion: 2, revision: 7, room: astralChatOverBound }, { expectedLayer: 'consumer' }),
    fixtureCase('private blind draw value leaked in log', 'protocol-v2-server-frame.schema.json', { type: 'snapshot', protocolVersion: 2, revision: 7, room: leakedBlindDrawLog }, { expectedLayer: 'privacy' }),
    fixtureCase('ack result null', 'protocol-v2-server-frame.schema.json', { type: 'ack', protocolVersion: 2, commandId: commandIds[36], revision: 8, result: null }, { expectedLayer: 'schema' }),
    fixtureCase('resync lacks viewer', 'protocol-v2-server-frame.schema.json', { type: 'resync', protocolVersion: 2, revision: 7, room: publicRoom, reason: 'stale-revision' }, { expectedLayer: 'schema' }),
    fixtureCase('unknown resync reason', 'protocol-v2-server-frame.schema.json', { type: 'resync', protocolVersion: 2, playerId: hostId, revision: 7, room: drawerRoom, reason: 'unknown' }, { expectedLayer: 'schema' }),
    fixtureCase('null upgrade correlation', 'protocol-v2-server-frame.schema.json', { type: 'upgrade-required', protocolVersion: 2, message: 'Upgrade.', commandId: null }, { expectedLayer: 'schema' })
  ];

  return { clientValid, clientInvalid, serverValid, serverInvalid, drawerRoom, publicRoom };
}

function protocolRoom(state, socket) {
  const source = roomSource(state);
  return {
    ...source,
    clients: new Set([socket]),
    gameSessionId: commandIds[41],
    recentCommandIds: [],
    resetAliases: [],
    roomInstanceId: commandIds[42],
    roomVersion: 2
  };
}

function createProtocolHarness({ clockValues, uuidValues, roomCodeValues = [], state }) {
  const clock = scriptedSource('protocol transcript clock', clockValues);
  const uuids = scriptedSource('protocol transcript UUIDs', uuidValues);
  const roomCodes = scriptedSource('protocol transcript room codes', roomCodeValues);
  const outputs = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    accountUser: { id: accountId, displayName: 'Host' },
    admittedRoomCode: 'ABCDE',
    playerId: hostId,
    roomCode: 'ABCDE',
    snapshotEnvelopeVersion: 2,
    snapshotRoomCode: 'ABCDE',
    visible: true,
    close() {},
    on() {},
    ping() {},
    send() {},
    terminate() {}
  };
  const initialRoom = protocolRoom(state, socket);
  const rooms = new Map([[initialRoom.code, initialRoom]]);

  function emitSnapshot(targetSocket, room, options = {}) {
    const type = options.type === 'resync' ? 'resync' : 'snapshot';
    outputs.push({
      type,
      protocolVersion: 2,
      playerId: targetSocket.playerId,
      revision: room.revision,
      room: createRoomSnapshot(room, targetSocket.playerId, room.updatedAt),
      ...(type === 'resync'
        ? { reason: options.reason || 'revision-mismatch', ...(options.commandId ? { commandId: options.commandId } : {}) }
        : {})
    });
  }

  const options = {
    allPlayersReadyForNextRound: () => false,
    appendRoomChatMessage(room, player, text) {
      const message = { id: uuids.next(), playerId: player.id, playerName: player.name, text, createdAt: room.updatedAt + 1 };
      room.chatMessages.push(message);
      return message;
    },
    broadcastRoom(room) {
      emitSnapshot(socket, room);
    },
    cleanChatText: (value) => String(value || '').trim().slice(0, 280),
    createInitialRoomState: () => state,
    createNextRoundRoomState: () => state,
    createWaitingRoom({ code, hostPlayer, ws }) {
      return {
        chatMessages: [],
        clients: new Set([ws]),
        code,
        completedGameId: null,
        finishedByAi: false,
        gameSessionId: null,
        hostId: hostPlayer.id,
        players: [{ ...hostPlayer, connected: true, host: true, joinedAt: fixedEpoch, lastSeenAt: fixedEpoch, disconnectedAt: null, controller: 'human', aiTakeoverAt: null }],
        readyForNextRoundPlayerIds: [],
        recentCommandIds: [],
        resetAliases: [],
        revision: 0,
        roomInstanceId: uuids.next(),
        roomVersion: 2,
        state: null,
        status: 'waiting',
        updatedAt: fixedEpoch
      };
    },
    digestAction: (value) => sha256(value),
    makeRoomCodeForSocket: () => roomCodes.next(),
    normalizedReadyIds: (room) => room.readyForNextRoundPlayerIds.filter((id) => room.players.some((player) => player.id === id)),
    notifyAwayPlayersAfterMove() {},
    now: clock.next,
    persistRoomsSoon() {},
    random: () => {
      throw new Error('Protocol transcript unexpectedly requested randomness.');
    },
    randomUuid: uuids.next,
    recordCompletedGame: () => {
      throw new Error('Protocol transcript unexpectedly completed a game.');
    },
    reportCompletedGameError(error) {
      throw error;
    },
    roomPlayer(targetSocket) {
      const room = rooms.get(targetSocket.roomCode);
      const player = room?.players.find((candidate) => candidate.id === targetSocket.playerId);
      return room && player ? { room, player } : null;
    },
    rooms,
    sendJson(_targetSocket, payload) {
      outputs.push(clone(payload));
    },
    sendRoomSnapshot: emitSnapshot,
    setPlayerReadyForNextRound() {},
    syncPlayerPresence(_room, player, timestamp) {
      player.connected = true;
      player.disconnectedAt = null;
      player.lastSeenAt = timestamp;
    }
  };
  const handler = createProtocolV2MessageHandler(options);
  return {
    handler,
    options,
    outputs,
    rooms,
    socket,
    assertConsumed() {
      clock.assertConsumed();
      uuids.assertConsumed();
      roomCodes.assertConsumed();
    }
  };
}

function runProtocolTranscripts(state) {
  const transcripts = [];

  const replay = createProtocolHarness({ clockValues: [fixedEpoch + 10], uuidValues: [commandIds[37]], state });
  const replayFrame = command(commandIds[38], 7, { type: 'send-chat-message', text: 'Exactly once' });
  replay.handler(replay.socket, replayFrame);
  const firstOutputs = replay.outputs.splice(0);
  replay.handler(replay.socket, replayFrame);
  const replayOutputs = replay.outputs.splice(0);
  replay.handler(replay.socket, command(commandIds[38], 7, { type: 'send-chat-message', text: 'Conflicting body' }));
  const conflictOutputs = replay.outputs.splice(0);
  transcripts.push({
    name: 'exact replay and conflicting command id',
    initialRevision: 7,
    steps: [
      { input: replayFrame, output: firstOutputs, resultingRevision: 8 },
      { input: replayFrame, output: replayOutputs, resultingRevision: 8 },
      { input: command(commandIds[38], 7, { type: 'send-chat-message', text: 'Conflicting body' }), output: conflictOutputs, resultingRevision: 8 }
    ]
  });
  replay.assertConsumed();

  for (const [name, expectedRevision, reason, id] of [
    ['stale revision', 6, 'stale-revision', commandIds[39]],
    ['future revision', 8, 'future-revision', commandIds[40]]
  ]) {
    const harness = createProtocolHarness({ clockValues: [], uuidValues: [], state });
    const input = command(id, expectedRevision, { type: 'send-chat-message', text: name });
    harness.handler(harness.socket, input);
    transcripts.push({ name, initialRevision: 7, steps: [{ input, output: harness.outputs, resultingRevision: 7, reason }] });
    harness.assertConsumed();
  }

  const reset = createProtocolHarness({
    clockValues: [fixedEpoch + 20, fixedEpoch + 21, fixedEpoch + 22],
    uuidValues: [commandIds[43]],
    roomCodeValues: ['FGHIJ'],
    state
  });
  const resetInput = command(commandIds[44], 7, { type: 'reset-room' });
  reset.handler(reset.socket, resetInput);
  const resetOutputs = reset.outputs.splice(0);
  const recoverySocket = {
    ...reset.socket,
    admittedRoomCode: null,
    roomCode: null,
    snapshotRoomCode: null
  };
  const recoveryInput = {
    type: 'join-room',
    protocolVersion: 2,
    presenceVersion: 1,
    snapshotEnvelopeVersion: 2,
    code: 'ABCDE',
    name: 'Host',
    playerId: hostId,
    recoveryCommandId: commandIds[44]
  };
  reset.handler(recoverySocket, recoveryInput);
  transcripts.push({
    name: 'room reset and old-code recovery',
    initialRevision: 7,
    steps: [
      { input: resetInput, output: resetOutputs, resultingRevision: 8, resultingRoomCode: 'FGHIJ' },
      { input: recoveryInput, output: reset.outputs, resultingRevision: 8, resultingRoomCode: 'FGHIJ' }
    ]
  });
  reset.assertConsumed();

  return { protocolVersion: 2, transcripts };
}

async function createHttpFixtures(gameOverState) {
  const clock = scriptedSource(
    'account fixture clock',
    Array.from({ length: 6 }, (_, index) => fixedEpoch + 100 + index)
  );
  const uuids = scriptedSource('account fixture UUIDs', [
    accountId,
    commandIds[0],
    commandIds[1],
    commandIds[2],
    commandIds[3],
    commandIds[4]
  ]);
  const store = new AccountStore(':memory:', { now: clock.next, randomUuid: uuids.next });
  let user;
  let game;
  let summary;
  let playerStats;
  try {
    await store.open();
    user = await store.createUser({
      email: 'fixture.user@example.invalid',
      displayName: 'Fixture User',
      password: 'not-serialized-value',
      role: 'player'
    });
    game = store.recordCompletedGame({
      mode: 'single',
      state: gameOverState,
      createdByUserId: user.id,
      playerAccounts: { [hostId]: user.id },
      sourceKey: 'single:synthetic-contract-fixture',
      completedAt: fixedEpoch
    });
    summary = store.getStatsSummary(user);
    playerStats = store.getVisiblePlayerStats(user, user.id);
  } finally {
    store.close();
  }
  clock.assertConsumed();
  uuids.assertConsumed();

  const releaseIdentity = {
    releaseSha: fullSha,
    buildTimestamp: '2026-07-27T18:00:00.000Z',
    schemaVersion: 2,
    protocolVersion: 2
  };
  const readiness = createReadinessResult({ releaseIdentity, databaseReady: true, roomState: 'ok', lastPersist: true }).payload;
  const notReady = createReadinessResult({ releaseIdentity: null, databaseReady: false, roomState: 'error', lastPersist: false }).payload;
  const version = createVersionResult(releaseIdentity).payload;
  const unavailable = createVersionResult(null).payload;

  const manualErrors = [
    ['ACCESS_REQUIRED', 'Flipvale access is required.'],
    ['ACCOUNT_AUTHENTICATION_REQUIRED', 'Sign in to your Flipvale account.'],
    ['ACCOUNT_AUTHENTICATION_FAILED', 'Email or password did not match.'],
    ['ADMIN_REQUIRED', 'Admin privileges are required.'],
    ['PUSH_NOT_CONFIGURED', 'Push notifications are not configured.'],
    ['ROOM_NOT_FOUND', 'Room not found.'],
    ['ROOM_MEMBERSHIP_REQUIRED', 'Join the room before sharing it.'],
    ['GAME_NOT_FOUND', 'Game not found.'],
    ['PLAYER_NOT_FOUND', 'Player not found.'],
    ['ADMIN_SELF_REVOKE_FORBIDDEN', 'You cannot revoke your own admin access.'],
    ['SERVICE_UNAVAILABLE', 'Service unavailable.'],
    ['SERVICE_NOT_READY', 'Service is not ready.'],
    ['API_ROUTE_NOT_FOUND', 'API route not found.']
  ].map(([code, error]) => ({ code, error }));
  const publicErrorCodes = [
    'ACCESS_AUTHENTICATION_FAILED', 'ACCOUNT_RATE_LIMITED', 'INVALID_REQUEST', 'UNSUPPORTED_MEDIA_TYPE', 'METHOD_NOT_ALLOWED',
    'INVALID_EMAIL', 'WEAK_PASSWORD', 'INVALID_ROLE', 'ACCOUNT_EXISTS', 'ACCOUNT_NOT_FOUND',
    'CURRENT_PASSWORD_MISMATCH', 'ACCOUNT_DELETION_STALE', 'ACCOUNT_DELETION_UNAVAILABLE', 'LAST_ADMIN',
    'INVALID_PUSH_SUBSCRIPTION', 'MISSING_PUSH_KEYS',
    'INCOMPLETE_GAME', 'INVALID_ROOM_CODE', 'PASSWORDS_MUST_MATCH', 'MISSING_HUMAN_PLAYER',
    'ACCOUNT_SESSION_CHANGED', 'STATS_CLIENT_UPGRADE_REQUIRED', 'INVALID_COMPLETED_AT',
    'REQUEST_TOO_LARGE', 'INVALID_JSON', 'EXPECTED_JSON_OBJECT', 'CODE_ALLOCATION_FAILED', 'INVITE_CODE_LIMIT',
    'INVITE_INVALID_OR_EXPIRED', 'INVITE_ROOM_UNAVAILABLE', 'INVITE_RATE_LIMITED',
    'INVALID_APNS_DEVICE', 'APNS_NOT_CONFIGURED', 'APNS_DEVICE_LIMIT', 'APNS_REGISTRATION_RATE_LIMITED'
  ];
  const propagatedErrors = publicErrorCodes.map((code) => {
    const response = publicApiErrorResponse(new PublicApiError(code));
    return { code: response.code, error: response.message };
  });
  const unknown = publicApiErrorResponse(new Error('synthetic internal failure'));
  const errors = [
    ...manualErrors,
    ...propagatedErrors,
    { code: unknown.code, error: unknown.message }
  ].filter((value, index, all) => all.findIndex((candidate) => candidate.code === value.code) === index);
  const nativeInviteRedemption = {
    roomCode: 'ABCDE',
    expiresAt: fixedEpoch + 60 * 60 * 1_000
  };
  const appleAppSiteAssociation = createAppleAppSiteAssociation(SYNTHETIC_APPLE_APPLICATION_IDENTIFIER);
  const apnsDeviceRegistration = {
    deviceToken: 'ab'.repeat(32),
    environment: 'development',
    appVersion: '0.1.0-42',
    locale: 'en-US'
  };
  const apnsLogoutRequest = { installationId: '5000000a-0000-4000-8000-000000000005' };
  const accountDeletionRequest = { currentPassword: 'current-password', confirmation: 'DELETE' };

  const valid = [
    fixtureCase('access signed out', 'account-http.schema.json', { authenticated: false }),
    fixtureCase('access signed in', 'account-http.schema.json', { authenticated: true }),
    fixtureCase('account absent', 'account-http.schema.json', { user: null }),
    fixtureCase('account user', 'account-http.schema.json', { user }),
    fixtureCase('operation succeeded', 'account-http.schema.json', { ok: true }),
    fixtureCase('account deletion request', 'account-http.schema.json', accountDeletionRequest),
    fixtureCase('recorded stats game', 'stats-http.schema.json', { game }),
    fixtureCase('stats games list', 'stats-http.schema.json', { games: [game] }),
    fixtureCase('stats summary', 'stats-http.schema.json', summary),
    fixtureCase('player stats', 'stats-http.schema.json', playerStats),
    fixtureCase('release version', 'operational.schema.json', version),
    fixtureCase('release unavailable', 'operational.schema.json', unavailable),
    fixtureCase('service ready', 'operational.schema.json', readiness),
    fixtureCase('service not ready', 'operational.schema.json', notReady),
    fixtureCase('native invite redemption', 'invite-http.schema.json', nativeInviteRedemption),
    fixtureCase('Apple app site association', 'invite-http.schema.json', appleAppSiteAssociation),
    fixtureCase('APNs enabled config', 'push-http.schema.json', { enabled: true }),
    fixtureCase('APNs disabled config', 'push-http.schema.json', { enabled: false }),
    fixtureCase('APNs device registration', 'push-http.schema.json', apnsDeviceRegistration),
    fixtureCase('APNs logout cleanup', 'push-http.schema.json', apnsLogoutRequest),
    fixtureCase('APNs operation succeeded', 'push-http.schema.json', { ok: true }),
    ...errors.map((value) => fixtureCase(`API error ${value.code}`, 'api-error.schema.json', value))
  ];

  const accountInternal = { user: { ...user, internalField: 'not-public' } };
  const incompleteGame = clone(game);
  delete incompleteGame.finishedByAi;
  const exposedNativeInviteIdentity = {
    ...nativeInviteRedemption,
    roomInstanceId: 'redacted-internal-identity'
  };
  const broadAppleAssociation = clone(appleAppSiteAssociation);
  broadAppleAssociation.applinks.details[0].components[1]['/'] = '/*';
  const inclusiveBrowserFallback = clone(appleAppSiteAssociation);
  inclusiveBrowserFallback.applinks.details[0].components[0].exclude = false;
  const invalid = [
    fixtureCase('access flag has wrong type', 'account-http.schema.json', { authenticated: 'yes' }, { expectedLayer: 'schema' }),
    fixtureCase('account exposes internal field', 'account-http.schema.json', accountInternal, { expectedLayer: 'schema' }),
    fixtureCase('account deletion lacks exact confirmation', 'account-http.schema.json', {
      ...accountDeletionRequest,
      confirmation: 'delete'
    }, { expectedLayer: 'schema' }),
    fixtureCase('stats game omits AI attribution', 'stats-http.schema.json', { game: incompleteGame }, { expectedLayer: 'schema' }),
    fixtureCase('readiness schema is unsupported', 'operational.schema.json', { ...readiness, schemaVersion: 3 }, { expectedLayer: 'schema' }),
    fixtureCase('version timestamp is not canonical', 'operational.schema.json', { ...version, buildTimestamp: 'not-a-date' }, { expectedLayer: 'schema' }),
    fixtureCase('native invite response exposes room identity', 'invite-http.schema.json', exposedNativeInviteIdentity, { expectedLayer: 'schema' }),
    fixtureCase('Apple association includes a broad route', 'invite-http.schema.json', broadAppleAssociation, { expectedLayer: 'schema' }),
    fixtureCase('Apple association does not exclude browser fallback', 'invite-http.schema.json', inclusiveBrowserFallback, { expectedLayer: 'schema' }),
    fixtureCase('APNs token uses uppercase hex', 'push-http.schema.json', {
      ...apnsDeviceRegistration,
      deviceToken: apnsDeviceRegistration.deviceToken.toUpperCase()
    }, { expectedLayer: 'schema' }),
    fixtureCase('APNs token has odd hex length', 'push-http.schema.json', {
      ...apnsDeviceRegistration,
      deviceToken: `${apnsDeviceRegistration.deviceToken}a`
    }, { expectedLayer: 'schema' }),
    fixtureCase('APNs registration exposes an extra field', 'push-http.schema.json', {
      ...apnsDeviceRegistration,
      accountId: accountId
    }, { expectedLayer: 'schema' }),
    fixtureCase('APNs logout installation is not canonical', 'push-http.schema.json', {
      installationId: apnsLogoutRequest.installationId.toUpperCase()
    }, { expectedLayer: 'schema' }),
    fixtureCase('API error omits code', 'api-error.schema.json', { error: 'Missing code.' }, { expectedLayer: 'schema' }),
    fixtureCase('API error uses unknown code', 'api-error.schema.json', { code: 'NOT_STABLE', error: 'Unknown.' }, { expectedLayer: 'schema' }),
    fixtureCase('non-JSON response body', 'api-error.schema.json', '<html>not JSON</html>', { expectedLayer: 'transport' })
  ];
  return { valid, invalid };
}

async function generateFiles() {
  const games = createGameFixtures();
  const domainParity = createDomainParityFixtures();
  const protocol = createProtocolFixtures(games.states);
  const http = await createHttpFixtures(games.states.gameOverState);
  const files = new Map([
    ['game-state.valid.json', serialize({ contractVersion: 1, cases: games.valid })],
    ['game-state.invalid.json', serialize({ contractVersion: 1, cases: games.invalid })],
    ['domain-parity.json', serialize(domainParity)],
    ['protocol-client.valid.json', serialize({ contractVersion: 1, cases: protocol.clientValid })],
    ['protocol-client.invalid.json', serialize({ contractVersion: 1, cases: protocol.clientInvalid })],
    ['protocol-server.valid.json', serialize({ contractVersion: 1, cases: protocol.serverValid })],
    ['protocol-server.invalid.json', serialize({ contractVersion: 1, cases: protocol.serverInvalid })],
    ['protocol-transcripts.json', serialize(runProtocolTranscripts(games.states.chooseSourceState))],
    ['http.valid.json', serialize({ contractVersion: 1, cases: http.valid })],
    ['http.invalid.json', serialize({ contractVersion: 1, cases: http.invalid })]
  ]);
  const manifest = {
    contractVersion: 1,
    generator: 'scripts/generate-contract-fixtures.mjs',
    files: Object.fromEntries([...files].map(([name, contents]) => [name, sha256(contents)]))
  };
  files.set('manifest.json', serialize(manifest));
  return files;
}

async function existingFixtureNames() {
  try {
    return (await fs.readdir(fixtureDirectory)).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function checkFixtures(expectedFiles) {
  const expectedNames = [...expectedFiles.keys()].sort();
  const actualNames = await existingFixtureNames();
  const missing = expectedNames.filter((name) => !actualNames.includes(name));
  const unexpected = actualNames.filter((name) => !expectedNames.includes(name));
  const stale = [];
  for (const name of expectedNames.filter((candidate) => actualNames.includes(candidate))) {
    const actual = await fs.readFile(path.join(fixtureDirectory, name), 'utf8');
    if (actual !== expectedFiles.get(name)) stale.push(name);
  }
  if (missing.length || unexpected.length || stale.length) {
    throw new Error([
      missing.length ? `missing: ${missing.join(', ')}` : '',
      unexpected.length ? `unexpected: ${unexpected.join(', ')}` : '',
      stale.length ? `stale: ${stale.join(', ')}` : ''
    ].filter(Boolean).join('; '));
  }
  process.stdout.write(`Verified ${expectedNames.length} deterministic contract fixture files.\n`);
}

async function assertFixtureDirectoryClean() {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--', fixtureRelativePath], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
  if (stdout.trim()) throw new Error(`Refusing to replace dirty fixtures:\n${stdout.trim()}`);
}

async function writeFixtures(expectedFiles) {
  await assertFixtureDirectoryClean();
  const parent = path.dirname(fixtureDirectory);
  await fs.mkdir(parent, { recursive: true });
  const temporaryDirectory = await fs.mkdtemp(path.join(parent, '.fixtures-'));
  const backupDirectory = `${fixtureDirectory}.backup-${process.pid}`;
  let movedExisting = false;
  try {
    for (const [name, contents] of expectedFiles) {
      await fs.writeFile(path.join(temporaryDirectory, name), contents, { encoding: 'utf8', flag: 'wx' });
    }
    try {
      await fs.rename(fixtureDirectory, backupDirectory);
      movedExisting = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await fs.rename(temporaryDirectory, fixtureDirectory);
    if (movedExisting) await fs.rm(backupDirectory, { recursive: true, force: false });
  } catch (error) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    if (movedExisting) {
      await fs.rm(fixtureDirectory, { recursive: true, force: true });
      await fs.rename(backupDirectory, fixtureDirectory);
    }
    throw error;
  }
  process.stdout.write(`Wrote ${expectedFiles.size} deterministic contract fixture files.\n`);
}

try {
  const files = await generateFiles();
  if (mode === '--write') await writeFixtures(files);
  else await checkFixtures(files);
} catch (error) {
  process.stderr.write(`Contract fixture generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
