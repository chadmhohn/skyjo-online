import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveDeployedSmokeAccount } from '../../../scripts/deployed-smoke-lib.mjs';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

describe('deployed smoke protocol contract', () => {
  it('defaults both entrypoint and library to the current protocol instead of retired v1', async () => {
    const [entrypoint, library, inviteRestartSmoke, chatSmoke] = await Promise.all([
      fs.readFile(path.join(root, 'scripts', 'smoke-deployed.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'deployed-smoke-lib.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'smoke-invite-restart.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'smoke-chat.mjs'), 'utf8')
    ]);
    expect(entrypoint).toContain("import { CURRENT_PROTOCOL_VERSION } from '../server-release.mjs'");
    expect(entrypoint).toMatch(/configuredProtocolVersion === undefined\s*\? CURRENT_PROTOCOL_VERSION/);
    expect(entrypoint).not.toMatch(/SKYJO_EXPECTED_PROTOCOL_VERSION \|\| 1/);
    expect(library).toContain("import { CURRENT_PROTOCOL_VERSION } from '../server-release.mjs'");
    expect(library).toMatch(/expectedProtocolVersion = CURRENT_PROTOCOL_VERSION/);
    expect(library).not.toMatch(/expectedProtocolVersion = 1/);
    expect(entrypoint).toContain('resolveAppleApplicationIdentifier');
    expect(entrypoint).toContain('expectedAppleApplicationIdentifier:');
    expect(entrypoint).toContain('resolveDeployedSmokeAccount');
    expect(library).toContain('/api/account/signup');
    expect(library).toContain('createAccount = false');
    expect(library).toContain('/.well-known/apple-app-site-association');
    expect(library).toContain('/api/rooms/invite/redeem');
    expect(library).toContain('INVITE_INVALID_OR_EXPIRED');
    expect(library).toMatch(/method: 'HEAD'/);
    expect(library).toMatch(/\.test\(cookie\)/);
    expect(library).not.toMatch(/assert\.match\(cookie/);
    expect(inviteRestartSmoke).not.toContain('console.error(logs)');
    expect(inviteRestartSmoke).not.toMatch(/assert\.match\(persistedRoomInstanceId/);
    expect(chatSmoke).not.toContain("console.error(serverLogs.join(''))");
    expect(chatSmoke).not.toMatch(/assert\.deepEqual\((?:expired|stale)NativeInvite\.payload/);
    const publicSmoke = await fs.readFile(path.join(root, 'scripts', 'smoke-public-release.mjs'), 'utf8');
    expect(publicSmoke).toContain('allowPreNativeInviteRollback');
    expect(publicSmoke).toContain('pre-native-invite rollback must retain the shared access gate');
  });

  it('adapts legacy controller environments without weakening production smoke', () => {
    const legacyEmail = 'canary-public-run-id@example.invalid';
    const canaryRelease = '/var/tmp/skyjo-deploy/32806169752-1-canary/release';
    const canary = resolveDeployedSmokeAccount({
      releaseDirectory: canaryRelease,
      runtimeDirectory: canaryRelease,
      configuredEmail: legacyEmail,
      configuredPassword: 'random-controller-password',
      randomBytes: (size: number) => Buffer.alloc(size, size === 18 ? 0xab : 0xcd)
    });
    expect(canary).toEqual({
      createAccount: true,
      email: `canary-${'ab'.repeat(18)}@example.invalid`,
      password: Buffer.alloc(32, 0xcd).toString('base64url')
    });
    expect(canary.email).not.toBe(legacyEmail);
    expect(canary.password).not.toBe('random-controller-password');

    const productionLaneCanary = '/var/tmp/skyjo-deploy/32806169752-2-production/release';
    expect(resolveDeployedSmokeAccount({
      releaseDirectory: productionLaneCanary,
      runtimeDirectory: productionLaneCanary,
      configuredSetup: 'signup',
      randomBytes: (size: number) => Buffer.alloc(size, 0xef)
    }).createAccount).toBe(true);

    expect(() => resolveDeployedSmokeAccount({
      releaseDirectory: canaryRelease,
      runtimeDirectory: canaryRelease,
      configuredSetup: 'existing'
    })).toThrow('An isolated staged canary cannot use a pre-existing account.');
    expect(() => resolveDeployedSmokeAccount({
      releaseDirectory: canaryRelease,
      runtimeDirectory: '/var/tmp/skyjo-deploy/32806169752-2-canary/release'
    })).toThrow('does not match its runtime');
    expect(() => resolveDeployedSmokeAccount({
      releaseDirectory: '/tmp/skyjo/release',
      runtimeDirectory: '/tmp/skyjo/release'
    })).toThrow('outside the trusted runtime roots');

    const productionRelease = `/srv/skyjo-online/releases/${'a'.repeat(40)}`;
    expect(resolveDeployedSmokeAccount({
      releaseDirectory: productionRelease,
      runtimeDirectory: productionRelease,
      configuredSetup: 'existing',
      configuredEmail: 'release-smoke@example.invalid',
      configuredPassword: 'production-smoke-password'
    })).toEqual({
      createAccount: false,
      email: 'release-smoke@example.invalid',
      password: 'production-smoke-password'
    });

    expect(() => resolveDeployedSmokeAccount({
      releaseDirectory: productionRelease,
      runtimeDirectory: productionRelease,
      configuredSetup: 'signup',
      configuredEmail: 'release-smoke@example.invalid',
      configuredPassword: 'production-smoke-password'
    })).toThrow('Production smoke cannot create an account.');
  });
});
