import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const fullShaPattern = /^[a-f0-9]{40}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const releaseVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const difficulties = Object.freeze(['easy', 'medium', 'hard', 'ultra']);

export const AI_BENCHMARK_FORMAT_VERSION = 1;
export const AI_BENCHMARK_KIND = 'skyjo-ai-benchmark';
export const AI_BENCHMARK_BUDGETS = Object.freeze({ p95Ms: 5, maxMs: 16 });
export const AI_BENCHMARK_PARAMETERS = Object.freeze({
  benchmarkAiOpponentCount: 7,
  benchmarkStateSeed: 163,
  closingScenarioWeight: 0.25,
  performanceSamples: 500,
  performanceWarmupSamples: 80,
  qualitySamplesPerScenario: 64,
  seededDealAiOpponentCount: 1,
  seededDealFirstSeed: 1,
  seededDealSamples: 2_000
});
export const AI_BENCHMARK_DRAW_OUTCOME_COUNT = 15;
export const AI_BENCHMARK_EVALUATOR =
  'actual reducer outcome with omniscient grid delta, reveal progress, and closer doubling';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(assertRecord(value, label)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unexpected fields.`);
  }
}

function finiteNumber(value, label, { integer = false, minimum = Number.NEGATIVE_INFINITY } = {}) {
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${label} must be a finite${integer ? ' safe integer' : ''}.`);
  }
  return value;
}

function assertExactNumber(value, expected, label) {
  finiteNumber(value, label);
  if (value !== expected) throw new Error(`${label} must equal ${expected}.`);
}

function assertFullSourceSha(value, label = 'AI benchmark source SHA') {
  if (typeof value !== 'string' || !fullShaPattern.test(value)) {
    throw new Error(`${label} must be a full lowercase 40-character commit SHA.`);
  }
  return value;
}

function assertReleaseVersion(value, label = 'AI benchmark release version') {
  if (typeof value !== 'string' || !releaseVersionPattern.test(value)) {
    throw new Error(`${label} must be a canonical package version.`);
  }
  return value;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
}

function validateDifficultyNumbers(value, label, { minimum = Number.NEGATIVE_INFINITY } = {}) {
  assertExactKeys(value, difficulties, label);
  for (const difficulty of difficulties) finiteNumber(value[difficulty], `${label} ${difficulty}`, { minimum });
}

function validateOrderedCalibration(benefits, regret, label) {
  if (
    benefits.ultra < benefits.hard ||
    benefits.hard < benefits.medium ||
    benefits.medium < benefits.easy
  ) {
    throw new Error(`${label} benefits are not ordered Easy through Ultra.`);
  }
  if (regret.ultra > regret.hard || regret.hard > regret.medium || regret.medium > regret.easy) {
    throw new Error(`${label} regret is not ordered Ultra through Easy.`);
  }
}

export async function resolveAiBenchmarkSourceSha({ environment = process.env, projectRoot = process.cwd() } = {}) {
  const environmentSha = [environment.SKYJO_RELEASE_SHA, environment.GITHUB_SHA]
    .find((value) => typeof value === 'string' && value.trim().length > 0);
  if (environmentSha !== undefined) return assertFullSourceSha(environmentSha.trim());

  let stdout;
  let status;
  try {
    ({ stdout } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: path.resolve(projectRoot),
      encoding: 'utf8',
      maxBuffer: 1024,
      windowsHide: true
    }));
    ({ stdout: status } = await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: path.resolve(projectRoot),
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      windowsHide: true
    }));
  } catch {
    throw new Error('AI benchmark source SHA is unavailable from the environment or local Git HEAD.');
  }
  if (String(status).trim().length > 0) {
    throw new Error('Local Git HEAD fallback requires a clean working tree.');
  }
  return assertFullSourceSha(String(stdout).trim(), 'Local Git HEAD');
}

export async function readAiBenchmarkReleaseVersion(projectRoot = process.cwd()) {
  let packageDocument;
  try {
    packageDocument = JSON.parse(await fs.readFile(path.join(path.resolve(projectRoot), 'package.json'), 'utf8'));
  } catch {
    throw new Error('AI benchmark package metadata is unavailable or invalid.');
  }
  return assertReleaseVersion(packageDocument?.version, 'Package release version');
}

