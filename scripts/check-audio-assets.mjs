import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const audioDirectory = path.join(repoRoot, 'public', 'audio');
const nativeAudioDirectory = path.join(repoRoot, 'ios', 'SkyjoApp', 'Resources', 'Audio');

export const acceptedFlipSha256 = 'dc9c08e4b172d404ce2f1ba8380d552fdd1d302419e2872f067f0d761147df90';
export const acceptedCueSha256 = Object.freeze({
  'card-flip.mp3': acceptedFlipSha256,
  'card-pickup.mp3': '5d6b866eb280804f86aae1d5d795da1a2260075a5c18b11472b84b33d31f68de',
  'card-place.mp3': '37f3fb1cd7a08f741eb7431de2cde4ad5eef129aa18496d379221461926373b8'
});
export const requiredCueFiles = [
  'card-flip.mp3',
  'card-pickup.mp3',
  'card-place.mp3'
];

const legacyAmbienceFile = 'table-ambience.mp3';
const maxTransferredBytes = 80 * 1024;
const maxDecodedPcmBytes = 1024 * 1024;
const maxReplacementDurationSeconds = 0.5;
const maxMeaningfulOnsetSeconds = 0.05;
const analysisWindowSeconds = 0.005;
const tailWindowSeconds = 0.02;
const minimumMeaningfulPeak = 10 ** (-34 / 20);
const minimumMeaningfulRms = 10 ** (-46 / 20);
const maximumTailPeak = 10 ** (-24 / 20);
const maximumTailRms = 10 ** (-36 / 20);
const maximumFinalSample = 10 ** (-40 / 20);

