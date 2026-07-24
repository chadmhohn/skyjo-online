import { useEffect, useRef, useState } from 'react';
import {
  deriveGameAudioEvents,
  type GameAudioContext,
  type GameAudioEvent,
  type GameAudioFrame,
  type SemanticAudioCue
} from './audioEvents';
import type { GameState } from './types';

export type AudioCue = SemanticAudioCue;
export type AudioStatus = 'idle' | 'ready' | 'blocked' | 'unavailable';
export type { GameAudioContext, GameAudioDelivery, GameAudioEvent, GameAudioFrame } from './audioEvents';

export interface AudioSettings {
  soundEffects: boolean;
  soundVolume: number;
}

type PlaybackEngine = typeof import('./audioPlaybackEngine');
type LegacyAudioSettingsUpdate = Partial<AudioSettings> & {
  ambience?: unknown;
  ambienceVolume?: unknown;
};

const audioSettingsKeys = [
  'skyjo-audio-settings-v3',
  'skyjo-audio-settings-v2',
  'skyjo-audio-settings-v1'
] as const;
const retainedSemanticEventIds = 256;
const defaultAudioSettings: AudioSettings = {
  soundEffects: true,
  soundVolume: 0.72
};

const settingsSubscribers = new Set<(settings: AudioSettings) => void>();
const statusSubscribers = new Set<(status: AudioStatus) => void>();
const playedSemanticEventIds = new Set<string>();

let audioSettings = readStoredAudioSettings();
let audioStatus: AudioStatus = 'idle';
let audioContext: AudioContext | null = null;
let audioPrimeInFlight: Promise<boolean> | null = null;
let playbackEngine: PlaybackEngine | null = null;
let playbackEnginePromise: Promise<PlaybackEngine> | null = null;
let playbackGeneration = 0;
let localRevisionSeed = 0;
let lastAudioResumeResetAt = 0;
let lifecycleConsumers = 0;

function isBrowser() {
  return typeof window !== 'undefined';
}

function hasAudioElement() {
  return isBrowser() && typeof Audio !== 'undefined';
}

/**
 * This function is deliberately synchronous. Calling it directly from the
 * trusted activation handler preserves Safari's user-activation token before
 * the lazy playback chunk crosses its first async boundary.
 */
function getAudioContextSynchronously() {
  const AudioContextConstructor = isBrowser()
    ? window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : null;
  if (!AudioContextConstructor) return null;
  try {
    if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContextConstructor();
    return audioContext;
  } catch {
    return null;
  }
}

/**
 * Invokes resume synchronously and only awaits the already-started operation.
 */
function resumeAudioContextSynchronously(context: AudioContext | null) {
  if (!context || context.state !== 'suspended') return Promise.resolve(true);
  try {
    return Promise.resolve(context.resume()).then(
      () => true,
      () => false
    );
  } catch {
    return Promise.resolve(false);
  }
}

function normalizeSettings(parsed: Partial<AudioSettings>): AudioSettings {
  const parsedVolume = Number(parsed.soundVolume ?? defaultAudioSettings.soundVolume);
  return {
    soundEffects: Boolean(parsed.soundEffects ?? defaultAudioSettings.soundEffects),
    soundVolume: Number.isFinite(parsedVolume)
      ? Math.min(1, Math.max(0, parsedVolume))
      : defaultAudioSettings.soundVolume
  };
}

function readStoredAudioSettings(): AudioSettings {
  if (!isBrowser()) return defaultAudioSettings;

  try {
    for (const key of audioSettingsKeys) {
      const stored = window.localStorage.getItem(key);
      if (stored) return normalizeSettings(JSON.parse(stored) as Partial<AudioSettings>);
    }
  } catch {
    return defaultAudioSettings;
  }
  return defaultAudioSettings;
}

function writeStoredAudioSettings(settings: AudioSettings) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(audioSettingsKeys[0], JSON.stringify(settings));
  } catch {
    // Audio remains usable when private browsing or storage policy blocks writes.
  }
}

