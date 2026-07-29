import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const associatedDomainsEntitlement = 'com.apple.developer.associated-domains';
export const requiredAssociatedDomains = Object.freeze([
  'applinks:skyjo.groundworkrevops.com'
]);

function checkedCommand(command, arguments_, label, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout || ''}`.trim();
    throw new Error(`${label} failed${detail ? `: ${detail}` : '.'}`);
  }
  return result;
}

function parsePlist(data, label) {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'skyjo-entitlements-'));
  const plistPath = path.join(temporaryDirectory, 'value.plist');
  try {
    writeFileSync(plistPath, data);
    const result = checkedCommand(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', plistPath],
      `${label} property-list decoding`
    );
    return JSON.parse(result.stdout);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label} did not decode to a JSON property list.`);
    }
    throw error;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function validateAssociatedDomainsEntitlements(entitlements, label = 'Entitlements') {
  if (!entitlements || typeof entitlements !== 'object' || Array.isArray(entitlements)) {
    throw new Error(`${label} must be a dictionary.`);
  }
  const domains = entitlements[associatedDomainsEntitlement];
  if (!Array.isArray(domains)) {
    throw new Error(`${label} is missing the Associated Domains array.`);
  }
  if (
    domains.length !== requiredAssociatedDomains.length
    || domains.some((domain, index) => domain !== requiredAssociatedDomains[index])
  ) {
    throw new Error(
      `${label} must contain only ${requiredAssociatedDomains[0]}.`
    );
  }
}

export function entitlementSectionRange(otoolOutput, label = 'Mach-O executable') {
  const sections = [];
  let currentSection;
  const finishSection = () => {
    if (currentSection) sections.push(currentSection);
    currentSection = undefined;
  };

  for (const rawLine of otoolOutput.split('\n')) {
    const line = rawLine.trim();
    if (line === 'Section') {
      finishSection();
      currentSection = {};
      continue;
    }
    if (line.startsWith('Load command ')) {
      finishSection();
      continue;
    }
    if (!currentSection) continue;
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (match) currentSection[match[1]] = match[2];
  }
  finishSection();

  const entitlementSections = sections.filter(
    (section) => section.sectname === '__entitlements' && section.segname === '__TEXT'
  );
  if (entitlementSections.length !== 1) {
    throw new Error(`${label} must contain exactly one __TEXT,__entitlements section.`);
  }
  const section = entitlementSections[0];
  if (!/^0x[0-9a-fA-F]+$/.test(section.size || '')) {
    throw new Error(`${label} has an invalid entitlement-section size.`);
  }
  if (!/^[0-9]+$/.test(section.offset || '')) {
    throw new Error(`${label} has an invalid entitlement-section offset.`);
  }
  const offset = Number.parseInt(section.offset, 10);
  const size = Number.parseInt(section.size, 16);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`${label} has unsafe entitlement-section bounds.`);
  }
  return { offset, size };
}

function simulatorEntitlements(executablePath, architecture, temporaryDirectory) {
  const architectures = checkedCommand(
    '/usr/bin/lipo',
    ['-archs', executablePath],
    'Built executable architecture inspection'
  ).stdout.trim().split(/\s+/).filter(Boolean);
  let thinPath = executablePath;
  if (architectures.length > 1) {
    thinPath = path.join(temporaryDirectory, `SkyjoNative-${architecture}`);
    checkedCommand(
      '/usr/bin/lipo',
      [executablePath, '-thin', architecture, '-output', thinPath],
      `Built ${architecture} executable extraction`
    );
  }

  const otoolOutput = checkedCommand(
    '/usr/bin/otool',
    ['-l', thinPath],
    `Built ${architecture} executable load-command inspection`
  ).stdout;
  const { offset, size } = entitlementSectionRange(
    otoolOutput,
    `Built ${architecture} executable`
  );
  const executable = readFileSync(thinPath);
  if (offset + size > executable.length) {
    throw new Error(`Built ${architecture} executable entitlement section exceeds file bounds.`);
  }
  return parsePlist(
    executable.subarray(offset, offset + size),
    `Built ${architecture} simulator entitlements`
  );
}

