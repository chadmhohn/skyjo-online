import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  boundedReadOpenFlags,
  builtNativeApplicationInventoryFailures,
  extractWavePcm,
  nativeApplicationResourceNames,
  parseAppleAudioInfo,
  publicResourceInventoryFailures,
  readBoundedRegularFile,
  unexpectedNativeResources,
  unexpectedPublicResources
} from './check-audio-assets.mjs';

const boundedReadsSupported = typeof constants.O_RDONLY === 'number'
  && typeof constants.O_NOFOLLOW === 'number'
  && typeof constants.O_NONBLOCK === 'number';
const boundedReadTestOptions = { skip: !boundedReadsSupported };

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

function instrumentedFileOperations(hooks = {}) {
  let descriptor;
  let closeCount = 0;
  let fstatCall = 0;
  let lstatCall = 0;
  let openCount = 0;
  let readCall = 0;
  const operations = {
    closeSync(value) {
      closeCount += 1;
      return closeSync(value);
    },
    fstatSync(...args) {
      const call = fstatCall;
      fstatCall += 1;
      hooks.beforeFstat?.({ call, descriptor: args[0] });
      const stat = fstatSync(...args);
      hooks.afterFstat?.({ call, descriptor: args[0], stat });
      return hooks.transformFstat?.({ call, descriptor: args[0], stat }) ?? stat;
    },
    lstatSync(...args) {
      const call = lstatCall;
      lstatCall += 1;
      hooks.beforeLstat?.({ call, filePath: args[0] });
      const stat = lstatSync(...args);
      hooks.afterLstat?.({ call, filePath: args[0], stat });
      return stat;
    },
    openSync(...args) {
      openCount += 1;
      hooks.beforeOpen?.({ filePath: args[0], flags: args[1] });
      descriptor = openSync(...args);
      return descriptor;
    },
    readSync(...args) {
      const call = readCall;
      readCall += 1;
      hooks.beforeRead?.({ call, descriptor: args[0] });
      const bytesRead = readSync(...args);
      hooks.afterRead?.({ bytesRead, call, descriptor: args[0] });
      return bytesRead;
    }
  };
  return {
    closeCount: () => closeCount,
    descriptor: () => descriptor,
    openCount: () => openCount,
    operations
  };
}

