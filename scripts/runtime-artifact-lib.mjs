import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadReleaseIdentity, sha256 } from '../server-release.mjs';
import {
  artifactNames,
  assertFullReleaseSha,
  isForbiddenArchivePathSegment,
  RUNTIME_ROOT_FILES,
  RUNTIME_SBOM_NAME,
  RUNTIME_SCRIPT_FILES,
  verifyRuntimeArtifact
} from './runtime-artifact-security.mjs';

export * from './runtime-artifact-security.mjs';

const execFileAsync = promisify(execFile);

async function copyRegularFile(sourcePath, targetPath) {
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Runtime source must be a regular file: ${sourcePath}.`);
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o755 });
  await fs.copyFile(sourcePath, targetPath);
  await fs.chmod(targetPath, 0o644);
}

async function copyRegularTree(sourceDirectory, targetDirectory) {
  const rootStat = await fs.lstat(sourceDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Runtime source must be a real directory: ${sourceDirectory}.`);
  await fs.mkdir(targetDirectory, { recursive: true, mode: 0o755 });
  const children = await fs.readdir(sourceDirectory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const child of children) {
    const sourcePath = path.join(sourceDirectory, child.name);
    const targetPath = path.join(targetDirectory, child.name);
    if (child.isSymbolicLink()) throw new Error(`Runtime source contains a symlink: ${sourcePath}.`);
    if (child.isDirectory()) await copyRegularTree(sourcePath, targetPath);
    else if (child.isFile()) await copyRegularFile(sourcePath, targetPath);
    else throw new Error(`Runtime source contains a special filesystem entry: ${sourcePath}.`);
  }
}

export async function pruneForbiddenRuntimePaths(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const removed = [];
  async function visit(directory) {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const childPath = path.join(directory, child.name);
      if (isForbiddenArchivePathSegment(child.name)) {
        await fs.rm(childPath, { recursive: child.isDirectory(), force: true });
        removed.push(path.relative(root, childPath).split(path.sep).join('/'));
      } else if (child.isDirectory()) {
        await visit(childPath);
      }
    }
  }
  await visit(root);
  return removed;
}

async function normalizeRuntimeTree(rootDirectory) {
  await fs.chmod(rootDirectory, 0o755);
  const children = await fs.readdir(rootDirectory, { withFileTypes: true });
  for (const child of children) {
    const childPath = path.join(rootDirectory, child.name);
    if (child.isSymbolicLink()) throw new Error(`Runtime stage contains a symlink: ${childPath}.`);
    if (child.isDirectory()) await normalizeRuntimeTree(childPath);
    else if (child.isFile()) await fs.chmod(childPath, 0o644);
    else throw new Error(`Runtime stage contains a special filesystem entry: ${childPath}.`);
  }
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  }
}

async function assertPackagingTools() {
  if (process.platform !== 'linux') throw new Error('Reproducible runtime artifacts must be built on Linux.');
  const [{ stdout: tarVersion }, { stdout: gzipVersion }] = await Promise.all([run('tar', ['--version']), run('gzip', ['--version'])]);
  if (!tarVersion.startsWith('tar (GNU tar)')) throw new Error('GNU tar is required for reproducible runtime artifacts.');
  if (!gzipVersion.toLowerCase().includes('gzip')) throw new Error('GNU gzip is required for reproducible runtime artifacts.');
}

async function gzipFile(sourcePath, targetPath) {
  const child = spawn('gzip', ['-n', '-9', '-c', sourcePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = createWriteStream(targetPath, { flags: 'wx', mode: 0o644 });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.pipe(output);
  await Promise.all([
    new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`gzip failed${stderr.trim() ? `: ${stderr.trim()}` : ''}`)));
    }),
    new Promise((resolve, reject) => {
      output.on('error', reject);
      output.on('close', resolve);
    })
  ]);
}

function cyclonedxCliPath(projectRoot) {
  return path.join(projectRoot, 'node_modules', '@cyclonedx', 'cyclonedx-npm', 'bin', 'cyclonedx-npm-cli.js');
}

