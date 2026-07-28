import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createContractAjv,
  fixtureRoot,
  readFixture,
  readJson,
  validatorFor,
  type FixtureCase
} from './fixtureSupport';

const validFixtureFiles = [
  'game-state.valid.json',
  'protocol-client.valid.json',
  'protocol-server.valid.json',
  'http.valid.json'
];
const invalidFixtureFiles = [
  'game-state.invalid.json',
  'protocol-client.invalid.json',
  'protocol-server.invalid.json',
  'http.invalid.json'
];

describe('contract schema corpus', () => {
  const { validators } = createContractAjv();

  it.each(validFixtureFiles)('accepts every valid case in %s', (fileName) => {
    for (const fixture of readFixture(fileName).cases) {
      const validate = validatorFor(validators, fixture);
      expect(validate(fixture.value), `${fileName}: ${fixture.name}\n${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it.each(invalidFixtureFiles)('rejects schema-invalid cases in %s', (fileName) => {
    const cases = readFixture(fileName).cases.filter((fixture) => fixture.expectedLayer === 'schema');
    expect(cases.length).toBeGreaterThan(0);
    for (const fixture of cases) {
      const validate = validatorFor(validators, fixture);
      expect(validate(fixture.value), `${fileName}: ${fixture.name}`).toBe(false);
    }
  });

  it('contains one unique, non-empty name per fixture file', () => {
    for (const fileName of [...validFixtureFiles, ...invalidFixtureFiles]) {
      const cases = readFixture(fileName).cases;
      const names = cases.map((fixture: FixtureCase) => fixture.name);
      expect(names.every(Boolean)).toBe(true);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('matches every manifest hash and has no unexpected JSON fixture', () => {
    const manifest = readJson<{ files: Record<string, string> }>(path.join(fixtureRoot, 'manifest.json'));
    const actualNames = fs.readdirSync(fixtureRoot).filter((name) => name.endsWith('.json')).sort();
    expect(actualNames).toEqual([...Object.keys(manifest.files), 'manifest.json'].sort());
    for (const [name, expectedHash] of Object.entries(manifest.files)) {
      const contents = fs.readFileSync(path.join(fixtureRoot, name));
      expect(crypto.createHash('sha256').update(contents).digest('hex'), name).toBe(expectedHash);
    }
  });
});
