import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeBufferSource {
  static instances: FakeBufferSource[] = [];
  buffer: AudioBuffer | null = null;
  readonly connect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn();

  constructor() {
    FakeBufferSource.instances.push(this);
  }
}

class FakeGain {
  static instances: FakeGain[] = [];
  gain = { value: 1 };
  readonly connect = vi.fn();

  constructor() {
    FakeGain.instances.push(this);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static initialState: AudioContextState = 'running';
  static rejectResume = false;
  readonly destination = {} as AudioDestinationNode;
  state: AudioContextState = FakeAudioContext.initialState;
  readonly createBufferSource = vi.fn(() => new FakeBufferSource());
  readonly createGain = vi.fn(() => new FakeGain());
  readonly decodeAudioData = vi.fn(async () => ({ duration: 0.2 }) as AudioBuffer);
  readonly resume = vi.fn(async () => {
    if (FakeAudioContext.rejectResume) throw new Error('resume denied');
    this.state = 'running';
  });
  readonly suspend = vi.fn(async () => {
    this.state = 'suspended';
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

class AmbienceAudio {
  static instances: AmbienceAudio[] = [];
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
    AmbienceAudio.instances.push(this);
  }
}

async function loadAudio() {
  vi.resetModules();
  return import('../../../src/audio');
}

async function flushPromises(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

describe('WebAudio playback', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:00:00Z'));
    FakeAudioContext.instances = [];
    FakeAudioContext.initialState = 'running';
    FakeAudioContext.rejectResume = false;
    FakeBufferSource.instances = [];
    FakeGain.instances = [];
    AmbienceAudio.instances = [];
    vi.stubGlobal('Audio', AmbienceAudio);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    );
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('preloads decoded buffers without constructing disabled ambience and plays a gain-scaled cue', async () => {
    const audio = await loadAudio();

    expect(fetch).not.toHaveBeenCalled();
    expect(FakeAudioContext.instances).toHaveLength(0);
    await expect(audio.primeAudio()).resolves.toBe(true);
    await flushPromises();
    const context = FakeAudioContext.instances[0];
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(context.decodeAudioData).toHaveBeenCalledTimes(3);
    expect(AmbienceAudio.instances).toHaveLength(0);

    audio.playAudioCue('flip');
    await flushPromises();
    const source = FakeBufferSource.instances[0];
    const gain = FakeGain.instances[0];
    expect(source.buffer).toEqual({ duration: 0.2 });
    expect(source.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(context.destination);
    expect(gain.gain.value).toBeCloseTo(0.72 * 0.24);
    expect(source.start).toHaveBeenCalledOnce();
    expect(audio.getAudioStatus()).toBe('ready');

    await vi.advanceTimersByTimeAsync(520);
    expect(source.stop).toHaveBeenCalledOnce();
  });

  it('coalesces duplicate warmup and preserves the cue triggered by the first activation', async () => {
    FakeAudioContext.initialState = 'suspended';
    const audio = await loadAudio();

    const firstPrime = audio.primeAudio();
    const duplicatePrime = audio.primeAudio();
    expect(duplicatePrime).toBe(firstPrime);
    audio.playAudioCue('flip');

    await expect(firstPrime).resolves.toBe(true);
    await flushPromises();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(FakeAudioContext.instances[0].decodeAudioData).toHaveBeenCalledTimes(3);
    expect(FakeBufferSource.instances).toHaveLength(1);
    expect(FakeBufferSource.instances[0].start).toHaveBeenCalledOnce();
  });

  it('does not create a context or fetch buffers while sound and ambience are disabled', async () => {
    const audio = await loadAudio();
    audio.setAudioSettings({ ambience: false, soundEffects: false });

    await expect(audio.primeAudio()).resolves.toBe(true);
    audio.playAudioCue('place');
    await flushPromises();

    expect(fetch).not.toHaveBeenCalled();
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(AmbienceAudio.instances).toHaveLength(0);
  });

  it('resumes a suspended context before playing', async () => {
    FakeAudioContext.initialState = 'suspended';
    const audio = await loadAudio();

    await expect(audio.primeAudio()).resolves.toBe(true);
    await flushPromises();
    const context = FakeAudioContext.instances[0];
    expect(context.resume).toHaveBeenCalledOnce();
    expect(audio.getAudioStatus()).toBe('ready');

    context.state = 'suspended';
    audio.playAudioCue('pickup');
    await flushPromises();
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(FakeBufferSource.instances[0].start).toHaveBeenCalledOnce();
  });

  it('reports blocked when context resume fails', async () => {
    FakeAudioContext.initialState = 'suspended';
    FakeAudioContext.rejectResume = true;
    const audio = await loadAudio();

    await expect(audio.primeAudio()).resolves.toBe(true);
    expect(audio.getAudioStatus()).toBe('blocked');

    audio.playAudioCue('place');
    await flushPromises();
    expect(audio.getAudioStatus()).toBe('blocked');
    expect(FakeBufferSource.instances).toHaveLength(0);
  });

  it('handles failed fetches and unavailable decoded buffers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    const audio = await loadAudio();
    await audio.primeAudio();
    await flushPromises();

    audio.playAudioCue('flip');
    await flushPromises();

    expect(audio.getAudioStatus()).toBe('blocked');
    expect(FakeBufferSource.instances).toHaveLength(0);
  });

  it('recreates a context that was closed between primes', async () => {
    const audio = await loadAudio();
    await audio.primeAudio();
    FakeAudioContext.instances[0].state = 'closed';

    await audio.primeAudio();

    expect(FakeAudioContext.instances).toHaveLength(2);
  });
});
