import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArguments, validateStageRootEntries } from '../release-controller.mjs';
import {
  authorizeRollback,
  executeActivationTransaction,
  loadVerifiedReleaseIdentity,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_EXTRACTED_BYTES,
  MAX_FILE_BYTES,
  normalizeArchiveEntry,
  REQUIRED_ARCHIVE_ENTRIES,
  readLinkWithin,
  replaceSymlink,
  resolveGithubTag,
  resolveWithin,
  selectReleasePathsToPrune,
  validateArchiveListing,
  validateReleaseTag,
  validateRunId
} from '../release-controller-lib.mjs';

const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const signature = 'A'.repeat(86);
const issuedAt = '1800000000';
const expiresAt = '1800000300';
const required = ['./', ...REQUIRED_ARCHIVE_ENTRIES];
const regularLine = '-rw-r--r-- 0/0 1 2026-07-11 00:00:00 file';

function trustedTestOperations() {
  if (process.platform === 'win32') return {};
  return { trustedUid: process.getuid(), trustedGid: process.getgid() };
}

function stageEntry(name, type = 'directory') {
  return {
    name,
    isDirectory: () => type === 'directory',
    isSymbolicLink: () => type === 'symlink'
  };
}

test('external admission lock preserves the legacy directories-only stage-root contract', () => {
  const runs = [stageEntry('1-1-canary'), stageEntry('2-1-production')];
  assert.equal(validateStageRootEntries({ nlink: 4 }, runs), 2);
  assert.throws(() => validateStageRootEntries({ nlink: 4 }, [...runs, stageEntry('.admission.lock', 'file')]), /unexpected entry/);
  assert.throws(() => validateStageRootEntries({ nlink: 5 }, runs), /link-count admission/);
});

test('deployment identifiers and command lanes are strict', () => {
  assert.equal(validateRunId('123-1-canary'), '123-1-canary');
  assert.equal(validateReleaseTag('v0.2.0'), 'v0.2.0');
  assert.throws(() => validateRunId('../x'), /Invalid/);
  assert.throws(() => validateReleaseTag('latest'), /Invalid/);
  const signedCommand = `verify 123-1-canary ${sha} ${digest} - ${issuedAt} ${expiresAt} canary-2026-07 ${signature}`;
  assert.deepEqual(parseArguments(['verify', '--authorization-command', signedCommand]), { command: 'verify', signedCommand });
  assert.deepEqual(parseArguments(['self-test']), { command: 'self-test' });
  assert.throws(() => parseArguments(['verify']), /signed deployment authorization/i);
  assert.throws(() => parseArguments(['verify', '--authorization-command', signedCommand, 'extra']), /signed deployment authorization/i);
  assert.throws(() => parseArguments(['self-test', '--authorization-command', signedCommand]), /takes no arguments/i);
});

