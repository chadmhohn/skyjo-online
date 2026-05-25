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
  stopAfterMs?: number;
  volumeScale: number;
};

const audioSettingsKey = 'skyjo-audio-settings-v2';
const legacyAudioSettingsKey = 'skyjo-audio-settings-v1';
const cueAssets: Record<AudioCue, CueAsset> = {
  flip: { src: '/audio/card-flip.mp3', stopAfterMs: 520, volumeScale: 0.28 },
  pickup: { src: '/audio/card-pickup.mp3', stopAfterMs: 430, volumeScale: 0.22 },
  place: { src: '/audio/card-place.mp3', stopAfterMs: 360, volumeScale: 0.16 }
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
const cueAudioTemplates = new Map<AudioCue, HTMLAudioElement>();
const activeCueAudio = new Set<HTMLAudioElement>();

let audioSettings = readStoredAudioSettings();
let audioStatus: AudioStatus = 'idle';
let ambienceAudio: HTMLAudioElement | null = null;
let audioAssetsPreloaded = false;

function isBrowser() {
  return typeof window !== 'undefined';
}

function hasAudioElement() {
  return isBrowser() && typeof Audio !== 'undefined';
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

function cueTemplate(cue: AudioCue) {
  const existing = cueAudioTemplates.get(cue);
  if (existing) return existing;
  const template = makeAudioElement(cueAssets[cue].src);
  if (!template) return null;
  cueAudioTemplates.set(cue, template);
  return template;
}

function preloadAudioAssets() {
  if (audioAssetsPreloaded) return;
  if (!hasAudioElement()) {
    setAudioStatus('unavailable');
    return;
  }
  audioAssetsPreloaded = true;
  (Object.keys(cueAssets) as AudioCue[]).forEach((cue) => {
    cueTemplate(cue)?.load();
  });
  ensureAmbienceAudio()?.load();
}

function cleanupCueAudio(audio: HTMLAudioElement) {
  audio.pause();
  try {
    audio.currentTime = 0;
  } catch {
    // Some mobile browsers reject currentTime changes before metadata is ready.
  }
  activeCueAudio.delete(audio);
}

async function playAsset(src: string, volume: number, stopAfterMs?: number) {
  const audio = makeAudioElement(src);
  if (!audio) return;
  audio.volume = clamp(volume, 0, 1);
  activeCueAudio.add(audio);
  audio.addEventListener('ended', () => activeCueAudio.delete(audio), { once: true });
  if (stopAfterMs) window.setTimeout(() => cleanupCueAudio(audio), stopAfterMs);

  try {
    await audio.play();
    setAudioStatus('ready');
  } catch {
    cleanupCueAudio(audio);
    setAudioStatus('blocked');
  }
}

export async function playAudioCue(cue: AudioCue) {
  if (!audioSettings.soundEffects || audioSettings.soundVolume <= 0) return;
  const asset = cueAssets[cue];
  const template = cueTemplate(cue);
  await playAsset(template?.src || asset.src, audioSettings.soundVolume * asset.volumeScale, asset.stopAfterMs);
}

export function playAudioTestCue() {
  void primeAudio();
  void playAudioCue('flip');
  window.setTimeout(() => void playAudioCue('pickup'), 170);
  window.setTimeout(() => void playAudioCue('place'), 360);
}

export async function primeAudio() {
  preloadAudioAssets();
  if (!hasAudioElement()) return false;
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
  try {
    await audio.play();
    setAudioStatus('ready');
  } catch {
    setAudioStatus('blocked');
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

function syncAmbience() {
  if (!audioSettings.ambience || audioSettings.ambienceVolume <= 0) {
    stopAmbience();
    return;
  }

  if (ambienceAudio) ambienceAudio.volume = clamp(audioSettings.ambienceVolume * 0.55, 0, 1);
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
  syncAmbience();
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
      syncAmbience();
    };

    preloadAudioAssets();
    syncAmbience();
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio);

    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
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
