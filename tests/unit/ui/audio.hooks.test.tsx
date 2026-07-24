import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameAudioContext } from '../../../src/audioEvents';
import type { Card, GameState, Player } from '../../../src/types';

class HookAudio {
  static instances: HookAudio[] = [];
  currentTime = 0;
  loop = false;
  muted = false;
  paused = true;
  preload = '';
  volume = 1;
  readonly addEventListener = vi.fn();
  readonly load = vi.fn();
  readonly pause = vi.fn(() => {
    this.paused = true;
  });
  readonly play = vi.fn(async () => {
    this.paused = false;
  });
  readonly removeEventListener = vi.fn();

  constructor(readonly src: string) {
    HookAudio.instances.push(this);
  }
}

function card(id: string, value = 1, faceUp = false): Card {
  return { faceUp, id, removed: false, value };
}

function player(id: string): Player {
  return {
    grid: Array.from({ length: 12 }, (_, index) => card(`${id}-${index}`)),
    id,
    kind: 'human',
    name: id,
    roundScore: 0,
    totalScore: 0
  };
}

function game(overrides: Partial<GameState> = {}): GameState {
  return {
    currentPlayerIndex: 0,
    discardPile: [card('discard', 4, true)],
    drawPile: [card('drawn', 7), card('draw-next', 2)],
    drawnCard: null,
    finalTurnPlayerIds: [],
    log: ['Localized display copy is not an audio protocol'],
    nextStarterId: null,
    openingRevealCounts: { local: 2, remote: 2 },
    phase: 'choose-source',
    players: [player('local'), player('remote')],
    round: 1,
    roundCloserId: null,
    roundHistory: [],
    selectedSource: null,
    winnerId: null,
    ...overrides
  };
}

function context(revision: number, overrides: Partial<GameAudioContext> = {}): GameAudioContext {
  return {
    delivery: 'live',
    localPlayerId: 'local',
    revision,
    sessionId: 'hook-session',
    visible: true,
    ...overrides
  };
}

async function loadAudio() {
  vi.resetModules();
  return import('../../../src/audio');
}