export function validateAiBenchmarkEvidence(value, options = {}) {
  assertExactKeys(value, [
    'budgets',
    'formatVersion',
    'kind',
    'parameters',
    'performance',
    'quality',
    'releaseVersion',
    'seededDeals',
    'sourceSha',
    'strategyVersion'
  ], 'AI benchmark evidence');
  assertExactNumber(value.formatVersion, AI_BENCHMARK_FORMAT_VERSION, 'AI benchmark format version');
  if (value.kind !== AI_BENCHMARK_KIND) throw new Error(`AI benchmark kind must be ${AI_BENCHMARK_KIND}.`);
  assertFullSourceSha(value.sourceSha);
  assertReleaseVersion(value.releaseVersion);
  finiteNumber(value.strategyVersion, 'AI benchmark strategy version', { integer: true, minimum: 1 });

  if (options.expectedSourceSha !== undefined) {
    const expectedSourceSha = assertFullSourceSha(options.expectedSourceSha, 'Expected AI benchmark source SHA');
    if (value.sourceSha !== expectedSourceSha) throw new Error('AI benchmark source SHA does not match the expected source.');
  }
  if (options.expectedReleaseVersion !== undefined) {
    const expectedReleaseVersion = assertReleaseVersion(options.expectedReleaseVersion, 'Expected release version');
    if (value.releaseVersion !== expectedReleaseVersion) {
      throw new Error('AI benchmark release version does not match the expected package release.');
    }
  }
  if (options.expectedStrategyVersion !== undefined) {
    finiteNumber(options.expectedStrategyVersion, 'Expected strategy version', { integer: true, minimum: 1 });
    if (value.strategyVersion !== options.expectedStrategyVersion) {
      throw new Error('AI benchmark strategy version does not match the expected strategy.');
    }
  }

  assertExactKeys(value.parameters, Object.keys(AI_BENCHMARK_PARAMETERS), 'AI benchmark parameters');
  for (const [key, expected] of Object.entries(AI_BENCHMARK_PARAMETERS)) {
    assertExactNumber(value.parameters[key], expected, `AI benchmark parameter ${key}`);
  }

  assertExactKeys(value.budgets, Object.keys(AI_BENCHMARK_BUDGETS), 'AI benchmark budgets');
  for (const [key, expected] of Object.entries(AI_BENCHMARK_BUDGETS)) {
    assertExactNumber(value.budgets[key], expected, `AI benchmark budget ${key}`);
  }

  assertExactKeys(
    value.performance,
    ['maxMs', 'outcomeLimit', 'p50Ms', 'p95Ms', 'sampleCount'],
    'AI benchmark performance'
  );
  assertExactNumber(
    value.performance.sampleCount,
    AI_BENCHMARK_PARAMETERS.performanceSamples,
    'AI benchmark performance sample count'
  );
  assertExactNumber(value.performance.outcomeLimit, AI_BENCHMARK_DRAW_OUTCOME_COUNT, 'AI benchmark outcome limit');
  finiteNumber(value.performance.p50Ms, 'AI benchmark p50', { minimum: 0 });
  finiteNumber(value.performance.p95Ms, 'AI benchmark p95', { minimum: 0 });
  finiteNumber(value.performance.maxMs, 'AI benchmark maximum', { minimum: 0 });
  if (value.performance.p50Ms > value.performance.p95Ms || value.performance.p95Ms > value.performance.maxMs) {
    throw new Error('AI benchmark timing percentiles are not monotonic.');
  }
  if (value.performance.p95Ms >= value.budgets.p95Ms || value.performance.maxMs >= value.budgets.maxMs) {
    throw new Error('AI benchmark timing budget was not met.');
  }

  assertExactKeys(value.quality, difficulties, 'AI benchmark quality');
  let scenarioNames;
  for (const difficulty of difficulties) {
    const profile = value.quality[difficulty];
    assertExactKeys(profile, ['aggregateBenefit', 'aggregateRegret', 'scenarios'], `AI ${difficulty} quality`);
    finiteNumber(profile.aggregateBenefit, `AI ${difficulty} aggregate benefit`);
    finiteNumber(profile.aggregateRegret, `AI ${difficulty} aggregate regret`, { minimum: 0 });
    const names = Object.keys(assertRecord(profile.scenarios, `AI ${difficulty} scenarios`)).sort();
    if (names.length !== 19) throw new Error(`AI ${difficulty} quality must contain 19 scenarios.`);
    if (scenarioNames && names.some((name, index) => name !== scenarioNames[index])) {
      throw new Error('AI benchmark profiles must contain identical scenarios.');
    }
    scenarioNames = names;
    let totalWeight = 0;
    let weightedBenefit = 0;
    let weightedRegret = 0;
    for (const name of names) {
      const scenario = profile.scenarios[name];
      assertExactKeys(scenario, ['benefit', 'regret', 'weight'], `AI ${difficulty} scenario ${name}`);
      finiteNumber(scenario.benefit, `AI ${difficulty} scenario benefit`);
      finiteNumber(scenario.regret, `AI ${difficulty} scenario regret`, { minimum: 0 });
      finiteNumber(scenario.weight, `AI ${difficulty} scenario weight`, { minimum: Number.EPSILON });
      totalWeight += scenario.weight;
      weightedBenefit += scenario.benefit * scenario.weight;
      weightedRegret += scenario.regret * scenario.weight;
    }
    const expectedBenefit = Number((weightedBenefit / totalWeight).toFixed(4));
    const expectedRegret = Number((weightedRegret / totalWeight).toFixed(4));
    if (profile.aggregateBenefit !== expectedBenefit || profile.aggregateRegret !== expectedRegret) {
      throw new Error(`AI ${difficulty} aggregate quality does not match its scenarios.`);
    }
  }
  validateOrderedCalibration(
    Object.fromEntries(difficulties.map((difficulty) => [difficulty, value.quality[difficulty].aggregateBenefit])),
    Object.fromEntries(difficulties.map((difficulty) => [difficulty, value.quality[difficulty].aggregateRegret])),
    'AI benchmark scenario'
  );

  assertExactKeys(
    value.seededDeals,
    ['benefits', 'evaluator', 'firstSeed', 'lastSeed', 'regret', 'sampleCount'],
    'AI benchmark seeded deals'
  );
  if (value.seededDeals.evaluator !== AI_BENCHMARK_EVALUATOR) {
    throw new Error('AI benchmark seeded-deal evaluator is not the certified evaluator.');
  }
  assertExactNumber(
    value.seededDeals.sampleCount,
    AI_BENCHMARK_PARAMETERS.seededDealSamples,
    'AI benchmark seeded-deal sample count'
  );
  assertExactNumber(
    value.seededDeals.firstSeed,
    AI_BENCHMARK_PARAMETERS.seededDealFirstSeed,
    'AI benchmark first dealt-game seed'
  );
  assertExactNumber(
    value.seededDeals.lastSeed,
    AI_BENCHMARK_PARAMETERS.seededDealFirstSeed + AI_BENCHMARK_PARAMETERS.seededDealSamples - 1,
    'AI benchmark last dealt-game seed'
  );
  validateDifficultyNumbers(value.seededDeals.benefits, 'AI benchmark seeded-deal benefits');
  validateDifficultyNumbers(value.seededDeals.regret, 'AI benchmark seeded-deal regret', { minimum: 0 });
  validateOrderedCalibration(value.seededDeals.benefits, value.seededDeals.regret, 'AI benchmark seeded-deal');
  return value;
}