function assertDescriptorClosed(instrumentation) {
  assert.equal(instrumentation.closeCount(), 1);
  assert.notEqual(instrumentation.descriptor(), undefined);
  assert.throws(
    () => fstatSync(instrumentation.descriptor()),
    (error) => error?.code === 'EBADF'
  );
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

test('bounded read flags fail closed when atomic protections are unavailable', () => {
  assert.throws(
    () => boundedReadOpenFlags({ O_RDONLY: 0, O_NONBLOCK: 4 }),
    /require O_NOFOLLOW and O_NONBLOCK support/
  );
  assert.throws(
    () => boundedReadOpenFlags({ O_RDONLY: 0, O_NOFOLLOW: 2 }),
    /require O_NOFOLLOW and O_NONBLOCK support/
  );
  if (boundedReadsSupported) {
    assert.equal(
      boundedReadOpenFlags(constants),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  }
});

test('bounded reads do not open or close a file when atomic protections are unavailable', () => {
  const instrumentation = instrumentedFileOperations();
  assert.throws(
    () => readBoundedRegularFile(
      '/not-opened',
      4,
      'Decoded WAVE output',
      instrumentation.operations,
      { O_RDONLY: 0, O_NONBLOCK: 4 }
    ),
    /require O_NOFOLLOW and O_NONBLOCK support/
  );
  assert.equal(instrumentation.openCount(), 0);
  assert.equal(instrumentation.closeCount(), 0);
});

test('bounded regular-file reads reject oversized, linked, and non-file output', boundedReadTestOptions, () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'skyjo-audio-reader-test-'));
  try {
    const decodedPath = path.join(temporaryDirectory, 'decoded.wav');
    writeFileSync(decodedPath, Buffer.from([1, 2, 3, 4]));
    assert.deepEqual(
      readBoundedRegularFile(decodedPath, 4, 'Decoded WAVE output'),
      Buffer.from([1, 2, 3, 4])
    );
    assert.throws(
      () => readBoundedRegularFile(decodedPath, 3, 'Decoded WAVE output'),
      /4 bytes exceeds the audio gate's safe bound/
    );

    const linkedPath = path.join(temporaryDirectory, 'linked.wav');
    symlinkSync(decodedPath, linkedPath);
    assert.throws(
      () => readBoundedRegularFile(linkedPath, 4, 'Decoded WAVE output'),
      /ELOOP|symbolic link|too many levels/i
    );

    const directoryPath = path.join(temporaryDirectory, 'directory.wav');
    mkdirSync(directoryPath);
    assert.throws(
      () => readBoundedRegularFile(directoryPath, 4, 'Decoded WAVE output'),
      /must be a regular file/
    );
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test(
  'bounded regular-file reads reject a FIFO without waiting for a writer',
  { skip: process.platform === 'win32' || !boundedReadsSupported },
  () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'skyjo-audio-fifo-test-'));
    try {
      const fifoPath = path.join(temporaryDirectory, 'decoded.wav');
      const result = spawnSync('mkfifo', [fifoPath], {
        encoding: 'utf8',
        timeout: 2_000
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const moduleUrl = new URL('./check-audio-assets.mjs', import.meta.url).href;
      const childScript = `
        import { readBoundedRegularFile } from ${JSON.stringify(moduleUrl)};
        try {
          readBoundedRegularFile(process.argv[1], 4, 'Decoded WAVE output');
          process.exitCode = 2;
        } catch (error) {
          if (!/must be a regular file/.test(String(error?.message))) throw error;
        }
      `;
      const probe = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', childScript, fifoPath],
        { encoding: 'utf8', timeout: 2_000 }
      );
      assert.equal(probe.error, undefined, probe.error?.message);
      assert.equal(probe.status, 0, probe.stderr);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  }
);

test('bounded regular-file reads reject post-open path replacement and close the descriptor', boundedReadTestOptions, () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'skyjo-audio-open-race-test-'));
  try {
    const decodedPath = path.join(temporaryDirectory, 'decoded.wav');
    const pinnedPath = path.join(temporaryDirectory, 'pinned.wav');
    writeFileSync(decodedPath, Buffer.from([1, 2, 3, 4]));
    const instrumentation = instrumentedFileOperations({
      afterFstat({ call }) {
        if (call === 0) {
          renameSync(decodedPath, pinnedPath);
          writeFileSync(decodedPath, Buffer.from([1, 2, 3, 4]));
        }
      }
    });
    assert.throws(
      () => readBoundedRegularFile(
        decodedPath,
        4,
        'Decoded WAVE output',
        instrumentation.operations
      ),
      /changed while it was being opened/
    );
    assertDescriptorClosed(instrumentation);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('bounded regular-file reads reject partial truncation during the read and close the descriptor', boundedReadTestOptions, () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'skyjo-audio-truncate-race-test-'));
  try {
    const decodedPath = path.join(temporaryDirectory, 'decoded.wav');
    writeFileSync(decodedPath, Buffer.from([1, 2, 3, 4]));
    const instrumentation = instrumentedFileOperations({
      beforeRead({ call }) {
        if (call === 0) truncateSync(decodedPath, 2);
        if (call === 1) truncateSync(decodedPath, 0);
      }
    });
    assert.throws(
      () => readBoundedRegularFile(
        decodedPath,
        4,
        'Decoded WAVE output',
        instrumentation.operations
      ),
      /changed while it was being read/
    );
    assertDescriptorClosed(instrumentation);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('bounded regular-file reads reject appended overflow and close the descriptor', boundedReadTestOptions, () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'skyjo-audio-overflow-race-test-'));
  try {
    const decodedPath = path.join(temporaryDirectory, 'decoded.wav');
    writeFileSync(decodedPath, Buffer.from([1, 2, 3, 4]));
    const instrumentation = instrumentedFileOperations({
      afterRead({ call }) {
        if (call === 0) appendFileSync(decodedPath, Buffer.from([5]));
      }
    });
    assert.throws(
      () => readBoundedRegularFile(
        decodedPath,
        5,
        'Decoded WAVE output',
        instrumentation.operations
      ),
      /grew while it was being read/
    );
    assertDescriptorClosed(instrumentation);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('bounded regular-file reads reject a final size change after the overflow probe', boundedReadTestOptions, () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'skyjo-audio-final-race-test-'));
  try {
    const decodedPath = path.join(temporaryDirectory, 'decoded.wav');
    writeFileSync(decodedPath, Buffer.from([1, 2, 3, 4]));
    const instrumentation = instrumentedFileOperations({
      afterRead({ bytesRead, call }) {
        if (call === 1 && bytesRead === 0) {
          appendFileSync(decodedPath, Buffer.from([5]));
        }
      }
    });
    assert.throws(
      () => readBoundedRegularFile(
        decodedPath,
        5,
        'Decoded WAVE output',
        instrumentation.operations
      ),
      /changed while it was being read/
    );
    assertDescriptorClosed(instrumentation);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('bounded regular-file reads reject late same-size path replacement', boundedReadTestOptions, () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'skyjo-audio-late-path-race-test-'));
  try {
    const decodedPath = path.join(temporaryDirectory, 'decoded.wav');
    const pinnedPath = path.join(temporaryDirectory, 'pinned.wav');
    writeFileSync(decodedPath, Buffer.from([1, 2, 3, 4]));
    const instrumentation = instrumentedFileOperations({
      afterRead({ bytesRead, call }) {
        if (call === 1 && bytesRead === 0) {
          renameSync(decodedPath, pinnedPath);
          writeFileSync(decodedPath, Buffer.from([1, 2, 3, 4]));
        }
      }
    });
    assert.throws(
      () => readBoundedRegularFile(
        decodedPath,
        4,
        'Decoded WAVE output',
        instrumentation.operations
      ),
      /changed while it was being read/
    );
    assertDescriptorClosed(instrumentation);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('bounded regular-file reads detect nanosecond metadata changes', boundedReadTestOptions, () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'skyjo-audio-metadata-race-test-'));
  try {
    const decodedPath = path.join(temporaryDirectory, 'decoded.wav');
    writeFileSync(decodedPath, Buffer.from([1, 2, 3, 4]));
    const instrumentation = instrumentedFileOperations({
      transformFstat({ call, stat }) {
        if (call !== 1) return stat;
        return {
          ...stat,
          ctimeNs: stat.ctimeNs + 1n,
          isFile: () => stat.isFile()
        };
      }
    });
    assert.throws(
      () => readBoundedRegularFile(
        decodedPath,
        4,
        'Decoded WAVE output',
        instrumentation.operations
      ),
      /changed while it was being read/
    );
    assertDescriptorClosed(instrumentation);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('bounded regular-file reads close the descriptor after a successful read', boundedReadTestOptions, () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'skyjo-audio-success-close-test-'));
  try {
    const decodedPath = path.join(temporaryDirectory, 'decoded.wav');
    writeFileSync(decodedPath, Buffer.from([1, 2, 3, 4]));
    const instrumentation = instrumentedFileOperations();
    assert.deepEqual(
      readBoundedRegularFile(
        decodedPath,
        4,
        'Decoded WAVE output',
        instrumentation.operations
      ),
      Buffer.from([1, 2, 3, 4])
    );
    assertDescriptorClosed(instrumentation);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

for (const [failureName, hooks, expectedError] of [
  ['path inspection', { beforeLstat: () => { throw new Error('injected lstat failure'); } }, /injected lstat failure/],
  ['descriptor read', { beforeRead: () => { throw new Error('injected read failure'); } }, /injected read failure/]
]) {
  test(`bounded regular-file reads close the descriptor after ${failureName} failure`, boundedReadTestOptions, () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'skyjo-audio-operation-failure-test-'));
    try {
      const decodedPath = path.join(temporaryDirectory, 'decoded.wav');
      writeFileSync(decodedPath, Buffer.from([1, 2, 3, 4]));
      const instrumentation = instrumentedFileOperations(hooks);
      assert.throws(
        () => readBoundedRegularFile(
          decodedPath,
          4,
          'Decoded WAVE output',
          instrumentation.operations
        ),
        expectedError
      );
      assertDescriptorClosed(instrumentation);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });
}

