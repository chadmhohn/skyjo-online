import type { GameState } from './types';

export type SemanticAudioCue =
  | 'flip'
  | 'pickup'
  | 'place'
  | 'columnClear'
  | 'localTurn'
  | 'roundEnd'
  | 'gameEnd';

export type GameAudioDelivery = 'live' | 'baseline' | 'resync';

export interface GameAudioContext {
  /**
   * Stable for one game, including all of its rounds. A new game must use a
   * different id so an old reconnect snapshot can never be compared to it.
   */
  sessionId: string;
  /**
   * Monotonically increasing for every state-bearing frame. Multiplayer should
   * pass the authoritative room revision. Hooks may omit this for solo play,
   * where the audio controller supplies a local committed-transition counter.
   */
  revision?: number;
  localPlayerId?: string | null;
  /**
   * Mark initial hydration and recovery snapshots explicitly. Revision gaps
   * are also treated as recovery baselines even when this is omitted.
   */
  delivery?: GameAudioDelivery;
  /**
   * False for a background client. The caller may omit this and let the audio
   * controller use document.visibilityState.
   */
  visible?: boolean;
}

export interface GameAudioFrame extends Omit<GameAudioContext, 'revision'> {
  revision: number;
  state: GameState | null | undefined;
}

export interface GameAudioEvent {
  cue: SemanticAudioCue;
  delayMs: number;
  id: string;
}

function boardDelta(previous: GameState, current: GameState) {
  let newlyFaceUp = 0;
  let newlyRemoved = 0;
  let replacements = 0;

  for (const currentPlayer of current.players) {
    const previousPlayer = previous.players.find((player) => player.id === currentPlayer.id);
    if (!previousPlayer) continue;

    for (let index = 0; index < currentPlayer.grid.length; index += 1) {
      const before = previousPlayer.grid[index];
      const after = currentPlayer.grid[index];
      if (!before || !after) continue;
      if (before.id !== after.id) replacements += 1;
      if (before.id === after.id && !before.faceUp && after.faceUp) newlyFaceUp += 1;
      if (!before.removed && after.removed) newlyRemoved += 1;
    }
  }

  return [newlyFaceUp, newlyRemoved, replacements] as const;
}

function activePlayerId(state: GameState) {
  return state.players[state.currentPlayerIndex]?.id ?? null;
}

function isTurnEntryPhase(state: GameState) {
  return state.phase === 'opening-reveal' || state.phase === 'choose-source';
}

function visibleDiscardChanged(previous: GameState, current: GameState) {
  const before = previous.discardPile[0];
  const after = current.discardPile[0];
  return (
    previous.discardPile.length !== current.discardPile.length ||
    before?.value !== after?.value ||
    before?.faceUp !== after?.faceUp ||
    before?.removed !== after?.removed
  );
}

function eventFactory(frame: GameAudioFrame) {
  let ordinal = 0;
  return (cue: SemanticAudioCue, delayMs = 0): GameAudioEvent => {
    const event: GameAudioEvent = {
      cue,
      delayMs,
      id: `${frame.sessionId}:${frame.revision}:${cue}:${ordinal}`
    };
    ordinal += 1;
    return event;
  };
}

/**
 * Converts exactly one accepted, contiguous game transition into semantic
 * audio events. Initial state, repeated/stale frames, resyncs, and revision
 * jumps are intentionally silent.
 */
export function deriveGameAudioEvents(
  previousFrame: GameAudioFrame | null | undefined,
  currentFrame: GameAudioFrame
): GameAudioEvent[] {
  const previous = previousFrame?.state;
  const current = currentFrame.state;
  if (!previousFrame || !previous || !current) return [];
  if (!currentFrame.sessionId || previousFrame.sessionId !== currentFrame.sessionId) return [];
  if (!Number.isSafeInteger(currentFrame.revision)) return [];
  if (currentFrame.revision !== previousFrame.revision + 1) return [];
  if ((currentFrame.delivery ?? 'live') !== 'live' || currentFrame.visible === false) return [];

  const makeEvent = eventFactory(currentFrame);
  if (previous.phase !== 'game-over' && current.phase === 'game-over') {
    return [makeEvent('gameEnd')];
  }
  if (previous.phase !== 'round-over' && current.phase === 'round-over') {
    return [makeEvent('roundEnd')];
  }

  const events: GameAudioEvent[] = [];
  const [newlyFaceUp, newlyRemoved, replacements] = boardDelta(previous, current);
  const activeSeatChanged = current.currentPlayerIndex !== previous.currentPlayerIndex;
  const observableBoardAction =
    newlyFaceUp > 0 ||
    newlyRemoved > 0 ||
    replacements > 0 ||
    visibleDiscardChanged(previous, current);
  const pickedUpCard =
    previous.phase === 'choose-source' &&
    ((current.phase === 'choose-replacement' && current.selectedSource !== null) ||
      (activeSeatChanged && observableBoardAction));
  if (pickedUpCard) events.push(makeEvent('pickup'));

  // Public multiplayer snapshots intentionally keep stable, position-scoped
  // card ids, so a replacement cannot be inferred from card identity. A
  // completed replacement always advances the active seat; cancelling a
  // discard choice does not.
  const placedCard =
    activeSeatChanged &&
    (previous.phase === 'choose-replacement' ||
      (previous.phase === 'choose-source' && observableBoardAction)) &&
    isTurnEntryPhase(current);
  const atomicTurnSpacing = pickedUpCard && placedCard ? 120 : 0;
  if (placedCard) events.push(makeEvent('place', atomicTurnSpacing));

  if (newlyFaceUp > 0) {
    events.push(makeEvent('flip', placedCard ? atomicTurnSpacing + 120 : 0));
  }
  if (newlyRemoved >= 3) {
    events.push(makeEvent('columnClear', placedCard ? atomicTurnSpacing + 180 : newlyFaceUp > 0 ? 180 : 0));
  }

  const previousActivePlayerId = activePlayerId(previous);
  const currentActivePlayerId = activePlayerId(current);
  const localTurnStarted =
    Boolean(currentFrame.localPlayerId) &&
    currentActivePlayerId === currentFrame.localPlayerId &&
    previousActivePlayerId !== currentActivePlayerId &&
    isTurnEntryPhase(current);
  if (localTurnStarted) {
    const latestMechanicalDelay = events.reduce((latest, event) => Math.max(latest, event.delayMs), 0);
    events.push(makeEvent('localTurn', events.length > 0 ? latestMechanicalDelay + 220 : 0));
  }

  return events;
}
