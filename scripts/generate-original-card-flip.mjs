import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sampleRate = 44_100;
const durationSeconds = 0.24;
const sampleCount = Math.round(sampleRate * durationSeconds);
const bytesPerSample = 2;
const dataBytes = sampleCount * bytesPerSample;
const wave = Buffer.alloc(44 + dataBytes);

wave.write('RIFF', 0, 'ascii');
wave.writeUInt32LE(36 + dataBytes, 4);
wave.write('WAVE', 8, 'ascii');
wave.write('fmt ', 12, 'ascii');
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(sampleRate, 24);
wave.writeUInt32LE(sampleRate * bytesPerSample, 28);
wave.writeUInt16LE(bytesPerSample, 32);
wave.writeUInt16LE(16, 34);
wave.write('data', 36, 'ascii');
wave.writeUInt32LE(dataBytes, 40);

let seed = 0x51f15e;
let previousNoise = 0;
let phase = 0;
for (let index = 0; index < sampleCount; index += 1) {
  const time = index / sampleRate;
  seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
  const noise = (seed / 0xffff_ffff) * 2 - 1;
  const highPassedNoise = noise - previousNoise * 0.86;
  previousNoise = noise;

  const attack = Math.min(1, time / 0.004);
  const decay = Math.exp(-time * 24);
  const release = time < 0.19 ? 1 : Math.max(0, (0.22 - time) / 0.03);
  const envelope = Math.sin(attack * Math.PI / 2) * decay * release;
  const frequency = 1_450 - 700 * Math.min(1, time / 0.18);
  phase += 2 * Math.PI * frequency / sampleRate;

  const secondTapTime = time - 0.058;
  const secondTap = secondTapTime >= 0
    ? Math.sin(Math.min(1, secondTapTime / 0.002) * Math.PI / 2)
      * Math.exp(-secondTapTime * 55)
    : 0;
  const signal = envelope * (highPassedNoise * 0.24 + Math.sin(phase) * 0.11)
    + secondTap * highPassedNoise * 0.07;
  const sample = Math.max(-1, Math.min(1, signal));
  wave.writeInt16LE(Math.round(sample * 32_767), 44 + index * bytesPerSample);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputs = [
  path.join(repoRoot, 'public', 'audio', 'card-flip.wav'),
  path.join(repoRoot, 'ios', 'SkyjoApp', 'Resources', 'Audio', 'card-flip.wav')
];
await Promise.all(outputs.map((output) => writeFile(output, wave)));
console.log(`Wrote ${outputs.length} byte-identical original card-flip cues (${wave.length} bytes each).`);