function setAudioStatus(status: AudioStatus) {
  if (audioStatus === status) return;
  audioStatus = status;
  statusSubscribers.forEach((subscriber) => subscriber(status));
}

function isPageVisible() {
  return document.visibilityState !== 'hidden';
}

function effectsEnabled() {
  return audioSettings.soundEffects && audioSettings.soundVolume > 0;
}

function configurePlaybackEngine(engine: PlaybackEngine) {
  engine.configureAudioPlaybackEngine({
    getSettings: () => audioSettings,
    isPageVisible,
    setStatus: setAudioStatus
  });
  engine.setAudioPlaybackContext(audioContext);
  return engine;
}

function loadPlaybackEngine() {
  if (playbackEngine) return Promise.resolve(playbackEngine);
  if (playbackEnginePromise) return playbackEnginePromise;
  playbackEnginePromise = import('./audioPlaybackEngine')
    .then((engine) => {
      playbackEngine = configurePlaybackEngine(engine);
      return playbackEngine;
    });
  return playbackEnginePromise;
}

function activatePlayback() {
  if (!effectsEnabled() || !isPageVisible()) return Promise.resolve(null);
  const context = getAudioContextSynchronously();
  const resume = resumeAudioContextSynchronously(context);
  if (!context && !hasAudioElement()) {
    setAudioStatus('unavailable');
    return Promise.resolve(null);
  }
  const generation = playbackGeneration;
  return Promise.all([resume, loadPlaybackEngine()])
    .then(([resumed, engine]) => {
      if (generation !== playbackGeneration || !effectsEnabled() || !isPageVisible()) return null;
      engine.setAudioPlaybackContext(context);
      return [engine, resumed] as const;
    })
    .catch(() => {
      setAudioStatus('unavailable');
      return null;
    });
}

function invalidatePendingPlayback() {
  playbackGeneration += 1;
  audioPrimeInFlight = null;
  playbackEngine?.stopAudioPlayback();
}

function resetAudioAfterResume() {
  if (!isPageVisible()) {
    invalidatePendingPlayback();
    if (audioContext?.state === 'running') void audioContext.suspend().catch(() => undefined);
    return;
  }

  const now = Date.now();
  if (now - lastAudioResumeResetAt < 500) return;
  lastAudioResumeResetAt = now;
  playbackGeneration += 1;
  audioPrimeInFlight = null;
  playbackEngine?.resetAudioPlaybackAfterResume();
  setAudioStatus('idle');
}

const trustedAudioActivation = (event: Event) => {
  if (!event.isTrusted) return;
  void primeAudio();
};

function updateLifecycleListeners(method: 'addEventListener' | 'removeEventListener') {
  if (!isBrowser()) return;
  window[method]('pointerdown', trustedAudioActivation);
  window[method]('touchstart', trustedAudioActivation);
  window[method]('click', trustedAudioActivation);
  window[method]('keydown', trustedAudioActivation);
  window[method]('focus', resetAudioAfterResume);
  window[method]('pageshow', resetAudioAfterResume);
  document[method]('visibilitychange', resetAudioAfterResume);
}

function acquireAudioLifecycle() {
  lifecycleConsumers += 1;
  if (lifecycleConsumers === 1) updateLifecycleListeners('addEventListener');
  return () => {
    lifecycleConsumers = Math.max(0, lifecycleConsumers - 1);
    if (lifecycleConsumers === 0) updateLifecycleListeners('removeEventListener');
  };
}

export function primeAudio() {
  if (audioPrimeInFlight) return audioPrimeInFlight;
  if (!effectsEnabled()) return Promise.resolve(true);
  const prime = activatePlayback()
    .then(async (activation) => {
      if (!activation) return false;
      const [engine, resumed] = activation;
      if (!resumed && !hasAudioElement()) {
        setAudioStatus('blocked');
        return false;
      }
      if (!resumed) setAudioStatus('idle');
      return engine.primeAudioPlayback();
    })
    .finally(() => {
      if (audioPrimeInFlight === prime) audioPrimeInFlight = null;
    });
  audioPrimeInFlight = prime;
  return prime;
}

