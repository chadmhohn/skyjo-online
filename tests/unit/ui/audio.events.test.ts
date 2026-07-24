import { describe, expect, it } from 'vitest';
import {
  deriveGameAudioEvents,
  type GameAudioDelivery,
  type GameAudioFrame
} from '../../../src/audioEvents';
import type { Card, GameState, Player, TurnPhase } from '../../../src/types';

function card(id: string, value = 1, faceUp = false, removed = false): Card {
  return { faceUp, id, removed, value };
}

function player(id: string, name: string): Player {
  return {
    grid: Array.from({ length: 12 }, (_, index) => card(`${id}-${index}`, (index % 8) + 1)),
    id,
    kind: 'human',
    name,
    roundScore: 0,
    totalScore: 0
  };
}

function state(overrides: Partial<GameState> = {}): GameState {
  return {
    currentPlayerIndex: 0,
    discardPile: [card('discard', 5, true)],
    drawPile: [card('draw', 7), card('draw-next', 2)],
    drawnCard: null,
    finalTurnPlayerIds: [],
    log: ['Arbitrary localized copy that must not drive audio'],
    nextStarterId: null,
    openingRevealCounts: { local: 2, remote: 2 },
    phase: 'choose-source',
    players: [player('local', 'Local player'), player('remote', 'Remote player')],
    round: 1,
    roundCloserId: null,
    roundHistory: [],
    selectedSource: null,
    winnerId: null,
    ...overrides
  };
}

function frame(
  gameState: GameState,
  revision: number,
  overrides: Partial<Pick<GameAudioFrame, 'delivery' | 'localPlayerId' | 'sessionId' | 'visible'>> = {}
): GameAudioFrame {
  return {
    delivery: 'live',
    localPlayerId: 'local',
    revision,
    sessionId: 'game-session-1',
    state: gameState,
    visible: true,
    ...overrides
  };
}

function withPhase(gameState: GameState, phase: TurnPhase): GameState {
  return { ...gameState, phase };
}

