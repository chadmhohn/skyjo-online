import { expect, test } from '../fixtures';

async function expectCompletePwaHead(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('meta[charset]')).toHaveAttribute('charset', /utf-8/i);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0a1410');
  await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'black-translucent');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'Skyjo');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/skyjo-icon-v2.svg');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/skyjo-icon-v2-180.png');
}

test('a live room invite hands off through browser and open-access Home Screen paths', async ({
  browser,
  context,
  page,
  skyjoServer
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`.replace(/[^a-z0-9-]/gi, '-');
  const signup = await context.request.post(`${skyjoServer.baseURL}/api/account/signup`, {
    data: {
      email: `invite-host-${suffix}@example.test`,
      displayName: 'Invite Host',
      password: 'invite-handoff-password',
      confirmPassword: 'invite-handoff-password'
    }
  });
  expect(signup.status()).toBe(201);

  await page.goto(`${skyjoServer.baseURL}/`);
  await expectCompletePwaHead(page);
  await page.goto(`${skyjoServer.baseURL}/lobby`);
  await expect(page.getByRole('heading', { name: 'Multiplayer Lobby' })).toBeVisible();
  await page.getByRole('button', { name: 'Create Room' }).click();
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connected');
  const roomCode = (await page.locator('.skyjo-room-code').innerText()).trim();
  expect(roomCode).toMatch(/^[A-Z0-9]{5}$/);

  const inviteResponse = await context.request.post(`${skyjoServer.baseURL}/api/rooms/invite`, {
    data: { roomCode }
  });
  expect(inviteResponse.status()).toBe(200);
  const invite = await inviteResponse.json() as { path: string; roomCode: string };
  expect(invite.roomCode).toBe(roomCode);
  expect(invite.path).toMatch(/^\/invite\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const landingContext = await browser.newContext({ serviceWorkers: 'block' });
  const codeContext = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const landingPage = await landingContext.newPage();
    const landingResponse = await landingPage.goto(`${skyjoServer.baseURL}${invite.path}`, {
      waitUntil: 'domcontentloaded'
    });
    expect(landingResponse?.status()).toBe(200);
    expect(landingResponse?.headers()['cache-control']).toContain('no-store');
    expect(landingResponse?.headers()['referrer-policy']).toBe('no-referrer');
    expect(landingResponse?.headers()['content-security-policy']).toContain("form-action 'self'");
    await expectCompletePwaHead(landingPage);
    await expect(landingPage.getByRole('heading', { name: `Join Room ${roomCode}` })).toBeVisible();
    await expect(landingPage.locator('#room-code')).toHaveValue(roomCode);
    await expect(landingPage.getByText('create or sign in to your account')).toBeVisible();

    await landingPage.getByRole('link', { name: 'Open in Browser' }).click();
    await expect(landingPage).toHaveURL(`${skyjoServer.baseURL}/lobby?room=${roomCode}`);
    await expect(landingPage.getByRole('heading', { name: 'Sign in to play multiplayer' })).toBeVisible();
    const browserCookies = await landingContext.cookies();
    expect(browserCookies.some((cookie) => cookie.name.startsWith('skyjo_session_') && cookie.value)).toBe(true);

    const codePage = await codeContext.newPage();
    const codeSignup = await codeContext.request.post(`${skyjoServer.baseURL}/api/account/signup`, {
      data: {
        email: `invite-guest-${suffix}@example.test`,
        displayName: 'Invite Guest',
        password: 'invite-handoff-password',
        confirmPassword: 'invite-handoff-password'
      }
    });
    expect(codeSignup.status()).toBe(201);
    await codePage.goto(`${skyjoServer.baseURL}/lobby?room=${roomCode}`);
    await expectCompletePwaHead(codePage);
    await expect(codePage.getByLabel('Room code')).toHaveValue(roomCode);
    await codePage.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(codePage.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connected');
    await expect(codePage.locator('.skyjo-room-code')).toHaveText(roomCode);
  } finally {
    await Promise.all([landingContext.close(), codeContext.close()]);
  }
});
