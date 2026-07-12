import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settingsKey = 'skyjo-audio-settings-v2';
const legacySettingsKey = 'skyjo-audio-settings-v1';

async function loadAudio() {
  vi.resetModules();
  return import('../../../src/audio');
}

describe('audio settings persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads defaults when no settings have been stored', async () => {
    const audio = await loadAudio();

    expect(audio.getAudioSettings()).toEqual({
      ambience: false,
      ambienceVolume: 0.34,
      soundEffects: true,
      soundVolume: 0.72
    });
    expect(audio.getAudioStatus()).toBe('idle');
  });

  it('normalizes and clamps current stored settings', async () => {
    window.localStorage.setItem(
      settingsKey,
      JSON.stringify({ ambience: 'enabled', ambienceVolume: 4, soundEffects: 0, soundVolume: -2 })
    );

    const audio = await loadAudio();

    expect(audio.getAudioSettings()).toEqual({
      ambience: true,
      ambienceVolume: 1,
      soundEffects: false,
      soundVolume: 0
    });
  });

  it('migrates legacy sound settings without enabling ambience', async () => {
    window.localStorage.setItem(legacySettingsKey, JSON.stringify({ soundEffects: false, soundVolume: 0.19 }));

    const audio = await loadAudio();

    expect(audio.getAudioSettings()).toEqual({
      ambience: false,
      ambienceVolume: 0.34,
      soundEffects: false,
      soundVolume: 0.19
    });
  });

  it('falls back safely when storage JSON or storage access fails', async () => {
    window.localStorage.setItem(settingsKey, '{not-json');
    expect((await loadAudio()).getAudioSettings().soundVolume).toBe(0.72);

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is unavailable');
    });
    expect((await loadAudio()).getAudioSettings().ambienceVolume).toBe(0.34);
  });

  it('persists clamped updates and stops notifying after unsubscribe', async () => {
    const audio = await loadAudio();
    const subscriber = vi.fn();
    const unsubscribe = audio.subscribeAudioSettings(subscriber);

    audio.setAudioSettings({ ambience: true, ambienceVolume: 2, soundVolume: -1 });

    expect(audio.getAudioSettings()).toEqual({
      ambience: true,
      ambienceVolume: 1,
      soundEffects: true,
      soundVolume: 0
    });
    expect(JSON.parse(window.localStorage.getItem(settingsKey) || '{}')).toEqual(audio.getAudioSettings());
    expect(subscriber).toHaveBeenCalledOnce();

    unsubscribe();
    audio.setAudioSettings({ soundEffects: false });
    expect(subscriber).toHaveBeenCalledOnce();
  });

  it('reports unavailable audio and supports status unsubscription', async () => {
    vi.stubGlobal('Audio', undefined);
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
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