function runMediaTool(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: options.encoding,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) {
    throw new Error(
      `${command} is required for the Skyjo audio gate (${result.error.message}). ` +
      'Install FFmpeg and make both ffmpeg and ffprobe available on PATH.'
    );
  }
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${command} failed${diagnostic ? `: ${diagnostic}` : '.'}`);
  }
  return result.stdout;
}

function probeAudio(filePath) {
  const output = runMediaTool('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_name,codec_type,sample_rate,channels,duration',
    '-show_entries',
    'format=duration,size',
    '-of',
    'json',
    filePath
  ], { encoding: 'utf8' });
  const parsed = JSON.parse(output);
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error(`${path.basename(filePath)} has no audio stream.`);

  return {
    channels: Number(stream.channels),
    codec: String(stream.codec_name || ''),
    durationSeconds: Number(stream.duration ?? parsed.format?.duration),
    sampleRate: Number(stream.sample_rate),
    sizeBytes: Number(parsed.format?.size)
  };
}

function decodeMonoPcm(filePath, sampleRate) {
  const output = runMediaTool('ffmpeg', [
    '-v',
    'error',
    '-i',
    filePath,
    '-map',
    '0:a:0',
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    'pipe:1'
  ]);
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}

function rms(samples, start, end) {
  if (end <= start) return 0;
  let total = 0;
  for (let index = start; index < end; index += 1) {
    const normalized = samples[index] / 32768;
    total += normalized * normalized;
  }
  return Math.sqrt(total / (end - start));
}

function peak(samples, start, end) {
  let maximum = 0;
  for (let index = start; index < end; index += 1) {
    maximum = Math.max(maximum, Math.abs(samples[index] / 32768));
  }
  return maximum;
}

function dbfs(value) {
  if (value <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(value);
}

function analyzePcm(buffer, sampleRate) {
  if (buffer.length < 2 || buffer.length % 2 !== 0) {
    throw new Error('Decoded PCM is empty or not signed 16-bit audio.');
  }

  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const fullRms = rms(samples, 0, samples.length);
  const fullPeak = peak(samples, 0, samples.length);
  const windowSamples = Math.max(1, Math.round(sampleRate * analysisWindowSeconds));
  const meaningfulRms = Math.max(minimumMeaningfulRms, fullRms * 0.25);
  const meaningfulPeak = Math.max(minimumMeaningfulPeak, fullPeak * 0.12);
  let onsetSample = samples.length;

  for (let start = 0; start < samples.length; start += windowSamples) {
    const end = Math.min(samples.length, start + windowSamples);
    if (rms(samples, start, end) >= meaningfulRms && peak(samples, start, end) >= meaningfulPeak) {
      onsetSample = start;
      break;
    }
  }

  const tailSamples = Math.max(1, Math.min(samples.length, Math.round(sampleRate * tailWindowSeconds)));
  const tailStart = samples.length - tailSamples;
  const tailRms = rms(samples, tailStart, samples.length);
  const tailPeak = peak(samples, tailStart, samples.length);
  const finalSample = Math.abs(samples[samples.length - 1] / 32768);

  return {
    decodedBytes: buffer.length,
    finalSampleDbfs: dbfs(finalSample),
    onsetSeconds: onsetSample / sampleRate,
    peakDbfs: dbfs(fullPeak),
    rmsDbfs: dbfs(fullRms),
    tailPeakDbfs: dbfs(tailPeak),
    tailRmsDbfs: dbfs(tailRms)
  };
}

function rounded(value, digits = 3) {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(digits));
}

export async function auditAudioAssets() {
  const directoryEntries = await fs.readdir(audioDirectory, { withFileTypes: true });
  const nativeDirectoryEntries = await fs.readdir(nativeAudioDirectory, { withFileTypes: true });
  const cueFiles = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mp3'))
    .map((entry) => entry.name)
    .sort();
  const failures = [];
  const nativeCueFiles = nativeDirectoryEntries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mp3'))
    .map((entry) => entry.name)
    .sort();

  if (cueFiles.includes(legacyAmbienceFile)) {
    failures.push(`${legacyAmbienceFile} must be removed; continuous ambience is outside issue #159.`);
  }
  for (const required of requiredCueFiles) {
    if (!cueFiles.includes(required)) failures.push(`Missing required cue ${required}.`);
    if (!nativeCueFiles.includes(required)) failures.push(`Missing required native cue ${required}.`);
  }
  for (const unexpected of nativeCueFiles.filter((file) => !requiredCueFiles.includes(file))) {
    failures.push(`Unexpected native cue ${unexpected}; document and gate new audio before bundling it.`);
  }

  const report = [];
  let transferredBytes = 0;
  let decodedPcmBytes = 0;

  for (const fileName of cueFiles.filter((file) => file !== legacyAmbienceFile)) {
    const filePath = path.join(audioDirectory, fileName);
    const bytes = await fs.readFile(filePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const acceptedSha256 = acceptedCueSha256[fileName];
    if (acceptedSha256 && sha256 !== acceptedSha256) {
      failures.push(`${fileName}: accepted SHA-256 changed (${sha256}).`);
    }
    let nativeBytes;
    let nativeSha256;
    try {
      nativeBytes = await fs.readFile(path.join(nativeAudioDirectory, fileName));
      nativeSha256 = createHash('sha256').update(nativeBytes).digest('hex');
      if (!bytes.equals(nativeBytes)) {
        failures.push(`${fileName}: native bundle copy is not byte-identical to public/audio.`);
      }
    } catch (error) {
      failures.push(`${fileName}: native bundle copy could not be read (${error instanceof Error ? error.message : String(error)}).`);
    }
    let probe;
    let pcm;
    try {
      probe = probeAudio(filePath);
      pcm = analyzePcm(decodeMonoPcm(filePath, probe.sampleRate), probe.sampleRate);
    } catch (error) {
      failures.push(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    transferredBytes += bytes.length;
    decodedPcmBytes += pcm.decodedBytes;

    if (probe.codec !== 'mp3') failures.push(`${fileName}: codec must be MP3, received ${probe.codec || 'unknown'}.`);
    if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
      failures.push(`${fileName}: duration must be a positive finite value.`);
    }
    if (!Number.isSafeInteger(probe.sampleRate) || probe.sampleRate < 22_050 || probe.sampleRate > 48_000) {
      failures.push(`${fileName}: sample rate must be between 22.05 and 48 kHz, received ${probe.sampleRate}.`);
    }
    if (probe.channels !== 1) failures.push(`${fileName}: cue must be mono, received ${probe.channels} channels.`);
    if (probe.sizeBytes !== bytes.length) {
      failures.push(`${fileName}: ffprobe size ${probe.sizeBytes} does not match file size ${bytes.length}.`);
    }

    if (fileName !== 'card-flip.mp3') {
      if (probe.durationSeconds > maxReplacementDurationSeconds) {
        failures.push(
          `${fileName}: duration ${probe.durationSeconds.toFixed(3)}s exceeds ${maxReplacementDurationSeconds.toFixed(3)}s.`
        );
      }
      if (pcm.onsetSeconds > maxMeaningfulOnsetSeconds) {
        failures.push(
          `${fileName}: first meaningful transient at ${pcm.onsetSeconds.toFixed(3)}s exceeds ` +
          `${maxMeaningfulOnsetSeconds.toFixed(3)}s.`
        );
      }
      if (pcm.tailRmsDbfs > dbfs(maximumTailRms)) {
        failures.push(
          `${fileName}: final ${Math.round(tailWindowSeconds * 1000)}ms RMS is ` +
          `${pcm.tailRmsDbfs.toFixed(1)} dBFS; expected at most ${dbfs(maximumTailRms).toFixed(1)} dBFS.`
        );
      }
      if (pcm.tailPeakDbfs > dbfs(maximumTailPeak)) {
        failures.push(
          `${fileName}: final ${Math.round(tailWindowSeconds * 1000)}ms peak is ` +
          `${pcm.tailPeakDbfs.toFixed(1)} dBFS; expected at most ${dbfs(maximumTailPeak).toFixed(1)} dBFS.`
        );
      }
      if (pcm.finalSampleDbfs > dbfs(maximumFinalSample)) {
        failures.push(
          `${fileName}: final sample is ${pcm.finalSampleDbfs.toFixed(1)} dBFS; ` +
          `expected at most ${dbfs(maximumFinalSample).toFixed(1)} dBFS for a clean tail.`
        );
      }
    }

    report.push({
      channels: probe.channels,
      decodedBytes: pcm.decodedBytes,
      durationSeconds: rounded(probe.durationSeconds, 4),
      file: fileName,
      finalSampleDbfs: rounded(pcm.finalSampleDbfs, 1),
      onsetMilliseconds: rounded(pcm.onsetSeconds * 1000, 1),
      nativeSha256,
      nativeSizeBytes: nativeBytes?.length,
      sampleRate: probe.sampleRate,
      sha256,
      sizeBytes: bytes.length,
      tailPeakDbfs: rounded(pcm.tailPeakDbfs, 1),
      tailRmsDbfs: rounded(pcm.tailRmsDbfs, 1)
    });
  }

  if (transferredBytes > maxTransferredBytes) {
    failures.push(`Total cue bytes ${transferredBytes} exceed the ${maxTransferredBytes}-byte transfer budget.`);
  }
  if (decodedPcmBytes > maxDecodedPcmBytes) {
    failures.push(`Decoded cue PCM ${decodedPcmBytes} bytes exceeds the ${maxDecodedPcmBytes}-byte memory budget.`);
  }

  return {
    budgets: {
      decodedPcmBytes,
      maxDecodedPcmBytes,
      maxTransferredBytes,
      transferredBytes
    },
    cues: report,
    failures
  };
}

async function main() {
  const result = await auditAudioAssets();
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length > 0) {
    throw new Error(`Skyjo audio asset gate failed with ${result.failures.length} finding(s).`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
