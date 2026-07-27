import fs from 'node:fs';
import path from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export interface FixtureCase {
  context?: {
    rosterPlayerIds: string[];
    roomStatus: 'waiting' | 'playing' | 'finished';
    readyForNextRoundPlayerIds: string[];
  };
  expectedLayer?: 'consumer' | 'privacy' | 'schema' | 'semantic' | 'transport' | 'wire';
  name: string;
  schema: string;
  value: unknown;
  wireBytes?: number;
}

interface FixtureDocument {
  cases: FixtureCase[];
  contractVersion: number;
}

export const contractRoot = path.resolve(process.cwd(), 'contracts', 'v1');
export const fixtureRoot = path.join(contractRoot, 'fixtures');
export const schemaRoot = path.join(contractRoot, 'schemas');

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

export function readFixture(name: string): FixtureDocument {
  return readJson<FixtureDocument>(path.join(fixtureRoot, name));
}

export function createContractAjv(): {
  ajv: Ajv2020;
  validators: Map<string, ValidateFunction>;
} {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const schemas = fs.readdirSync(schemaRoot)
    .filter((name) => name.endsWith('.schema.json'))
    .sort()
    .map((name) => ({ name, schema: readJson<Record<string, unknown>>(path.join(schemaRoot, name)) }));
  for (const { schema } of schemas) ajv.addSchema(schema);
  const validators = new Map<string, ValidateFunction>();
  for (const { name, schema } of schemas) {
    const id = String(schema.$id);
    const validator = ajv.getSchema(id);
    if (!validator) throw new Error(`Could not compile ${name}.`);
    validators.set(name, validator);
  }
  return { ajv, validators };
}

export function validatorFor(validators: Map<string, ValidateFunction>, fixture: FixtureCase): ValidateFunction {
  const validator = validators.get(fixture.schema);
  if (!validator) throw new Error(`Fixture ${fixture.name} references unknown schema ${fixture.schema}.`);
  return validator;
}
