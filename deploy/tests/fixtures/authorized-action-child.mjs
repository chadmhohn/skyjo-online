import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { executeAuthorizedControllerAction, writeTerminalLine } from '../../release-controller.mjs';

const [mode, ledgerRoot, publicKeyPath, signedCommand, startedPath, continuePath, completedPath] = process.argv.slice(2);

async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fsp.access(filePath).then(() => true).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

try {
  const publicKey = crypto.createPublicKey(await fsp.readFile(publicKeyPath));
  const result = await executeAuthorizedControllerAction({
    expectedCommand: 'verify',
    signedCommand,
    keyring: new Map([['canary-2026-07', { role: 'canary', publicKey }]]),
    ledgerRoot,
    expectedUid: process.getuid?.(),
    action: async (fields) => {
      await fsp.writeFile(startedPath, `${JSON.stringify({ pid: process.pid, releaseSha: fields.releaseSha })}\n`, { flag: 'wx' });
      await waitForFile(continuePath);
      return { verified: fields.releaseSha };
    }
  });
  await fsp.writeFile(completedPath, `${JSON.stringify({ pid: process.pid })}\n`, { flag: 'wx' });
  if (mode === 'hold') await waitForFile(`${completedPath}.exit`);
  if (mode === 'output') writeTerminalLine(1, `${JSON.stringify({ ...result, padding: 'x'.repeat(64 * 1024) })}\n`);
} catch (error) {
  writeTerminalLine(2, `${error?.stack || error}\n`);
  process.exitCode = 1;
}
