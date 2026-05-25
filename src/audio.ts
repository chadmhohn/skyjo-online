import { useEffect, useRef, useState } from 'react';
import type { GameState } from './types';

export type AudioCue = 'flip' | 'pickup' | 'place';
export type AudioStatus = 'idle' | 'ready' | 'blocked' | 'unavailable';

export interface AudioSettings {
  music: boolean;
  musicVolume: number;
  soundEffects: boolean;
  soundVolume: number;
}

const audioSettingsKey = 'skyjo-audio-settings-v1';
const defaultAudioSettings: AudioSettings = {
  music: false,
  musicVolume: 0.32,
  soundEffects: true,
  soundVolume: 0.72
};
const subscribers = new Set<(settings: AudioSettings) => void>();
const statusSubscribers = new Set<(status: AudioStatus) => void>();

let audioSettings = readStoredAudioSettings();
let audioContext: AudioContext | null = null;
let musicGain: GainNode | null = null;
let musicTimer: number | null = null;
let musicStep = 0;
let audioStatus: AudioStatus = 'idle';
let silentUnlockPlayed = false;
let fallbackMusicAudio: HTMLAudioElement | null = null;
let fallbackMusicUrl = '';
const fallbackCueUrls = new Map<AudioCue, string>();

function isBrowser() {
  return typeof window !== 'undefined';
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readStoredAudioSettings(): AudioSettings {
  if (!isBrowser()) return defaultAudioSettings;

  try {
    const stored = window.localStorage.getItem(audioSettingsKey);
    if (!stored) return defaultAudioSettings;
    const parsed = JSON.parse(stored) as Partial<AudioSettings>;
    return {
      music: Boolean(parsed.music ?? defaultAudioSettings.music),
      musicVolume: clamp(Number(parsed.musicVolume ?? defaultAudioSettings.musicVolume), 0, 1),
      soundEffects: Boolean(parsed.soundEffects ?? defaultAudioSettings.soundEffects),
      soundVolume: clamp(Number(parsed.soundVolume ?? defaultAudioSettings.soundVolume), 0, 1)
    };
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

function getAudioContext() {
  if (!isBrowser()) return null;
  if (audioContext) return audioContext;

  const AudioContextConstructor =
    window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) {
    setAudioStatus('unavailable');
    return null;
  }

  try {
    audioContext = new AudioContextConstructor();
    return audioContext;
  } catch {
    setAudioStatus('blocked');
    return null;
  }
}

async function ensureAudioContext() {
  const context = getAudioContext();
  if (!context) return null;

  if (context.state === 'suspended') {
    try {
      await context.resume();
    } catch {
      setAudioStatus('blocked');
      return null;
    }
  }

  if (context.state === 'closed') {
    setAudioStatus('blocked');
    return null;
  }

  if (context.state === 'running') setAudioStatus('ready');
  else setAudioStatus('blocked');

  return context;
}

function playSilentUnlock(context: AudioContext) {
  if (silentUnlockPlayed) return;
  silentUnlockPlayed = true;
  try {
    const buffer = context.createBuffer(1, 1, Math.max(1, context.sampleRate));
    const source = context.createBufferSource();
    const gainNode = context.createGain();
    gainNode.gain.setValueAtTime(0.0001, context.currentTime);
    source.buffer = buffer;
    source.connect(gainNode);
    gainNode.connect(context.destination);
    source.start(0);
  } catch {
    silentUnlockPlayed = false;
  }
}

function envelope(gain: GainNode, start: number, peak: number, end: number, duration: number) {
  gain.gain.cancelScheduledValues(start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  gain.gain.setValueAtTime(0.0001, start + duration + end);
}

function playTone(
  context: AudioContext,
  {
    duration,
    endFrequency,
    frequency,
    gain,
    type
  }: {
    duration: number;
    endFrequency?: number;
    frequency: number;
    gain: number;
    type: OscillatorType;
  }
) {
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const start = context.currentTime;

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
  envelope(gainNode, start, gain, 0.02, duration);
  oscillator.connect(gainNode);
  gainNode.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}

function playNoise(context: AudioContext, gain: number, duration: number, cutoff: number) {
  const sampleCount = Math.max(1, Math.floor(context.sampleRate * duration));
  const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
  const data = buffer.getChannelData(0);

  for (let index = 0; index < sampleCount; index += 1) {
    data[index] = (Math.random() * 2 - 1) * (1 - index / sampleCount);
  }

  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gainNode = context.createGain();
  const start = context.currentTime;

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(cutoff, start);
  envelope(gainNode, start, gain, 0.02, duration);
  source.buffer = buffer;
  source.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(context.destination);
  source.start(start);
}

function isIosLike() {
  if (!isBrowser()) return false;
  return /iPad|iPhone|iPod/.test(window.navigator.userAgent) || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
}

function writeAscii(data: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) data[offset + index] = value.charCodeAt(index);
}

function buildToneUrl({
  duration,
  frequencies,
  volume = 0.42
}: {
  duration: number;
  frequencies: number[];
  volume?: number;
}) {
  const sampleRate = 22050;
  const sampleCount = Math.max(1, Math.floor(sampleRate * duration));
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, sampleCount * 2, true);

  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const progress = index / sampleCount;
    const frequency = frequencies[Math.min(frequencies.length - 1, Math.floor(progress * frequencies.length))];
    const fadeIn = Math.min(1, progress / 0.05);
    const fadeOut = Math.min(1, (1 - progress) / 0.08);
    const envelopeValue = Math.max(0, Math.min(fadeIn, fadeOut));
    const sample = Math.sin(Math.PI * 2 * frequency * time) * volume * envelopeValue;
    view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
  }

  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

function fallbackCueUrl(cue: AudioCue) {
  const cached = fallbackCueUrls.get(cue);
  if (cached) return cached;
  const url =
    cue === 'flip'
      ? buildToneUrl({ duration: 0.24, frequencies: [740, 520], volume: 0.55 })
      : cue === 'pickup'
        ? buildToneUrl({ duration: 0.22, frequencies: [880, 660], volume: 0.5 })
        : buildToneUrl({ duration: 0.28, frequencies: [220, 150], volume: 0.52 });
  fallbackCueUrls.set(cue, url);
  return url;
}

async function playFallbackCue(cue: AudioCue) {
  if (!isBrowser() || !audioSettings.soundEffects || audioSettings.soundVolume <= 0) return;
  try {
    const audio = new Audio(fallbackCueUrl(cue));
    audio.volume = clamp(audioSettings.soundVolume, 0, 1);
    await audio.play();
    setAudioStatus('ready');
  } catch {
    setAudioStatus('blocked');
  }
}

function fallbackMusicToneUrl() {
  if (fallbackMusicUrl) return fallbackMusicUrl;
  fallbackMusicUrl = buildToneUrl({
    duration: 4.16,
    frequencies: [196, 246.94, 293.66, 369.99, 329.63, 293.66, 246.94, 220],
    volume: 0.24
  });
  return fallbackMusicUrl;
}

async function startFallbackMusic() {
  if (!isBrowser() || !audioSettings.music || audioSettings.musicVolume <= 0) return;
  if (!fallbackMusicAudio) {
    fallbackMusicAudio = new Audio(fallbackMusicToneUrl());
    fallbackMusicAudio.loop = true;
  }
  fallbackMusicAudio.volume = clamp(audioSettings.musicVolume * 0.7, 0, 1);
  try {
    await fallbackMusicAudio.play();
    setAudioStatus('ready');
  } catch {
    setAudioStatus('blocked');
  }
}

function stopFallbackMusic() {
  if (!fallbackMusicAudio) return;
  fallbackMusicAudio.pause();
  fallbackMusicAudio.currentTime = 0;
}

export async function playAudioCue(cue: AudioCue) {
  if (!audioSettings.soundEffects || audioSettings.soundVolume <= 0) return;
  if (isIosLike()) {
    await playFallbackCue(cue);
    return;
  }

  const context = await ensureAudioContext();
  if (!context) {
    await playFallbackCue(cue);
    return;
  }
  playSilentUnlock(context);

  const gain = clamp(audioSettings.soundVolume, 0, 1);

  if (cue === 'flip') {
    playNoise(context, 0.16 * gain, 0.1, 2300);
    playTone(context, { duration: 0.12, endFrequency: 340, frequency: 620, gain: 0.09 * gain, type: 'triangle' });
    return;
  }

  if (cue === 'pickup') {
    playTone(context, { duration: 0.07, endFrequency: 760, frequency: 1120, gain: 0.075 * gain, type: 'square' });
    window.setTimeout(() => {
      const currentContext = getAudioContext();
      if (currentContext) {
        playTone(currentContext, { duration: 0.06, endFrequency: 520, frequency: 860, gain: 0.055 * gain, type: 'triangle' });
      }
    }, 44);
    return;
  }

  playTone(context, { duration: 0.13, endFrequency: 86, frequency: 170, gain: 0.14 * gain, type: 'sine' });
  playNoise(context, 0.07 * gain, 0.07, 900);
}

export function playAudioTestCue() {
  void primeAudio();
  void playAudioCue('flip');
  window.setTimeout(() => void playAudioCue('pickup'), 150);
  window.setTimeout(() => void playAudioCue('place'), 320);
}

export async function primeAudio() {
  if (isIosLike()) {
    setAudioStatus('idle');
    return true;
  }
  const context = await ensureAudioContext();
  if (!context) return false;
  playSilentUnlock(context);
  return context.state === 'running';
}

function scheduleMusicNote(context: AudioContext) {
  if (!musicGain) return;
  const notes = [196, 246.94, 293.66, 369.99, 329.63, 293.66, 246.94, 220];
  const frequency = notes[musicStep % notes.length];
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const start = context.currentTime;

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.connect(gainNode);
  gainNode.connect(musicGain);
  gainNode.gain.setValueAtTime(0.0001, start);
  gainNode.gain.exponentialRampToValueAtTime(0.28, start + 0.04);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, start + 0.46);
  oscillator.start(start);
  oscillator.stop(start + 0.5);
  musicStep += 1;
}