describe('typed semantic game audio events', () => {
  it('derives one stable pickup event for an accepted contiguous transition', () => {
    const before = state();
    const after = {
      ...before,
      drawnCard: card('draw', 7, true),
      drawPile: before.drawPile.slice(1),
      phase: 'choose-replacement' as const,
      selectedSource: 'draw' as const
    };

    const first = deriveGameAudioEvents(frame(before, 40), frame(after, 41));
    const repeatedDerivation = deriveGameAudioEvents(frame(before, 40), frame(after, 41));

    expect(first).toEqual([
      {
        cue: 'pickup',
        delayMs: 0,
        id: 'game-session-1:41:pickup:0'
      }
    ]);
    expect(repeatedDerivation).toEqual(first);
  });

  it('suppresses delayed authoritative echoes, stale/replayed frames, resyncs, and revision gaps', () => {
    const before = state();
    const accepted = {
      ...before,
      drawnCard: card('draw', 7, true),
      drawPile: before.drawPile.slice(1),
      phase: 'choose-replacement' as const,
      selectedSource: 'draw' as const
    };

    expect(deriveGameAudioEvents(frame(before, 8), frame(accepted, 9))).toHaveLength(1);
    expect(deriveGameAudioEvents(frame(accepted, 9), frame(accepted, 9))).toEqual([]);
    expect(deriveGameAudioEvents(frame(accepted, 9), frame(before, 8))).toEqual([]);
    expect(deriveGameAudioEvents(frame(before, 8), frame(accepted, 10))).toEqual([]);
    expect(
      deriveGameAudioEvents(frame(before, 8), frame(accepted, 9, { delivery: 'resync' }))
    ).toEqual([]);
    expect(
      deriveGameAudioEvents(frame(before, 8), frame(accepted, 9, { delivery: 'baseline' }))
    ).toEqual([]);
    expect(
      deriveGameAudioEvents(
        frame(before, 8, { sessionId: 'old-game' }),
        frame(accepted, 9, { sessionId: 'new-game' })
      )
    ).toEqual([]);
  });

  it('never derives action audio from English log text or a rejected no-op', () => {
    const before = state({ log: ['Alice drew a card and discarded and revealed a card'] });
    const after = {
      ...before,
      log: ['Bob replaced a card and finished opening reveals']
    };

    expect(deriveGameAudioEvents(frame(before, 11), frame(after, 12))).toEqual([]);
  });

  it.each<GameAudioDelivery>(['baseline', 'resync'])(
    'keeps %s hydration silent even when the snapshot contains a scoring transition',
    (delivery) => {
      const before = state();
      const after = withPhase(before, 'round-over');

      expect(deriveGameAudioEvents(frame(before, 1), frame(after, 2, { delivery }))).toEqual([]);
      expect(deriveGameAudioEvents(null, frame(after, 2, { delivery }))).toEqual([]);
    }
  );

  it('maps board changes to place, flip, and column-clear cues with deterministic spacing', () => {
    const before = state({
      drawnCard: card('drawn', 4, true),
      phase: 'choose-replacement',
      selectedSource: 'draw'
    });
    const players = before.players.map((item) => ({
      ...item,
      grid: item.grid.map((itemCard, index) => {
        if (item.id !== 'local') return itemCard;
        if (index === 0) return card('drawn', 4, true, true);
        if (index === 4 || index === 8) return { ...itemCard, faceUp: true, removed: true };
        return itemCard;
      })
    }));
    const after = state({
      currentPlayerIndex: 1,
      discardPile: [card('replaced-card', 1, true), ...before.discardPile],
      players
    });

    expect(deriveGameAudioEvents(frame(before, 20), frame(after, 21))).toEqual([
      { cue: 'place', delayMs: 0, id: 'game-session-1:21:place:0' },
      { cue: 'flip', delayMs: 120, id: 'game-session-1:21:flip:1' },
      { cue: 'columnClear', delayMs: 180, id: 'game-session-1:21:columnClear:2' }
    ]);
  });

  it('detects placement from redacted position ids and keeps a cancelled discard silent', () => {
    const before = state({
      drawnCard: card('drawn-card', 4, true),
      phase: 'choose-replacement',
      selectedSource: 'draw'
    });
    const redactedPlayers = before.players.map((item) => ({
      ...item,
      grid: item.grid.map((itemCard, index) =>
        item.id === 'local' && index === 0
          ? { ...itemCard, faceUp: true }
          : itemCard
      )
    }));
    const accepted = {
      ...state({
        currentPlayerIndex: 1,
        players: redactedPlayers
      }),
      discardPile: [{ ...before.discardPile[0], value: 9 }, ...before.discardPile.slice(1)]
    };

    expect(deriveGameAudioEvents(frame(before, 30), frame(accepted, 31))).toEqual([
      { cue: 'place', delayMs: 0, id: 'game-session-1:31:place:0' },
      { cue: 'flip', delayMs: 120, id: 'game-session-1:31:flip:1' }
    ]);

    const cancelled = state({
      currentPlayerIndex: before.currentPlayerIndex,
      players: before.players
    });
    expect(deriveGameAudioEvents(frame(before, 31), frame(cancelled, 32))).toEqual([]);
  });

  it('spaces pickup before place and flip for one atomic AI turn snapshot', () => {
    const before = state({ currentPlayerIndex: 1 });
    const after = state({
      currentPlayerIndex: 0,
      discardPile: [card('discarded-by-ai', 9, true), ...before.discardPile],
      players: before.players.map((item) => ({
        ...item,
        grid: item.grid.map((itemCard, index) =>
          item.id === 'remote' && index === 0 ? { ...itemCard, faceUp: true } : itemCard
        )
      }))
    });

    expect(deriveGameAudioEvents(frame(before, 40), frame(after, 41))).toEqual([
      { cue: 'pickup', delayMs: 0, id: 'game-session-1:41:pickup:0' },
      { cue: 'place', delayMs: 120, id: 'game-session-1:41:place:1' },
      { cue: 'flip', delayMs: 240, id: 'game-session-1:41:flip:2' },
      { cue: 'localTurn', delayMs: 460, id: 'game-session-1:41:localTurn:3' }
    ]);
  });

  it('uses scoring cues as exclusive transition outcomes', () => {
    const before = state();

    expect(
      deriveGameAudioEvents(frame(before, 50), frame(withPhase(before, 'round-over'), 51))
    ).toEqual([{ cue: 'roundEnd', delayMs: 0, id: 'game-session-1:51:roundEnd:0' }]);
    expect(
      deriveGameAudioEvents(frame(before, 60), frame(withPhase(before, 'game-over'), 61))
    ).toEqual([{ cue: 'gameEnd', delayMs: 0, id: 'game-session-1:61:gameEnd:0' }]);
  });

  it('announces a local turn only for a visible foreground transition', () => {
    const before = state({ currentPlayerIndex: 1 });
    const after = state({ currentPlayerIndex: 0 });

    expect(deriveGameAudioEvents(frame(before, 70), frame(after, 71))).toEqual([
      { cue: 'localTurn', delayMs: 0, id: 'game-session-1:71:localTurn:0' }
    ]);
    expect(
      deriveGameAudioEvents(frame(before, 70), frame(after, 71, { visible: false }))
    ).toEqual([]);
    expect(
      deriveGameAudioEvents(
        frame(before, 70, { localPlayerId: null }),
        frame(after, 71, { localPlayerId: null })
      )
    ).toEqual([]);
  });
});
