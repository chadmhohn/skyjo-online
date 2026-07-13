import { expect, test } from '../fixtures';

test('multiplayer stays read-only offline and recovers the same seat without focus socket churn', async ({
  context,
  page,
  skyjoServer
}, testInfo) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    let socketCount = 0;
    class CountingWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) super(url);
        else super(url, protocols);
        socketCount += 1;
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: CountingWebSocket });
    Object.defineProperty(window, '__skyjoSocketCount', { configurable: true, get: () => socketCount });
  });

  const projectPart = testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  await page.goto(`${skyjoServer.baseURL}/account?next=/lobby`);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.getByLabel('Email').fill(`recovery-${projectPart}@example.test`);
  await page.getByLabel('Display name').fill('Recovery Player');
  await page.getByLabel('Password', { exact: true }).fill('recovery-secret-123');
  await page.getByLabel('Confirm password').fill('recovery-secret-123');
  await page.getByRole('button', { name: 'Create Account' }).click();

  const connection = page.getByTestId('connection-status');
  await expect(connection).toHaveAttribute('data-connection-state', 'idle');
  await page.getByRole('button', { name: 'Create Room' }).click();
  await expect(connection).toHaveAttribute('data-connection-state', 'connected');
  const roomCode = await page.locator('.skyjo-room-code').innerText();
  expect(roomCode).toMatch(/^[A-Z0-9]{5}$/);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __skyjoSocketCount: number }).__skyjoSocketCount)).toBe(1);

  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __skyjoSocketCount: number }).__skyjoSocketCount)).toBe(1);
  await page.getByRole('button', { name: /Table Chat/ }).click();

  await context.setOffline(true);
  await expect(connection).toHaveAttribute('data-connection-state', 'offline', { timeout: 500 });
  await expect(page.locator('.skyjo-room-code')).toHaveText(roomCode);
  await expect(page.getByRole('button', { name: 'Reset Room' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();

  await context.setOffline(false);
  await expect(connection).toHaveAttribute('data-connection-state', 'connected', { timeout: 10_000 });
  await expect(page.locator('.skyjo-room-code')).toHaveText(roomCode);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __skyjoSocketCount: number }).__skyjoSocketCount)).toBe(2);
});
