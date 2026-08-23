import type { SemanticAudioCue } from './audioEvents';

export type AudioPlaybackStatus = 'idle' | 'ready' | 'blocked' | 'unavailable';

export interface AudioPlaybackSettings {
  soundEffects: boolean;
  soundVolume: number;
}

export interface AudioPlaybackHost {
  getSettings: () => AudioPlaybackSettings;
  isPageVisible: () => boolean;
  setStatus: (status: AudioPlaybackStatus) => void;
}

type AudioCue = SemanticAudioCue;

type ToneSpec = {
  durationSeconds: number;
  frequency: number;
  gain: number;
  startSeconds: number;
};

type CueProfileBase = {
  minGapMs: number;
  priority: number;
  stopAfterMs: number;
  volumeScale: number;
};

type AssetCueProfile = CueProfileBase & {
  kind: 'asset';
  src: string;
};

type ProceduralCueProfile = CueProfileBase & {
  durationSeconds: number;
  kind: 'procedural';
  tones: readonly ToneSpec[];
};

type CueProfile = AssetCueProfile | ProceduralCueProfile;

type ActiveVoice = {
  cue: AudioCue;
  id: number;
  priority: number;
  startedAt: number;
  stop: () => void;
};

const maxActiveVoices = 3;
const maxStartsPerSecond = 4;
const assetCues: readonly AudioCue[] = ['flip', 'pickup', 'place'];
const cueProfiles: Record<AudioCue, CueProfile> = {
  flip: {
    kind: 'asset',
    minGapMs: 180,
    priority: 1,
    src: '/audio/card-flip.wav',
    stopAfterMs: 520,
    volumeScale: 0.24
  },
  pickup: {
    kind: 'asset',
    minGapMs: 300,
    priority: 1,
    src: '/audio/card-pickup.mp3',
    stopAfterMs: 380,
    volumeScale: 0.18
  },
  place: {
    kind: 'asset',
    minGapMs: 220,
    priority: 1,
    src: '/audio/card-place.mp3',
    stopAfterMs: 340,
    volumeScale: 0.14
  },
  columnClear: {
    durationSeconds: 0.46,
    kind: 'procedural',
    minGapMs: 600,
    priority: 2,
    stopAfterMs: 500,
    tones: [
      { durationSeconds: 0.2, frequency: 293.66, gain: 0.62, startSeconds: 0 },
      { durationSeconds: 0.25, frequency: 392, gain: 0.48, startSeconds: 0.11 }
    ],
    volumeScale: 0.15
  },
  localTurn: {
    durationSeconds: 0.52,
    kind: 'procedural',
    minGapMs: 1_500,
    priority: 3,
    stopAfterMs: 560,
    tones: [
      { durationSeconds: 0.24, frequency: 440, gain: 0.58, startSeconds: 0 },
      { durationSeconds: 0.27, frequency: 554.37, gain: 0.52, startSeconds: 0.16 }
    ],
    volumeScale: 0.2
  },
  roundEnd: {
    durationSeconds: 0.82,
    kind: 'procedural',
    minGapMs: 2_000,
    priority: 4,
    stopAfterMs: 880,
    tones: [
      { durationSeconds: 0.5, frequency: 392, gain: 0.46, startSeconds: 0 },
      { durationSeconds: 0.58, frequency: 523.25, gain: 0.42, startSeconds: 0.2 }
    ],
    volumeScale: 0.18
  },
  gameEnd: {
    durationSeconds: 1.08,
    kind: 'procedural',
    minGapMs: 3_000,
    priority: 5,
    stopAfterMs: 1_140,
    tones: [
      { durationSeconds: 0.55, frequency: 392, gain: 0.42, startSeconds: 0 },
      { durationSeconds: 0.58, frequency: 493.88, gain: 0.4, startSeconds: 0.19 },
      { durationSeconds: 0.64, frequency: 587.33, gain: 0.38, startSeconds: 0.38 }
    ],
    volumeScale: 0.19
  }
};

const cueAudioElements = new Map<AudioCue, HTMLAudioElement>();
const cueAudioBuffers = new Map<AudioCue, AudioBuffer>();
const cueAudioBufferPromises = new Map<AudioCue, Promise<AudioBuffer | null>>();
const proceduralSources = new Map<AudioCue, string>();
const lastCuePlayedAt = new Map<AudioCue, number>();
const pendingCueStarts = new Set<AudioCue>();
const activeVoices = new Map<number, ActiveVoice>();
const startedVoiceTimes: number[] = [];
const scheduledPlaybackCues = new Set<number>();

