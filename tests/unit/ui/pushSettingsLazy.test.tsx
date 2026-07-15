import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import type { AccountUser } from '../../../src/account';

vi.mock('../../../src/PushSettingsControls', () => {
  throw new Error('Simulated stale settings chunk.');
});

import App from '../../../src/App';

const accountUser: AccountUser = {
  id: 'push-settings-user',
  email: 'push-settings@example.test',
  displayName: 'Push Settings User',
  role: 'player',
  disabled: false,
  createdAt: 1,
  updatedAt: 2,
  lastLoginAt: 3
};

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('lazy push settings recovery', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/account');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/account/me') return response({ user: accountUser });
      return response({});
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('resolves a rejected settings chunk to an accessible full-reload fallback', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Reload turn alerts');
    expect(screen.getByRole('link', { name: 'Reload turn alerts' })).toHaveAttribute('href', '/account');
    expect(screen.getByRole('link', { name: 'Reload turn alerts' })).toHaveClass('skyjo-button', 'px-3', 'py-2');
  });
});