export function playAudioCue(cue: AudioCue, delayMs = 0) {
  void activatePlayback().then((activation) => {
    activation?.[0].playAudioPlaybackCue(cue, delayMs);
  });
}

export function playAudioTestCue() {
  const generation = playbackGeneration;
  void primeAudio().then((ready) => {
    if (ready && generation === playbackGeneration) playbackEngine?.playAudioPlaybackTestCue();
  });
}

export function getAudioSettings() {
  return audioSettings;
}

export function setAudioSettings(nextSettings: LegacyAudioSettingsUpdate) {
  audioSettings = normalizeSettings({
    ...audioSettings,
    ...nextSettings
  });
  writeStoredAudioSettings(audioSettings);
  settingsSubscribers.forEach((subscriber) => subscriber(audioSettings));
  if (!effectsEnabled()) {
    invalidatePendingPlayback();
  }
}

export function subscribeAudioSettings(subscriber: (settings: AudioSettings) => void) {
  settingsSubscribers.add(subscriber);
  return () => {
    settingsSubscribers.delete(subscriber);
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
  useEffect(acquireAudioLifecycle, []);

  return [settings, setAudioSettings, status] as const;
}

function rememberSemanticEvent(eventId: string) {
  if (playedSemanticEventIds.has(eventId)) return false;
  playedSemanticEventIds.add(eventId);
  if (playedSemanticEventIds.size > retainedSemanticEventIds) {
    playedSemanticEventIds.delete(playedSemanticEventIds.values().next().value as string);
  }
  return true;
}

export function playGameAudioEvents(events: readonly GameAudioEvent[]) {
  for (const event of events) {
    if (!rememberSemanticEvent(event.id)) continue;
    playAudioCue(event.cue, event.delayMs);
  }
}

export function playGameAudioTransition(
  previousFrame: GameAudioFrame | null | undefined,
  currentFrame: GameAudioFrame
) {
  const events = deriveGameAudioEvents(previousFrame, currentFrame);
  playGameAudioEvents(events);
  return events;
}

/**
 * Existing one-argument calls remain source-compatible and intentionally act
 * only as lifecycle owners. Semantic playback starts after the root supplies a
 * stable session id and revision context.
 */
export function useGameAudio(state: GameState | null | undefined, context?: GameAudioContext) {
  const previousFrameRef = useRef<GameAudioFrame | null>(null);
  const localSequenceRef = useRef<{
    revision: number;
    sessionId: string;
    state: GameState | null | undefined;
  } | null>(null);
  const hasContext = context !== undefined;
  const delivery = context?.delivery;
  const localPlayerId = context?.localPlayerId;
  const revision = context?.revision;
  const sessionId = context?.sessionId;
  const visible = context?.visible;
  useEffect(acquireAudioLifecycle, []);

  useEffect(() => {
    if (!hasContext || sessionId === undefined) {
      previousFrameRef.current = null;
      localSequenceRef.current = null;
      return;
    }
    let resolvedRevision = revision;
    if (resolvedRevision === undefined) {
      const localSequence = localSequenceRef.current;
      if (!localSequence || localSequence.sessionId !== sessionId) {
        resolvedRevision = ++localRevisionSeed;
        localSequenceRef.current = { revision: resolvedRevision, sessionId, state };
      } else if (localSequence.state !== state) {
        resolvedRevision = ++localRevisionSeed;
        localSequenceRef.current = { revision: resolvedRevision, sessionId, state };
      } else {
        resolvedRevision = localSequence.revision;
      }
    } else {
      localSequenceRef.current = null;
    }
    const currentFrame: GameAudioFrame = {
      delivery: delivery ?? 'live',
      localPlayerId,
      revision: resolvedRevision,
      sessionId,
      state,
      visible: visible ?? isPageVisible()
    };
    playGameAudioTransition(previousFrameRef.current, currentFrame);
    previousFrameRef.current = currentFrame;
  }, [delivery, hasContext, localPlayerId, revision, sessionId, state, visible]);
}
