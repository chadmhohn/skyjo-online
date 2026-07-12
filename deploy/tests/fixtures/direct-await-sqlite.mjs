import fs from 'node:fs/promises';
import path from 'node:path';
import { invokeDirectController } from '../../release-controller.mjs';
import { backupWithKeepAlive } from '../../state-snapshot-lib.mjs';

const [sourcePath, backupPath, ledgerPath, mode = 'complete'] = process.argv.slice(2);
const residuePath = `${backupPath}.run-residue`;

if (mode === 'unsettled') {
  await fs.writeFile(ledgerPath, `${JSON.stringify({ status: 'started' })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50).unref());
} else {
  await invokeDirectController(async () => {
    await fs.writeFile(ledgerPath, `${JSON.stringify({ status: 'started' })}\n`);
    await fs.mkdir(path.join(residuePath, 'candidate', 'snapshot'), { recursive: true });
    await fs.writeFile(path.join(residuePath, 'candidate', 'snapshot', 'proof'), 'residue');
    try {
      if (mode === 'fail') throw new Error('injected direct controller failure');
      await backupWithKeepAlive(sourcePath, backupPath);
      // The snapshot-local keepalive is clear here. This unref'ed phase models
      // later recursive run cleanup, which still needs the controller guard.
      await new Promise((resolve) => setTimeout(resolve, 50).unref());
      if (mode === 'cleanup-fail') throw new Error('injected post-backup cleanup failure');
      await fs.rm(residuePath, { recursive: true, force: true });
      await fs.writeFile(ledgerPath, `${JSON.stringify({ status: 'completed' })}\n`);
      process.stdout.write(`${JSON.stringify({ verified: 'a'.repeat(40), activated: false })}\n`);
    } catch (error) {
      await fs.rm(residuePath, { recursive: true, force: true });
      await fs.writeFile(ledgerPath, `${JSON.stringify({ status: 'failed' })}\n`);
      throw error;
    }
  });
}
