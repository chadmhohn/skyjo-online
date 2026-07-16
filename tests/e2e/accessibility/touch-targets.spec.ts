import type { Page } from '@playwright/test';
import { expect, installSeededBrowserRuntime, test } from '../fixtures';

const minimumTargetSize = 43.99;

async function expectTouchTargets(page: Page, state: string) {
  const targets = await page.locator(
    'a[href], button, input:not([type="hidden"]), select, summary, textarea, [role="button"], [role="switch"], [role="tab"], [tabindex="0"]'
  ).evaluateAll((elements) =>
    [...new Set(elements)].flatMap((element) => {
      const htmlElement = element as HTMLElement;
      const style = window.getComputedStyle(htmlElement);
      const rect = htmlElement.getBoundingClientRect();
      if (
        htmlElement.hidden ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        rect.width === 0 ||
        rect.height === 0
      ) {
        return [];
      }
      return [{
        disabled: (htmlElement as HTMLButtonElement).disabled === true,
        height: rect.height,
        label:
          htmlElement.getAttribute('aria-label') ||
          htmlElement.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ||
          htmlElement.getAttribute('type') ||
          htmlElement.tagName.toLowerCase(),
        tag: htmlElement.tagName.toLowerCase(),
        width: rect.width
      }];
    })
  );
  expect(targets.length, `${state} should expose interactive targets`).toBeGreaterThan(0);
  const undersized = targets.filter(
    (target) => target.width < minimumTargetSize || target.height < minimumTargetSize
  );
  expect(undersized, `${state} contains targets smaller than 44 by 44 CSS pixels`).toEqual([]);
  return targets;
}

async function waitForSavedSoloGame(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const request = indexedDB.open('skyjo-pwa', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const database = request.result;
              const records = database.transaction('soloSessions').objectStore('soloSessions').count();
              records.onerror = () => reject(records.error);
              records.onsuccess = () => {
                resolve(records.result);
                database.close();
              };
            };
          })
      )
    )
    .toBeGreaterThan(0);
}

async function expectPhoneGuidanceFullyVisible(page: Page, state: string) {
  const guidance = page.getByRole('region', { name: 'Action guidance' });
  await expect(guidance).toBeVisible();
  const geometry = await guidance.evaluate((element) => {
    const container = element.getBoundingClientRect();
    const content = [...element.querySelectorAll('.skyjo-action-guidance-title, .skyjo-action-guidance-instruction, .skyjo-disabled-note')]
      .map((child) => child.getBoundingClientRect());
    return {
      contentContained: content.every(
        (rect) => rect.top >= container.top - 0.5 && rect.bottom <= container.bottom + 0.5
      ),
      inViewport: container.top >= -0.5 && container.bottom <= window.innerHeight + 0.5,
      noClipping: (element as HTMLElement).scrollHeight <= (element as HTMLElement).clientHeight + 1
    };
  });
  expect(geometry, `${state} phone guidance should be fully readable`).toEqual({
    contentContained: true,
    inViewport: true,
    noClipping: true
  });
  await expect(guidance.locator('.skyjo-action-guidance-instruction')).toBeVisible();
  await expect(guidance.locator('.skyjo-disabled-note')).toBeVisible();
}

async function enableDoubleText(page: Page) {
  const baseline = await page.evaluate(() => Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize));
  await page.evaluate(() => document.documentElement.classList.add('skyjo-test-text-scale-200'));
  const scaled = await page.evaluate(() => Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize));
  expect(scaled).toBeCloseTo(baseline * 2, 2);
}

