import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractWavePcm,
  parseAppleAudioInfo,
  unexpectedNativeAudioResources
} from './check-audio-assets.mjs';

const validAppleAudioInfo = `<?xml version="1.0" encoding="UTF8"?>
<audio_info xmlns="http://apple.com/core_audio/audio_info">
  <audio_file audio_file_id="0">
    <file_type>'MPG3'</file_type>
    <tracks>
      <track track_id="1">
        <num_channels>1</num_channels>
        <sample_rate units="Hz">44100</sample_rate>
        <format_type>.mp3</format_type>
        <duration units="sec">0.391837</duration>
      </track>
    </tracks>
    <alerts></alerts>
  </audio_file>
</audio_info>`;

function riffChunk(identifier, contents) {
  const padding = contents.length % 2;
  const chunk = Buffer.alloc(8 + contents.length + padding);
  chunk.write(identifier, 0, 4, 'ascii');
  chunk.writeUInt32LE(contents.length, 4);
  contents.copy(chunk, 8);
  return chunk;
}

function testWave() {
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(44_100, 4);
  format.writeUInt32LE(88_200, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);

  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(0, 0);
  pcm.writeInt16LE(12_345, 2);
  pcm.writeInt16LE(-12_345, 4);
  pcm.writeInt16LE(0, 6);

  const chunks = Buffer.concat([
    riffChunk('fmt ', format),
    riffChunk('JUNK', Buffer.from([1, 2, 3])),
    riffChunk('data', pcm)
  ]);
  const wave = Buffer.alloc(12 + chunks.length);
  wave.write('RIFF', 0, 4, 'ascii');
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVE', 8, 4, 'ascii');
  chunks.copy(wave, 12);
  return { pcm, wave };
}

test('parseAppleAudioInfo accepts one MP3 track and preserves measured metadata', () => {
  assert.deepEqual(parseAppleAudioInfo(validAppleAudioInfo, 4_225), {
    channels: 1,
    codec: 'mp3',
    durationSeconds: 0.391837,
    sampleRate: 44_100,
    sizeBytes: 4_225
  });
});

test('parseAppleAudioInfo rejects non-MP3 and ambiguous track reports', () => {
  assert.throws(
    () => parseAppleAudioInfo(validAppleAudioInfo.replace("'MPG3'", "'WAVE'"), 4_225),
    /audio format must be MP3/
  );
  assert.throws(
    () => parseAppleAudioInfo(validAppleAudioInfo.replace('</tracks>', '<track track_id="2"></track></tracks>'), 4_225),
    /exactly one audio track/
  );
  assert.throws(
    () => parseAppleAudioInfo(validAppleAudioInfo.replace('<alerts>', '<alert level="ERROR"></alert><alerts>'), 4_225),
    /reported an error/
  );
});

test('extractWavePcm accepts bounded mono 16-bit PCM and skips padded metadata chunks', () => {
  const { pcm, wave } = testWave();
  assert.deepEqual(extractWavePcm(wave, 44_100), pcm);
});

test('extractWavePcm rejects mismatched formats and truncated data chunks', () => {
  const { wave } = testWave();
  const wrongFormat = Buffer.from(wave);
  wrongFormat.writeUInt16LE(3, 20);
  assert.throws(() => extractWavePcm(wrongFormat, 44_100), /must be mono signed 16-bit PCM/);

  const truncatedData = Buffer.from(wave);
  const dataOffset = truncatedData.indexOf(Buffer.from('data'));
  assert.notEqual(dataOffset, -1);
  truncatedData.writeUInt32LE(1_000, dataOffset + 4);
  assert.throws(() => extractWavePcm(truncatedData, 44_100), /chunk exceeds the file bounds/);
});

test('native audio inventory rejects alternate bundled formats outside the exact cue allowlist', () => {
  assert.deepEqual(
    unexpectedNativeAudioResources([
      'Audio/card-flip.mp3',
      'Audio/card-pickup.mp3',
      'Audio/card-place.mp3',
      'Audio/table-ambience.m4a',
      'Audio/ringtone.m4r',
      'Effects/bonus.WAV',
      'Effects/voice.aifc',
      'Music/radio.adts',
      'Music/theme.mp4',
      'Music/trailer.3gp',
      'Music/theme.caf',
      'Assets.xcassets/Contents.json',
      'Audio/README.md'
    ]),
    [
      'Audio/ringtone.m4r',
      'Audio/table-ambience.m4a',
      'Effects/bonus.WAV',
      'Effects/voice.aifc',
      'Music/radio.adts',
      'Music/theme.caf',
      'Music/theme.mp4',
      'Music/trailer.3gp'
    ]
  );
});
