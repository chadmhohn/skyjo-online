import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameAudioEvent } from '../../../src/audioEvents';

type AudioListener = () => void;

class ControllerAudio {
  static instances: ControllerAudio[] = [];
  currentTime = 0;
  loop = false;
  muted = false;
  paused = true;
  preload = '';
  volume = 1;
  private readonly listeners = new Map<string, Set<AudioListener>>();
  readonly load = vi.fn();
  readonly pause = vi.fn(() => {
    this.paused = true;
  });
  readonly play = vi.fn(async () => {
    this.paused = false;
  });

  constructor(readonly src: string) {
    ControllerAudio.instances.push(this);
  }

  addEventListener(type: string, listener: AudioListener) {
    const listeners = this.listeners.get(type) ?? new Set<AudioListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: AudioListener) {
    this.listeners.get(type)?.delete(listener);
  }

  finish() {
    this.paused = true;
    this.listeners.get('ended')?.forEach((listener) => listener());
    this.listeners.delete('ended');
  }
}

class FakeAudioParam {
  value = 1;
  readonly cancelScheduledValues = vi.fn();
  readonly exponentialRampToValueAtTime = vi.fn();
  readonly linearRampToValueAtTime = vi.fn();
  readonly setValueAtTime = vi.fn();
}

class FakeGain {
  static instances: FakeGain[] = [];
  readonly gain = new FakeAudioParam();
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();

  constructor() {
    FakeGain.instances.push(this);
  }
}

class FakeBufferSource {
  static instances: FakeBufferSource[] = [];
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn(() => {
    this.onended?.();
  });

  constructor() {
    FakeBufferSource.instances.push(this);
  }
}

class FakeOscillator {
  static instances: FakeOscillator[] = [];
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  readonly frequency = new FakeAudioParam();
  readonly start = vi.fn();
  readonly stop = vi.fn();
  type: OscillatorType = 'sine';

  constructor() {
    FakeOscillator.instances.push(this);
  }
}

class ControllerAudioContext {
  static instances: ControllerAudioContext[] = [];
  readonly createBufferSource = vi.fn(() => new FakeBufferSource());
  readonly createGain = vi.fn(() => new FakeGain());
  readonly createOscillator = vi.fn(() => new FakeOscillator());
  readonly decodeAudioData = vi.fn(async () => ({ duration: 0.3 }) as AudioBuffer);
  readonly destination = {} as AudioDestinationNode;
  readonly resume = vi.fn(async () => {
    this.state = 'running';
  });
  readonly suspend = vi.fn(async () => {
    this.state = 'suspended';
  });
  currentTime = 0;
  state: AudioContextState = 'running';

  constructor() {
    ControllerAudioContext.instances.push(this);
  }
}

async function loadAudio() {
  vi.resetModules();
  return import('../../../src/audio');
}