test('path and archive validation reject traversal, links, duplicates, and forbidden secrets', () => {
  assert.deepEqual({ MAX_ARCHIVE_BYTES, MAX_EXTRACTED_BYTES, MAX_FILE_BYTES, MAX_ARCHIVE_ENTRIES }, {
    MAX_ARCHIVE_BYTES: 16 * 1024 * 1024,
    MAX_EXTRACTED_BYTES: 24 * 1024 * 1024,
    MAX_FILE_BYTES: 4 * 1024 * 1024,
    MAX_ARCHIVE_ENTRIES: 4096
  });
  assert.equal(normalizeArchiveEntry('./dist/index.html'), 'dist/index.html');
  assert.throws(() => normalizeArchiveEntry('../secret'), /traversal/);
  assert.throws(() => normalizeArchiveEntry('././dist/index.html'), /traversal/);
  assert.throws(() => normalizeArchiveEntry('C:\\secret'), /invalid|absolute/);
  assert.throws(() => normalizeArchiveEntry('node_modules/minimist/bad\tname'), /control/);
  assert.throws(() => normalizeArchiveEntry('node_modules/minimist/bad\u007fname'), /control/);
  for (const forbidden of [
    'node_modules/minimist/.github/FUNDING.yml',
    'node_modules/minimist/.GitHub/workflow.yml',
    'node_modules/minimist/.git/config',
    'node_modules/minimist/.GIT/config',
    'node_modules/minimist/.env',
    'node_modules/minimist/.env.production',
    'node_modules/minimist/.ENV.local',
    'node_modules/minimist/.envrc',
    'node_modules/minimist/.EnViRoNmEnT'
  ]) assert.throws(() => normalizeArchiveEntry(forbidden), /forbidden/);
  assert.equal(normalizeArchiveEntry('node_modules/minimist/.gitignore'), 'node_modules/minimist/.gitignore');
  assert.equal(normalizeArchiveEntry('node_modules/minimist/.npmignore'), 'node_modules/minimist/.npmignore');
  assert.equal(normalizeArchiveEntry('node_modules/minimist/.github-actions/config.yml'), 'node_modules/minimist/.github-actions/config.yml');
  assert.throws(() => resolveWithin('/srv/releases', '..', 'etc'), /escapes/);
  const verbose = required.map((entry) => entry === './' ? 'drwxr-xr-x 0/0 0 2026-07-11 00:00:00 ./' : regularLine);
  const validated = validateArchiveListing(required, verbose);
  assert.equal(validated.entries.has('server.mjs'), true);
  assert.equal(REQUIRED_ARCHIVE_ENTRIES.has('server-game-state-validation.mjs'), true);
  assert.equal(validated.entries.has('server-game-state-validation.mjs'), true);
  const missingValidatorIndex = required.indexOf('server-game-state-validation.mjs');
  const missingValidator = required.filter((_, index) => index !== missingValidatorIndex);
  const missingValidatorVerbose = verbose.filter((_, index) => index !== missingValidatorIndex);
  assert.throws(
    () => validateArchiveListing(missingValidator, missingValidatorVerbose),
    /missing required runtime entry: server-game-state-validation\.mjs/
  );
  assert.throws(
    () => validateArchiveListing(
      [...required, 'server-game-state-validation.mjs.bak'],
      [...verbose, regularLine]
    ),
    /unexpected runtime entry: server-game-state-validation\.mjs\.bak/
  );
  const linked = [...verbose];
  linked[1] = 'lrwxrwxrwx 0/0 0 2026-07-11 00:00 release.json -> /etc/passwd';
  assert.throws(() => validateArchiveListing(required, linked), /not a regular file/);
  assert.throws(() => validateArchiveListing([...required, 'server.mjs'], [...verbose, regularLine]), /duplicate/);
  const oversized = [...verbose];
  oversized[1] = `-rw-r--r-- 0/0 ${MAX_FILE_BYTES + 1} 2026-07-11 00:00:00 release.json`;
  assert.throws(() => validateArchiveListing(required, oversized), /too large/);
});

