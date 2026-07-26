import { isIgnorableWindowsChromeCleanupError } from '../../../scripts/lighthouse-gate-lib.mjs';

describe('Lighthouse gate cleanup', () => {
  const options = { platform: 'win32', tempDirectory: 'C:\\Users\\tester\\AppData\\Local\\Temp' };

  it.each(['EPERM', 'EBUSY'])('accepts only the known %s temporary-profile cleanup race', (code) => {
    expect(isIgnorableWindowsChromeCleanupError({
      code,
      syscall: 'rm',
      path: '\\\\?\\C:\\Users\\tester\\AppData\\Local\\Temp\\lighthouse.1234'
    }, options)).toBe(true);
  });

  it.each([
    [{ code: 'EACCES', syscall: 'rm', path: 'C:\\Users\\tester\\AppData\\Local\\Temp\\lighthouse.1234' }, options],
    [{ code: 'EPERM', syscall: 'open', path: 'C:\\Users\\tester\\AppData\\Local\\Temp\\lighthouse.1234' }, options],
    [{ code: 'EPERM', syscall: 'rm', path: 'C:\\Users\\tester\\AppData\\Local\\Temp\\unrelated' }, options],
    [{ code: 'EPERM', syscall: 'rm', path: 'C:\\srv\\skyjo-online' }, options],
    [{ code: 'EPERM', syscall: 'rm', path: 'C:\\Users\\tester\\AppData\\Local\\Temp\\lighthouse.1234' }, { ...options, platform: 'linux' }]
  ])('rejects unrelated cleanup failures', (error, context) => {
    expect(isIgnorableWindowsChromeCleanupError(error, context)).toBe(false);
  });
});
