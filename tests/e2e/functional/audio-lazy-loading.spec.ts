import { expect, test } from '../fixtures';
import { startFreshSoloGame } from '../helpers/soloFlow';

const audioSettingsKey = 'skyjo-audio-settings-v3';
const cuePaths = ['/audio/card-flip.mp3', '/audio/card-pickup.mp3', '/audio/card-place.mp3'];

test.describe('lazy audio loading', () => {
  test.use({ serviceWorkers: 'block' });

  for (const path of ['/', '/single-player']) {
    test(`${path} does not request MP3 assets before activation`, async ({ page, skyjoServer }) => {
      const audioRequests: string[] = [];
      page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.endsWith('.mp3')) audioRequests.push(pathname);
      });

      await page.goto(`${skyjoServer.baseURL}${path}`);
      await expect(page.getByRole('main')).toBeVisible();
      await page.waitForTimeout(250);

      expect(audioRequests).toEqual([]);
    });
  }

  test('the first audio gesture fetches cues once and resume waits for another gesture', async ({ page, skyjoServer }) => {
    await page.addInitScript(() => {
      class DeterministicAudioContext {
        readonly destination = {};
        state = 'suspended';

        async decodeAudioData() {
          return {};
        }

        createBufferSource() {
          return { buffer: null, connect() {}, start() {}, stop() {} };
        }

        createGain() {
          return { connect() {}, gain: { value: 1 } };
        }

        async resume() {
          this.state = 'running';
        }

        async suspend() {
          this.state = 'suspended';
        }
      }

      Object.defineProperty(window, 'AudioContext', { configurable: true, value: DeterministicAudioContext });
    });
    const audioRequests: string[] = [];
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith('.mp3')) audioRequests.push(pathname);
    });

    await page.goto(skyjoServer.baseURL);
    await expect(page.getByRole('heading', { name: 'Skyjo', exact: true })).toBeVisible();
    expect(audioRequests).toEqual([]);

    await page.getByText('Sound', { exact: true }).click();
    await page.getByRole('button', { name: 'Preview sounds' }).click();
    await expect.poll(() => [...audioRequests].sort()).toEqual([...cuePaths].sort());

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
    });
    await page.waitForTimeout(250);
    expect([...audioRequests].sort()).toEqual([...cuePaths].sort());

    await page.getByRole('heading', { name: 'Skyjo', exact: true }).click();
    await page.waitForTimeout(250);
    expect([...audioRequests].sort()).toEqual([...cuePaths].sort());
  });

  test('disabled game sounds do not request audio after trusted gestures', async ({ page, skyjoServer }) => {
    await page.addInitScript(({ key }) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({ ambience: false, ambienceVolume: 0, soundEffects: false, soundVolume: 0.72 })
      );
    }, { key: audioSettingsKey });
    const audioRequests: string[] = [];
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith('.mp3')) audioRequests.push(pathname);
    });

    await startFreshSoloGame(page, skyjoServer.baseURL);
    await page.getByRole('heading', { name: 'Single Player' }).click();
    await page.keyboard.press('Tab');
    await page.waitForTimeout(250);

    expect(audioRequests).toEqual([]);
  });
});
