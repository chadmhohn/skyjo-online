import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

describe('deployed smoke protocol contract', () => {
  it('defaults both entrypoint and library to the current protocol instead of retired v1', async () => {
    const [entrypoint, library] = await Promise.all([
      fs.readFile(path.join(root, 'scripts', 'smoke-deployed.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'deployed-smoke-lib.mjs'), 'utf8')
    ]);
    expect(entrypoint).toContain("import { CURRENT_PROTOCOL_VERSION } from '../server-release.mjs'");
    expect(entrypoint).toMatch(/configuredProtocolVersion === undefined\s*\? CURRENT_PROTOCOL_VERSION/);
    expect(entrypoint).not.toMatch(/SKYJO_EXPECTED_PROTOCOL_VERSION \|\| 1/);
    expect(library).toContain("import { CURRENT_PROTOCOL_VERSION } from '../server-release.mjs'");
    expect(library).toMatch(/expectedProtocolVersion = CURRENT_PROTOCOL_VERSION/);
    expect(library).not.toMatch(/expectedProtocolVersion = 1/);
  });
});
