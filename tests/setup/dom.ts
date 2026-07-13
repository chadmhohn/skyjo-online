import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { resetSoloDatabaseForTests } from '../../src/soloDurability';

type MutableMediaQueryList = MediaQueryList & {
  setMatches: (matches: boolean) => void;
};

const mediaQueries = new Map<string, MutableMediaQueryList>();

function mediaQueryList(query: string): MutableMediaQueryList {
  const existing = mediaQueries.get(query);
  if (existing) return existing;
  const eventTarget = new EventTarget();
  let matches = false;
  const result = {
    get matches() {
      return matches;
    },
    media: query,
    onchange: null,
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    addListener: (listener: (event: MediaQueryListEvent) => void) => eventTarget.addEventListener('change', listener as EventListener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => eventTarget.removeEventListener('change', listener as EventListener),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    setMatches(nextMatches: boolean) {
      if (matches === nextMatches) return;
      matches = nextMatches;
      const event = new Event('change') as MediaQueryListEvent;
      Object.defineProperties(event, {
        matches: { value: matches },
        media: { value: query }
      });
      eventTarget.dispatchEvent(event);
    }
  } as MutableMediaQueryList;
  mediaQueries.set(query, result);
  return result;
}

export function setMediaQueryMatches(query: string, matches: boolean) {
  mediaQueryList(query).setMatches(matches);
}

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: mediaQueryList
});

Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => undefined
});

Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
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
  mediaQueries.forEach((query) => query.setMatches(false));
  await resetSoloDatabaseForTests();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
});