export function serializeAiBenchmarkEvidence(value, options = {}) {
  validateAiBenchmarkEvidence(value, options);
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`;
}

export function aiBenchmarkSha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function writeAiBenchmarkEvidence(filePath, value) {
  const data = serializeAiBenchmarkEvidence(value);
  const digest = aiBenchmarkSha256(data);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data, { encoding: 'utf8', mode: 0o600 });
  const checksumPath = `${filePath}.sha256`;
  await fs.writeFile(checksumPath, `${digest}  ${path.basename(filePath)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { checksumPath, digest };
}

export async function readVerifiedAiBenchmarkEvidence(
  filePath,
  checksumPath = `${filePath}.sha256`,
  options = {}
) {
  if (options.expectedSourceSha === undefined) {
    throw new Error('AI benchmark verification requires an expected source SHA.');
  }
  const [data, checksum] = await Promise.all([
    fs.readFile(filePath, 'utf8'),
    fs.readFile(checksumPath, 'utf8')
  ]);
  const expectedName = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = checksum.match(new RegExp(`^([a-f0-9]{64})  ${expectedName}\\n$`));
  if (!match || !sha256Pattern.test(match[1])) throw new Error('AI benchmark checksum file is invalid.');
  const actual = aiBenchmarkSha256(data);
  if (!crypto.timingSafeEqual(Buffer.from(match[1], 'ascii'), Buffer.from(actual, 'ascii'))) {
    throw new Error('AI benchmark evidence checksum mismatch.');
  }
  let decoded;
  try {
    decoded = JSON.parse(data);
  } catch {
    throw new Error('AI benchmark evidence is not valid JSON.');
  }
  validateAiBenchmarkEvidence(decoded, options);
  if (serializeAiBenchmarkEvidence(decoded, options) !== data) {
    throw new Error('AI benchmark evidence is not canonically serialized.');
  }
  return { digest: actual, evidence: decoded };
}
