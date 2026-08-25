import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AI_BENCHMARK_BUDGETS,
  AI_BENCHMARK_DRAW_OUTCOME_COUNT,
  AI_BENCHMARK_EVALUATOR,
  AI_BENCHMARK_FORMAT_VERSION,
  AI_BENCHMARK_KIND,
  AI_BENCHMARK_PARAMETERS,
  aiBenchmarkSha256,
  readAiBenchmarkReleaseVersion,
  readVerifiedAiBenchmarkEvidence,
  resolveAiBenchmarkSourceSha,
  serializeAiBenchmarkEvidence,
  validateAiBenchmarkEvidence,
  writeAiBenchmarkEvidence
} from '../../../scripts/ai-benchmark-evidence.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..', '..', '..');
const sourceSha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const releaseVersion = '0.3.7';
const temporaryRoots: string[] = [];

function profile(benefit: number, regret: number) {
  return {
    aggregateBenefit: benefit,
    aggregateRegret: regret,
    scenarios: Object.fromEntries(
      Array.from({ length: 19 }, (_, index) => [
        `scenario-${String(index + 1).padStart(2, '0')}`,
        { benefit, regret, weight: 1 }
      ])
    )
  };
}

function evidence() {
  return {
    formatVersion: AI_BENCHMARK_FORMAT_VERSION,
    kind: AI_BENCHMARK_KIND,
    sourceSha,
    releaseVersion,
    strategyVersion: 1,
    parameters: { ...AI_BENCHMARK_PARAMETERS },
    budgets: { ...AI_BENCHMARK_BUDGETS },
    performance: {
      sampleCount: AI_BENCHMARK_PARAMETERS.performanceSamples,
      outcomeLimit: AI_BENCHMARK_DRAW_OUTCOME_COUNT,
      p50Ms: 0.01,
      p95Ms: 0.05,
      maxMs: 0.1
    },
    quality: {
      easy: profile(1, 4),
      medium: profile(2, 3),
      hard: profile(3, 2),
      ultra: profile(4, 1)
    },
    seededDeals: {
      sampleCount: AI_BENCHMARK_PARAMETERS.seededDealSamples,
      firstSeed: AI_BENCHMARK_PARAMETERS.seededDealFirstSeed,
      lastSeed: AI_BENCHMARK_PARAMETERS.seededDealFirstSeed + AI_BENCHMARK_PARAMETERS.seededDealSamples - 1,
      evaluator: AI_BENCHMARK_EVALUATOR,
      benefits: { easy: 1, medium: 2, hard: 3, ultra: 4 },
      regret: { easy: 4, medium: 3, hard: 2, ultra: 1 }
    }
  };
}

type BenchmarkEvidence = ReturnType<typeof evidence>;

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-ai-evidence-'));
  temporaryRoots.push(directory);
  return directory;
}

async function cleanGitRepository() {
  const directory = await temporaryDirectory();
  await execFileAsync('git', ['init', '--quiet'], { cwd: directory });
  await fs.writeFile(path.join(directory, 'tracked.txt'), 'benchmark source\n', 'utf8');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: directory });
  await execFileAsync('git', [
    '-c',
    'user.name=Skyjo Tests',
    '-c',
    'user.email=skyjo-tests@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'benchmark source'
  ], { cwd: directory });
  return directory;
}