let host: AudioPlaybackHost | null = null;
let audioContext: AudioContext | null = null;
let cueAssetsPreloaded = false;
let audioBlockedUntil = 0;
let nextVoiceId = 1;
let playbackGeneration = 0;

function isBrowser() {
  return typeof window !== 'undefined';
}

function hasAudioElement() {
  return isBrowser() && typeof Audio !== 'undefined';
}

function hasWebAudio() {
  return audioContext !== null && audioContext.state !== 'closed';
}

function getSettings() {
  return host?.getSettings() ?? { soundEffects: false, soundVolume: 0 };
}

function isPageVisible() {
  return host?.isPageVisible() ?? false;
}

function setStatus(status: AudioPlaybackStatus) {
  host?.setStatus(status);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isCueEnabled(cue: AudioCue) {
  const settings = getSettings();
  return Boolean(cueProfiles[cue]) && settings.soundEffects && settings.soundVolume > 0;
}

function cueVolume(cue: AudioCue) {
  return clamp(getSettings().soundVolume * cueProfiles[cue].volumeScale, 0, 1);
}

function makeAudioElement(src: string) {
  if (!hasAudioElement()) {
    setStatus('unavailable');
    return null;
  }
  const audio = new Audio(src);
  audio.preload = 'auto';
  return audio;
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function wavDataUri(cue: AudioCue, profile: ProceduralCueProfile) {
  const existing = proceduralSources.get(cue);
  if (existing) return existing;

  const sampleRate = 22_050;
  const sampleCount = Math.ceil(profile.durationSeconds * sampleRate);
  const dataSize = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const time = sampleIndex / sampleRate;
    let sample = 0;
    for (const tone of profile.tones) {
      const localTime = time - tone.startSeconds;
      if (localTime < 0 || localTime >= tone.durationSeconds) continue;
      const attack = Math.min(0.014, tone.durationSeconds * 0.2);
      const release = Math.min(0.12, tone.durationSeconds * 0.45);
      const attackEnvelope = attack > 0 ? Math.min(1, localTime / attack) : 1;
      const releaseEnvelope = release > 0 ? Math.min(1, (tone.durationSeconds - localTime) / release) : 1;
      const envelope = attackEnvelope * releaseEnvelope;
      const fundamental = Math.sin(2 * Math.PI * tone.frequency * localTime);
      const warmHarmonic = Math.sin(4 * Math.PI * tone.frequency * localTime) * 0.12;
      sample += (fundamental + warmHarmonic) * envelope * tone.gain;
    }
    view.setInt16(44 + sampleIndex * 2, Math.round(clamp(sample, -0.92, 0.92) * 0x7fff), true);
  }

  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 8_192)));
  }
  const source = `data:audio/wav;base64,${window.btoa(binary)}`;
  proceduralSources.set(cue, source);
  return source;
}

function cueElement(cue: AudioCue) {
  const existing = cueAudioElements.get(cue);
  if (existing) return existing;
  const profile = cueProfiles[cue];
  const src = profile.kind === 'asset' ? profile.src : wavDataUri(cue, profile);
  const audio = makeAudioElement(src);
  if (!audio) return null;
  cueAudioElements.set(cue, audio);
  return audio;
}