test('bounded regular-file reads do not close a descriptor when opening fails', boundedReadTestOptions, () => {
  const instrumentation = instrumentedFileOperations({
    beforeOpen() {
      const error = new Error('injected open failure');
      error.code = 'EACCES';
      throw error;
    }
  });
  assert.throws(
    () => readBoundedRegularFile(
      '/not-opened',
      4,
      'Decoded WAVE output',
      instrumentation.operations
    ),
    /injected open failure/
  );
  assert.equal(instrumentation.openCount(), 1);
  assert.equal(instrumentation.closeCount(), 0);
  assert.equal(instrumentation.descriptor(), undefined);
});

test('native resource inventory rejects alternate or disguised media outside the exact allowlist', () => {
  assert.deepEqual(
    unexpectedNativeResources([
      'Audio/card-flip.mp3',
      'Audio/card-pickup.mp3',
      'Audio/card-place.mp3',
      'Audio/README.md',
      'Audio/table-ambience.m4a',
      'Audio/ringtone.m4r',
      'Audio/disguised.bin',
      'Assets.xcassets/Contents.json',
      'Assets.xcassets/Hidden.dataset/theme.data',
      'Effects/bonus.WAV',
      'Effects/voice.aifc',
      'Music/radio.adts',
      'Music/theme.mp4',
      'Music/theme.m4v',
      'Music/trailer.3gp',
      'Music/theme.caf',
      'PrivacyInfo.xcprivacy'
    ]),
    [
      'Assets.xcassets/Hidden.dataset/theme.data',
      'Audio/disguised.bin',
      'Audio/ringtone.m4r',
      'Audio/table-ambience.m4a',
      'Effects/bonus.WAV',
      'Effects/voice.aifc',
      'Music/radio.adts',
      'Music/theme.caf',
      'Music/theme.m4v',
      'Music/theme.mp4',
      'Music/trailer.3gp'
    ]
  );
});

