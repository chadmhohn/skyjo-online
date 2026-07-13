import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import App from '../../../src/App';

describe('application shell', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ user: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the home choices and navigates to a deterministic solo table', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Skyjo' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Single Player' }));
    expect(await screen.findByRole('heading', { name: 'Single Player' })).toBeInTheDocument();
    expect(screen.getAllByTestId('shared-game-table')).toHaveLength(1);
    expect(screen.getAllByTestId('opponent-rail')).toHaveLength(1);
    expect(screen.getAllByTestId('table-center')).toHaveLength(1);
    expect(screen.getAllByTestId('local-board')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Reveal opening card/ })).not.toHaveLength(0);
  });
});
