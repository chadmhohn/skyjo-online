import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNT_DELETION_LEDGER_FORMAT,
  ACCOUNT_DELETION_LEDGER_VERSION,
  createAccountDeletionLedger,
  loadAccountDeletionLedger,
  resolveAccountDeletionLedgerPath
} from '../../../server-account-deletion-ledger.mjs';

describe('external account deletion ledger', () => {
  let directory = '';
  let ledgerPath = '';

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-deletion-ledger-'));
    ledgerPath = path.join(directory, 'account-deletions.json');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('durably records an idempotent minimal tombstone outside rollback state', async () => {
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const ledger = await createAccountDeletionLedger({ filePath: ledgerPath, now: () => 1234 });
    expect(ledger.entries()).toEqual([]);
    expect(JSON.parse(await fs.readFile(ledgerPath, 'utf8'))).toEqual({
      format: ACCOUNT_DELETION_LEDGER_FORMAT,
      version: ACCOUNT_DELETION_LEDGER_VERSION,
      entries: []
    });
    await ledger.recordDeletion(userId.toUpperCase());
    await ledger.recordDeletion(userId);
    expect(await loadAccountDeletionLedger(ledgerPath)).toEqual([{ userId, deletedAt: 1234 }]);
    expect(JSON.parse(await fs.readFile(ledgerPath, 'utf8'))).toEqual({
      format: ACCOUNT_DELETION_LEDGER_FORMAT,
      version: ACCOUNT_DELETION_LEDGER_VERSION,
      entries: [{ userId, deletedAt: 1234 }]
    });
  });

  it('derives a sibling path and rejects malformed ledger state', async () => {
    expect(resolveAccountDeletionLedgerPath({ SKYJO_DB_FILE: path.join(directory, 'skyjo.sqlite') }))
      .toBe(ledgerPath);
    await fs.writeFile(ledgerPath, '{"format":"wrong","version":1,"entries":[]}');
    await expect(loadAccountDeletionLedger(ledgerPath)).rejects.toThrow(/invalid format/i);
    await fs.rm(ledgerPath);
    await expect(loadAccountDeletionLedger(ledgerPath, { allowMissing: false })).rejects.toThrow(/missing/i);
  });

  it('reads through one no-follow descriptor and rejects linked ledger files', async () => {
    const targetPath = path.join(directory, 'target.json');
    await fs.writeFile(targetPath, JSON.stringify({
      format: ACCOUNT_DELETION_LEDGER_FORMAT,
      version: ACCOUNT_DELETION_LEDGER_VERSION,
      entries: []
    }));
    await fs.symlink(targetPath, ledgerPath);
    await expect(loadAccountDeletionLedger(ledgerPath)).rejects.toThrow(/invalid/i);
  });
});
