import fs from 'node:fs/promises';
import { invokeDirectController } from '../../release-controller.mjs';
import { backupWithKeepAlive } from '../../state-snapshot-lib.mjs';

const [sourcePath, backupPath, ledgerPath, mode = 'complete'] = process.argv.slice(2);

if (mode === 'unsettled') {
  await fs.writeFile(ledgerPath, `${JSON.stringify({ status: 'started' })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50).unref());
} else {
  await invokeDirectController(async () => {
    await fs.writeFile(ledgerPath, `${JSON.stringify({ status: 'started' })}\n`);
    if (mode === 'fail') throw new Error('injected direct controller failure');
    await backupWithKeepAlive(sourcePath, backupPath);
    await fs.writeFile(ledgerPath, `${JSON.stringify({ status: 'completed' })}\n`);
    process.stdout.write(`${JSON.stringify({ verified: 'a'.repeat(40), activated: false })}\n`);
  });
}