async function startMusic() {
  if (musicTimer !== null || !audioSettings.music || audioSettings.musicVolume <= 0) return;
  const context = await ensureAudioContext();
  if (!context || musicTimer !== null) return;

  musicGain = context.createGain();
  musicGain.gain.setValueAtTime(audioSettings.musicVolume * 0.24, context.currentTime);
  musicGain.connect(context.destination);
  playSilentUnlock(context);
  scheduleMusicNote(context);
  musicTimer = window.setInterval(() => scheduleMusicNote(context), 520);
}

function stopMusic() {
  if (musicTimer !== null) {
    window.clearInterval(musicTimer);
    musicTimer = null;
  }
  if (!musicGain || !audioContext) return;

  const gainNode = musicGain;
  const start = audioContext.currentTime;
  gainNode.gain.cancelScheduledValues(start);
  gainNode.gain.setValueAtTime(gainNode.gain.value, start);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
  window.setTimeout(() => {
    gainNode.disconnect();
  }, 160);
  musicGain = null;
}

function syncMusic() {
  if (!audioSettings.music || audioSettings.musicVolume <= 0) {
    stopMusic();
    stopFallbackMusic();
    return;
  }

  if (isIosLike()) {
    stopMusic();
    void startFallbackMusic();
    return;
  }

  stopFallbackMusic();
  if (musicGain && audioContext) {
    musicGain.gain.setValueAtTime(audioSettings.musicVolume * 0.24, audioContext.currentTime);
  }
  void startMusic();
}

export function getAudioSettings() {
  return audioSettings;
}

export function setAudioSettings(nextSettings: Partial<AudioSettings>) {
  audioSettings = {
    ...audioSettings,
    ...nextSettings,
    musicVolume: clamp(Number(nextSettings.musicVolume ?? audioSettings.musicVolume), 0, 1),
    soundVolume: clamp(Number(nextSettings.soundVolume ?? audioSettings.soundVolume), 0, 1)
  };
  writeStoredAudioSettings(audioSettings);
  notifySubscribers();
  syncMusic();
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
      syncMusic();
    };

    syncMusic();
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