async function phoneTypeSizes(page: Page) {
  return page.evaluate(() => {
    const size = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing phone type sample: ${selector}`);
      return Number.parseFloat(window.getComputedStyle(element).fontSize);
    };
    return {
      guidanceInstruction: size('.skyjo-phone-action-guidance .skyjo-action-guidance-instruction'),
      guidanceNote: size('.skyjo-phone-action-guidance .skyjo-disabled-note'),
      guidanceTitle: size('.skyjo-phone-action-guidance .skyjo-action-guidance-title'),
      title: size('.skyjo-game-title')
    };
  });
}

function expectScaledTypeOutcome(normal: number, scaled: number, minimum: number, label: string) {
  expect(scaled, `${label} should meet its 200% effective size`).toBeGreaterThanOrEqual(minimum);
  expect(scaled + 0.01, `${label} should not shrink`).toBeGreaterThanOrEqual(normal);
  expect(
    scaled / normal >= 1.9 || normal >= minimum - 0.01,
    `${label} should double or already be browser-inflated: ${JSON.stringify({ normal, scaled })}`
  ).toBe(true);
}

async function expectGuidanceDetailsReachable(page: Page) {
  const guidance = page.getByRole('region', { name: 'Action guidance' });
  await expect(guidance).toBeVisible();
  await expect(guidance).toHaveAttribute('tabindex', '0');
  await guidance.focus();
  await expect(guidance).toBeFocused();
  await page.keyboard.press('Home');
  await expect.poll(() => guidance.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
  await expect(guidance.locator('.skyjo-action-guidance-title')).toBeInViewport();
  const maximum = await guidance.evaluate((element) => element.scrollHeight - element.clientHeight);
  expect(maximum).toBeGreaterThan(1);
  await page.keyboard.press('PageDown');
  await expect.poll(() => guidance.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('End');
  await expect.poll(() =>
    guidance.evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))
  ).toBeLessThanOrEqual(1);
  const noteEndVisible = await guidance.locator('.skyjo-disabled-note').evaluate((note) => {
    const region = note.parentElement?.closest<HTMLElement>('[aria-label="Action guidance"]');
    if (!region) return false;
    const regionRect = region.getBoundingClientRect();
    const noteRect = note.getBoundingClientRect();
    return noteRect.bottom <= regionRect.bottom + 1 && noteRect.bottom > regionRect.top + 1;
  });
  expect(noteEndVisible).toBe(true);
  expect(await page.evaluate(() => ({ left: window.scrollX, top: window.scrollY }))).toEqual({ left: 0, top: 0 });
}

test('visible controls meet the 44px target contract across routes and disabled states', async ({ context, page, skyjoServer }) => {
  test.setTimeout(60_000);
  await installSeededBrowserRuntime(page, 75);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto(skyjoServer.baseURL);
  await expectTouchTargets(page, 'home');

  await page.goto(`${skyjoServer.baseURL}/account`);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expectTouchTargets(page, 'account signup');

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const signup = await context.request.post(`${skyjoServer.baseURL}/api/account/signup`, {
    data: {
      email: `targets-${suffix}@example.test`,
      displayName: 'Target Tester',
      password: 'target-test-password',
      confirmPassword: 'target-test-password'
    }
  });
  expect(signup.status()).toBe(201);

  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await expectPhoneGuidanceFullyVisible(page, 'solo opening at 390x844');
  const openingTargets = await expectTouchTargets(page, 'solo opening');
  expect(openingTargets.some((target) => target.disabled)).toBe(true);

  await page.getByRole('button', { name: 'Open game settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Game' }).click();
  await expectTouchTargets(page, 'solo settings');
  await settings.getByRole('button', { name: 'Close game settings' }).click();

  await page.goto(`${skyjoServer.baseURL}/lobby`);
  await expect(page.getByRole('heading', { name: 'Multiplayer Lobby' })).toBeVisible();
  await expectTouchTargets(page, 'multiplayer lobby');
  await page.getByRole('button', { name: 'Create Room' }).click();
  await expect(page.locator('.skyjo-room-code')).toBeVisible();
  const waitingTargets = await expectTouchTargets(page, 'waiting room');
  expect(waitingTargets.some((target) => target.disabled)).toBe(true);
});

test('settings dialog traps focus and restores its trigger in a real browser', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 76);
  await page.goto(`${skyjoServer.baseURL}/single-player`);

  const trigger = page.getByRole('button', { name: 'Open game settings' });
  await trigger.click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const closeButton = settings.getByRole('button', { name: 'Close game settings' });
  await expect(closeButton).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(settings.getByRole('button', { name: 'Done' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('200% text remains operable without horizontal scroll on a short 320px viewport', async ({ page, skyjoServer }) => {
  test.setTimeout(45_000);
  await installSeededBrowserRuntime(page, 77);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(skyjoServer.baseURL);
  await enableDoubleText(page);
  await expectTouchTargets(page, 'home at 200% text and 320x568');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  await page.goto(`${skyjoServer.baseURL}/single-player`);
  const compactGuidance = page.getByRole('region', { name: 'Action guidance' });
  await expect(compactGuidance).toBeVisible();
  await expect(compactGuidance.locator('.skyjo-action-guidance-title')).toBeInViewport();
  await expect
    .poll(() => compactGuidance.evaluate((element) => Number.parseFloat(getComputedStyle(element).maxHeight)))
    .toBe(64);
  await expectGuidanceDetailsReachable(page);
  const normalType = await phoneTypeSizes(page);
  await enableDoubleText(page);
  const scaledType = await phoneTypeSizes(page);
  expectScaledTypeOutcome(normalType.title, scaledType.title, 28, 'Single Player heading');
  expectScaledTypeOutcome(normalType.guidanceTitle, scaledType.guidanceTitle, 25.5, 'Guidance heading');
  expectScaledTypeOutcome(normalType.guidanceInstruction, scaledType.guidanceInstruction, 22, 'Guidance instruction');
  expectScaledTypeOutcome(normalType.guidanceNote, scaledType.guidanceNote, 22, 'Guidance disabled note');
  await expectGuidanceDetailsReachable(page);
  await expectTouchTargets(page, 'solo at 200% text and 320x568');
  await page.getByRole('button', { name: 'Open game settings' }).click();
  await expectTouchTargets(page, 'settings at 200% text and 320x568');
  await page.getByRole('button', { name: 'Close game settings' }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  await page.getByRole('button', { name: /face-down\. Reveal this opening card/ }).first().click();
  await waitForSavedSoloGame(page);
  await page.reload();
  await enableDoubleText(page);
  const resumeDialog = page.getByRole('dialog', { name: 'Continue your solo game?' });
  await expect(resumeDialog).toBeVisible();
  expect(await resumeDialog.evaluate((element) => window.getComputedStyle(element).overflowY)).toBe('auto');
  await page.getByRole('button', { name: 'New Game' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'New Game' })).toBeVisible();
  await expectTouchTargets(page, 'saved-game dialog at 200% text and 320x568');
});
