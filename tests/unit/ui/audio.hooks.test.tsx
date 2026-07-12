import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameState } from '../../../src/types';
import { setAudioSettings, useAudioSettings, useGameAudio } from '../../../src/audio';

class HookAudio {
  static instances: HookAudio[] = [];
  currentTime = 0;
  loop = false;
  muted = false;
  paused = true;
  preload = '';
  volume = 1;
  readonly load = vi.fn();
  readonly pause = vi.fn(() => {
    this.paused = true;
  });
  readonly play = vi.fn(async () => {
    this.paused = false;
  });

  constructor(readonly src: string) {
    HookAudio.instances.push(this);
  }
}

function gameWithLog(message: string) {
  return { log: message ? [message] : [] } as unknown as GameState;
}

function playsFor(suffix: string) {
  return HookAudio.instances
    .filter((audio) => audio.src.endsWith(suffix))
    .reduce((total, audio) => total + audio.play.mock.calls.length, 0);
}

describe('audio hooks', () => {
  let testClock = Date.parse('2026-07-12T12:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    testClock += 10_000;
    vi.setSystemTime(testClock);
    vi.stubGlobal('Audio', HookAudio);
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    setAudioSettings({ ambience: false, ambienceVolume: 0.34, soundEffects: true, soundVolume: 0.72 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('subscribes to settings and browser lifecycle events, then cleans up', async () => {
    const windowAdd = vi.spyOn(window, 'addEventListener');
    const windowRemove = vi.spyOn(window, 'removeEventListener');
    const documentAdd = vi.spyOn(document, 'addEventListener');
    const documentRemove = vi.spyOn(document, 'removeEventListener');
    const { result, unmount } = renderHook(() => useAudioSettings());

    expect(result.current[0].soundVolume).toBe(0.72);
    expect(windowAdd.mock.calls.map(([event]) => event)).toEqual(
      expect.arrayContaining(['pointerdown', 'touchstart', 'click', 'keydown', 'focus', 'pageshow'])
    );
    expect(documentAdd).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    await act(async () => {
      result.current[1]({ ambience: true, ambienceVolume: 0.6, soundVolume: 0.4 });
      await Promise.resolve();
    });
    expect(result.current[0]).toMatchObject({ ambience: true, ambienceVolume: 0.6, soundVolume: 0.4 });
    expect(result.current[2]).toBe('ready');

    await act(async () => {
      window.dispatchEvent(new Event('pointerdown'));
      await Promise.resolve();
    });
    const ambience = HookAudio.instances.find((audio) => audio.src.endsWith('table-ambience.mp3'));
    expect(ambience?.play).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(ambience?.pause).toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      vi.advanceTimersByTime(501);
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(HookAudio.instances.length).toBeGreaterThan(4);

    unmount();
    expect(windowRemove.mock.calls.map(([event]) => event)).toEqual(
      expect.arrayContaining(['pointerdown', 'touchstart', 'click', 'keydown', 'focus', 'pageshow'])
    );
    expect(documentRemove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('maps new game-log events to pickup, place, and flip cues without replaying the initial log', async () => {
    const pickupBefore = playsFor('card-pickup.mp3');
    const placeBefore = playsFor('card-place.mp3');
    const flipBefore = playsFor('card-flip.mp3');
    const { rerender } = renderHook(({ state }: { state: GameState }) => useGameAudio(state), {
      initialProps: { state: gameWithLog('Alice drew a card') }
    });
    expect(playsFor('card-pickup.mp3')).toBe(pickupBefore);

    rerender({ state: gameWithLog('Alice drew a 5') });
    await act(async () => Promise.resolve());
    expect(playsFor('card-pickup.mp3')).toBe(pickupBefore + 1);

    await vi.advanceTimersByTimeAsync(500);
    rerender({ state: gameWithLog('Alice discarded a 7 and revealed a card') });
    await act(async () => Promise.resolve());
    expect(playsFor('card-place.mp3')).toBe(placeBefore + 1);
    await vi.advanceTimersByTimeAsync(120);
    expect(playsFor('card-flip.mp3')).toBe(flipBefore + 1);

    await vi.advanceTimersByTimeAsync(500);
    rerender({ state: gameWithLog('Alice replaced a card') });
    await act(async () => Promise.resolve());
    expect(playsFor('card-place.mp3')).toBe(placeBefore + 2);

    await vi.advanceTimersByTimeAsync(500);
    rerender({ state: gameWithLog('Alice revealed an opening card') });
    await act(async () => Promise.resolve());
    expect(playsFor('card-flip.mp3')).toBe(flipBefore + 2);

    rerender({ state: gameWithLog('Alice revealed an opening card') });
    await act(async () => Promise.resolve());
    expect(playsFor('card-flip.mp3')).toBe(flipBefore + 2);
  });

  it('ignores empty logs and recognizes the finished-opening cue', async () => {
    const flipBefore = playsFor('card-flip.mp3');
    const { rerender } = renderHook(({ state }: { state: GameState | null }) => useGameAudio(state), {
      initialProps: { state: null as GameState | null }
    });

    rerender({ state: gameWithLog('') });
    expect(playsFor('card-flip.mp3')).toBe(flipBefore);
    rerender({ state: gameWithLog('Alice waits') });
    rerender({ state: gameWithLog('Alice finished opening reveals') });
    await act(async () => Promise.resolve());
    expect(playsFor('card-flip.mp3')).toBe(flipBefore + 1);
  });
});