test('root and served release identities must match and verify checksums', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-release-'));
  try {
    const dist = path.join(root, 'dist');
    await fs.mkdir(dist);
    const data = `${JSON.stringify({ formatVersion: 1, releaseSha: sha, buildTimestamp: '2026-07-11T00:00:00.000Z', schemaVersion: 2, protocolVersion: 1 }, null, 2)}\n`;
    const checksum = `${crypto.createHash('sha256').update(data).digest('hex')}  release.json\n`;
    await Promise.all([
      fs.writeFile(path.join(root, 'release.json'), data), fs.writeFile(path.join(root, 'release.json.sha256'), checksum),
      fs.writeFile(path.join(dist, 'release.json'), data), fs.writeFile(path.join(dist, 'release.json.sha256'), checksum)
    ]);
    assert.equal((await loadVerifiedReleaseIdentity(root, sha)).releaseSha, sha);
    await fs.writeFile(path.join(dist, 'release.json'), `${data} `);
    await assert.rejects(loadVerifiedReleaseIdentity(root, sha), /differ/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('release symlink swaps remain within the release store', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-links-'));
  try {
    const releases = path.join(root, 'releases');
    const target = path.join(releases, sha);
    await fs.mkdir(target, { recursive: true });
    const current = path.join(root, 'current');
    await replaceSymlink(current, target, trustedTestOperations());
    assert.equal(await readLinkWithin(current, releases), target);
    await fs.rm(current, { force: true });
    await fs.symlink(path.dirname(root), current, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readLinkWithin(current, releases), /outside|escapes/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('GitHub tag verification follows annotated tags and requires a commit', async () => {
  const responses = [
    { ok: true, json: async () => ({ object: { type: 'tag', sha: 'c'.repeat(40) } }) },
    { ok: true, json: async () => ({ object: { type: 'commit', sha } }) }
  ];
  assert.equal(await resolveGithubTag('v0.2.0', async () => responses.shift()), sha);
  await assert.rejects(resolveGithubTag('v0.2.0', async () => ({ ok: false, status: 503 })), /503/);
});

test('activation failures select restart-before-swap or rollback-after-swap without state restore', async () => {
  const beforeSwap = [];
  await assert.rejects(executeActivationTransaction({
    stop: async () => beforeSwap.push('stop'), prepare: async () => { throw new Error('prepare failed'); },
    swap: async () => beforeSwap.push('swap'), start: async () => beforeSwap.push('start'), verify: async () => {},
    rollback: async () => beforeSwap.push('rollback'), restartPrevious: async () => beforeSwap.push('restart-previous')
  }), (error) => error.message === 'prepare failed' && error.activationRolledBack === false);
  assert.deepEqual(beforeSwap, ['stop', 'restart-previous']);

  const afterSwap = [];
  await assert.rejects(executeActivationTransaction({
    stop: async () => afterSwap.push('stop'), prepare: async () => afterSwap.push('prepare'),
    swap: async () => afterSwap.push('swap'), start: async () => afterSwap.push('start'),
    verify: async () => { throw new Error('smoke failed'); }, rollback: async () => afterSwap.push('rollback'),
    restartPrevious: async () => afterSwap.push('restart-previous')
  }), (error) => error.message === 'smoke failed' && error.activationRolledBack === true);
  assert.deepEqual(afterSwap, ['stop', 'prepare', 'swap', 'start', 'rollback']);
});

test('public rollback authorization is exact and release retention keeps five including both links', () => {
  const metadata = { releaseSha: sha, artifactSha256: digest, tag: 'v0.2.0' };
  assert.equal(authorizeRollback({ currentReleaseSha: sha, metadata, requestedReleaseSha: sha, requestedDigest: digest, requestedTag: 'v0.2.0' }), true);
  assert.throws(() => authorizeRollback({ currentReleaseSha: sha, metadata, requestedReleaseSha: sha, requestedDigest: 'c'.repeat(64), requestedTag: 'v0.2.0' }), /does not match/);
  const entries = Array.from({ length: 8 }, (_, index) => ({ path: `/releases/${index}`, mtimeMs: index }));
  assert.deepEqual(selectReleasePathsToPrune(entries, ['/releases/7', '/releases/6'], 5), ['/releases/2', '/releases/1', '/releases/0']);
});

test('operational assets keep the safety contracts explicit', async () => {
  const deploy = path.resolve(import.meta.dirname, '..');
  const [wrapper, bootstrap, bootstrapWrapper, bootstrapGuard, bootstrapSafety, nodeInstaller, nodeGuard, controllerLauncher, transportKey, service, canary, canarySmoke, productionSmoke, stateProof, legacyProof, stateProofLauncher, legacyProofScript, controller, sudoers, admissionLock, remote] = await Promise.all([
    fs.readFile(path.join(deploy, 'skyjo-release-controller'), 'utf8'),
    fs.readFile(path.join(deploy, 'bootstrap-skyjo-delivery.sh'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-delivery-bootstrap'), 'utf8'),
    fs.readFile(path.join(deploy, 'bootstrap-generation-guard-lib.sh'), 'utf8'),
    fs.readFile(path.join(deploy, 'bootstrap-safety-lib.sh'), 'utf8'),
    fs.readFile(path.join(deploy, 'node-runtime-installer.sh'), 'utf8'),
    fs.readFile(path.join(deploy, 'node-runtime-guard-lib.sh'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-controller-launch'), 'utf8'),
    fs.readFile(path.join(deploy, 'transport-key-lib.sh'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-online.service'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-online-canary@.service'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-online-canary-smoke@.service'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-online-smoke@.service'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-online-state-proof@.service'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-online-legacy-proof@.service'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-state-proof-launch'), 'utf8'),
    fs.readFile(path.join(deploy, 'legacy-runtime-proof.mjs'), 'utf8'),
    fs.readFile(path.join(deploy, 'release-controller.mjs'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-deploy.sudoers'), 'utf8'),
    fs.readFile(path.join(deploy, 'admission-lock.mjs'), 'utf8'),
    fs.readFile(path.join(deploy, 'github-release-remote.sh'), 'utf8')
  ]);
  const legacyUnitCleanup = await fs.readFile(path.join(deploy, 'legacy-proof-unit-cleanup-lib.sh'), 'utf8');
  assert.match(wrapper, /flock --exclusive --nonblock --no-fork/);
  assert.match(wrapper, /--conflict-exit-code 73/);
  assert.doesNotMatch(wrapper, /--close/);
  assert.match(wrapper, /sha256sum --check --strict "\$manifest"/);
  assert.match(wrapper, /skyjo-controller-launch/);
  assert.match(bootstrap, /Prepared Skyjo delivery assets\. The live production unit was not replaced/);
  const pathReset = bootstrap.indexOf('PATH=/usr/sbin:/usr/bin:/sbin:/bin');
  const restrictiveUmask = bootstrap.indexOf('umask 077');
  const rootGate = bootstrap.indexOf('require_root\n');
  const firstSource = bootstrap.indexOf('. "$SCRIPT_DIR/bootstrap-safety-lib.sh"');
  assert.ok(pathReset > 0 && restrictiveUmask > pathReset && rootGate > restrictiveUmask && firstSource > rootGate,
    'bootstrap must reset PATH and umask and require root before sourcing helpers');
  assert.match(bootstrap, /snapshot_and_exec_prepare/);
  assert.match(bootstrap, /exec "\$target\/bootstrap-skyjo-delivery\.sh" prepare/);
  assert.match(bootstrap, /initial_assert_root_directory_chain "\$SCRIPT_DIR"/);
  assert.match(bootstrap, /Bootstrap snapshot source is not root-owned/);
  assert.match(bootstrap, /Prepare key inputs must be the installed immutable snapshots/);
  assert.match(bootstrap, /bundle\.sha256/);
  assert.match(bootstrap, /initial_assert_generation "\$target"/);
  assert.match(bootstrapWrapper, /skyjo_guard_bootstrap_generation/);
  assert.match(bootstrapWrapper, /exec "\$bootstrap"/);
  assert.match(bootstrapGuard, /\^\[a-f0-9\]\{64\}\$/);
  assert.match(bootstrapGuard, /sha256sum --check --strict bundle\.sha256/);
  assert.match(bootstrapSafety, /cp --no-dereference --reflink=never/);
  assert.match(bootstrapSafety, /Refusing unsafe pre-existing file destination/);
  assert.match(bootstrap, /skyjo_install_node_archive/);
  assert.match(bootstrap, /node-v\$NODE_VERSION-linux-x64/);
  assert.match(nodeInstaller, /\.skyjo-node-runtime/);
  assert.match(nodeInstaller, /skyjo_assert_root_directory_chain/);
  assert.match(nodeInstaller, /flock --exclusive/);
  assert.match(nodeInstaller, /\.node\.link\.XXXXXX/);
  assert.match(nodeGuard, /skyjo_guard_node_runtime/);
  assert.match(nodeGuard, /stat -c %g/);
  const controllerGuard = controllerLauncher.indexOf('skyjo_guard_node_runtime');
  const controllerExec = controllerLauncher.indexOf('exec /opt/skyjo-online/node-v24.18.0/bin/node');
  assert.ok(controllerGuard > 0 && controllerExec > controllerGuard,
    'locked shell launcher must validate the pinned runtime before direct Node execution');
  assert.match(controllerLauncher, /sha256sum --check --strict "\$manifest"/);
  assert.match(controllerLauncher, /\/usr\/local\/lib\/skyjo-online\/admission-lock\.mjs/);
  assert.match(bootstrap, /skyjo_canonical_transport_public_key "\$public_key" "\$TRANSPORT_KEY_FINGERPRINT"/);
  assert.match(transportKey, /LF or CRLF/);
  assert.match(bootstrap, /Legacy rollback snapshot contains a symbolic link/);
  assert.match(bootstrap, /skyjo_secure_directory \/var\/tmp\/skyjo-deploy root skyjo-deploy 1731 true/);
  assert.match(bootstrap, /findmnt --noheadings --output FSTYPE --target \/var\/tmp\/skyjo-deploy/);
  assert.match(bootstrap, /lock=\/var\/lib\/skyjo-deploy\/\.admission\.lock/);
  assert.doesNotMatch(bootstrap, /lock=\/var\/tmp\/skyjo-deploy\/\.admission\.lock/);
  assert.match(bootstrap, /0:0:640:1:0\) \/usr\/bin\/chown root:skyjo-deploy "\$lock"/);
  assert.match(bootstrap, /\/usr\/bin\/sync -f \/var\/lib\/skyjo-deploy/);
  const prepareStart = bootstrap.indexOf('prepare()');
  const prepareHostLock = bootstrap.indexOf('flock --exclusive --nonblock --conflict-exit-code 73 8', prepareStart);
  const lockRootCreation = bootstrap.indexOf('skyjo_secure_directory /var/lib/skyjo-deploy root root 0755', prepareHostLock);
  const admissionCreation = bootstrap.indexOf('ensure_admission_lock', lockRootCreation);
  const admissionAcquisition = bootstrap.indexOf('acquire_admission_lock', admissionCreation);
  const admissionAssetInstall = bootstrap.indexOf('for file in admission-lock.mjs', admissionAcquisition);
  assert.ok(prepareHostLock > prepareStart && lockRootCreation > prepareHostLock && admissionCreation > lockRootCreation &&
    admissionAcquisition > admissionCreation && admissionAssetInstall > admissionAcquisition,
  'prepare must hold host then external admission lock before publishing new delivery assets');
  for (const functionName of ['adopt_legacy()', 'activate_unit()']) {
    const start = bootstrap.indexOf(functionName);
    assert.ok(start > 0 && bootstrap.indexOf('acquire_admission_lock', start) > start, `${functionName} must acquire the external admission lock`);
  }
  assert.match(bootstrap, /\.quota-admitted/);
  assert.match(admissionLock, /ADMISSION_LOCK_PATH = '\/var\/lib\/skyjo-deploy\/\.admission\.lock'/);
  assert.match(admissionLock, /O_RDONLY \| \(fs\.constants\.O_NOFOLLOW/);
  assert.match(admissionLock, /stdio: \['ignore', 'ignore', 'ignore', handle\.fd\]/);
  assert.match(admissionLock, /conflictExitCode/);
  assert.match(controller, /conflictExitCode: 73/);
  assert.match(controller, /isAdmissionLockConflictImpl\(error, 73\) \? 73/);
  assert.doesNotMatch(controller, /error\?\.exitCode === 73 \? 73/);
  assert.match(controller, /\/usr\/local\/lib\/skyjo-online\/admission-lock\.mjs/);
  assert.match(remote, /controller_status != 255 && controller_status != 73/);
  assert.doesNotMatch(remote, /controller_status != (?!255|73)\d+/);
  assert.match(bootstrap, /skyjo_secure_directory "\$AUTH_ROOT" root root 0700/);
  assert.match(bootstrap, /skyjo_atomic_install "\$canary_authorization_key" "\$AUTH_ROOT\/canary-2026-07\.pem"/);
  assert.match(bootstrap, /skyjo_atomic_install "\$production_authorization_key" "\$AUTH_ROOT\/production-2026-07\.pem"/);
  assert.match(bootstrap, /Installed canary key differs from its immutable snapshot/);
  assert.match(bootstrap, /Production environment content changed during preparation/);
  assert.match(bootstrap, /ensure_system_identity skyjo \/var\/lib\/skyjo-online \/usr\/sbin\/nologin/);
  assert.match(bootstrap, /ensure_system_identity skyjo-canary \/var\/empty\/skyjo-canary \/usr\/sbin\/nologin/);
  assert.match(bootstrap, /ensure_system_identity skyjo-deploy \/var\/lib\/skyjo-deploy \/bin\/sh/);
  assert.match(bootstrap, /Runtime identity has unexpected supplementary groups/);
  assert.match(bootstrap, /Runtime identities must have distinct primary group IDs/);
  assert.match(bootstrap, /Runtime private group is shared by another primary identity/);
  assert.match(bootstrap, /skyjo_publish_legacy_proof_environment "\$env_path" root skyjo[\s\S]*?\|\| return 1/);
  assert.match(bootstrap, /skyjo_remove_legacy_proof_environment/);
  assert.match(bootstrap, /\. "\$SCRIPT_DIR\/legacy-proof-unit-cleanup-lib\.sh"/);
  assert.match(bootstrap, /skyjo_finalize_bootstrap_legacy_proof "\$proof_status" "\$unit" "\$env_path"/);
  assert.match(legacyUnitCleanup, /skyjo-online-legacy-proof@bootstrap-activation\.service/);
  assert.match(legacyUnitCleanup, /show --no-pager --all[\s\S]*--property=Id[\s\S]*--property=CollectMode/);
  assert.match(legacyUnitCleanup, /"\$skyjo_cleanup_systemctl" reset-failed "\$skyjo_cleanup_unit" \|\| return 1/);
  assert.doesNotMatch(legacyUnitCleanup, /reset-failed[^\n]*\|\| true/);
  const sudoersPreflight = bootstrap.indexOf('visudo -cf "$SCRIPT_DIR/skyjo-deploy.sudoers"');
  const sudoersPublication = bootstrap.indexOf('install_asset "$SCRIPT_DIR/skyjo-deploy.sudoers"');
  const unitPreflight = bootstrap.indexOf('systemd-analyze verify \\\n    "$SCRIPT_DIR/skyjo-online-canary@.service"');
  const unitPublication = bootstrap.indexOf('install_asset "$SCRIPT_DIR/skyjo-online-canary@.service"');
  assert.ok(sudoersPreflight > 0 && sudoersPublication > sudoersPreflight, 'sudoers source must preflight before publication');
  assert.ok(unitPreflight > 0 && unitPublication > unitPreflight, 'systemd sources must preflight before publication');
  const wrapperPublication = bootstrap.lastIndexOf('skyjo_atomic_install "$SCRIPT_DIR/skyjo-delivery-bootstrap"');
  const daemonReload = bootstrap.lastIndexOf('/usr/bin/systemctl daemon-reload', wrapperPublication);
  const generationPublication = bootstrap.lastIndexOf('skyjo_publish_relative_symlink "$BOOTSTRAP_STORE/current"');
  assert.ok(wrapperPublication > daemonReload && generationPublication > wrapperPublication,
    'delayed bootstrap entrypoint must publish only after successful preparation');
  const activationStart = bootstrap.indexOf('activate_unit()');
  const transientGuard = bootstrap.indexOf('SYSTEMD_EXEC_PID', activationStart);
  const productionStop = bootstrap.indexOf('systemctl stop skyjo-online.service', activationStart);
  assert.ok(activationStart >= 0 && transientGuard > activationStart && transientGuard < productionStop, 'transient-service guard must precede production stop');
  assert.match(bootstrap, /activation_proof\(\) \{ run_legacy_proof "\$target" \|\| return 1; \}/);
  assert.match(bootstrap, /skyjo_run_activation_transaction activation_recover/);
  const recoveryBlock = bootstrap.indexOf('activation_recover()', productionStop);
  const recoveryStop = bootstrap.indexOf('systemctl stop skyjo-online.service', recoveryBlock);
  assert.doesNotMatch(bootstrap.slice(recoveryStop, bootstrap.indexOf('sha256sum --check', recoveryStop)), /\|\| true/,
    'recovery must not restore the legacy unit while a hardened process may still be active');
  const recoveryStart = bootstrap.indexOf('/usr/bin/systemctl start skyjo-online.service ||', recoveryBlock);
  const recoveryProof = bootstrap.indexOf('run_legacy_proof "$target" ||', recoveryStart);
  assert.ok(recoveryStart > productionStop && recoveryProof > recoveryStart,
    'failure recovery must run the full trusted legacy proof after restarting the original unit');
  assert.doesNotMatch(bootstrap.slice(recoveryStart, recoveryProof), /healthz/,
    'failure recovery may not substitute a health-only check for the full trusted proof');
  assert.match(bootstrap, /Unexpected systemd drop-in directory must be removed before preparation/);
  const savedUnitCheck = bootstrap.indexOf('sha256sum --check --strict "$old_unit_checksum"');
  assert.ok(savedUnitCheck > activationStart && savedUnitCheck < productionStop,
    'saved legacy unit checksum must verify before production stop');
  const liveUnitCompare = bootstrap.indexOf('skyjo_classify_activation_unit /etc/systemd/system/skyjo-online.service "$old_unit" "$STAGED_UNIT"');
  assert.ok(liveUnitCompare > savedUnitCheck && liveUnitCompare < productionStop,
    'live unit must classify as exact legacy or staged hardened content before production stop');
  assert.match(bootstrap, /activation_steps='activation_stop activation_prepare_state activation_reload activation_start activation_health activation_proof'/);
  const adoptionStart = bootstrap.indexOf('adopt_legacy()');
  const adoptionBackup = bootstrap.indexOf('skyjo_prepare_unit_backup', adoptionStart);
  const numericStagingCleanup = 'skyjo_cleanup_legacy_staging "$APP_ROOT/releases" "$sha" 0 0 4';
  const adoptionStagingCleanup = bootstrap.indexOf(numericStagingCleanup, adoptionStart);
  const adoptionTargetPublish = bootstrap.indexOf('/usr/bin/mv -T "$tmp" "$target"', adoptionStart);
  const numericCurrentLink = 'skyjo_ensure_legacy_link "$APP_ROOT/current" "releases/$sha" 0 0';
  const numericPreviousLink = 'skyjo_ensure_legacy_link "$APP_ROOT/previous" "releases/$sha" 0 0';
  const adoptionCurrent = bootstrap.indexOf(numericCurrentLink, adoptionStart);
  const adoptionPrevious = bootstrap.indexOf(numericPreviousLink, adoptionStart);
  assert.ok(adoptionBackup > adoptionStart && adoptionStagingCleanup > adoptionBackup && adoptionTargetPublish > adoptionStagingCleanup &&
    adoptionCurrent > adoptionTargetPublish && adoptionPrevious > adoptionCurrent,
    'adoption must back up, clean interrupted staging, and resumably publish target, current, then previous');
  assert.equal(bootstrap.indexOf(numericStagingCleanup, adoptionStagingCleanup + numericStagingCleanup.length), -1,
    'installed bootstrap must have exactly one numeric interrupted-staging cleanup call site');
  assert.equal(bootstrap.indexOf(numericCurrentLink, adoptionCurrent + numericCurrentLink.length), -1,
    'installed bootstrap must have exactly one numeric current-link call site');
  assert.equal(bootstrap.indexOf(numericPreviousLink, adoptionPrevious + numericPreviousLink.length), -1,
    'installed bootstrap must have exactly one numeric previous-link call site');
  assert.doesNotMatch(bootstrap, /skyjo_ensure_legacy_link "\$APP_ROOT\/(?:current|previous)" "releases\/\$sha" root root/,
    'installed bootstrap must not pass account names to the numeric link ownership contract');
  assert.doesNotMatch(bootstrap, /skyjo_cleanup_legacy_staging "\$APP_ROOT\/releases" "\$sha" root root/,
    'installed bootstrap must not pass account names to the numeric staging ownership contract');
  assert.match(service, /User=skyjo/);
  assert.match(service, /\/opt\/skyjo-online\/node\/bin\/node/);
  assert.match(canary, /^User=skyjo-canary$/m);
  assert.match(canary, /^CollectMode=inactive$/m);
  assert.match(canary, /EnvironmentFile=\/run\/skyjo-online-canary\/%i\.env/);
  assert.doesNotMatch(canary, /^EnvironmentFile=\/etc\/skyjo-online\.env$/m);
  assert.match(canary, /^IPAddressDeny=any$/m);
  assert.match(canary, /^IPAddressAllow=localhost$/m);
  assert.doesNotMatch(canary, /^PrivateTmp=true$/m);
  assert.match(canarySmoke, /^User=skyjo-canary$/m);
  assert.match(canarySmoke, /^CollectMode=inactive$/m);
  assert.doesNotMatch(canarySmoke, /^EnvironmentFile=\/etc\/skyjo-online\.env$/m);
  assert.match(productionSmoke, /^User=skyjo$/m);
  assert.match(productionSmoke, /^CollectMode=inactive$/m);
  assert.match(productionSmoke, /^EnvironmentFile=\/etc\/skyjo-online\.env$/m);
  assert.match(stateProof, /^User=skyjo-canary$/m);
  assert.match(stateProof, /^CollectMode=inactive$/m);
  assert.match(stateProof, /^RestrictAddressFamilies=AF_UNIX$/m);
  assert.doesNotMatch(stateProof, /^PrivateTmp=true$/m);
  assert.match(legacyProof, /^User=skyjo$/m);
  assert.match(legacyProof, /^CollectMode=inactive$/m);
  assert.match(legacyProof, /^EnvironmentFile=\/etc\/skyjo-online\.env$/m);
  assert.match(legacyProof, /^IPAddressAllow=localhost$/m);
  assert.doesNotMatch(legacyProof, /^User=skyjo-canary$/m);
  assert.match(stateProofLauncher, /"\$release\/scripts\/backup-state\.mjs"/);
  assert.match(stateProofLauncher, /"\$release\/scripts\/verify-state-backup\.mjs"/);
  assert.match(legacyProofScript, /inspectRuntimeState/);
  assert.match(legacyProofScript, /smoke account authentication failed/);
  assert.match(controller, /SKYJO_VAPID_PRIVATE_KEY=/);
  assert.match(controller, /\['root:root', runDirectory\]/);
  assert.match(controller, /\['0711', runDirectory\]/);
  assert.doesNotMatch(controller, /run\(PATHS\.node, \[resolveWithin\(releaseDirectory, 'scripts\//);
  assert.match(controller, /verifyRunningProduction\(oldRelease, rollbackAnchor, parsed\.runId\)/);
  assert.match(controller, /publishImmutableDirectory\(incoming, immutableTarget\)/);
  assert.match(controller, /proveDurablePublishedDirectory\(immutableTarget\)/);
  assert.match(controller, /fsyncFilesystemPath\(PATHS\.releases, \{ directory: true \}\)/);
  assert.match(controller, /swap: async \(markLinksChanged\)/);
  assert.match(controller, /flag: 'wx'/);
  const promotionPreflight = controller.indexOf('async function promoteAction(parsed)');
  const hardenedUnit = controller.indexOf('await assertHardenedProductionUnit()', promotionPreflight);
  const rollbackAnchor = controller.indexOf('const rollbackAnchor = await validateRollbackAnchor(oldRelease)', hardenedUnit);
  const reviveCurrent = controller.indexOf('await verifyRunningProduction(oldRelease, rollbackAnchor, parsed.runId)', rollbackAnchor);
  const prepareCandidate = controller.indexOf('const prepared = await prepareCandidate(parsed)', reviveCurrent);
  assert.ok(promotionPreflight >= 0 && hardenedUnit > promotionPreflight && rollbackAnchor > hardenedUnit &&
    reviveCurrent > rollbackAnchor && prepareCandidate > reviveCurrent,
  'fresh promotion must start and fully prove the validated current release before candidate work');
  assert.match(controller, /assertEffectiveDeliveryUnits/);
  assert.match(controller, /Deployment staging requires .*ext4.*link-count.*semantics/);
  assert.match(controller, /Effective production systemd DropInPaths must be empty/);
  assert.match(controller, /primary groups must be distinct/);
  assert.match(sudoers, /^skyjo-deploy .*NOPASSWD: \/usr\/local\/sbin\/skyjo-release-controller \*$/m);
});

test('first activation runbooks require a disconnect-safe transient service sharing the controller lock', async () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  for (const name of ['atomic-vps-releases.md', 'immutable-deployment.md']) {
    const document = await fs.readFile(path.join(root, 'docs', name), 'utf8');
    assert.match(document, /systemd-run/);
    assert.match(document, /--service-type=exec/);
    assert.match(document, /flock --exclusive --nonblock --no-fork/);
    assert.match(document, /\/usr\/local\/sbin\/skyjo-delivery-bootstrap activate-production-unit/);
    assert.match(document, /\/usr\/local\/sbin\/skyjo-delivery-bootstrap adopt-legacy/);
    assert.doesNotMatch(document, /deploy\/bootstrap-skyjo-delivery\.sh adopt-legacy/);
    assert.doesNotMatch(document, /sudo (?:deploy\/bootstrap-skyjo-delivery\.sh|[^\n]*BOOTSTRAP[^\n]*) activate-production-unit/);
  }
});

test('the one-time command-protocol cutover requires pre-merge bootstrap and manual canary evidence', async () => {
  const document = await fs.readFile(path.resolve(import.meta.dirname, '..', '..', 'docs', 'immutable-deployment.md'), 'utf8');
  assert.match(document, /Signed-action protocol cutover/);
  assert.match(document, /dispatcher\/controller installed from `0cc063e`/);
  assert.match(document, /Release Canary` is intentionally ineligible on pull requests/);
  assert.match(document, /git -c core\.autocrlf=false -c core\.eol=lf archive/);
  assert.match(document, /Before merging, run `bootstrap-skyjo-delivery\.sh prepare`/);
  assert.match(document, /manual `verify` through `deploy\/github-release-remote\.sh`/);
  assert.match(document, /Merge only after that manual canary passes/);
  assert.match(document, /Do not tag or promote during the cutover window/);
});