async function flushPromises(rounds = 16) {
  await vi.dynamicImportSettled();
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function event(id: string, cue: GameAudioEvent['cue'], delayMs = 0): GameAudioEvent {
  return { cue, delayMs, id };
}

function listenerFor(spy: ReturnType<typeof vi.spyOn>, eventName: string): EventListener {
  const listener = spy.mock.calls.find((call: unknown[]) => call[0] === eventName)?.[1];
  if (typeof listener !== 'function') throw new Error(`Missing ${eventName} listener.`);
  return listener as EventListener;
}

describe('root audio controller', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T21:00:00Z'));
    ControllerAudio.instances = [];
    ControllerAudioContext.instances = [];
    FakeBufferSource.instances = [];
    FakeGain.instances = [];
    FakeOscillator.instances = [];
    vi.stubGlobal('Audio', ControllerAudio);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('applies each stable semantic event exactly once, including delayed duplicates', async () => {
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
    const audio = await loadAudio();

    audio.playGameAudioEvents([
      event('session:8:pickup:0', 'pickup'),
      event('session:8:pickup:0', 'pickup'),
      event('session:8:place:1', 'place', 120),
      event('session:8:place:1', 'place', 120)
    ]);
    await flushPromises();
    expect(ControllerAudio.instances.filter((instance) => instance.src.endsWith('card-pickup.mp3'))[0]?.play)
      .toHaveBeenCalledOnce();
    expect(ControllerAudio.instances.some((instance) => instance.src.endsWith('card-place.mp3'))).toBe(false);

    await vi.advanceTimersByTimeAsync(120);
    await flushPromises();
    expect(ControllerAudio.instances.filter((instance) => instance.src.endsWith('card-place.mp3'))[0]?.play)
      .toHaveBeenCalledOnce();

    audio.playGameAudioEvents([
      event('session:8:pickup:0', 'pickup'),
      event('session:8:place:1', 'place')
    ]);
    await flushPromises();
    expect(ControllerAudio.instances.reduce((total, instance) => total + instance.play.mock.calls.length, 0)).toBe(2);
  });

  it('limits playback to three simultaneous voices and four starts in a rolling second', async () => {
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
    const audio = await loadAudio();

    audio.playGameAudioEvents([
      event('rate:1', 'flip'),
      event('rate:2', 'pickup'),
      event('rate:3', 'place'),
      event('rate:4', 'columnClear'),
      event('rate:5', 'localTurn')
    ]);
    await flushPromises();

    const startsInFirstWindow = ControllerAudio.instances.reduce(
      (total, instance) => total + instance.play.mock.calls.length,
      0
    );
    expect(startsInFirstWindow).toBe(4);
    expect(ControllerAudio.instances.filter((instance) => !instance.paused)).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(999);
    audio.playGameAudioEvents([event('rate:6', 'gameEnd')]);
    await flushPromises();
    expect(ControllerAudio.instances.reduce(
      (total, instance) => total + instance.play.mock.calls.length,
      0
    )).toBe(4);

    await vi.advanceTimersByTimeAsync(1);
    audio.playGameAudioEvents([event('rate:7', 'roundEnd')]);
    await flushPromises();
    expect(ControllerAudio.instances.reduce(
      (total, instance) => total + instance.play.mock.calls.length,
      0
    )).toBe(5);
    expect(ControllerAudio.instances.filter((instance) => !instance.paused).length).toBeLessThanOrEqual(3);
  });

  it('owns one context, cancels stale delayed cues on hide, and resumes only on the next trusted gesture', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    );
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: ControllerAudioContext });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
    const windowAdd = vi.spyOn(window, 'addEventListener');
    const audio = await loadAudio();
    const rendered = renderHook(() => audio.useAudioSettings());

    await act(async () => {
      await expect(audio.primeAudio()).resolves.toBe(true);
      await expect(audio.primeAudio()).resolves.toBe(true);
      await flushPromises();
    });
    expect(ControllerAudioContext.instances).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);

    audio.playGameAudioEvents([
      event('lifecycle:flip', 'flip'),
      event('lifecycle:stale', 'localTurn', 200)
    ]);
    await flushPromises();
    expect(FakeBufferSource.instances).toHaveLength(1);
    const source = FakeBufferSource.instances[0];
    const gain = FakeGain.instances[0];

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await flushPromises();
    expect(source.stop).toHaveBeenCalledOnce();
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(gain.disconnect).toHaveBeenCalledOnce();
    expect(ControllerAudioContext.instances[0].suspend).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(250);
    expect(FakeOscillator.instances).toHaveLength(0);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await vi.advanceTimersByTimeAsync(501);
    act(() => window.dispatchEvent(new Event('focus')));
    await flushPromises();
    expect(ControllerAudioContext.instances[0].resume).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);

    const trustedActivation = listenerFor(windowAdd, 'pointerdown');
    await act(async () => {
      trustedActivation({ isTrusted: true } as Event);
      await flushPromises();
    });
    expect(ControllerAudioContext.instances).toHaveLength(1);
    expect(ControllerAudioContext.instances[0].resume).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(3);
    rendered.unmount();
  });

  it('uses HTML Audio when AudioContext construction fails', async () => {
    class ThrowingAudioContext {
      constructor() {
        throw new Error('WebAudio is unavailable');
      }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: ThrowingAudioContext });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
    const audio = await loadAudio();

    audio.playGameAudioEvents([event('fallback:1', 'place')]);
    await flushPromises();

    const fallback = ControllerAudio.instances.find((instance) => instance.src.endsWith('card-place.mp3'));
    expect(fallback?.play).toHaveBeenCalledOnce();
    expect(audio.getAudioStatus()).toBe('ready');
  });

  it('stops current and delayed playback immediately when effects are muted', async () => {
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
    const audio = await loadAudio();

    audio.playGameAudioEvents([
      event('mute:1', 'flip'),
      event('mute:2', 'roundEnd', 100)
    ]);
    await flushPromises();
    const playing = ControllerAudio.instances.find((instance) => instance.src.endsWith('card-flip.wav'));
    expect(playing?.paused).toBe(false);

    audio.setAudioSettings({ soundEffects: false });
    expect(playing?.paused).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(ControllerAudio.instances).toHaveLength(1);
  });
});
