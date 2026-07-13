import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GameTableLayout, type DrawIntent } from '../../../src/GameTableLayout';
import type { Card, GameState, Player } from '../../../src/types';

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

    await user.click(screen.getByRole('button', { name: 'Reveal opening card 1.' }));
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
});
