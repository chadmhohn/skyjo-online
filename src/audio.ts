import { useEffect, useRef, useState } from 'react';
import type { GameState } from './types';

export type AudioCue = 'flip' | 'pickup' | 'place';
export type AudioStatus = 'idle' | 'ready' | 'blocked' | 'unavailable';

export interface AudioSettings {
  ambience: boolean;
  ambienceVolume: number;
  soundEffects: boolean;
  soundVolume: number;
}

type CueAsset = {
  src: string;
  minGapMs: number;
  stopAfterMs?: number;
  volumeScale: number;
};

const audioSettingsKey = 'skyjo-audio-settings-v2';
const legacyAudioSettingsKey = 'skyjo-audio-settings-v1';
const cueAssets: Record<AudioCue, CueAsset> = {
  flip: { src: '/audio/card-flip.mp3', minGapMs: 180, stopAfterMs: 520, volumeScale: 0.24 },
  pickup: { src: '/audio/card-pickup.mp3', minGapMs: 450, stopAfterMs: 380, volumeScale: 0.18 },
  place: { src: '/audio/card-place.mp3', minGapMs: 260, stopAfterMs: 340, volumeScale: 0.14 }
};
const ambienceSrc = '/audio/table-ambience.mp3';
const defaultAudioSettings: AudioSettings = {
  ambience: false,
  ambienceVolume: 0.34,
  soundEffects: true,
  soundVolume: 0.72
};
const subscribers = new Set<(settings: AudioSettings) => void>();
const statusSubscribers = new Set<(status: AudioStatus) => void>();
const cueAudioElements = new Map<AudioCue, HTMLAudioElement>();
const cueAudioBuffers = new Map<AudioCue, AudioBuffer>();
const cueAudioBufferPromises = new Map<AudioCue, Promise<AudioBuffer | null>>();
const lastCuePlayedAt = new Map<AudioCue, number>();
const cuePlayTokens = new Map<AudioCue, number>();

let audioSettings = readStoredAudioSettings();
let audioStatus: AudioStatus = 'idle';
let audioContext: AudioContext | null = null;
let ambienceAudio: HTMLAudioElement | null = null;
let audioAssetsPreloaded = false;
let audioBlockedUntil = 0;
let ambienceStartInFlight: Promise<void> | null = null;
let lastAudioResumeResetAt = 0;

function isBrowser() {
  return typeof window !== 'undefined';
}

function hasAudioElement() {
  return isBrowser() && typeof Audio !== 'undefined';
}

function audioContextConstructor() {
  if (!isBrowser()) return null;
  return window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext || null;
}

function hasWebAudio() {
  return Boolean(audioContextConstructor());
}

