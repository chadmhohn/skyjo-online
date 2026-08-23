import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync
} from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDirectory = path.join(repoRoot, 'public');
const audioDirectory = path.join(repoRoot, 'public', 'audio');
const nativeResourcesDirectory = path.join(repoRoot, 'ios', 'SkyjoApp', 'Resources');
const nativeAudioDirectory = path.join(repoRoot, 'ios', 'SkyjoApp', 'Resources', 'Audio');
const nativeProjectPath = path.join(repoRoot, 'ios', 'SkyjoNative.xcodeproj', 'project.pbxproj');

export const acceptedFlipSha256 = 'cd39c3d5f749b84b73db28ed581ef34fb37bd539eeb1a2389713350ca96d2ad3';
export const acceptedCueSha256 = Object.freeze({
  'card-flip.wav': acceptedFlipSha256,
  'card-pickup.mp3': '5d6b866eb280804f86aae1d5d795da1a2260075a5c18b11472b84b33d31f68de',
  'card-place.mp3': '37f3fb1cd7a08f741eb7431de2cde4ad5eef129aa18496d379221461926373b8'
});
export const requiredCueFiles = [
  'card-flip.wav',
  'card-pickup.mp3',
  'card-place.mp3'
];
const acceptedCueSizeBytes = Object.freeze({
  'card-flip.wav': 21_212,
  'card-pickup.mp3': 4_225,
  'card-place.mp3': 3_702
});
const requiredNativeAudioResources = requiredCueFiles.map((file) => `Audio/${file}`);
const approvedPublicResourceFiles = new Set([
  'audio/README.md',
  ...requiredCueFiles.map((file) => `audio/${file}`),
  'manifest.webmanifest',
  'skyjo-icon-v2-180.png',
  'skyjo-icon-v2-192.png',
  'skyjo-icon-v2-512.png'
]);
// Exact resource inventory is deliberately broader than an audio-extension
// list. AVFoundation can decode audio from evolving containers and from bytes
// with misleading extensions, so every new bundled resource must receive an
// explicit review and gate update before it enters the native target.
const approvedNativeResourceFiles = new Set([
  'Assets.xcassets/AccentColor.colorset/Contents.json',
  'Assets.xcassets/AppIcon.appiconset/Contents.json',
  'Assets.xcassets/AppIcon.appiconset/Original-External-1024.png',
  'Assets.xcassets/Contents.json',
  'Audio/README.md',
  ...requiredNativeAudioResources,
  'Info.plist',
  'PrivacyInfo.xcprivacy',
  'SkyjoNative.entitlements'
]);
const approvedNativeProjectResourceNames = [
  'Assets.xcassets',
  'PrivacyInfo.xcprivacy',
  ...requiredCueFiles
].sort();
const approvedBuiltNativeApplicationFiles = [
  'AppIcon60x60@2x.png',
  'AppIcon76x76@2x~ipad.png',
  'Assets.car',
  'Info.plist',
  'PkgInfo',
  'PrivacyInfo.xcprivacy',
  'SkyjoNative',
  ...requiredCueFiles
].sort();

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
const appleAfconvertPath = '/usr/bin/afconvert';
const appleAfinfoPath = '/usr/bin/afinfo';
const boundedReadFileOperations = Object.freeze({
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync
});

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFileMetadata(left, right) {
  return sameFileIdentity(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export function boundedReadOpenFlags(fileConstants = constants) {
  if (
    typeof fileConstants.O_RDONLY !== 'number'
    || typeof fileConstants.O_NOFOLLOW !== 'number'
    || typeof fileConstants.O_NONBLOCK !== 'number'
  ) {
    throw new Error(
      'Secure bounded file reads require O_NOFOLLOW and O_NONBLOCK support on this platform.'
    );
  }
  return fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK;
}

function portableRelativePath(value) {
  return value.split(path.sep).join('/');
}

export function unexpectedNativeResources(resourceFiles) {
  return resourceFiles
    .map((file) => portableRelativePath(file))
    .filter((file) => !approvedNativeResourceFiles.has(file))
    .sort();
}

export function unexpectedPublicResources(resourceFiles) {
  return resourceFiles
    .map((file) => portableRelativePath(file))
    .filter((file) => !approvedPublicResourceFiles.has(file))
    .sort();
}

function exactInventoryFailures(resourceFiles, approvedFiles, label) {
  const normalized = resourceFiles.map((file) => portableRelativePath(file)).sort();
  const received = new Set(normalized);
  const approved = new Set(approvedFiles);
  const failures = [];
  for (const expected of approvedFiles) {
    if (!received.has(expected)) failures.push(`Missing approved ${label} ${expected}.`);
  }
  for (const unexpected of normalized) {
    if (!approved.has(unexpected)) failures.push(`Unexpected ${label} ${unexpected}.`);
  }
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] === normalized[index - 1]) {
      failures.push(`Duplicate ${label} ${normalized[index]}.`);
    }
  }
  return failures;
}