async function flushPromises(rounds = 12) {
  await vi.dynamicImportSettled();
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function playCount(suffix: string) {
  return HookAudio.instances
    .filter((instance) => instance.src.endsWith(suffix))
    .reduce((total, instance) => total + instance.play.mock.calls.length, 0);
}

describe('root audio hooks', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T20:00:00Z'));
    HookAudio.instances = [];
    vi.stubGlobal('Audio', HookAudio);
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('installs one lifecycle listener set across multiple hook consumers and removes it after the last unmount', async () => {
    const windowAdd = vi.spyOn(window, 'addEventListener');
    const windowRemove = vi.spyOn(window, 'removeEventListener');
    const documentAdd = vi.spyOn(document, 'addEventListener');
    const documentRemove = vi.spyOn(document, 'removeEventListener');
    const audio = await loadAudio();

    const settingsHook = renderHook(() => audio.useAudioSettings());
    const gameHook = renderHook(() => audio.useGameAudio(null));
    for (const eventName of ['pointerdown', 'touchstart', 'click', 'keydown', 'focus', 'pageshow']) {
      expect(windowAdd.mock.calls.filter(([name]) => name === eventName)).toHaveLength(1);
    }
    expect(documentAdd.mock.calls.filter(([name]) => name === 'visibilitychange')).toHaveLength(1);

    settingsHook.unmount();
    expect(windowRemove).not.toHaveBeenCalled();
    expect(documentRemove).not.toHaveBeenCalled();

    gameHook.unmount();
    for (const eventName of ['pointerdown', 'touchstart', 'click', 'keydown', 'focus', 'pageshow']) {
      expect(windowRemove.mock.calls.filter(([name]) => name === eventName)).toHaveLength(1);
    }
    expect(documentRemove.mock.calls.filter(([name]) => name === 'visibilitychange')).toHaveLength(1);
  });

  it('plays a typed transition once and suppresses its delayed authoritative echo', async () => {
    const audio = await loadAudio();
    const initial = game();
    const accepted = {
      ...initial,
      drawPile: initial.drawPile.slice(1),
      drawnCard: { ...initial.drawPile[0], faceUp: true },
      phase: 'choose-replacement' as const,
      selectedSource: 'draw' as const
    };
    const rendered = renderHook(
      ({ state, audioContext }: { state: GameState; audioContext: GameAudioContext }) =>
        audio.useGameAudio(state, audioContext),
      { initialProps: { state: initial, audioContext: context(100, { delivery: 'baseline' }) } }
    );
    expect(playCount('card-pickup.mp3')).toBe(0);

    rendered.rerender({ state: accepted, audioContext: context(101) });
    await act(async () => flushPromises());
    expect(playCount('card-pickup.mp3')).toBe(1);

    rendered.rerender({ state: accepted, audioContext: context(101) });
    await act(async () => flushPromises());
    expect(playCount('card-pickup.mp3')).toBe(1);
    rendered.unmount();
  });

  it('supplies a monotonic local revision sequence when solo context omits revision', async () => {
    const audio = await loadAudio();
    const initial = game();
    const accepted = {
      ...initial,
      drawPile: initial.drawPile.slice(1),
      drawnCard: { ...initial.drawPile[0], faceUp: true },
      phase: 'choose-replacement' as const,
      selectedSource: 'draw' as const
    };
    const soloContext: GameAudioContext = {
      localPlayerId: 'local',
      sessionId: 'solo-game-id',
      visible: true
    };
    const rendered = renderHook(
      ({ state }: { state: GameState }) => audio.useGameAudio(state, soloContext),
      { initialProps: { state: initial } }
    );

    rendered.rerender({ state: accepted });
    await act(async () => flushPromises());
    expect(playCount('card-pickup.mp3')).toBe(1);

    rendered.rerender({ state: accepted });
    await act(async () => flushPromises());
    expect(playCount('card-pickup.mp3')).toBe(1);

    rendered.rerender({ state: { ...accepted, log: ['Only display copy changed'] } });
    await act(async () => flushPromises());
    expect(playCount('card-pickup.mp3')).toBe(1);
    rendered.unmount();
  });

  it('keeps resync/background frames silent and resumes only from a later contiguous live transition', async () => {
    const audio = await loadAudio();
    const waiting = game({ currentPlayerIndex: 1 });
    const localTurn = game({ currentPlayerIndex: 0 });
    const rendered = renderHook(
      ({ state, audioContext }: { state: GameState; audioContext: GameAudioContext }) =>
        audio.useGameAudio(state, audioContext),
      { initialProps: { state: waiting, audioContext: context(20, { delivery: 'baseline' }) } }
    );

    rendered.rerender({ state: localTurn, audioContext: context(21, { delivery: 'resync' }) });
    await act(async () => flushPromises());
    expect(HookAudio.instances).toHaveLength(0);

    rendered.rerender({ state: waiting, audioContext: context(22, { visible: false }) });
    await act(async () => flushPromises());
    expect(HookAudio.instances).toHaveLength(0);

    rendered.rerender({ state: localTurn, audioContext: context(23) });
    await act(async () => flushPromises());
    expect(HookAudio.instances).toHaveLength(1);
    expect(HookAudio.instances[0].src).toMatch(/^data:audio\/wav;base64,/);
    expect(HookAudio.instances[0].play).toHaveBeenCalledOnce();
    rendered.unmount();
  });

  it('preserves legacy one-argument hook calls as silent lifecycle consumers', async () => {
    const audio = await loadAudio();
    const initial = game();
    const accepted = {
      ...initial,
      drawnCard: { ...initial.drawPile[0], faceUp: true },
      phase: 'choose-replacement' as const,
      selectedSource: 'draw' as const
    };
    const rendered = renderHook(({ state }: { state: GameState }) => audio.useGameAudio(state), {
      initialProps: { state: initial }
    });

    rendered.rerender({ state: accepted });
    await act(async () => flushPromises());
    expect(HookAudio.instances).toHaveLength(0);
    rendered.unmount();
  });
});
