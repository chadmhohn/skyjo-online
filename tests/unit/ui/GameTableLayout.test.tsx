import { useLayoutEffect, useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PHONE_LAYOUT_MEDIA_QUERY } from '../../../src/accessibility';
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

  it('renders an optional center start accessory without disturbing the existing table controls', async () => {
    const user = userEvent.setup();
    const actions = handlers();
    const chooseSource = stateFor(2, {
      phase: 'choose-source',
      openingRevealCounts: { p1: 2, p2: 2 }
    });
    const { container, rerender } = render(
      <GameTableLayout
        {...actions}
        centerStartAccessory={<div data-testid="center-start-accessory">Room tools</div>}
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={chooseSource}
      />
    );

    const startSide = container.querySelector<HTMLElement>('.skyjo-table-band-side-start');
    const accessory = screen.getByTestId('center-start-accessory');
    const piles = screen.getByTestId('table-piles');
    const deck = screen.getByRole('button', { name: /^Deck/ });
    const discard = screen.getByTitle('Take the top discard card.');
    expect(startSide).toContainElement(accessory);
    expect(screen.getByTestId('table-center')).toContainElement(piles);
    expect(deck).toBeEnabled();
    expect(discard).toBeEnabled();

    await user.click(deck);
    await user.click(discard);
    expect(actions.onDraw).toHaveBeenCalledOnce();
    expect(actions.onChooseDiscard).toHaveBeenCalledOnce();

    rerender(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={chooseSource}
      />
    );
    expect(screen.queryByTestId('center-start-accessory')).not.toBeInTheDocument();
    expect(screen.getByTestId('table-piles')).toBe(piles);
    expect(screen.getByRole('button', { name: /^Deck/ })).toBeEnabled();
  });

  it('makes both boards keyboard-scrollable only for a contained fixed table', () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo
    });
    const actions = handlers();
    const { rerender } = render(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={stateFor(2)}
      />
    );
    const opponentRail = screen.getByTestId('opponent-rail');
    const localBoard = screen.getByTestId('local-board');
    expect(opponentRail).toHaveAttribute('role', 'region');
    expect(opponentRail).not.toHaveAttribute('tabindex');
    expect(localBoard).not.toHaveAttribute('role');
    expect(localBoard).not.toHaveAttribute('tabindex');
    rerender(
      <GameTableLayout
        {...actions}
        containBoardScroll
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={stateFor(2)}
      />
    );
    expect(opponentRail).not.toHaveAttribute('tabindex');
    const activeOpponent = opponentRail.querySelector<HTMLElement>('[data-vertical-scroll-active="true"]');
    expect(activeOpponent).not.toBeNull();
    expect(activeOpponent).toHaveAttribute('tabindex', '0');
    expect(activeOpponent).toHaveAccessibleName('Opponent 1 board');
    expect(localBoard).toHaveAttribute('data-scroll-contained', 'true');
    expect(localBoard).toHaveAttribute('role', 'region');
    expect(localBoard).toHaveAttribute('tabindex', '0');
    Object.defineProperties(localBoard, {
      clientHeight: { configurable: true, value: 200 },
      scrollLeft: { configurable: true, value: 0, writable: true },
      scrollTop: { configurable: true, value: 0, writable: true }
    });
    expect(fireEvent.keyDown(localBoard, { key: 'ArrowDown' })).toBe(false);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 44 });

    rerender(
      <GameTableLayout
        {...actions}
        containBoardScroll
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={stateFor(3)}
      />
    );
    expect(opponentRail).not.toHaveAttribute('tabindex');
    expect(opponentRail.querySelectorAll('[data-vertical-scroll-active="true"]')).toHaveLength(2);
    expect(opponentRail.querySelectorAll('[data-player-role="opponent"][tabindex="0"]')).toHaveLength(2);

    rerender(
      <GameTableLayout
        {...actions}
        containBoardScroll
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={stateFor(8)}
      />
    );
    expect(opponentRail).toHaveAttribute('tabindex', '0');
    expect(opponentRail.querySelectorAll('[data-vertical-scroll-active="true"]')).toHaveLength(1);
    expect(opponentRail.querySelectorAll('[data-player-role="opponent"][tabindex="0"]')).toHaveLength(1);
    expect(opponentRail.querySelectorAll('[data-player-role="opponent"][tabindex="-1"]')).toHaveLength(6);
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
    const drawnDecision = screen.getByRole('region', { name: 'Drawn card decision' });
    expect(screen.queryByRole('region', { name: 'Action guidance' })).not.toBeInTheDocument();
    expect(drawnDecision.querySelector('.skyjo-drawn-action-grid')).toBeInTheDocument();
    expect(drawnDecision.querySelector('.skyjo-drawn-action-grid')).not.toHaveClass('mt-3');
    expect(drawnDecision).toHaveTextContent('Place selected. Choose a highlighted card.');
    expect(within(drawnDecision).getByText('7')).toHaveClass('skyjo-drawn-card');
    expect(within(drawnDecision).getAllByRole('button')).toHaveLength(2);
    await user.click(within(drawnDecision).getByRole('button', { name: /Discard \+ reveal/ }));
    expect(actions.onSetDrawIntent).toHaveBeenCalledWith('discard');
  });

  it('announces the private drawn value and moves keyboard focus to its decision controls', async () => {
    const user = userEvent.setup();
    const actions = handlers();
    const chooseSource = stateFor(2, {
      phase: 'choose-source',
      openingRevealCounts: { p1: 2, p2: 2 }
    });
    const { rerender } = render(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={chooseSource}
      />
    );
    const deck = screen.getByRole('button', { name: /^Deck/ });
    deck.focus();
    await user.keyboard('{Enter}');
    expect(actions.onDraw).toHaveBeenCalledOnce();
    document.documentElement.setAttribute('tabindex', '-1');
    document.documentElement.focus();
    expect(document.documentElement).toHaveFocus();

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
          drawnCard: { ...card('blind', 0, true), value: -2 }
        }}
      />
    );
    document.documentElement.removeAttribute('tabindex');

    expect(screen.getByRole('button', { name: 'Place drawn card' })).toHaveFocus();
    await waitFor(() => expect(screen.getByTestId('turn-announcer')).toHaveTextContent(
      'You drew minus 2. Place mode selected.'
    ));
  });

  it('keeps structural phone table bands out of the accessibility tree and exposes final-lap status once', async () => {
    act(() => setMediaQueryMatches(PHONE_LAYOUT_MEDIA_QUERY, true));
    const actions = handlers();
    const opening = stateFor(2);
    const { container, rerender } = render(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={opening}
      />
    );
    const progressBand = container.querySelector<HTMLElement>('.skyjo-table-band-side-start');
    expect(progressBand).not.toBeNull();
    expect(progressBand).not.toHaveAttribute('role');
    expect(progressBand).not.toHaveAttribute('aria-label');
    expect(progressBand).toHaveAttribute('tabindex', '-1');
    expect(screen.queryByRole('region', { name: /opening reveal progress/i })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Action guidance' })).toHaveTextContent('Choose two face-down cards');

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
    expect(progressBand).not.toHaveAttribute('role');
    expect(progressBand).toHaveAttribute('tabindex', '-1');

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
    const drawnProgressBand = container.querySelector<HTMLElement>('.skyjo-table-band-side-start');
    expect(drawnProgressBand).not.toBeNull();
    expect(drawnProgressBand).not.toHaveAttribute('role');
    expect(drawnProgressBand).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('region', { name: 'Drawn card decision' })).toBeInTheDocument();

    const finalTurn = {
      ...chooseSource,
      roundCloserId: 'p2',
      finalTurnPlayerIds: ['p1']
    };
    rerender(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={finalTurn}
      />
    );
    const finalLap = screen.getByRole('region', { name: 'Final lap status' });
    expect(screen.getAllByRole('region', { name: 'Final lap status' })).toHaveLength(1);
    expect(finalLap).toBe(container.querySelector('.skyjo-table-band-side-start'));
    expect(finalLap).toHaveAttribute('tabindex', '0');
    expect(finalLap).toHaveTextContent('Opponent 1 went out.');
    expect(finalLap).toHaveTextContent('This is your last move of the round.');

    finalLap.focus();
    expect(finalLap).toHaveFocus();
    rerender(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={{ ...chooseSource, phase: 'round-over' }}
      />
    );
    await waitFor(() => expect(screen.getByRole('region', { name: 'Action guidance' })).toHaveFocus());
    expect(finalLap).not.toHaveAttribute('role');
    expect(finalLap).not.toHaveAttribute('aria-label');
    expect(finalLap).toHaveAttribute('tabindex', '-1');
  });

  it('keeps visible desktop opening progress named and keyboard reachable', () => {
    act(() => setMediaQueryMatches(PHONE_LAYOUT_MEDIA_QUERY, false));
    render(
      <GameTableLayout
        {...handlers()}
        drawIntent="place"
        localPlayerId="p1"
        localTurn
        state={stateFor(2)}
      />
    );

    const progress = screen.getByRole('region', { name: 'Opening reveal progress' });
    expect(progress).toHaveAttribute('tabindex', '0');
    expect(progress).toHaveTextContent('You (you)');
    expect(progress).toHaveTextContent('0/2');
  });

  it('names the authoritative current player while a waiting player watches the final lap', () => {
    const finalTurn = stateFor(3, {
      currentPlayerIndex: 1,
      phase: 'choose-source',
      roundCloserId: 'p1',
      finalTurnPlayerIds: ['p2', 'p3'],
      openingRevealCounts: { p1: 2, p2: 2, p3: 2 }
    });

    render(
      <GameTableLayout
        {...handlers()}
        drawIntent="place"
        localPlayerId="p3"
        localTurn={false}
        state={finalTurn}
      />
    );

    expect(screen.getByRole('region', { name: 'Final lap status' })).toHaveTextContent(
      'Opponent 1 is taking a final turn.'
    );
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

  it('retires opening-card focus recovery before a back-to-back authoritative draw snapshot', async () => {
    const user = userEvent.setup();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrameId += 1;
      frames.set(nextFrameId, callback);
      return nextFrameId;
    });
    // A frame can already be dequeued when a WebKit commit attempts to cancel
    // it. Keep callbacks runnable to prove that their interaction scope also
    // prevents stale focus, independent of cancellation timing.
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    function flushFrames() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(1));
    }

    function RapidAuthoritativeTable() {
      const [state, setState] = useState(() => stateFor(2));

      useLayoutEffect(() => {
        if (state.phase !== 'choose-source') return;
        setState((current) => ({
          ...current,
          phase: 'choose-replacement',
          selectedSource: 'draw',
          drawnCard: { ...card('blind', 0, true), value: 7 }
        }));
      }, [state.phase]);

      return (
        <GameTableLayout
          {...handlers()}
          drawIntent="place"
          localPlayerId="p1"
          localTurn
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

    render(<RapidAuthoritativeTable />);
    await user.click(screen.getAllByRole('button', { name: /Reveal this opening card/ })[0]);
    const next = screen.getAllByRole('button', { name: /Reveal this opening card/ })[0];
    await user.click(next);
    expect(screen.getByRole('region', { name: 'Drawn card decision' })).toBeInTheDocument();

    act(flushFrames);

    expect(document.activeElement).not.toHaveAttribute('data-card-index');
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
    act(() => setMediaQueryMatches(PHONE_LAYOUT_MEDIA_QUERY, true));
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

  it('cancels contained auto-follow for supported gestures without hijacking modified or handled keys', () => {
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
    const { unmount } = render(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn={false}
        state={stateFor(8, { currentPlayerIndex: 2 })}
      />
    );
    const rail = screen.getByTestId('opponent-rail');
    Object.defineProperty(rail, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(rail, 'scrollLeft', { configurable: true, value: 173, writable: true });
    Object.defineProperty(rail, 'scrollWidth', { configurable: true, value: 1000 });
    scrollTo.mockClear();

    fireEvent.focusIn(rail);
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
      expect(fireEvent.keyDown(rail, { key })).toBe(false);
    }
    fireEvent.wheel(rail, { deltaX: 80 });
    fireEvent.pointerDown(rail);
    fireEvent.touchStart(rail, { touches: [{ clientX: 200, clientY: 100 }] });

    expect(scrollTo).toHaveBeenCalledTimes(16);
    expect(scrollTo).toHaveBeenNthCalledWith(3, { left: 123, behavior: 'auto' });
    expect(scrollTo).toHaveBeenNthCalledWith(5, { left: 223, behavior: 'auto' });
    expect(scrollTo).toHaveBeenNthCalledWith(7, { left: 0, behavior: 'auto' });
    expect(scrollTo).toHaveBeenNthCalledWith(9, { left: 800, behavior: 'auto' });
    expect(scrollTo).toHaveBeenNthCalledWith(11, { left: 0, behavior: 'auto' });
    expect(scrollTo).toHaveBeenNthCalledWith(13, { left: 353, behavior: 'auto' });
    expect(scrollTo).toHaveBeenNthCalledWith(16, { left: 173, behavior: 'auto' });
    expect(fireEvent.keyDown(rail, { key: 'Enter' })).toBe(true);
    fireEvent.wheel(screen.getByTestId('local-board'), { deltaX: 80 });
    expect(scrollTo).toHaveBeenCalledTimes(16);
    for (const modifier of [
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true }
    ]) {
      expect(fireEvent.keyDown(rail, { key: 'ArrowRight', ...modifier })).toBe(true);
    }
    const alreadyPrevented = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowRight'
    });
    alreadyPrevented.preventDefault();
    rail.dispatchEvent(alreadyPrevented);
    expect(scrollTo).toHaveBeenCalledTimes(16);
    unmount();
  });

  it('retains the rail through state updates and follows the latest opponent after the gesture pause', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));
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
    const rendered = render(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn={false}
        state={stateFor(8, { currentPlayerIndex: 2 })}
      />
    );
    const rail = screen.getByTestId('opponent-rail');
    Object.defineProperty(rail, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(rail, 'scrollLeft', { configurable: true, value: 173, writable: true });
    rail.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
    const latestOpponent = rail.querySelector<HTMLElement>('[data-player-id="p4"]');
    if (!latestOpponent) throw new Error('Missing latest opponent test board.');
    latestOpponent.getBoundingClientRect = () => ({ left: 300, width: 100 }) as DOMRect;
    scrollTo.mockClear();

    fireEvent.wheel(rail, { deltaX: 80 });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 173, behavior: 'auto' });
    rendered.rerender(
      <GameTableLayout
        {...actions}
        drawIntent="place"
        localPlayerId="p1"
        localTurn={false}
        state={stateFor(8, { currentPlayerIndex: 3, log: ['Turn advanced'] })}
      />
    );
    expect(scrollTo).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1_799));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 473, behavior: 'smooth' });

    rendered.unmount();
    vi.useRealTimers();
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