export function publicResourceInventoryFailures(resourceFiles) {
  return exactInventoryFailures(
    resourceFiles,
    [...approvedPublicResourceFiles].sort(),
    'public resource'
  );
}

export function builtNativeApplicationInventoryFailures(resourceFiles) {
  return exactInventoryFailures(
    resourceFiles,
    approvedBuiltNativeApplicationFiles,
    'native application bundle file'
  );
}

function projectSection(projectText, kind) {
  const begin = `/* Begin ${kind} section */`;
  const end = `/* End ${kind} section */`;
  const startIndex = projectText.indexOf(begin);
  const endIndex = projectText.indexOf(end, startIndex + begin.length);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`The Xcode project is missing its ${kind} section.`);
  }
  return projectText.slice(startIndex + begin.length, endIndex);
}

function projectObject(section, marker) {
  const startIndex = section.indexOf(marker);
  if (startIndex === -1) throw new Error(`The Xcode project is missing ${marker}.`);
  const remainder = section.slice(startIndex + marker.length);
  const closing = remainder.match(/\n[\t ]*};/);
  if (!closing || closing.index === undefined) {
    throw new Error(`The Xcode project has a malformed ${marker} object.`);
  }
  const endIndex = startIndex + marker.length + closing.index + closing[0].length;
  return section.slice(startIndex, endIndex);
}

export function nativeApplicationResourceNames(projectText) {
  const target = projectObject(
    projectSection(projectText, 'PBXNativeTarget'),
    '/* SkyjoNative */ = {'
  );
  if (!target.includes('productType = "com.apple.product-type.application";')) {
    throw new Error('SkyjoNative is no longer the application target.');
  }
  const buildPhases = target.match(/buildPhases = \(([\s\S]*?)\);/)?.[1];
  if (!buildPhases) throw new Error('SkyjoNative has no parseable build phases.');
  const resourcePhaseID = buildPhases.match(
    /([A-F0-9]{24}) \/\* Resources \*\//
  )?.[1];
  if (!resourcePhaseID) throw new Error('SkyjoNative has no Resources build phase.');

  const resources = projectObject(
    projectSection(projectText, 'PBXResourcesBuildPhase'),
    `${resourcePhaseID} /* Resources */ = {`
  );
  const fileList = resources.match(/files = \(([\s\S]*?)\);/)?.[1];
  if (fileList === undefined) {
    throw new Error('SkyjoNative has no parseable Resources file list.');
  }
  return fileList
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const entry = line.match(/^[A-F0-9]{24} \/\* (.+) in Resources \*\/,$/);
      if (!entry) throw new Error(`SkyjoNative has an unparseable resource entry: ${line}`);
      return entry[1];
    })
    .sort();
}

async function listRelativeResourceFiles(root, label, directory = root) {
  const files = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = portableRelativePath(path.relative(root, absolutePath));
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} must not contain symbolic links: ${relativePath}.`);
    }
    if (entry.isDirectory()) {
      files.push(...await listRelativeResourceFiles(root, label, absolutePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`${label} contain an unsupported entry: ${relativePath}.`);
    }
  }
  return files.sort();
}

function mediaToolStatus(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  return result.error ? { error: result.error, status: null } : { error: null, status: result.status };
}

function resolveMediaBackend() {
  const ffprobe = mediaToolStatus('ffprobe', ['-version']);
  const ffmpeg = mediaToolStatus('ffmpeg', ['-version']);
  if (ffprobe.status === 0 && ffmpeg.status === 0) return 'ffmpeg';

  if (process.platform === 'darwin') {
    const afinfo = mediaToolStatus(appleAfinfoPath, ['-h']);
    const afconvert = mediaToolStatus(appleAfconvertPath, ['-h']);
    // Both Apple tools intentionally return non-zero after printing help. A
    // completed absolute-path invocation is enough to establish availability;
    // the real probe and decode still have to exit zero for every cue.
    if (!afinfo.error && afinfo.status !== null && !afconvert.error && afconvert.status !== null) {
      return 'apple-coreaudio';
    }
  }

  const unavailable = [
    ffprobe.status === 0 ? null : `ffprobe (${ffprobe.error?.message || `exit ${ffprobe.status}`})`,
    ffmpeg.status === 0 ? null : `ffmpeg (${ffmpeg.error?.message || `exit ${ffmpeg.status}`})`
  ].filter(Boolean).join(', ');
  throw new Error(
    `The Skyjo audio gate requires ffprobe and ffmpeg${unavailable ? `; unavailable: ${unavailable}` : ''}. ` +
    'Install FFmpeg and make both commands available on PATH. On macOS, the gate can instead use the ' +
    'system /usr/bin/afinfo and /usr/bin/afconvert tools.'
  );
}

function runMediaTool(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: options.encoding,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) {
    throw new Error(`${command} could not run for the Skyjo audio gate (${result.error.message}).`);
  }
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${command} failed${diagnostic ? `: ${diagnostic}` : '.'}`);
  }
  return result.stdout;
}

