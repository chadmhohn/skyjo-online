import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GameTableLayout, type DrawIntent } from '../../../src/GameTableLayout';
import { revealOpeningCard } from '../../../src/game';
import type { Card, GameState, Player } from '../../../src/types';
import { setMediaQueryMatches } from '../../setup/dom';

function card(playerId: string, index: number, faceUp = false): Card {
  return {
    id: `${playerId}-card-${index}`,
    value: (index % 12) - 2,
    faceUp,
    removed: false
  };
}

function player(index: number): Player {
  const id = `p${index + 1}`;
  return {
    id,
    kind: index === 0 ? 'human' : 'ai',
    name: index === 0 ? 'You' : `Opponent ${index}`,
    grid: Array.from({ length: 12 }, (_, cardIndex) => card(id, cardIndex)),
    totalScore: index,
    roundScore: index
  };
}

function stateFor(playerCount: number, overrides: Partial<GameState> = {}): GameState {
  const players = Array.from({ length: playerCount }, (_, index) => player(index));
  return {
    players,
    drawPile: [card('draw', 0), card('draw', 1)],
    discardPile: [{ ...card('discard', 0, true), value: 4 }],
    currentPlayerIndex: 0,
    phase: 'opening-reveal',
    selectedSource: null,
    drawnCard: null,
    round: 1,
    log: [],
    winnerId: null,
    nextStarterId: null,
    roundCloserId: null,
    finalTurnPlayerIds: [],
    openingRevealCounts: Object.fromEntries(players.map((item) => [item.id, 0])),
    roundHistory: [],
    ...overrides
  };
}

function handlers() {
  return {
    onCardClick: vi.fn(),
    onChooseDiscard: vi.fn(),
    onCancelDiscard: vi.fn(),
    onDraw: vi.fn(),
    onSetDrawIntent: vi.fn<(intent: DrawIntent) => void>()
  };
}

