import path from 'node:path';

const sourceRoot = process.argv[2];
if (!sourceRoot || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/verify-swift-domain-coverage.mjs <source-root>');
}

let input = '';
for await (const chunk of process.stdin) input += chunk;

let report;
try {
  report = JSON.parse(input);
} catch {
  throw new Error('llvm-cov did not emit a valid JSON coverage report.');
}

const normalizedRoot = `${path.resolve(sourceRoot)}${path.sep}`;
const files = (report?.data ?? [])
  .flatMap((entry) => entry?.files ?? [])
  .filter((file) => typeof file?.filename === 'string')
  .filter((file) => path.resolve(file.filename).startsWith(normalizedRoot));

if (files.length === 0) {
  throw new Error(`Coverage report contained no SkyjoDomain source under ${normalizedRoot}.`);
}

const totals = files.reduce(
  (result, file) => ({
    count: result.count + Number(file?.summary?.lines?.count ?? 0),
    covered: result.covered + Number(file?.summary?.lines?.covered ?? 0)
  }),
  { count: 0, covered: 0 }
);
if (!Number.isFinite(totals.count) || !Number.isFinite(totals.covered) || totals.count <= 0) {
  throw new Error('Coverage report did not contain valid executable line totals.');
}

const percentage = (totals.covered / totals.count) * 100;
process.stdout.write(
  `SkyjoDomain line coverage: ${percentage.toFixed(2)}% (${totals.covered}/${totals.count})\n`
);
if (percentage < 90) {
  throw new Error(`SkyjoDomain line coverage ${percentage.toFixed(2)}% is below the required 90.00%.`);
}