function probeAudioWithFfmpeg(filePath) {
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

function decodeMonoPcmWithFfmpeg(filePath, sampleRate) {
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

function requiredXmlValue(xml, tagName) {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...xml.matchAll(new RegExp(`<${escapedTagName}(?:\\s[^>]*)?>([^<]*)</${escapedTagName}>`, 'g'))];
  if (matches.length !== 1) {
    throw new Error(`afinfo returned ${matches.length} ${tagName} values; expected exactly one.`);
  }
  return matches[0][1].trim();
}

export function parseAppleAudioInfo(xml, sizeBytes) {
  if (!xml.includes('<audio_info ') || !xml.includes('</audio_info>')) {
    throw new Error('afinfo did not return its expected audio_info XML document.');
  }
  if ((xml.match(/<audio_file\b/g) || []).length !== 1) {
    throw new Error('afinfo must report exactly one audio file.');
  }
  if ((xml.match(/<track\b/g) || []).length !== 1) {
    throw new Error('afinfo must report exactly one audio track.');
  }
  if (/<alert\s+level="ERROR"/i.test(xml)) {
    throw new Error('afinfo reported an error while reading the audio file.');
  }

  const fileType = requiredXmlValue(xml, 'file_type').replaceAll("'", '');
  const formatType = requiredXmlValue(xml, 'format_type');
  const codec = fileType === 'MPG3' && formatType === '.mp3'
    ? 'mp3'
    : fileType === 'WAVE' && formatType === 'lpcm'
      ? 'pcm_s16le'
      : undefined;
  if (!codec) {
    throw new Error(
      `audio format must be MP3 or linear PCM WAVE; afinfo reported ${fileType || 'unknown'}/${formatType || 'unknown'}.`
    );
  }

  return {
    channels: Number(requiredXmlValue(xml, 'num_channels')),
    codec,
    durationSeconds: Number(requiredXmlValue(xml, 'duration')),
    sampleRate: Number(requiredXmlValue(xml, 'sample_rate')),
    sizeBytes
  };
}

function probeAudioWithApple(filePath) {
  const output = runMediaTool(appleAfinfoPath, ['-r', '-x', filePath], { encoding: 'utf8' });
  return parseAppleAudioInfo(output, statSync(filePath).size);
}

function waveChunk(buffer, offset) {
  if (offset + 8 > buffer.length) {
    throw new Error('Decoded WAVE has a truncated chunk header.');
  }
  const identifier = buffer.toString('ascii', offset, offset + 4);
  const length = buffer.readUInt32LE(offset + 4);
  const dataStart = offset + 8;
  const dataEnd = dataStart + length;
  if (dataEnd > buffer.length) {
    throw new Error(`Decoded WAVE ${identifier || 'unknown'} chunk exceeds the file bounds.`);
  }
  return { dataEnd, dataStart, identifier, length, nextOffset: dataEnd + (length % 2) };
}

export function extractWavePcm(buffer, expectedSampleRate) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    throw new Error('Decoded WAVE output is missing or truncated.');
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Decoded output is not a RIFF/WAVE file.');
  }
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) {
    throw new Error('Decoded WAVE RIFF size does not match the output file size.');
  }

  let format;
  let pcm;
  let offset = 12;
  while (offset < buffer.length) {
    const chunk = waveChunk(buffer, offset);
    if (chunk.identifier === 'fmt ') {
      if (format) throw new Error('Decoded WAVE contains more than one format chunk.');
      if (chunk.length < 16) throw new Error('Decoded WAVE format chunk is truncated.');
      format = {
        audioFormat: buffer.readUInt16LE(chunk.dataStart),
        blockAlign: buffer.readUInt16LE(chunk.dataStart + 12),
        bitsPerSample: buffer.readUInt16LE(chunk.dataStart + 14),
        byteRate: buffer.readUInt32LE(chunk.dataStart + 8),
        channels: buffer.readUInt16LE(chunk.dataStart + 2),
        sampleRate: buffer.readUInt32LE(chunk.dataStart + 4)
      };
    } else if (chunk.identifier === 'data') {
      if (pcm) throw new Error('Decoded WAVE contains more than one data chunk.');
      pcm = buffer.subarray(chunk.dataStart, chunk.dataEnd);
    }
    offset = chunk.nextOffset;
  }

  if (offset !== buffer.length) throw new Error('Decoded WAVE has an invalid final chunk boundary.');
  if (!format) throw new Error('Decoded WAVE is missing its format chunk.');
  if (!pcm) throw new Error('Decoded WAVE is missing its PCM data chunk.');
  if (
    format.audioFormat !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== expectedSampleRate ||
    format.bitsPerSample !== 16 ||
    format.blockAlign !== 2 ||
    format.byteRate !== expectedSampleRate * 2
  ) {
    throw new Error(
      'Decoded WAVE must be mono signed 16-bit PCM at the probed sample rate; received ' +
      `${format.channels} channel(s), format ${format.audioFormat}, ${format.bitsPerSample}-bit, ${format.sampleRate} Hz.`
    );
  }
  if (pcm.length === 0 || pcm.length % format.blockAlign !== 0) {
    throw new Error('Decoded WAVE PCM data is empty or not frame-aligned.');
  }
  return pcm;
}