export async function generateRuntimeSbom({ projectRoot, packageRoot = projectRoot, outputPath, releaseSha }) {
  const normalizedSha = assertFullReleaseSha(releaseSha);
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedPackageRoot = path.resolve(packageRoot);
  const resolvedOutput = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedOutput), { recursive: true, mode: 0o755 });
  const cliPath = cyclonedxCliPath(resolvedProjectRoot);
  const cliStat = await fs.lstat(cliPath);
  if (!cliStat.isFile() || cliStat.isSymbolicLink()) throw new Error('Pinned CycloneDX CLI is not a regular file.');
  await run(process.execPath, [
    cliPath,
    '--omit', 'dev', 'optional',
    '--spec-version', '1.6',
    '--output-reproducible',
    '--output-format', 'JSON',
    '--output-file', resolvedOutput,
    '--validate',
    path.join(resolvedPackageRoot, 'package.json')
  ], { cwd: resolvedPackageRoot, env: { ...process.env, NODE_ENV: 'production' } });
  const sbom = JSON.parse(await fs.readFile(resolvedOutput, 'utf8'));
  const properties = Array.isArray(sbom.metadata?.component?.properties)
    ? sbom.metadata.component.properties.filter((property) => property?.name !== 'skyjo:releaseSha')
    : [];
  properties.push({ name: 'skyjo:releaseSha', value: normalizedSha });
  sbom.metadata.component.properties = properties.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  await fs.writeFile(resolvedOutput, `${JSON.stringify(sbom, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  return resolvedOutput;
}

export async function buildRuntimeArtifact({ projectRoot, outputDirectory, releaseSha }) {
  await assertPackagingTools();
  const normalizedSha = assertFullReleaseSha(releaseSha);
  const root = path.resolve(projectRoot);
  const output = path.resolve(outputDirectory);
  const names = artifactNames(normalizedSha);
  const archivePath = path.join(output, names.archiveName);
  const checksumPath = path.join(output, names.checksumName);
  const externalSbomPath = path.join(output, names.sbomName);
  const releaseIdentity = await loadReleaseIdentity(path.join(root, 'dist'), { allowDevelopment: false, requireFullSha: true });
  if (releaseIdentity.releaseSha !== normalizedSha) throw new Error('Built release identity does not match the requested artifact SHA.');
  await fs.mkdir(output, { recursive: true, mode: 0o755 });
  for (const target of [archivePath, checksumPath, externalSbomPath]) await fs.rm(target, { force: true });

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-runtime-artifact-'));
  const stage = path.join(temporaryRoot, 'stage');
  const tarPath = path.join(temporaryRoot, `${names.archiveName}.tar`);
  try {
    await fs.mkdir(stage, { recursive: true, mode: 0o755 });
    await Promise.all([
      copyRegularTree(path.join(root, 'dist'), path.join(stage, 'dist')),
      copyRegularTree(path.join(root, 'server-dist'), path.join(stage, 'server-dist'))
    ]);
    for (const relativePath of [...RUNTIME_ROOT_FILES, ...RUNTIME_SCRIPT_FILES]) {
      await copyRegularFile(path.join(root, relativePath), path.join(stage, relativePath));
    }
    await Promise.all([
      copyRegularFile(path.join(root, 'dist', 'release.json'), path.join(stage, 'release.json')),
      copyRegularFile(path.join(root, 'dist', 'release.json.sha256'), path.join(stage, 'release.json.sha256'))
    ]);
    await run('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: stage,
      env: { ...process.env, NODE_ENV: 'production' }
    });
    await Promise.all([
      fs.rm(path.join(stage, 'node_modules', '.bin'), { recursive: true, force: true }),
      fs.rm(path.join(stage, 'node_modules', '.package-lock.json'), { force: true })
    ]);
    await pruneForbiddenRuntimePaths(path.join(stage, 'node_modules'));
    await generateRuntimeSbom({ projectRoot: root, packageRoot: stage, outputPath: path.join(stage, RUNTIME_SBOM_NAME), releaseSha: normalizedSha });
    await copyRegularFile(path.join(stage, RUNTIME_SBOM_NAME), externalSbomPath);
    await normalizeRuntimeTree(stage);

    const buildEpoch = Math.floor(Date.parse(releaseIdentity.buildTimestamp) / 1000);
    await run('tar', [
      '--sort=name', '--format=ustar', `--mtime=@${buildEpoch}`, '--owner=0', '--group=0', '--numeric-owner',
      '--mode=u+rwX,go+rX,go-w', '-cf', tarPath, '-C', stage, '.'
    ]);
    await gzipFile(tarPath, archivePath);
    const archiveData = await fs.readFile(archivePath);
    const archiveChecksum = sha256(archiveData);
    await fs.writeFile(checksumPath, `${archiveChecksum}  ${names.archiveName}\n`, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    const verification = await verifyRuntimeArtifact({ archivePath, checksumPath, expectedReleaseSha: normalizedSha });
    return { ...verification, sbomPath: externalSbomPath };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