test('public inventory rejects media anywhere outside the exact published allowlist', () => {
  assert.deepEqual(
    unexpectedPublicResources([
      'audio/README.md',
      'audio/card-flip.mp3',
      'audio/card-pickup.mp3',
      'audio/card-place.mp3',
      'manifest.webmanifest',
      'skyjo-icon.svg',
      'audio/theme.m4v',
      'music/theme.m4v',
      'theme.bin',
      'nested/voice.caf'
    ]),
    ['audio/theme.m4v', 'music/theme.m4v', 'nested/voice.caf', 'theme.bin']
  );
  assert.deepEqual(
    publicResourceInventoryFailures([
      'audio/README.md',
      'audio/card-flip.mp3',
      'audio/card-pickup.mp3',
      'audio/card-place.mp3',
      'manifest.webmanifest',
      'skyjo-icon-180.png',
      'skyjo-icon-192.png',
      'skyjo-icon-512.png',
      'skyjo-icon-v2-180.png',
      'skyjo-icon-v2-192.png',
      'skyjo-icon-v2-512.png',
      'skyjo-icon-v2.svg',
      'music/theme.m4v'
    ]),
    [
      'Missing approved public resource skyjo-icon.svg.',
      'Unexpected public resource music/theme.m4v.'
    ]
  );
});

test('clean native application inventory rejects every nested or disguised addition', () => {
  const approved = [
    'Assets.car',
    'Info.plist',
    'PkgInfo',
    'PrivacyInfo.xcprivacy',
    'SkyjoNative',
    'card-flip.mp3',
    'card-pickup.mp3',
    'card-place.mp3'
  ];
  assert.deepEqual(builtNativeApplicationInventoryFailures(approved), []);
  assert.deepEqual(
    builtNativeApplicationInventoryFailures([
      ...approved.filter((file) => file !== 'PrivacyInfo.xcprivacy'),
      'Frameworks/Some.framework/theme.m4v',
      'PlugIns/Anything.appex/theme.bin'
    ]),
    [
      'Missing approved native application bundle file PrivacyInfo.xcprivacy.',
      'Unexpected native application bundle file Frameworks/Some.framework/theme.m4v.',
      'Unexpected native application bundle file PlugIns/Anything.appex/theme.bin.'
    ]
  );
});

test('Xcode application resource phase inventory fails closed on added build resources', () => {
  const project = `
/* Begin PBXNativeTarget section */
    A10000000000000000000001 /* SkyjoNative */ = {
      isa = PBXNativeTarget;
      buildPhases = (
        A20000000000000000000003 /* Resources */,
      );
      productType = "com.apple.product-type.application";
    };
/* End PBXNativeTarget section */
/* Begin PBXResourcesBuildPhase section */
    A20000000000000000000003 /* Resources */ = {
      isa = PBXResourcesBuildPhase;
      files = (
        B20000000000000000000005 /* Assets.xcassets in Resources */,
        C20000000000000000000006 /* card-flip.mp3 in Resources */,
        D20000000000000000000001 /* theme.m4v in Resources */,
      );
    };
/* End PBXResourcesBuildPhase section */`;
  assert.deepEqual(
    nativeApplicationResourceNames(project),
    ['Assets.xcassets', 'card-flip.mp3', 'theme.m4v']
  );
  assert.throws(
    () => nativeApplicationResourceNames(project.replace(' in Resources */', ' */')),
    /unparseable resource entry/
  );
});
