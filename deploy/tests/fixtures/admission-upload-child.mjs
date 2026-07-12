import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { performUpload } from '../../skyjo-deploy-dispatch.mjs';

const [stageRoot, runId, releaseSha, readyPath = '-', releasePath = '-'] = process.argv.slice(2);

async function waitForRelease() {
  if (readyPath === '-' || releasePath === '-') return;
  await fs.writeFile(readyPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(releasePath);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await delay(10);
  }
  throw new Error('Admission test release gate timed out.');
}

try {
  const result = await performUpload({
    stageRoot,
    runId,
    releaseSha,
    bytes: 1,
    input: Readable.from([Buffer.from('x')]),
    afterAdmissionMkdir: waitForRelease
  });
  process.stdout.write(`${JSON.stringify({ ok: true, archivePath: result.archivePath })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, message: error?.message, exitCode: error?.exitCode ?? 70 })}\n`);
  process.exitCode = error?.exitCode ?? 70;
}