async function cueBuffer(cue: AudioCue, generation: number) {
  const profile = cueProfiles[cue];
  if (profile.kind !== 'asset') return null;
  const existing = cueAudioBuffers.get(cue);
  if (existing) return existing;
  const existingPromise = cueAudioBufferPromises.get(cue);
  if (existingPromise) return existingPromise;

  const context = audioContext;
  if (!context || context.state === 'closed') return null;
  const promise = fetch(profile.src)
    .then((response) => {
      if (!response.ok) throw new Error(`Could not load audio cue ${cue}`);
      return response.arrayBuffer();
    })
    .then((data) => context.decodeAudioData(data.slice(0)))
    .then((buffer) => {
      if (generation === playbackGeneration && context === audioContext) {
        cueAudioBuffers.set(cue, buffer);
        return buffer;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      cueAudioBufferPromises.delete(cue);
    });
  cueAudioBufferPromises.set(cue, promise);
  return promise;
}

function preloadEnabledAssetCues(generation: number) {
  const settings = getSettings();
  if (cueAssetsPreloaded || !settings.soundEffects || settings.soundVolume <= 0) return;
  if (!hasWebAudio() && !hasAudioElement()) {
    setStatus('unavailable');
    return;
  }

  cueAssetsPreloaded = true;
  if (hasWebAudio()) {
    assetCues.forEach((cue) => {
      void cueBuffer(cue, generation);
    });
    return;
  }
  assetCues.forEach((cue) => cueElement(cue)?.load());
}

function cleanupCueAudio(audio: HTMLAudioElement) {
  audio.pause();
  try {
    audio.currentTime = 0;
  } catch {
    // Some mobile browsers reject currentTime changes before metadata is ready.
  }
}

function releaseVoice(voiceId: number) {
  activeVoices.delete(voiceId);
}

function disconnectAudioNode(node: AudioNode) {
  try {
    node.disconnect();
  } catch {
    // Already-disconnected or partial test nodes are harmless during cleanup.
  }
}

function stopVoice(voiceId: number) {
  const voice = activeVoices.get(voiceId);
  if (!voice) return;
  activeVoices.delete(voiceId);
  try {
    voice.stop();
  } catch {
    // A source may already have naturally ended.
  }
}

function stopAllVoices() {
  [...activeVoices.keys()].forEach(stopVoice);
}

function stopActiveCue(cue: AudioCue) {
  [...activeVoices.values()].filter((voice) => voice.cue === cue).forEach((voice) => stopVoice(voice.id));
}

function reserveVoice(cue: AudioCue) {
  const now = Date.now();
  while (startedVoiceTimes.length > 0 && now - startedVoiceTimes[0] >= 1_000) {
    startedVoiceTimes.shift();
  }
  if (startedVoiceTimes.length >= maxStartsPerSecond) return null;

  const profile = cueProfiles[cue];
  if (activeVoices.size >= maxActiveVoices) {
    const victim = [...activeVoices.values()].sort(
      (left, right) => left.priority - right.priority || left.startedAt - right.startedAt
    )[0];
    if (!victim || victim.priority > profile.priority) return null;
    stopVoice(victim.id);
  }

  const voiceId = nextVoiceId;
  nextVoiceId += 1;
  startedVoiceTimes.push(now);
  activeVoices.set(voiceId, {
    cue,
    id: voiceId,
    priority: profile.priority,
    startedAt: now,
    stop: () => undefined
  });
  return voiceId;
}

function bindVoiceStop(voiceId: number, stop: () => void) {
  const voice = activeVoices.get(voiceId);
  if (voice) voice.stop = stop;
}

function startAssetBuffer(cue: AudioCue, context: AudioContext, buffer: AudioBuffer) {
  const profile = cueProfiles[cue];
  if (profile.kind !== 'asset') return false;
  stopActiveCue(cue);
  const voiceId = reserveVoice(cue);
  if (voiceId === null) return true;

  try {
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = cueVolume(cue);
    source.connect(gain);
    gain.connect(context.destination);
    let stopTimer: number | null = null;
    const finish = () => {
      if (stopTimer !== null) window.clearTimeout(stopTimer);
      releaseVoice(voiceId);
      disconnectAudioNode(source);
      disconnectAudioNode(gain);
    };
    source.onended = finish;
    bindVoiceStop(voiceId, () => {
      if (stopTimer !== null) window.clearTimeout(stopTimer);
      source.onended = null;
      try {
        source.stop();
      } catch {
        // BufferSourceNode.stop throws after natural completion.
      }
      disconnectAudioNode(source);
      disconnectAudioNode(gain);
    });
    lastCuePlayedAt.set(cue, Date.now());
    source.start();
    stopTimer = window.setTimeout(() => stopVoice(voiceId), profile.stopAfterMs);
    audioBlockedUntil = 0;
    setStatus('ready');
    return true;
  } catch {
    releaseVoice(voiceId);
    lastCuePlayedAt.set(cue, 0);
    return false;
  }
}

function playHtmlElement(cue: AudioCue) {
  const audio = cueElement(cue);
  if (!audio) return false;
  const profile = cueProfiles[cue];
  stopActiveCue(cue);
  const voiceId = reserveVoice(cue);
  if (voiceId === null) return true;

  let stopTimer: number | null = null;
  const onEnded = () => {
    if (stopTimer !== null) window.clearTimeout(stopTimer);
    releaseVoice(voiceId);
  };
  const removeEndedListener = () => {
    if (typeof audio.removeEventListener === 'function') audio.removeEventListener('ended', onEnded);
  };
  bindVoiceStop(voiceId, () => {
    if (stopTimer !== null) window.clearTimeout(stopTimer);
    removeEndedListener();
    cleanupCueAudio(audio);
  });

  audio.volume = cueVolume(cue);
  audio.muted = false;
  try {
    audio.pause();
    audio.currentTime = 0;
  } catch {
    // Current time can be locked until metadata loads on iOS.
  }
  if (typeof audio.addEventListener === 'function') audio.addEventListener('ended', onEnded, { once: true });

  lastCuePlayedAt.set(cue, Date.now());
  stopTimer = window.setTimeout(() => stopVoice(voiceId), profile.stopAfterMs);
  try {
    const playResult = audio.play();
    if (!playResult) {
      audioBlockedUntil = 0;
      setStatus('ready');
      return true;
    }
    void playResult
      .then(() => {
        audioBlockedUntil = 0;
        setStatus('ready');
      })
      .catch(() => {
        stopVoice(voiceId);
        lastCuePlayedAt.set(cue, 0);
        audioBlockedUntil = Date.now() + 750;
        setStatus('blocked');
      });
    return true;
  } catch {
    stopVoice(voiceId);
    lastCuePlayedAt.set(cue, 0);
    audioBlockedUntil = Date.now() + 750;
    setStatus('blocked');
    return false;
  }
}

async function startAssetCue(cue: AudioCue, generation: number) {
  const context = audioContext;
  if (context && context.state !== 'closed') {
    try {
      if (context.state === 'suspended') await context.resume();
      if (generation !== playbackGeneration) return true;
      if (context.state === 'running') {
        const buffer = await cueBuffer(cue, generation);
        if (
          buffer &&
          generation === playbackGeneration &&
          context === audioContext &&
          isCueEnabled(cue) &&
          isPageVisible()
        ) {
          const started = startAssetBuffer(cue, context, buffer);
          if (started) return true;
        }
      }
    } catch {
      // HTML Audio below remains a valid fallback after a Web Audio failure.
    }
  }
  if (generation !== playbackGeneration || !isCueEnabled(cue) || !isPageVisible()) return true;
  return hasAudioElement() ? playHtmlElement(cue) : false;
}

function scheduleAudioParam(
  parameter: AudioParam,
  startAt: number,
  holdUntil: number,
  endAt: number,
  value: number
) {
  if (
    typeof parameter.setValueAtTime !== 'function' ||
    typeof parameter.linearRampToValueAtTime !== 'function' ||
    typeof parameter.exponentialRampToValueAtTime !== 'function'
  ) {
    parameter.value = value;
    return;
  }
  parameter.cancelScheduledValues(startAt);
  parameter.setValueAtTime(0.0001, startAt);
  parameter.linearRampToValueAtTime(value, startAt + 0.014);
  parameter.setValueAtTime(value, holdUntil);
  parameter.exponentialRampToValueAtTime(0.0001, endAt);
}

async function startProceduralCue(cue: AudioCue, profile: ProceduralCueProfile, generation: number) {
  const context = audioContext;
  if (context && context.state !== 'closed') {
    let gain: GainNode | null = null;
    let oscillators: OscillatorNode[] = [];
    let stopTimer: number | null = null;
    let voiceId: number | null = null;
    try {
      if (context.state === 'suspended') await context.resume();
      if (generation !== playbackGeneration) return true;
      if (context.state === 'running' && typeof context.createOscillator === 'function') {
        gain = context.createGain();
        const now = Number.isFinite(context.currentTime) ? context.currentTime : 0;
        const endAt = now + profile.durationSeconds;
        scheduleAudioParam(gain.gain, now, Math.max(now + 0.02, endAt - 0.11), endAt, cueVolume(cue));
        gain.connect(context.destination);
        oscillators = profile.tones.map((tone) => {
          const oscillator = context.createOscillator();
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(tone.frequency, now + tone.startSeconds);
          oscillator.connect(gain as GainNode);
          return oscillator;
        });
        if (generation !== playbackGeneration || !isCueEnabled(cue) || !isPageVisible()) {
          oscillators.forEach((oscillator) => oscillator.disconnect());
          gain.disconnect();
          return true;
        }
        stopActiveCue(cue);
        voiceId = reserveVoice(cue);
        if (voiceId === null) {
          oscillators.forEach((oscillator) => oscillator.disconnect());
          gain.disconnect();
          return true;
        }
        bindVoiceStop(voiceId, () => {
          if (stopTimer !== null) {
            window.clearTimeout(stopTimer);
            stopTimer = null;
          }
          oscillators.forEach((oscillator) => {
            try {
              oscillator.stop();
            } catch {
              // Oscillators may already have completed their short envelope.
            }
            oscillator.disconnect();
          });
          gain?.disconnect();
        });
        lastCuePlayedAt.set(cue, Date.now());
        oscillators.forEach((oscillator, index) => {
          const tone = profile.tones[index];
          oscillator.start(now + tone.startSeconds);
          oscillator.stop(now + tone.startSeconds + tone.durationSeconds);
        });
        stopTimer = window.setTimeout(() => {
          if (voiceId !== null) stopVoice(voiceId);
        }, profile.stopAfterMs);
        audioBlockedUntil = 0;
        setStatus('ready');
        return true;
      }
    } catch {
      if (voiceId !== null) {
        stopVoice(voiceId);
      } else {
        oscillators.forEach((oscillator) => {
          try {
            oscillator.disconnect();
          } catch {
            // A partially constructed oscillator may not be connected yet.
          }
        });
        try {
          gain?.disconnect();
        } catch {
          // A partially constructed gain may not be connected yet.
        }
      }
      // Generated WAV below is the no-WebAudio/iOS fallback.
    }
  }
  if (generation !== playbackGeneration || !isCueEnabled(cue) || !isPageVisible()) return true;
  return hasAudioElement() ? playHtmlElement(cue) : false;
}

async function startCue(cue: AudioCue) {
  if (pendingCueStarts.has(cue)) return;
  pendingCueStarts.add(cue);
  const generation = playbackGeneration;
  try {
    if (!isCueEnabled(cue) || !isPageVisible() || Date.now() < audioBlockedUntil) return;
    const profile = cueProfiles[cue];
    const previousPlayedAt = lastCuePlayedAt.get(cue) ?? 0;
    if (Date.now() - previousPlayedAt < profile.minGapMs) return;

    const started = profile.kind === 'asset'
      ? await startAssetCue(cue, generation)
      : await startProceduralCue(cue, profile, generation);
    if (
      generation === playbackGeneration &&
      !started
    ) {
      setStatus(hasAudioElement() || hasWebAudio() ? 'blocked' : 'unavailable');
    }
  } finally {
    pendingCueStarts.delete(cue);
  }
}

export function configureAudioPlaybackEngine(nextHost: AudioPlaybackHost) {
  host = nextHost;
}

export function setAudioPlaybackContext(context: AudioContext | null) {
  if (audioContext === context) return;
  playbackGeneration += 1;
  stopAllVoices();
  audioContext = context;
  cueAudioBuffers.clear();
  cueAudioBufferPromises.clear();
  cueAssetsPreloaded = false;
}

export async function primeAudioPlayback() {
  const settings = getSettings();
  if (!settings.soundEffects || settings.soundVolume <= 0) return true;
  if (!hasWebAudio() && !hasAudioElement()) {
    setStatus('unavailable');
    return false;
  }

  const generation = playbackGeneration;
  audioBlockedUntil = 0;
  preloadEnabledAssetCues(generation);
  const context = audioContext;
  if (context?.state === 'suspended') {
    try {
      await context.resume();
    } catch {
      if (generation === playbackGeneration) setStatus(hasAudioElement() ? 'idle' : 'blocked');
      return hasAudioElement();
    }
  }
  if (generation !== playbackGeneration) return false;
  if (context?.state === 'running' || hasAudioElement()) setStatus('ready');
  return true;
}

export function playAudioPlaybackCue(cue: AudioCue, delayMs = 0) {
  if (delayMs <= 0) {
    void startCue(cue);
    return;
  }
  const timer = window.setTimeout(() => {
    scheduledPlaybackCues.delete(timer);
    void startCue(cue);
  }, delayMs);
  scheduledPlaybackCues.add(timer);
}

export function playAudioPlaybackTestCue() {
  playAudioPlaybackCue('flip');
  playAudioPlaybackCue('pickup', 170);
  playAudioPlaybackCue('place', 360);
}

export function stopAudioPlayback() {
  playbackGeneration += 1;
  scheduledPlaybackCues.forEach((timer) => window.clearTimeout(timer));
  scheduledPlaybackCues.clear();
  stopAllVoices();
  cueAudioElements.forEach(cleanupCueAudio);
  pendingCueStarts.clear();
  startedVoiceTimes.length = 0;
}

export function resetAudioPlaybackAfterResume() {
  stopAudioPlayback();
  audioBlockedUntil = 0;
  lastCuePlayedAt.clear();
  cueAudioElements.clear();
  cueAssetsPreloaded = false;
}
