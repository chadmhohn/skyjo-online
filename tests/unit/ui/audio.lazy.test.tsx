import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class LazyAudio {
  static instances: LazyAudio[] = [];
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
    LazyAudio.instances.push(this);
  }
}

async function loadAudio() {
  vi.resetModules();
  return import('../../../src/audio');
}

function registeredListener(
  spy: ReturnType<typeof vi.spyOn>,
  eventName: string
): EventListener {
  const listener = spy.mock.calls.find((call: unknown[]) => call[0] === eventName)?.[1];
  if (typeof listener !== 'function') throw new Error(`Missing ${eventName} listener.`);
  return listener as EventListener;
}

function trustedEvent() {
  return { isTrusted: true } as Event;
}

describe('lazy audio activation', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T12:00:00Z'));
    LazyAudio.instances = [];
    vi.stubGlobal('Audio', LazyAudio);
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not construct media on mount or synthetic events and primes once on trusted activation', async () => {
    const windowAdd = vi.spyOn(window, 'addEventListener');
    const audio = await loadAudio();
    const { unmount } = renderHook(() => audio.useAudioSettings());
    const unlock = registeredListener(windowAdd, 'pointerdown');

    expect(LazyAudio.instances).toHaveLength(0);
    await act(async () => {
      unlock(new Event('pointerdown'));
      await vi.dynamicImportSettled();
    });
    expect(LazyAudio.instances).toHaveLength(0);

    await act(async () => {
      unlock(trustedEvent());
      unlock(trustedEvent());
      await vi.dynamicImportSettled();
    });
    expect(LazyAudio.instances.map((instance) => instance.src)).toEqual([
      '/audio/card-flip.mp3',
      '/audio/card-pickup.mp3',
      '/audio/card-place.mp3'
    ]);
    LazyAudio.instances.forEach((instance) => expect(instance.load).toHaveBeenCalledOnce());
    unmount();
  });

  it('waits for another trusted activation after an iOS-style resume reset', async () => {
    const windowAdd = vi.spyOn(window, 'addEventListener');
    const documentAdd = vi.spyOn(document, 'addEventListener');
    const audio = await loadAudio();
    const { unmount } = renderHook(() => audio.useAudioSettings());
    const unlock = registeredListener(windowAdd, 'pointerdown');
    const focus = registeredListener(windowAdd, 'focus');
    const pageShow = registeredListener(windowAdd, 'pageshow');
    const visibilityChange = registeredListener(documentAdd, 'visibilitychange');

    await act(async () => {
      unlock(trustedEvent());
      await vi.dynamicImportSettled();
    });
    expect(LazyAudio.instances).toHaveLength(3);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => visibilityChange(new Event('visibilitychange')));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => {
      focus(new Event('focus'));
      pageShow(new Event('pageshow'));
    });
    expect(LazyAudio.instances).toHaveLength(3);

    await act(async () => {
      unlock(trustedEvent());
      unlock(trustedEvent());
      await vi.dynamicImportSettled();
    });
    expect(LazyAudio.instances).toHaveLength(6);
    LazyAudio.instances.slice(3).forEach((instance) => expect(instance.load).toHaveBeenCalledOnce());
    unmount();
  });

  it('keeps trusted activations network-idle when both channels are disabled', async () => {
    window.localStorage.setItem(
      'skyjo-audio-settings-v2',
      JSON.stringify({ ambience: false, ambienceVolume: 0.34, soundEffects: false, soundVolume: 0.72 })
    );
    const windowAdd = vi.spyOn(window, 'addEventListener');
    const audio = await loadAudio();
    const { unmount } = renderHook(() => audio.useAudioSettings());
    const unlock = registeredListener(windowAdd, 'pointerdown');

    await act(async () => {
      unlock(trustedEvent());
      await vi.dynamicImportSettled();
    });
    audio.playAudioCue('flip');

    expect(LazyAudio.instances).toHaveLength(0);
    unmount();
  });
});