function getAudioContext() {
  const AudioContextConstructor = audioContextConstructor();
  if (!AudioContextConstructor) return null;
  if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContextConstructor();
  return audioContext;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeSettings(parsed: Partial<AudioSettings>): AudioSettings {
  return {
    ambience: Boolean(parsed.ambience ?? defaultAudioSettings.ambience),
    ambienceVolume: clamp(Number(parsed.ambienceVolume ?? defaultAudioSettings.ambienceVolume), 0, 1),
    soundEffects: Boolean(parsed.soundEffects ?? defaultAudioSettings.soundEffects),
    soundVolume: clamp(Number(parsed.soundVolume ?? defaultAudioSettings.soundVolume), 0, 1)
  };
}

function readStoredAudioSettings(): AudioSettings {
  if (!isBrowser()) return defaultAudioSettings;

  try {
    const stored = window.localStorage.getItem(audioSettingsKey);
    if (stored) return normalizeSettings(JSON.parse(stored) as Partial<AudioSettings>);

    const legacyStored = window.localStorage.getItem(legacyAudioSettingsKey);
    if (!legacyStored) return defaultAudioSettings;
    const legacyParsed = JSON.parse(legacyStored) as Partial<AudioSettings>;
    return normalizeSettings({
      soundEffects: legacyParsed.soundEffects,
      soundVolume: legacyParsed.soundVolume
    });
  } catch {
    return defaultAudioSettings;
  }
}

function writeStoredAudioSettings(settings: AudioSettings) {
  if (!isBrowser()) return;
  window.localStorage.setItem(audioSettingsKey, JSON.stringify(settings));
}

function notifySubscribers() {
  subscribers.forEach((subscriber) => subscriber(audioSettings));
}

function notifyStatusSubscribers() {
  statusSubscribers.forEach((subscriber) => subscriber(audioStatus));
}

function setAudioStatus(status: AudioStatus) {
  if (audioStatus === status) return;
  audioStatus = status;
  notifyStatusSubscribers();
}

function makeAudioElement(src: string) {
  if (!hasAudioElement()) {
    setAudioStatus('unavailable');
    return null;
  }
  const audio = new Audio(src);
  audio.preload = 'auto';
  return audio;
}

function cueElement(cue: AudioCue) {
  const existing = cueAudioElements.get(cue);
  if (existing) return existing;
  const audio = makeAudioElement(cueAssets[cue].src);
  if (!audio) return null;
  cueAudioElements.set(cue, audio);
  return audio;
}

function preloadAudioAssets() {
  if (audioAssetsPreloaded) return;
  if (!hasWebAudio() && !hasAudioElement()) {
    setAudioStatus('unavailable');
    return;
  }
  audioAssetsPreloaded = true;
  if (hasWebAudio()) {
    (Object.keys(cueAssets) as AudioCue[]).forEach((cue) => {
      void cueBuffer(cue);
    });
  } else {
    (Object.keys(cueAssets) as AudioCue[]).forEach((cue) => {
      cueElement(cue)?.load();
    });
  }
  ensureAmbienceAudio()?.load();
}

async function cueBuffer(cue: AudioCue) {
  const existing = cueAudioBuffers.get(cue);
  if (existing) return existing;
  const existingPromise = cueAudioBufferPromises.get(cue);
  if (existingPromise) return existingPromise;

  const context = getAudioContext();
  if (!context) return null;
  const promise = fetch(cueAssets[cue].src)
    .then((response) => {
      if (!response.ok) throw new Error(`Could not load audio cue ${cue}`);
      return response.arrayBuffer();
    })
    .then((data) => context.decodeAudioData(data.slice(0)))
    .then((buffer) => {
      cueAudioBuffers.set(cue, buffer);
      return buffer;
    })
    .catch(() => null)
    .finally(() => {
      cueAudioBufferPromises.delete(cue);
    });
  cueAudioBufferPromises.set(cue, promise);
  return promise;
}

function resetAudioAfterResume() {
  if (document.visibilityState === 'hidden') {
    stopAmbience();
    if (audioContext?.state === 'running') void audioContext.suspend().catch(() => undefined);
    audioBlockedUntil = 0;
    lastCuePlayedAt.clear();
    return;
  }
  const now = Date.now();
  if (now - lastAudioResumeResetAt < 500) return;
  lastAudioResumeResetAt = now;

  audioBlockedUntil = 0;
  lastCuePlayedAt.clear();
  cuePlayTokens.clear();
  cueAudioElements.forEach((audio) => cleanupCueAudio(audio));
  cueAudioElements.clear();
  if (ambienceAudio) {
    ambienceAudio.pause();
    ambienceAudio = null;
  }
  ambienceStartInFlight = null;
  audioAssetsPreloaded = false;
  setAudioStatus('idle');
  preloadAudioAssets();
}

function cleanupCueAudio(audio: HTMLAudioElement) {
  audio.pause();
  try {
    audio.currentTime = 0;
  } catch {
    // Some mobile browsers reject currentTime changes before metadata is ready.
  }
}

function playCueAsset(cue: AudioCue) {
  if (hasWebAudio()) {
    void playCueBuffer(cue);
    return;
  }
  if (Date.now() < audioBlockedUntil) return;
  const asset = cueAssets[cue];
  const previousPlayedAt = lastCuePlayedAt.get(cue) ?? 0;
  if (Date.now() - previousPlayedAt < asset.minGapMs) return;

  const audio = cueElement(cue);
  if (!audio) return;
  lastCuePlayedAt.set(cue, Date.now());
  const playToken = (cuePlayTokens.get(cue) ?? 0) + 1;
  cuePlayTokens.set(cue, playToken);
  audio.volume = clamp(audioSettings.soundVolume * asset.volumeScale, 0, 1);
  audio.muted = false;
  try {
    audio.pause();
    audio.currentTime = 0;
  } catch {
    // Current time can be locked until metadata loads on iOS.
  }
  if (asset.stopAfterMs) {
    window.setTimeout(() => {
      if (cuePlayTokens.get(cue) === playToken) cleanupCueAudio(audio);
    }, asset.stopAfterMs);
  }

  const playResult = audio.play();
  if (!playResult) {
    setAudioStatus('ready');
    return;
  }
  playResult
    .then(() => {
      audioBlockedUntil = 0;
      setAudioStatus('ready');
    })
    .catch(() => {
      audioBlockedUntil = Date.now() + 750;
      lastCuePlayedAt.set(cue, 0);
      cleanupCueAudio(audio);
      setAudioStatus('blocked');
    });
}

async function playCueBuffer(cue: AudioCue) {
  if (Date.now() < audioBlockedUntil) return;
  const asset = cueAssets[cue];
  const previousPlayedAt = lastCuePlayedAt.get(cue) ?? 0;
  if (Date.now() - previousPlayedAt < asset.minGapMs) return;

  const context = getAudioContext();
  if (!context) {
    playCueAsset(cue);
    return;
  }

  try {
    if (context.state === 'suspended') await context.resume();
    if (context.state !== 'running') throw new Error('Audio context is not running.');
    const buffer = await cueBuffer(cue);
    if (!buffer) throw new Error('Audio cue buffer is unavailable.');
    lastCuePlayedAt.set(cue, Date.now());
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = clamp(audioSettings.soundVolume * asset.volumeScale, 0, 1);
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
    if (asset.stopAfterMs) {
      window.setTimeout(() => {
        try {
          source.stop();
        } catch {
          // Buffer sources throw if they already ended.
        }
      }, asset.stopAfterMs);
    }
    audioBlockedUntil = 0;
    setAudioStatus('ready');
  } catch {
    audioBlockedUntil = Date.now() + 750;
    lastCuePlayedAt.set(cue, 0);
    setAudioStatus('blocked');
  }
}

export function playAudioCue(cue: AudioCue) {
  if (!audioSettings.soundEffects || audioSettings.soundVolume <= 0) return;
  playCueAsset(cue);
}

export function playAudioTestCue() {
  void primeAudio();
  void playAudioCue('flip');
  window.setTimeout(() => void playAudioCue('pickup'), 170);
  window.setTimeout(() => void playAudioCue('place'), 360);
}

export async function primeAudio() {
  preloadAudioAssets();
  if (!hasWebAudio() && !hasAudioElement()) return false;
  audioBlockedUntil = 0;
  const context = getAudioContext();
  if (context?.state === 'suspended') {
    try {
      await context.resume();
      setAudioStatus('ready');
    } catch {
      setAudioStatus('blocked');
    }
  }
  if (!audioSettings.ambience) return true;
  await startAmbience();
  return audioStatus === 'ready';
}

function ensureAmbienceAudio() {
  if (ambienceAudio) return ambienceAudio;
  const audio = makeAudioElement(ambienceSrc);
  if (!audio) return null;
  audio.loop = true;
  ambienceAudio = audio;
  return ambienceAudio;
}

async function startAmbience() {
  if (!audioSettings.ambience || audioSettings.ambienceVolume <= 0) return;
  const audio = ensureAmbienceAudio();
  if (!audio) return;
  audio.volume = clamp(audioSettings.ambienceVolume * 0.55, 0, 1);
  if (!audio.paused) return;
  if (ambienceStartInFlight) return ambienceStartInFlight;
  try {
    ambienceStartInFlight = audio.play().then(() => {
      audioBlockedUntil = 0;
      setAudioStatus('ready');
    });
    await ambienceStartInFlight;
  } catch {
    audioBlockedUntil = Date.now() + 5000;
    setAudioStatus('blocked');
  } finally {
    ambienceStartInFlight = null;
  }
}

function stopAmbience() {
  if (!ambienceAudio) return;
  ambienceAudio.pause();
  try {
    ambienceAudio.currentTime = 0;
  } catch {
    // Safe to ignore on browsers that only allow seeking after metadata loads.
  }
}

function syncAmbience(allowStart = false) {
  if (!audioSettings.ambience || audioSettings.ambienceVolume <= 0) {
    stopAmbience();
    return;
  }

  if (ambienceAudio) ambienceAudio.volume = clamp(audioSettings.ambienceVolume * 0.55, 0, 1);
  if (!allowStart) return;
  void startAmbience();
}

export function getAudioSettings() {
  return audioSettings;
}

export function setAudioSettings(nextSettings: Partial<AudioSettings>) {
  audioSettings = {
    ...audioSettings,
    ...nextSettings,
    ambienceVolume: clamp(Number(nextSettings.ambienceVolume ?? audioSettings.ambienceVolume), 0, 1),
    soundVolume: clamp(Number(nextSettings.soundVolume ?? audioSettings.soundVolume), 0, 1)
  };
  writeStoredAudioSettings(audioSettings);
  notifySubscribers();
  syncAmbience(nextSettings.ambience !== undefined || nextSettings.ambienceVolume !== undefined);
}

export function subscribeAudioSettings(subscriber: (settings: AudioSettings) => void) {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function getAudioStatus() {
  return audioStatus;
}

export function subscribeAudioStatus(subscriber: (status: AudioStatus) => void) {
  statusSubscribers.add(subscriber);
  return () => {
    statusSubscribers.delete(subscriber);
  };
}

export function useAudioSettings() {
  const [settings, setSettings] = useState(getAudioSettings);
  const [status, setStatus] = useState(getAudioStatus);

  useEffect(() => subscribeAudioSettings(setSettings), []);
  useEffect(() => subscribeAudioStatus(setStatus), []);

  useEffect(() => {
    if (!isBrowser()) return undefined;
    const unlockAudio = () => {
      void primeAudio();
      syncAmbience(true);
    };

    preloadAudioAssets();
    syncAmbience(false);
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('touchstart', unlockAudio, { passive: true });
    window.addEventListener('click', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio);
    window.addEventListener('focus', resetAudioAfterResume);
    window.addEventListener('pageshow', resetAudioAfterResume);
    document.addEventListener('visibilitychange', resetAudioAfterResume);

    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
      window.removeEventListener('click', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
      window.removeEventListener('focus', resetAudioAfterResume);
      window.removeEventListener('pageshow', resetAudioAfterResume);
      document.removeEventListener('visibilitychange', resetAudioAfterResume);
    };
  }, []);

  return [settings, setAudioSettings, status] as const;
}

function playCueForLog(message: string) {
  if (message.includes('drew a')) {
    void playAudioCue('pickup');
    return;
  }

  if (message.includes('discarded') && message.includes('revealed a card')) {
    void playAudioCue('place');
    window.setTimeout(() => void playAudioCue('flip'), 120);
    return;
  }

  if (message.includes('replaced a card')) {
    void playAudioCue('place');
    return;
  }

  if (message.includes('revealed an opening card') || message.includes('finished opening reveals')) {
    void playAudioCue('flip');
  }
}

export function useGameAudio(state: GameState | null | undefined) {
  const previousLogRef = useRef<string | null>(null);

  useEffect(() => {
    const latestLog = state?.log[0] || '';
    if (!latestLog) return;

    if (previousLogRef.current === null) {
      previousLogRef.current = latestLog;
      return;
    }

    if (previousLogRef.current === latestLog) return;
    previousLogRef.current = latestLog;
    playCueForLog(latestLog);
  }, [state?.log]);
}