function signedEntitlements(appBundlePath) {
  const result = checkedCommand(
    '/usr/bin/codesign',
    ['-d', '--entitlements', '-', '--xml', appBundlePath],
    'Built application entitlement inspection'
  );
  return parsePlist(result.stdout, 'Built application signed entitlements');
}

export function auditBuiltAssociatedDomains(appBundlePath) {
  if (!path.isAbsolute(appBundlePath)) {
    throw new Error('The application bundle path must be absolute.');
  }
  const bundleStats = lstatSync(appBundlePath);
  if (!bundleStats.isDirectory() || bundleStats.isSymbolicLink()) {
    throw new Error('The application bundle must be a real directory, not a symbolic link.');
  }
  const resolvedBundlePath = realpathSync(appBundlePath);
  const infoPath = path.join(resolvedBundlePath, 'Info.plist');
  const info = parsePlist(readFileSync(infoPath), 'Built application Info.plist');
  if (info.CFBundleIdentifier !== 'com.groundworkrevops.skyjo') {
    throw new Error('The built application has an unexpected bundle identifier.');
  }
  if (
    typeof info.CFBundleExecutable !== 'string'
    || path.basename(info.CFBundleExecutable) !== info.CFBundleExecutable
  ) {
    throw new Error('The built application has an invalid executable name.');
  }
  if (info.DTPlatformName !== 'iphoneos' && info.DTPlatformName !== 'iphonesimulator') {
    throw new Error('The built application has an unexpected Apple platform.');
  }
  const executablePath = path.join(resolvedBundlePath, info.CFBundleExecutable);
  const executableStats = lstatSync(executablePath);
  if (!executableStats.isFile() || executableStats.isSymbolicLink()) {
    throw new Error('The built application executable must be a real file.');
  }

  checkedCommand(
    '/usr/bin/codesign',
    ['--verify', '--strict', '--verbose=2', resolvedBundlePath],
    'Built application signature verification'
  );
  const signatureEntitlements = signedEntitlements(resolvedBundlePath);

  if (info.DTPlatformName === 'iphoneos') {
    validateAssociatedDomainsEntitlements(
      signatureEntitlements,
      'Built device application signed entitlements'
    );
    return { architectures: [], platform: info.DTPlatformName };
  }

  if (Object.hasOwn(signatureEntitlements, associatedDomainsEntitlement)) {
    validateAssociatedDomainsEntitlements(
      signatureEntitlements,
      'Built simulator application signed entitlements'
    );
  }
  const architectures = checkedCommand(
    '/usr/bin/lipo',
    ['-archs', executablePath],
    'Built executable architecture inspection'
  ).stdout.trim().split(/\s+/).filter(Boolean);
  if (architectures.length === 0 || new Set(architectures).size !== architectures.length) {
    throw new Error('The built simulator executable has an invalid architecture list.');
  }
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'skyjo-simulator-binary-'));
  try {
    for (const architecture of architectures) {
      validateAssociatedDomainsEntitlements(
        simulatorEntitlements(executablePath, architecture, temporaryDirectory),
        `Built ${architecture} simulator entitlements`
      );
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return { architectures, platform: info.DTPlatformName };
}

function parseArguments(arguments_) {
  if (
    arguments_.length !== 2
    || arguments_[0] !== '--app-bundle'
    || !arguments_[1]
  ) {
    throw new Error(
      'Usage: node scripts/check-ios-associated-domains.mjs --app-bundle <absolute-app-path>'
    );
  }
  return arguments_[1];
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = auditBuiltAssociatedDomains(parseArguments(process.argv.slice(2)));
    const architectureSummary = result.architectures.length > 0
      ? ` across ${result.architectures.join(', ')}`
      : '';
    console.log(
      `Verified built ${result.platform} Associated Domains entitlement${architectureSummary}.`
    );
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