describe('GameTableLayout', () => {
  it.each([2, 3, 4, 8])('renders one ordered table tree with roster modifiers for %i players', (playerCount) => {
    const actions = handlers();
    render(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={stateFor(playerCount)}
      />
    );

    const table = screen.getByTestId('shared-game-table');
    const opponentRail = screen.getByTestId('opponent-rail');
    const localBoard = screen.getByTestId('local-board');
    expect(Array.from(table.children).map((element) => element.getAttribute('data-testid'))).toEqual([
      'opponent-rail',
      'table-center-band',
      'local-board'
    ]);
    expect(screen.getAllByTestId('shared-game-table')).toHaveLength(1);
    expect(screen.getAllByTestId('table-center')).toHaveLength(1);
    expect(table).toHaveClass(`skyjo-table-roster-${playerCount}`);
    expect(opponentRail).toHaveClass(`skyjo-opponents-count-${playerCount - 1}`);
    expect(opponentRail).toHaveAttribute('data-entry-count', String(playerCount - 1));
    expect(opponentRail).toHaveAttribute('data-scroll-contained', 'true');
    expect(opponentRail.querySelectorAll('[data-player-role="opponent"]')).toHaveLength(playerCount - 1);
    expect(localBoard.querySelectorAll('[data-player-role="local"]')).toHaveLength(1);
    expect(table.querySelectorAll('[data-player-id]')).toHaveLength(playerCount);
    expect(opponentRail.querySelectorAll('[role="grid"]')).toHaveLength(playerCount - 1);
    expect(localBoard.querySelectorAll('[role="grid"]')).toHaveLength(1);
    expect(table.querySelectorAll('[role="row"]')).toHaveLength(playerCount * 3);
    expect(table.querySelectorAll('[role="gridcell"]')).toHaveLength(playerCount * 12);
    expect(opponentRail.querySelectorAll('button')).toHaveLength(0);
    expect(localBoard.querySelectorAll('button')).toHaveLength(12);
    expect(opponentRail.querySelector('[role="gridcell"]')).toHaveAccessibleName(/Opponent 1, row 1, column 1, SKYJO face-down/);
    expect(opponentRail.querySelector('[role="gridcell"]')).not.toHaveAccessibleName(/minus 2/);
    expect(
      within(screen.getByRole('region', { name: 'Action guidance' })).getByRole('heading', {
        level: 3,
        name: 'Choose two face-down cards'
      })
    ).toBeInTheDocument();
  });

  it('routes local card and centered pile decisions through the supplied callbacks', async () => {
    const user = userEvent.setup();
    const actions = handlers();
    const opening = stateFor(2);
    const { rerender } = render(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={opening}
      />
    );

    await user.click(screen.getByRole('button', { name: /You, row 1, column 1, SKYJO face-down\. Reveal this opening card/ }));
    expect(actions.onCardClick).toHaveBeenCalledWith(0);

    const chooseSource = stateFor(2, {
      phase: 'choose-source',
      openingRevealCounts: { p1: 2, p2: 2 }
    });
    rerender(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={chooseSource}
      />
    );
    await user.click(screen.getByRole('button', { name: /Deck/ }));
    await user.click(screen.getByRole('button', { name: /Discard/ }));
    expect(actions.onDraw).toHaveBeenCalledTimes(1);
    expect(actions.onChooseDiscard).toHaveBeenCalledTimes(1);

    rerender(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={{ ...chooseSource, phase: 'choose-replacement', selectedSource: 'discard' }}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Put the discard card back.' }));
    expect(actions.onCancelDiscard).toHaveBeenCalledTimes(1);

    rerender(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={{
          ...chooseSource,
          phase: 'choose-replacement',
          selectedSource: 'draw',
          drawnCard: { ...card('blind', 0, true), value: 7 }
        }}
      />
    );
    await user.click(screen.getByRole('button', { name: /Discard \+ reveal/ }));
    expect(actions.onSetDrawIntent).toHaveBeenCalledWith('discard');
  });

  it('keeps one actionable card in the tab order and moves it with grid arrow keys', async () => {
    const user = userEvent.setup();
    const actions = handlers();
    render(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={stateFor(2)}
      />
    );

    const cards = screen.getAllByRole('button', { name: /Reveal this opening card/ });
    expect(cards[0]).toHaveAttribute('tabindex', '0');
    expect(cards[1]).toHaveAttribute('tabindex', '-1');
    cards[0].focus();
    await user.keyboard('{ArrowRight}');
    expect(cards[1]).toHaveFocus();
    expect(cards[0]).toHaveAttribute('tabindex', '-1');
    expect(cards[1]).toHaveAttribute('tabindex', '0');
  });

  it('recovers focus to the next opening card and then to stable action guidance', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(1);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    function StatefulTable() {
      const [state, setState] = useState(() => stateFor(2));
      return (
        <GameTableLayout
          {...handlers()}
          drawIntent="place"
          localPlayerId="p1"
          localTurn={state.currentPlayerIndex === 0}
          onCardClick={(index) => setState((current) => revealOpeningCard(current, index))}
          state={state}
        />
      );
    }

    render(<StatefulTable />);
    const first = screen.getAllByRole('button', { name: /Reveal this opening card/ })[0];
    await user.click(first);
    const next = screen.getAllByRole('button', { name: /Reveal this opening card/ })[0];
    await waitFor(() => expect(next).toHaveFocus());
    await user.click(next);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Action guidance' })).toHaveFocus());
    expect(screen.queryAllByRole('button', { name: /Reveal this opening card/ })).toHaveLength(0);
  });

  it('does not let deferred card focus recovery override explicit deck focus', async () => {
    const user = userEvent.setup();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrameId += 1;
      frames.set(nextFrameId, callback);
      return nextFrameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => {
      frames.delete(frameId);
    });

    function flushFrames() {
      const pendingFrames = [...frames.values()];
      frames.clear();
      pendingFrames.forEach((callback) => callback(1));
    }

    function StatefulTable() {
      const [state, setState] = useState(() => stateFor(2));
      return (
        <GameTableLayout
          {...handlers()}
          drawIntent="place"
          localPlayerId="p1"
          localTurn={state.currentPlayerIndex === 0}
          onCardClick={(index) =>
            setState((current) => {
              const next = revealOpeningCard(current, index);
              if ((next.openingRevealCounts.p1 ?? 0) < 2) return next;
              return {
                ...next,
                currentPlayerIndex: 0,
                phase: 'choose-source',
                openingRevealCounts: { ...next.openingRevealCounts, p2: 2 }
              };
            })
          }
          state={state}
        />
      );
    }

    render(<StatefulTable />);
    await user.click(screen.getAllByRole('button', { name: /Reveal this opening card/ })[0]);
    act(flushFrames);

    const next = screen.getAllByRole('button', { name: /Reveal this opening card/ })[0];
    expect(next).toHaveFocus();
    await user.click(next);

    const deck = screen.getByRole('button', { name: /^Deck/ });
    expect(deck).toBeEnabled();
    deck.focus();
    expect(deck).toHaveFocus();

    act(flushFrames);

    expect(deck).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Action guidance' })).not.toHaveFocus();
  });

  it('uses one atomic turn announcer and deduplicates changing waiting players', async () => {
    const actions = handlers();
    const { rerender } = render(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn={false}
        state={stateFor(3, { currentPlayerIndex: 1 })}
      />
    );
    await waitFor(() => expect(screen.getByTestId('turn-announcer')).toHaveTextContent('Waiting for other players.'));
    expect(screen.getAllByTestId('turn-announcer')).toHaveLength(1);
    expect(screen.getByTestId('turn-announcer')).toHaveTextContent('Waiting for other players.');
    expect(screen.getByTestId('shared-game-table').querySelectorAll('[aria-live]')).toHaveLength(1);

    rerender(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn={false}
        state={stateFor(3, { currentPlayerIndex: 2, log: ['Opponent changed'] })}
      />
    );
    await waitFor(() => expect(screen.getByTestId('turn-announcer')).toHaveTextContent('Waiting for other players.'));
  });

  it('renders one complete phone guidance region outside the geometry anchor, including disabled reasons', () => {
    act(() => setMediaQueryMatches('(max-width: 640px)', true));
    const actions = handlers();
    render(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        interactionDisabledReason="Room recovery is still synchronizing."
        localPlayerId="p1"
        localTurn
        state={stateFor(2)}
      />
    );

    const guidance = screen.getByRole('region', { name: 'Action guidance' });
    expect(screen.getAllByRole('region', { name: 'Action guidance' })).toHaveLength(1);
    expect(guidance).toHaveClass('skyjo-phone-action-guidance');
    expect(guidance).toHaveTextContent('Choose two face-down cards');
    expect(within(guidance).getByRole('heading', { level: 2, name: 'Choose two face-down cards' })).toBeInTheDocument();
    expect(guidance).toHaveTextContent('Each player reveals exactly two cards');
    expect(guidance).toHaveTextContent('Action unavailable: Room recovery is still synchronizing.');
    expect(screen.getByTestId('shared-game-table')).not.toContainElement(guidance);
  });

  it('auto-scrolls only the contained opponent rail when the active opponent changes', () => {
    const actions = handlers();
    const scrollTo = vi.fn();
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(1);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const state = stateFor(4, { currentPlayerIndex: 2 });
    render(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn={false}
        state={state}
      />
    );

    expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: 'smooth' });
    expect(scrollIntoView).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByTestId('opponent-rail'));
    expect(screen.getByTestId('opponent-rail')).toHaveAttribute('data-scroll-contained', 'true');
  });

  it('switches contained opponent scrolling to auto when reduced motion changes live', () => {
    const actions = handlers();
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(1);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    render(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn={false}
        state={stateFor(4, { currentPlayerIndex: 2 })}
      />
    );

    expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: 'smooth' });
    scrollTo.mockClear();
    act(() => setMediaQueryMatches('(prefers-reduced-motion: reduce)', true));
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: 'auto' });
  });
});
