import fs from 'node:fs/promises';
import { backup, DatabaseSync } from 'node:sqlite';
import { invokeDirectController } from '../../release-controller.mjs';

const [sourcePath, backupPath, ledgerPath, mode = 'complete'] = process.argv.slice(2);

await invokeDirectController(async () => {
  await fs.writeFile(ledgerPath, `${JSON.stringify({ status: 'started' })}\n`);
  if (mode === 'fail') throw new Error('injected direct controller failure');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, backupPath);
  } finally {
    source.close();
  }
  await fs.writeFile(ledgerPath, `${JSON.stringify({ status: 'completed' })}\n`);
  process.stdout.write(`${JSON.stringify({ verified: 'a'.repeat(40), activated: false })}\n`);
});
