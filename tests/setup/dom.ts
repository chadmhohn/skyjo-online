import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { resetSoloDatabaseForTests } from '../../src/soloDurability';

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true
  })
});

Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => undefined
});

Object.defineProperty(HTMLMediaElement.prototype, 'load', {
  configurable: true,
  value: () => undefined
});

Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
  configurable: true,
  value: () => undefined
});

Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true,
  value: async () => undefined
});

afterEach(async () => {
  cleanup();
  await resetSoloDatabaseForTests();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
});