async function writeRawEvidence(filePath: string, data: string) {
  const digest = aiBenchmarkSha256(data);
  await fs.writeFile(filePath, data, 'utf8');
  await fs.writeFile(`${filePath}.sha256`, `${digest}  ${path.basename(filePath)}\n`, 'utf8');
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('certifiable AI benchmark evidence', () => {
  it('resolves exact environment identities and safely falls back to local Git HEAD', async () => {
    await expect(resolveAiBenchmarkSourceSha({
      environment: { GITHUB_SHA: otherSha, SKYJO_RELEASE_SHA: sourceSha },
      projectRoot: root
    })).resolves.toBe(sourceSha);
    await expect(resolveAiBenchmarkSourceSha({
      environment: { GITHUB_SHA: otherSha, SKYJO_RELEASE_SHA: '  ' },
      projectRoot: root
    })).resolves.toBe(otherSha);
    const gitRoot = await cleanGitRepository();
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: gitRoot,
      encoding: 'utf8'
    });
    await expect(resolveAiBenchmarkSourceSha({ environment: {}, projectRoot: gitRoot })).resolves.toBe(stdout.trim());
    await fs.writeFile(path.join(gitRoot, 'untracked.txt'), 'dirty\n', 'utf8');
    await expect(resolveAiBenchmarkSourceSha({ environment: {}, projectRoot: gitRoot })).rejects.toThrow(
      /requires a clean working tree/i
    );
    await expect(resolveAiBenchmarkSourceSha({
      environment: { SKYJO_RELEASE_SHA: 'BAD' },
      projectRoot: root
    })).rejects.toThrow(/full lowercase 40-character/i);
    await expect(resolveAiBenchmarkSourceSha({
      environment: {},
      projectRoot: path.join(root, 'missing-git-root')
    })).rejects.toThrow(/unavailable from the environment or local Git HEAD/i);
  });

  it('reads the canonical package release version and rejects invalid package metadata', async () => {
    await expect(readAiBenchmarkReleaseVersion(root)).resolves.toBe(releaseVersion);
    const directory = await temporaryDirectory();
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: 'not-semver' }), 'utf8');
    await expect(readAiBenchmarkReleaseVersion(directory)).rejects.toThrow(/canonical package version/i);
    await fs.writeFile(path.join(directory, 'package.json'), '{', 'utf8');
    await expect(readAiBenchmarkReleaseVersion(directory)).rejects.toThrow(/metadata is unavailable or invalid/i);
  });

  it('writes sorted canonical JSON plus an exact checksum and verifies the expected identities', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'benchmark.json');
    const value = evidence();
    const written = await writeAiBenchmarkEvidence(filePath, value);
    const data = await fs.readFile(filePath, 'utf8');
    expect(data.startsWith('{\n  "budgets"')).toBe(true);
    expect(data.endsWith('\n')).toBe(true);
    expect(await fs.readFile(written.checksumPath, 'utf8')).toBe(`${written.digest}  benchmark.json\n`);
    const verified = await readVerifiedAiBenchmarkEvidence(filePath, written.checksumPath, {
      expectedReleaseVersion: releaseVersion,
      expectedSourceSha: sourceSha,
      expectedStrategyVersion: 1
    });
    expect(verified).toEqual({ digest: written.digest, evidence: value });
    expect(serializeAiBenchmarkEvidence(value)).toBe(data);
  });

  it('rejects content tampering, wrong source identity, malformed checksums, and noncanonical JSON', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'benchmark.json');
    const written = await writeAiBenchmarkEvidence(filePath, evidence());
    await fs.appendFile(filePath, ' ', 'utf8');
    await expect(readVerifiedAiBenchmarkEvidence(filePath, written.checksumPath, {
      expectedSourceSha: sourceSha
    })).rejects.toThrow(/checksum mismatch/i);

    await writeAiBenchmarkEvidence(filePath, evidence());
    await expect(readVerifiedAiBenchmarkEvidence(filePath, written.checksumPath, {
      expectedSourceSha: otherSha
    })).rejects.toThrow(/does not match the expected source/i);
    await expect(readVerifiedAiBenchmarkEvidence(filePath, written.checksumPath)).rejects.toThrow(/requires an expected source/i);

    await fs.writeFile(written.checksumPath, `${'0'.repeat(64)}  wrong.json\n`, 'utf8');
    await expect(readVerifiedAiBenchmarkEvidence(filePath, written.checksumPath, {
      expectedSourceSha: sourceSha
    })).rejects.toThrow(/checksum file is invalid/i);

    const noncanonical = `${JSON.stringify(evidence())}\n`;
    await writeRawEvidence(filePath, noncanonical);
    await expect(readVerifiedAiBenchmarkEvidence(filePath, `${filePath}.sha256`, {
      expectedSourceSha: sourceSha
    })).rejects.toThrow(/not canonically serialized/i);

    const invalidJson = '{\n';
    await writeRawEvidence(filePath, invalidJson);
    await expect(readVerifiedAiBenchmarkEvidence(filePath, `${filePath}.sha256`, {
      expectedSourceSha: sourceSha
    })).rejects.toThrow(/not valid JSON/i);
  });

  it.each([
    ['format', (value: BenchmarkEvidence) => { value.formatVersion = 2; }, /format version/i],
    ['kind', (value: BenchmarkEvidence) => { value.kind = 'other'; }, /kind/i],
    ['source', (value: BenchmarkEvidence) => { value.sourceSha = sourceSha.toUpperCase(); }, /full lowercase/i],
    ['release', (value: BenchmarkEvidence) => { value.releaseVersion = 'latest'; }, /canonical package version/i],
    ['strategy', (value: BenchmarkEvidence) => { value.strategyVersion = 0; }, /strategy version/i],
    ['parameter', (value: BenchmarkEvidence) => { value.parameters.seededDealSamples = 1; }, /parameter seededDealSamples/i],
    ['budget', (value: BenchmarkEvidence) => { value.budgets.p95Ms = 10; }, /budget p95Ms/i],
    ['timing order', (value: BenchmarkEvidence) => { value.performance.p50Ms = 0.06; }, /not monotonic/i],
    ['timing budget', (value: BenchmarkEvidence) => { value.performance.p95Ms = 5; value.performance.maxMs = 5; }, /budget was not met/i],
    ['scenario count', (value: BenchmarkEvidence) => { delete value.quality.easy.scenarios['scenario-19']; }, /19 scenarios/i],
    ['scenario identity', (value: BenchmarkEvidence) => { value.quality.medium.scenarios.different = value.quality.medium.scenarios['scenario-19']; delete value.quality.medium.scenarios['scenario-19']; }, /identical scenarios/i],
    ['aggregate', (value: BenchmarkEvidence) => { value.quality.hard.aggregateBenefit = 99; }, /does not match its scenarios/i],
    ['quality order', (value: BenchmarkEvidence) => { value.quality.ultra = profile(2, 3); }, /benefits are not ordered/i],
    ['evaluator', (value: BenchmarkEvidence) => { value.seededDeals.evaluator = 'different'; }, /certified evaluator/i],
    ['first seed', (value: BenchmarkEvidence) => { value.seededDeals.firstSeed = 2; }, /first dealt-game seed/i],
    ['last seed', (value: BenchmarkEvidence) => { value.seededDeals.lastSeed = 1999; }, /last dealt-game seed/i],
    ['seeded order', (value: BenchmarkEvidence) => { value.seededDeals.benefits.ultra = 0; }, /benefits are not ordered/i]
  ])('rejects invalid %s evidence', (_label, mutate, expected) => {
    const value = evidence();
    mutate(value);
    expect(() => validateAiBenchmarkEvidence(value)).toThrow(expected);
  });

  it('rejects mismatched release and strategy expectations', () => {
    expect(() => validateAiBenchmarkEvidence(evidence(), {
      expectedReleaseVersion: '0.2.1'
    })).toThrow(/does not match the expected package release/i);
    expect(() => validateAiBenchmarkEvidence(evidence(), {
      expectedStrategyVersion: 2
    })).toThrow(/does not match the expected strategy/i);
  });
});