function decodeMonoPcmWithApple(filePath, sampleRate) {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'skyjo-audio-gate-'));
  const outputPath = path.join(temporaryDirectory, 'decoded.wav');
  try {
    runMediaTool(appleAfconvertPath, [
      filePath,
      outputPath,
      '-f',
      'WAVE',
      '-d',
      `LEI16@${sampleRate}`,
      '-c',
      '1'
    ]);
    return extractWavePcm(
      readBoundedRegularFile(
        outputPath,
        maxDecodedPcmBytes + 64 * 1024,
        'Decoded WAVE output'
      ),
      sampleRate
    );
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export function readBoundedRegularFile(
  filePath,
  maximumBytes,
  label = 'File',
  fileOperations = boundedReadFileOperations,
  fileConstants = constants
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error('Maximum file size must be a non-negative safe integer.');
  }
  const openFlags = boundedReadOpenFlags(fileConstants);
  let descriptor;
  try {
    descriptor = fileOperations.openSync(filePath, openFlags);
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error(`${label} must be a regular file and cannot be a symbolic link.`);
    }
    throw error;
  }
  try {
    const initialStat = fileOperations.fstatSync(descriptor, { bigint: true });
    const initialPathStat = fileOperations.lstatSync(filePath, { bigint: true });
    if (
      !initialStat.isFile()
      || !initialPathStat.isFile()
      || initialPathStat.isSymbolicLink()
    ) {
      throw new Error(`${label} must be a regular file and cannot be a symbolic link.`);
    }
    if (!sameStableFileMetadata(initialStat, initialPathStat)) {
      throw new Error(`${label} changed while it was being opened.`);
    }
    if (initialStat.size > BigInt(maximumBytes)) {
      throw new Error(
        `${label} ${initialStat.size} bytes exceeds the audio gate's safe bound.`
      );
    }

    const contents = Buffer.alloc(Number(initialStat.size));
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = fileOperations.readSync(
        descriptor,
        contents,
        offset,
        contents.length - offset,
        offset
      );
      if (bytesRead === 0) {
        throw new Error(`${label} changed while it was being read.`);
      }
      offset += bytesRead;
    }

    const overflowProbe = Buffer.alloc(1);
    if (fileOperations.readSync(descriptor, overflowProbe, 0, 1, offset) !== 0) {
      throw new Error(`${label} grew while it was being read.`);
    }
    const finalStat = fileOperations.fstatSync(descriptor, { bigint: true });
    const finalPathStat = fileOperations.lstatSync(filePath, { bigint: true });
    if (
      !finalStat.isFile()
      || !finalPathStat.isFile()
      || finalPathStat.isSymbolicLink()
      || !sameStableFileMetadata(initialStat, finalStat)
      || !sameStableFileMetadata(finalStat, finalPathStat)
    ) {
      throw new Error(`${label} changed while it was being read.`);
    }
    return contents;
  } finally {
    fileOperations.closeSync(descriptor);
  }
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
  const mediaBackend = resolveMediaBackend();
  const probeAudio = mediaBackend === 'ffmpeg' ? probeAudioWithFfmpeg : probeAudioWithApple;
  const decodeMonoPcm = mediaBackend === 'ffmpeg' ? decodeMonoPcmWithFfmpeg : decodeMonoPcmWithApple;
  const publicResourceFiles = await listRelativeResourceFiles(
    publicDirectory,
    'Public resources'
  );
  const nativeResourceFiles = await listRelativeResourceFiles(
    nativeResourcesDirectory,
    'Native resources'
  );
  const nativeProjectText = await fs.readFile(nativeProjectPath, 'utf8');
  const cueFiles = publicResourceFiles
    .filter((file) => file.startsWith('audio/') && !file.slice('audio/'.length).includes('/'))
    .map((file) => file.slice('audio/'.length))
    .filter((file) => /\.(?:mp3|wav)$/i.test(file))
    .sort();
  const failures = [];

  if (cueFiles.includes(legacyAmbienceFile)) {
    failures.push(`${legacyAmbienceFile} must be removed; continuous ambience is outside issue #159.`);
  }
  for (const required of requiredCueFiles) {
    if (!cueFiles.includes(required)) failures.push(`Missing required cue ${required}.`);
    if (!nativeResourceFiles.includes(`Audio/${required}`)) {
      failures.push(`Missing required native cue ${required}.`);
    }
  }
  for (const unexpected of unexpectedNativeResources(nativeResourceFiles)) {
    failures.push(
      `Unexpected native resource ${unexpected}; document and gate new bundled resources before shipping them.`
    );
  }
  failures.push(...publicResourceInventoryFailures(publicResourceFiles));
  try {
    const projectResources = nativeApplicationResourceNames(nativeProjectText);
    if (JSON.stringify(projectResources) !== JSON.stringify(approvedNativeProjectResourceNames)) {
      failures.push(
        `SkyjoNative Resources must remain the exact approved inventory; received ${projectResources.join(', ') || 'none'}.`
      );
    }
  } catch (error) {
    failures.push(
      `SkyjoNative Resources could not be verified (${error instanceof Error ? error.message : String(error)}).`
    );
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

    const expectedCodec = fileName.endsWith('.wav') ? 'pcm_s16le' : 'mp3';
    if (probe.codec !== expectedCodec) {
      failures.push(`${fileName}: codec must be ${expectedCodec}, received ${probe.codec || 'unknown'}.`);
    }
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
    failures,
    mediaBackend
  };
}

