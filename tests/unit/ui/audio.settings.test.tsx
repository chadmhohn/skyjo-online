import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settingsKey = 'skyjo-audio-settings-v3';
const previousSettingsKey = 'skyjo-audio-settings-v2';
const legacySettingsKey = 'skyjo-audio-settings-v1';

async function loadAudio() {
  vi.resetModules();
  return import('../../../src/audio');
}

describe('audio settings persistence and migration', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads quiet, effects-first defaults with retired ambience forced off', async () => {
    const audio = await loadAudio();

    expect(audio.getAudioSettings()).toEqual({
      soundEffects: true,
      soundVolume: 0.72
    });
    expect(audio.getAudioStatus()).toBe('idle');
  });

  it.each([
    previousSettingsKey,
    legacySettingsKey
  ])('migrates %s effects mute/volume while dropping ambience', async (sourceKey) => {
    window.localStorage.setItem(
      sourceKey,
      JSON.stringify({
        ambience: true,
        ambienceVolume: 0.91,
        soundEffects: false,
        soundVolume: 0.19
      })
    );

    const audio = await loadAudio();

    expect(audio.getAudioSettings()).toEqual({
      soundEffects: false,
      soundVolume: 0.19
    });
  });

  it('prefers current settings while discarding retired channel fields', async () => {
    window.localStorage.setItem(
      previousSettingsKey,
      JSON.stringify({ soundEffects: false, soundVolume: 0.1 })
    );
    window.localStorage.setItem(
      settingsKey,
      JSON.stringify({
        ambience: true,
        ambienceVolume: 1,
        soundEffects: true,
        soundVolume: 0.41,
        turnAlerts: false,
        turnVolume: 0.22
      })
    );

    expect((await loadAudio()).getAudioSettings()).toEqual({
      soundEffects: true,
      soundVolume: 0.41
    });
  });

  it('normalizes malformed booleans and clamps finite volume values', async () => {
    window.localStorage.setItem(
      settingsKey,
      JSON.stringify({
        ambience: 'true',
        soundEffects: 'false',
        soundVolume: -2,
        turnAlerts: 1,
        turnVolume: 4
      })
    );

    expect((await loadAudio()).getAudioSettings()).toEqual({
      soundEffects: true,
      soundVolume: 0
    });
  });

  it('falls back to the default volume when stored input is non-finite', async () => {
    window.localStorage.setItem(
      settingsKey,
      JSON.stringify({ soundEffects: true, soundVolume: 'not-a-number' })
    );

    expect((await loadAudio()).getAudioSettings()).toEqual({
      soundEffects: true,
      soundVolume: 0.72
    });
  });

  it('falls back safely when storage JSON or storage reads fail', async () => {
    window.localStorage.setItem(settingsKey, '{not-json');
    expect((await loadAudio()).getAudioSettings()).toMatchObject({
      soundEffects: true,
      soundVolume: 0.72
    });

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is unavailable');
    });
    expect((await loadAudio()).getAudioSettings()).toMatchObject({
      soundEffects: true,
      soundVolume: 0.72
    });
  });

  it('keeps in-memory settings and subscriber delivery usable when storage writes fail', async () => {
    const audio = await loadAudio();
    const subscriber = vi.fn();
    const unsubscribe = audio.subscribeAudioSettings(subscriber);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage quota denied');
    });

    expect(() => {
      audio.setAudioSettings({
        ambience: true,
        ambienceVolume: 1,
        soundEffects: false,
        soundVolume: 0.33
      });
    }).not.toThrow();
    expect(audio.getAudioSettings()).toEqual({
      soundEffects: false,
      soundVolume: 0.33
    });
    expect(subscriber).toHaveBeenCalledOnce();

    unsubscribe();
    audio.setAudioSettings({ soundEffects: true });
    expect(subscriber).toHaveBeenCalledOnce();
  });

  it('persists normalized v3 updates and never revives retired ambience', async () => {
    const audio = await loadAudio();

    audio.setAudioSettings({
      ambience: true,
      ambienceVolume: 0.8,
      soundVolume: -1
    });

    expect(audio.getAudioSettings()).toEqual({
      soundEffects: true,
      soundVolume: 0
    });
    expect(JSON.parse(window.localStorage.getItem(settingsKey) || '{}')).toEqual(audio.getAudioSettings());
    expect(window.localStorage.getItem(previousSettingsKey)).toBeNull();
  });

  it('reports unavailable audio and supports status unsubscription', async () => {
    vi.stubGlobal('Audio', undefined);
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
    const audio = await loadAudio();
    const subscriber = vi.fn();
    const unsubscribe = audio.subscribeAudioStatus(subscriber);

    await expect(audio.primeAudio()).resolves.toBe(false);
    expect(audio.getAudioStatus()).toBe('unavailable');
    expect(subscriber).toHaveBeenCalledWith('unavailable');

    unsubscribe();
    await audio.primeAudio();
    expect(subscriber).toHaveBeenCalledOnce();
  });
});
