import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function runtimeVersion(identifier) {
  const match = identifier.match(/\.iOS-([0-9-]+)$/);
  return match ? match[1].split('-').map(Number) : [];
}

function compareVersions(lhs, rhs) {
  const length = Math.max(lhs.length, rhs.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (lhs[index] ?? 0) - (rhs[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function selectByScore(devices, score) {
  return devices
    .map((device) => ({ device, score: score(device.name) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((lhs, rhs) => lhs.score - rhs.score || lhs.device.name.localeCompare(rhs.device.name))[0]
    ?.device;
}

export function selectSimulatorMatrix(payload) {
  const runtime = Object.keys(payload.devices ?? {})
    .filter((identifier) => identifier.includes('.SimRuntime.iOS-'))
    .sort((lhs, rhs) => compareVersions(runtimeVersion(rhs), runtimeVersion(lhs)))[0];
  if (!runtime) throw new Error('No available iOS Simulator runtime was found.');

  const available = payload.devices[runtime].filter(
    (device) => device.isAvailable !== false && !device.availabilityError
  );
  const iPhones = available.filter((device) => device.name.startsWith('iPhone '));
  const iPads = available.filter((device) => device.name.startsWith('iPad'));

  const standard = selectByScore(iPhones, (name) => {
    if (/mini$/i.test(name)) return 0;
    if (/iPhone SE/i.test(name)) return 5;
    if (/e$/i.test(name)) return 10;
    if (/iPhone [0-9]+$/.test(name)) return 20;
    if (/ Pro$/.test(name)) return 30;
    if (!/(Max|Plus|Air)/i.test(name)) return 40;
    return Number.POSITIVE_INFINITY;
  });
  const large = selectByScore(iPhones, (name) => {
    if (/Pro Max$/i.test(name)) return 0;
    if (/Plus$/i.test(name)) return 10;
    if (/Air$/i.test(name)) return 20;
    return Number.POSITIVE_INFINITY;
  });
  const iPad = selectByScore(iPads, (name) => {
    if (/iPad Pro 13-inch/i.test(name)) return 0;
    if (/13-inch/i.test(name)) return 10;
    if (/iPad Pro 11-inch/i.test(name)) return 20;
    if (/11-inch/i.test(name)) return 30;
    if (/iPad \(/i.test(name)) return 40;
    if (/mini/i.test(name)) return 50;
    return 60;
  });

  if (!standard) throw new Error(`No standard iPhone is available on ${runtime}.`);
  if (!large) throw new Error(`No large iPhone is available on ${runtime}.`);
  if (!iPad) throw new Error(`No iPad is available on ${runtime}.`);
  if (standard.udid === large.udid) {
    throw new Error('The standard and large iPhone matrix entries must be distinct.');
  }

  return [
    { role: 'standard-phone', runtime, ...standard },
    { role: 'large-phone', runtime, ...large },
    { role: 'ipad', runtime, ...iPad }
  ];
}

function main() {
  const input = fs.readFileSync(0, 'utf8');
  const matrix = selectSimulatorMatrix(JSON.parse(input));
  for (const device of matrix) {
    console.log([device.role, device.runtime, device.name, device.udid].join('\t'));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