export async function auditBuiltNativeApplication(bundlePath) {
  const failures = [];
  let resourceFiles = [];
  try {
    const bundleStat = await fs.lstat(bundlePath);
    if (bundleStat.isSymbolicLink() || !bundleStat.isDirectory()) {
      throw new Error('bundle path must be a real directory, not a symbolic link');
    }
    resourceFiles = await listRelativeResourceFiles(
      bundlePath,
      'Built native application bundle'
    );
    failures.push(...builtNativeApplicationInventoryFailures(resourceFiles));
  } catch (error) {
    failures.push(
      `Built native application bundle could not be inventoried (${error instanceof Error ? error.message : String(error)}).`
    );
  }

  for (const fileName of requiredCueFiles) {
    try {
      const bytes = await fs.readFile(path.join(bundlePath, fileName));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== acceptedCueSizeBytes[fileName]) {
        failures.push(
          `${fileName}: built native bundle size ${bytes.length} does not match approved size ${acceptedCueSizeBytes[fileName]}.`
        );
      }
      if (sha256 !== acceptedCueSha256[fileName]) {
        failures.push(`${fileName}: built native bundle SHA-256 changed (${sha256}).`);
      }
    } catch (error) {
      failures.push(
        `${fileName}: built native bundle cue could not be read (${error instanceof Error ? error.message : String(error)}).`
      );
    }
  }

  return {
    bundle: path.basename(bundlePath),
    failures,
    files: resourceFiles
  };
}

async function main() {
  if (process.argv.length === 4 && process.argv[2] === '--native-app-bundle') {
    const result = await auditBuiltNativeApplication(path.resolve(process.argv[3]));
    console.log(JSON.stringify(result, null, 2));
    if (result.failures.length > 0) {
      throw new Error(
        `Skyjo built native application gate failed with ${result.failures.length} finding(s).`
      );
    }
    return;
  }
  if (process.argv.length !== 2) {
    throw new Error(
      'Usage: node scripts/check-audio-assets.mjs [--native-app-bundle <absolute-app-path>]'
    );
  }
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
