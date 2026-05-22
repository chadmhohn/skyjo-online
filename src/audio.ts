import { useEffect, useRef, useState } from 'react';
import type { GameState } from './types';

export type AudioCue = 'flip' | 'pickup' | 'place';

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

let audioSettings = readStoredAudioSettings();
let audioContext: AudioContext | null = null;
let musicGain: GainNode | null = null;
let musicTimer: number | null = null;
let musicStep = 0;

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

function getAudioContext() {
  if (!isBrowser()) return null;
  if (audioContext) return audioContext;

  const AudioContextConstructor =
    window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return null;

  audioContext = new AudioContextConstructor();
  return audioContext;
}

async function ensureAudioContext() {
  const context = getAudioContext();
  if (!context) return null;

  if (context.state === 'suspended') {
    try {
      await context.resume();
    } catch {
      return null;
    }
  }

  return context;
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

export async function playAudioCue(cue: AudioCue) {
  if (!audioSettings.soundEffects || audioSettings.soundVolume <= 0) return;
  const context = await ensureAudioContext();
  if (!context) return;

  const gain = clamp(audioSettings.soundVolume, 0, 1);

  if (cue === 'flip') {
    playNoise(context, 0.08 * gain, 0.08, 2300);
    playTone(context, { duration: 0.09, endFrequency: 340, frequency: 620, gain: 0.045 * gain, type: 'triangle' });
    return;
  }

  if (cue === 'pickup') {
    playTone(context, { duration: 0.055, endFrequency: 760, frequency: 1120, gain: 0.036 * gain, type: 'square' });
    window.setTimeout(() => {
      const currentContext = getAudioContext();
      if (currentContext) {
        playTone(currentContext, { duration: 0.05, endFrequency: 520, frequency: 860, gain: 0.025 * gain, type: 'triangle' });
      }
    }, 44);
    return;
  }

  playTone(context, { duration: 0.11, endFrequency: 86, frequency: 170, gain: 0.07 * gain, type: 'sine' });
  playNoise(context, 0.035 * gain, 0.06, 900);
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
  gainNode.gain.exponentialRampToValueAtTime(0.18, start + 0.04);
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
  musicGain.gain.setValueAtTime(audioSettings.musicVolume * 0.16, context.currentTime);
  musicGain.connect(context.destination);
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
    return;
  }

  if (musicGain && audioContext) {
    musicGain.gain.setValueAtTime(audioSettings.musicVolume * 0.16, audioContext.currentTime);
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

export function useAudioSettings() {
  const [settings, setSettings] = useState(getAudioSettings);

  useEffect(() => subscribeAudioSettings(setSettings), []);

  useEffect(() => {
    if (!isBrowser()) return undefined;
    const unlockAudio = () => {
      void ensureAudioContext().then(() => syncMusic());
    };

    syncMusic();
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio);

    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, []);

  return [settings, setAudioSettings] as const;
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
