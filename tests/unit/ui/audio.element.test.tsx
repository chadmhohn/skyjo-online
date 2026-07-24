import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PlayBehavior = (audio: FakeAudio) => Promise<void> | undefined;

class FakeAudio {
  static instances: FakeAudio[] = [];
  static playBehavior: PlayBehavior = async (audio) => {
    audio.paused = false;
  };

  readonly load = vi.fn();
  readonly pause = vi.fn(() => {
    this.paused = true;
  });
  readonly play = vi.fn(() => FakeAudio.playBehavior(this));
  currentTime = 0;
  loop = false;
  muted = false;
  paused = true;
  preload = '';
  volume = 1;

  constructor(readonly src: string) {
    FakeAudio.instances.push(this);
  }
}

async function loadAudio() {
  vi.resetModules();
  return import('../../../src/audio');
}

async function flushPromises() {
  await vi.dynamicImportSettled();
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function bySource(suffix: string) {
  const audio = FakeAudio.instances.find((instance) => instance.src.endsWith(suffix));
  if (!audio) throw new Error(`Missing fake audio for ${suffix}`);
  return audio;
}

describe('HTML Audio playback', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:00:00Z'));
    FakeAudio.instances = [];
    FakeAudio.playBehavior = async (audio) => {
      audio.paused = false;
    };
    vi.stubGlobal('Audio', FakeAudio);
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('preloads only enabled cue assets exactly once', async () => {
    const audio = await loadAudio();

    await expect(audio.primeAudio()).resolves.toBe(true);
    await expect(audio.primeAudio()).resolves.toBe(true);

    expect(FakeAudio.instances.map((instance) => instance.src)).toEqual([
      '/audio/card-flip.mp3',
      '/audio/card-pickup.mp3',
      '/audio/card-place.mp3'
    ]);
    FakeAudio.instances.forEach((instance) => expect(instance.load).toHaveBeenCalledOnce());
  });

  it('does no audio work when both audio channels are disabled', async () => {
    const audio = await loadAudio();
    audio.setAudioSettings({ ambience: false, soundEffects: false });

    await expect(audio.primeAudio()).resolves.toBe(true);
    audio.playAudioCue('flip');

    expect(FakeAudio.instances).toHaveLength(0);
  });

  it('never constructs retired ambience from legacy settings', async () => {
    const audio = await loadAudio();
    audio.setAudioSettings({ ambience: true, ambienceVolume: 1, soundEffects: false });
    await flushPromises();

    await expect(audio.primeAudio()).resolves.toBe(true);

    expect(audio.getAudioSettings()).toEqual({ soundEffects: false, soundVolume: 0.72 });
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it('plays a volume-scaled cue, throttles duplicates, and cleans it up on schedule', async () => {
    const audio = await loadAudio();
    await audio.primeAudio();
    const statusSubscriber = vi.fn();
    audio.subscribeAudioStatus(statusSubscriber);

    audio.playAudioCue('flip');
    await flushPromises();
    const flip = bySource('card-flip.mp3');

    expect(flip.play).toHaveBeenCalledOnce();
    expect(flip.volume).toBeCloseTo(0.72 * 0.24);
    expect(flip.muted).toBe(false);
    expect(audio.getAudioStatus()).toBe('ready');
    expect(statusSubscriber).not.toHaveBeenCalled();

    audio.playAudioCue('flip');
    expect(flip.play).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(520);
    expect(flip.pause).toHaveBeenCalledTimes(2);
    expect(flip.currentTime).toBe(0);
  });

  it('marks rejected playback blocked, observes the cooldown, then recovers', async () => {
    const audio = await loadAudio();
    await audio.primeAudio();
    FakeAudio.playBehavior = async () => {
      throw new Error('autoplay denied');
    };

    audio.playAudioCue('pickup');
    await flushPromises();
    const pickup = bySource('card-pickup.mp3');
    expect(audio.getAudioStatus()).toBe('blocked');
    expect(pickup.pause).toHaveBeenCalled();

    audio.playAudioCue('place');
    expect(bySource('card-place.mp3').play).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(751);
    FakeAudio.playBehavior = async (element) => {
      element.paused = false;
    };
    audio.playAudioCue('pickup');
    await flushPromises();
    expect(pickup.play).toHaveBeenCalledTimes(2);
    expect(audio.getAudioStatus()).toBe('ready');
  });

  it('accepts legacy void play results and does not play disabled effects', async () => {
    FakeAudio.playBehavior = () => undefined;
    const audio = await loadAudio();

    audio.playAudioCue('place');
    await flushPromises();
    expect(bySource('card-place.mp3').play).toHaveBeenCalledOnce();
    expect(audio.getAudioStatus()).toBe('ready');

    audio.setAudioSettings({ soundEffects: false });
    audio.playAudioCue('flip');
    audio.setAudioSettings({ soundEffects: true, soundVolume: 0 });
    audio.playAudioCue('pickup');
    expect(FakeAudio.instances).toHaveLength(1);
  });

  it('plays the three-part test sequence on deterministic timers', async () => {
    const audio = await loadAudio();

    audio.playAudioTestCue();
    await flushPromises();
    expect(bySource('card-flip.mp3').play).toHaveBeenCalledOnce();
    expect(bySource('card-pickup.mp3').play).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(170);
    expect(bySource('card-pickup.mp3').play).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(190);
    expect(bySource('card-place.mp3').play).toHaveBeenCalledOnce();
  });

  it('renders semantic score and turn cues through generated WAV fallback audio', async () => {
    const audio = await loadAudio();

    audio.playGameAudioEvents([
      { cue: 'columnClear', delayMs: 0, id: 'semantic:1' },
      { cue: 'localTurn', delayMs: 0, id: 'semantic:2' }
    ]);
    await flushPromises();

    expect(FakeAudio.instances).toHaveLength(2);
    FakeAudio.instances.forEach((instance) => {
      expect(instance.src).toMatch(/^data:audio\/wav;base64,/);
      expect(instance.play).toHaveBeenCalledOnce();
    });
  });

  it('reports blocked when generated fallback playback is rejected', async () => {
    FakeAudio.playBehavior = async () => {
      throw new Error('autoplay denied');
    };
    const audio = await loadAudio();
    audio.playAudioCue('roundEnd');
    await flushPromises();

    expect(audio.getAudioStatus()).toBe('blocked');
  });
});
