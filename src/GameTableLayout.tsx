import { useEffect, useRef } from 'react';
import { knownCardCount } from './gamePresentation';
import type { Card, GameState, Player } from './types';

const rows = [0, 1, 2];
const columns = [0, 1, 2, 3];
const currentPlayerScrollPauseMs = 1800;

export type DrawIntent = 'place' | 'discard';
export type PlayerBoardVariant = 'opponents' | 'local';

type TurnStatusTone = 'local' | 'waiting' | 'neutral';
type TurnStatus = {
  eyebrow: string;
  title: string;
  description: string;
  tone: TurnStatusTone;
};

export interface GameTableLayoutProps {
  state: GameState;
  localPlayerId?: string;
  localTurn: boolean;
  drawIntent: DrawIntent;
  interactionDisabledReason?: string;
  onCardClick: (index: number) => void;
  onChooseDiscard: () => void;
  onCancelDiscard: () => void;
  onDraw: () => void;
  onSetDrawIntent: (intent: DrawIntent) => void;
}

function cardLabel(card: Card) {
  if (card.removed) return '';
  if (card.faceUp) return card.value < 0 ? `-${Math.abs(card.value)}` : String(card.value);
  return 'SKYJO';
}

function cardClass(card: Card, isSelectable: boolean) {
  const base = `skyjo-card ${isSelectable ? 'skyjo-card-selectable cursor-pointer' : 'cursor-default'}`;
  if (card.removed) return `${base} skyjo-card-removed`;
  if (!card.faceUp) return `${base} skyjo-card-hidden`;
  if (card.value === -2) return `${base} skyjo-card-blue-dark`;
  if (card.value === -1) return `${base} skyjo-card-blue`;
  if (card.value === 0) return `${base} skyjo-card-cyan`;
  if (card.value <= 4) return `${base} skyjo-card-green`;
  if (card.value <= 8) return `${base} skyjo-card-gold`;
  return `${base} skyjo-card-red`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function hiddenCardCount(player: Player) {
  return player.grid.filter((card) => !card.faceUp && !card.removed).length;
}

function openingRevealCount(state: GameState, player: Player) {
  return Math.min(state.openingRevealCounts[player.id] ?? 0, 2);
}

function getTurnStatus(state: GameState, localTurn: boolean): TurnStatus {
  const activePlayer = state.players[state.currentPlayerIndex];
  const activeName = activePlayer?.name || 'Current player';

  if (state.phase === 'round-over') {
    return {
      eyebrow: 'Round over',
      title: 'Round scoring is complete',
      description: 'Check the round score and total score, then start the next round when ready.',
      tone: 'neutral'
    };
  }

  if (state.phase === 'game-over') {
    return {
      eyebrow: 'Game over',
      title: 'Final totals are in',
      description: 'The lowest total score wins the game.',
      tone: 'neutral'
    };
  }

  if (state.phase === 'opening-reveal') {
    const remaining = Math.max(0, 2 - openingRevealCount(state, activePlayer));
    return localTurn
      ? {
          eyebrow: 'Your move',
          title: 'Choose two face-down cards',
          description: `${pluralize(remaining, 'opening card')} left. Each player reveals exactly two cards before the round starts.`,
          tone: 'local'
        }
      : {
          eyebrow: 'Waiting',
          title: `Waiting on ${activeName}`,
          description: `${activeName} is choosing two face-down cards. Each player reveals exactly two cards before the round starts.`,
          tone: 'waiting'
        };
  }

  if (state.phase === 'choose-source') {
    return localTurn
      ? {
          eyebrow: 'Your turn',
          title: 'Choose a source',
          description: 'Take the visible discard card or draw blind from the deck.',
          tone: 'local'
        }
      : {
          eyebrow: 'Waiting',
          title: `Waiting on ${activeName}`,
          description: `${activeName} is choosing the discard pile or the deck.`,
          tone: 'waiting'
        };
  }

  if (state.selectedSource === 'draw' && state.drawnCard) {
    return localTurn
      ? {
          eyebrow: 'Your turn',
          title: 'Drawn card waiting',
          description: 'Place the drawn card on your board, or discard it and reveal one hidden card.',
          tone: 'local'
        }
      : {
          eyebrow: 'Waiting',
          title: `Waiting on ${activeName}`,
          description: `${activeName} must place the drawn card or discard it and reveal a hidden card.`,
          tone: 'waiting'
        };
  }

  return localTurn
    ? {
        eyebrow: 'Your turn',
        title: 'Place the discard card',
        description: 'Select any highlighted card to replace, or tap discard again to put it back.',
        tone: 'local'
      }
    : {
        eyebrow: 'Waiting',
        title: `Waiting on ${activeName}`,
        description: `${activeName} is choosing which board card to replace.`,
        tone: 'waiting'
      };
}

function sourceDisabledReason(state: GameState, localTurn: boolean, source: 'deck' | 'discard') {
  const activePlayer = state.players[state.currentPlayerIndex];

  if (state.phase === 'opening-reveal') return 'Opening reveals must finish before the piles are available.';
  if (state.phase === 'round-over') return 'Round scoring is complete.';
  if (state.phase === 'game-over') return 'Game is complete.';
  if (state.phase === 'choose-replacement') {
    return state.selectedSource === 'draw' && state.drawnCard
      ? 'Choose whether to place the drawn card or discard it first.'
      : 'Select a highlighted board card to finish this move.';
  }
  if (!localTurn) return `Waiting for ${activePlayer?.name || 'the current player'}.`;
  if (source === 'discard' && !state.discardPile[0]) return 'The discard pile is empty.';
  return '';
}

function cardAffordanceLabel({
  card,
  canSelectOpening,
  canSelectReplacement,
  drawIntent,
  index,
  isCurrent,
  isLocal,
  player,
  selectable,
  state
}: {
  card: Card;
  canSelectOpening: boolean;
  canSelectReplacement: boolean;
  drawIntent: DrawIntent;
  index: number;
  isCurrent: boolean;
  isLocal: boolean;
  player: Player;
  selectable: boolean;
  state: GameState;
}) {
  if (card.removed) return `Cleared slot ${index + 1} on ${player.name}'s board.`;
  if (selectable && canSelectOpening) return `Reveal opening card ${index + 1}.`;
  if (selectable && state.selectedSource === 'discard') return `Replace card ${index + 1} with the discard card.`;
  if (selectable && drawIntent === 'discard') return `Reveal hidden card ${index + 1} after discarding the drawn card.`;
  if (selectable) return `Replace card ${index + 1} with the drawn card.`;
  if (!isLocal) return `${player.name}'s card is not on your board.`;
  if (!isCurrent) return 'Waiting for your turn.';
  if (canSelectOpening && card.faceUp) return 'Already revealed. Choose a face-down card.';
  if (canSelectReplacement && drawIntent === 'discard' && card.faceUp) return 'Choose a hidden card to reveal after discarding.';
  if (state.phase === 'choose-source') return 'Choose the deck or discard pile first.';
  return 'This card is not selectable right now.';
}

interface PlayerGridProps {
  player: Player;
  isCurrent: boolean;
  isLocal: boolean;
  state: GameState;
  drawIntent?: DrawIntent;
  interactionDisabledReason?: string;
  onCardClick?: (index: number) => void;
}

function PlayerGrid({
  player,
  isCurrent,
  isLocal,
  state,
  drawIntent = 'place',
  interactionDisabledReason,
  onCardClick
}: PlayerGridProps) {
  const canSelectOpening =
    isLocal &&
    isCurrent &&
    state.phase === 'opening-reveal' &&
    (state.openingRevealCounts[player.id] ?? 0) < 2;
  const canSelectReplacement =
    isLocal &&
    isCurrent &&
    state.phase === 'choose-replacement' &&
    (state.selectedSource === 'discard' || state.selectedSource === 'draw');
  const selectionMode = !interactionDisabledReason && (canSelectOpening || canSelectReplacement);
  const playerRole = player.kind === 'ai' ? 'AI opponent' : isLocal ? 'You' : 'Player';
  const playerStatus = isCurrent ? (isLocal ? 'Your move now' : 'Current turn') : isLocal ? 'Waiting for your turn' : 'Waiting';
  const openingRemaining = Math.max(0, 2 - openingRevealCount(state, player));
  const knownCards = knownCardCount(player);

  return (
    <section
      className={`skyjo-panel skyjo-player-grid ${
        isLocal ? 'skyjo-player-grid-local' : 'skyjo-player-grid-opponent'
      } ${isCurrent ? 'skyjo-panel-current' : ''}`}
      data-player-id={player.id}
      data-player-role={isLocal ? 'local' : 'opponent'}
    >
      <div className="skyjo-player-grid-header mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="skyjo-serif text-xl font-semibold text-[#f5e6c8]">{player.name}</h2>
            <span
              aria-label={`${knownCards} of 12 cards flipped`}
              className="skyjo-flipped-pill"
              data-tooltip={`${knownCards} of 12 cards flipped`}
              tabIndex={0}
              title={`${knownCards} of 12 cards flipped`}
            >
              <span>{knownCards}/12</span>
              <span className="skyjo-flipped-info" aria-hidden="true">i</span>
              <span className="sr-only"> cards flipped</span>
            </span>
            {isCurrent || isLocal ? (
              <span
                className={`skyjo-turn-pill ${isCurrent && isLocal ? 'skyjo-turn-pill-local' : ''} ${
                  isLocal && !isCurrent ? 'skyjo-turn-pill-muted' : ''
                }`}
              >
                {isCurrent ? (isLocal ? 'Your turn' : 'Current turn') : 'Waiting'}
              </span>
            ) : null}
            {canSelectOpening ? <span className="skyjo-selection-pill">{openingRemaining}/2 opening picks</span> : null}
          </div>
          <p className="skyjo-player-grid-subtitle mt-1 text-sm text-[#f5e6c8]/55">
            {playerRole} - {playerStatus}
          </p>
        </div>
        <div className="skyjo-player-grid-scores flex items-baseline gap-2 text-right text-sm">
          <span className="skyjo-kicker">Shown</span>
          <span className="font-bold tabular-nums text-[#f5e6c8]">{player.roundScore}</span>
          <span className="skyjo-kicker ml-1">Total</span>
          <span className="font-bold tabular-nums text-[#f5e6c8]">{player.totalScore}</span>
        </div>
      </div>
      <div className="skyjo-player-card-rows grid">
        {rows.map((row) => (
          <div className="skyjo-player-card-row grid" key={row}>
            {columns.map((column) => {
              const index = row * 4 + column;
              const card = player.grid[index];
              const revealAfterDiscard = state.selectedSource === 'draw' && state.drawnCard && drawIntent === 'discard';
              const domainSelectable = Boolean(
                !card.removed &&
                  ((canSelectOpening && !card.faceUp) || (canSelectReplacement && (!revealAfterDiscard || !card.faceUp)))
              );
              const selectable = !interactionDisabledReason && domainSelectable;
              const dimDuringSelection = selectionMode && !selectable && !card.removed;
              const affordanceLabel = cardAffordanceLabel({
                card,
                canSelectOpening,
                canSelectReplacement,
                drawIntent,
                index,
                isCurrent,
                isLocal,
                player,
                selectable: domainSelectable,
                state
              });
              return (
                <button
                  aria-label={affordanceLabel}
                  className={`${cardClass(card, selectable)} ${selectable ? 'skyjo-card-eligible' : ''} ${
                    dimDuringSelection ? 'skyjo-card-ineligible' : ''
                  }`}
                  disabled={!selectable}
                  key={card.id}
                  onClick={() => onCardClick?.(index)}
                  title={interactionDisabledReason || affordanceLabel}
                  type="button"
                >
                  {cardLabel(card)}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

interface PlayerBoardGridProps {
  variant: PlayerBoardVariant;
  state: GameState;
  localPlayerId?: string;
  drawIntent: DrawIntent;
  interactionDisabledReason?: string;
  onCardClick: (index: number) => void;
}

export function PlayerBoardGrid({
  variant,
  state,
  localPlayerId,
  drawIntent,
  interactionDisabledReason,
  onCardClick
}: PlayerBoardGridProps) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const userScrollPausedUntilRef = useRef(0);
  const isOpponents = variant === 'opponents';
  const players = state.players.filter((player) =>
    isOpponents ? player.id !== localPlayerId : player.id === localPlayerId
  );
  const currentPlayer = state.players[state.currentPlayerIndex];
  const currentOpponentId = isOpponents && players.some((player) => player.id === currentPlayer?.id)
    ? currentPlayer.id
    : '';

  useEffect(() => {
    if (!isOpponents) return undefined;

    const element = boardRef.current;
    if (!element) return undefined;

    const pauseCurrentPlayerScroll = () => {
      userScrollPausedUntilRef.current = Date.now() + currentPlayerScrollPauseMs;
    };

    element.addEventListener('wheel', pauseCurrentPlayerScroll, { passive: true });
    element.addEventListener('touchstart', pauseCurrentPlayerScroll, { passive: true });
    element.addEventListener('pointerdown', pauseCurrentPlayerScroll, { passive: true });

    return () => {
      element.removeEventListener('wheel', pauseCurrentPlayerScroll);
      element.removeEventListener('touchstart', pauseCurrentPlayerScroll);
      element.removeEventListener('pointerdown', pauseCurrentPlayerScroll);
    };
  }, [isOpponents]);

  useEffect(() => {
    if (!isOpponents || !currentOpponentId) return undefined;

    const element = boardRef.current;
    if (!element || Date.now() < userScrollPausedUntilRef.current) return undefined;

    const target = Array.from(element.querySelectorAll<HTMLElement>('[data-player-id]')).find(
      (item) => item.dataset.playerId === currentOpponentId
    );
    if (!target) return undefined;

    const frame = window.requestAnimationFrame(() => {
      if (Date.now() < userScrollPausedUntilRef.current) return;
      const railRect = element.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetCenter = element.scrollLeft + targetRect.left - railRect.left + targetRect.width / 2;
      const left = Math.max(0, targetCenter - element.clientWidth / 2);
      element.scrollTo({ left, behavior: 'smooth' });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [currentOpponentId, isOpponents, state.log.length, state.phase]);

  return (
    <div
      aria-label={isOpponents ? 'Opponent boards' : 'Your board'}
      className={`skyjo-player-board-grid skyjo-${variant}-board skyjo-${variant}-count-${players.length}`}
      data-entry-count={players.length}
      data-layout-variant={variant}
      data-scroll-contained={isOpponents ? 'true' : undefined}
      data-testid={isOpponents ? 'opponent-rail' : 'local-board'}
      ref={boardRef}
    >
      {players.map((player) => {
        const index = state.players.findIndex((item) => item.id === player.id);
        return (
          <PlayerGrid
            drawIntent={drawIntent}
            interactionDisabledReason={interactionDisabledReason}
            isCurrent={index === state.currentPlayerIndex}
            isLocal={!isOpponents}
            key={player.id}
            onCardClick={onCardClick}
            player={player}
            state={state}
          />
        );
      })}
    </div>
  );
}

function FinalTurnCallout({ state, localPlayerId }: { state: GameState; localPlayerId?: string }) {
  const activeFinalLap =
    Boolean(state.roundCloserId) && (state.phase === 'choose-source' || state.phase === 'choose-replacement');
  if (!activeFinalLap) return null;

  const closer = state.players.find((player) => player.id === state.roundCloserId);
  const currentPlayer = state.players[state.currentPlayerIndex];
  const currentPlayerHasFinalTurn = Boolean(currentPlayer && state.finalTurnPlayerIds.includes(currentPlayer.id));
  const localPlayerHasFinalTurn = Boolean(localPlayerId && state.finalTurnPlayerIds.includes(localPlayerId));
  const closerName = closer?.name || 'A player';
  let turnMessage = 'Everyone else gets one final turn before scoring.';

  if (currentPlayerHasFinalTurn && currentPlayer?.id === localPlayerId) {
    turnMessage = 'This is your last move of the round.';
  } else if (currentPlayerHasFinalTurn && currentPlayer) {
    turnMessage = `${currentPlayer.name} is taking a final turn.`;
  } else if (localPlayerHasFinalTurn) {
    turnMessage = 'Your final turn is still coming up.';
  }

  return (
    <section aria-live="polite" className="skyjo-final-turn-callout" role="status">
      <div className="flex items-start gap-3">
        <div className="skyjo-final-turn-mark" aria-hidden="true">!</div>
        <div className="min-w-0">
          <div className="skyjo-kicker text-amber-100/75">Final lap active</div>
          <h2 className="skyjo-serif mt-1 text-xl font-bold leading-tight text-[#fff6df]">{closerName} went out.</h2>
          <p className="mt-2 text-sm font-extrabold leading-5 text-amber-100">{turnMessage}</p>
          <p className="mt-1 text-xs leading-5 text-[#f5e6c8]/68">
            {closerName} revealed their last card. No full turns remain after this final lap.
          </p>
        </div>
      </div>
    </section>
  );
}

interface TableControlsProps {
  state: GameState;
  localTurn: boolean;
  drawIntent: DrawIntent;
  interactionDisabledReason?: string;
  localPlayerId?: string;
  onChooseDiscard: () => void;
  onCancelDiscard: () => void;
  onDraw: () => void;
  onSetDrawIntent: (intent: DrawIntent) => void;
}

function TableControls({
  state,
  localTurn,
  drawIntent,
  interactionDisabledReason,
  localPlayerId,
  onChooseDiscard,
  onCancelDiscard,
  onDraw,
  onSetDrawIntent
}: TableControlsProps) {
  const topDiscard = state.discardPile[0];
  const activePlayer = state.players[state.currentPlayerIndex];
  const hasHiddenCard = hiddenCardCount(activePlayer) > 0;
  const status = getTurnStatus(state, localTurn);
  const deckDisabledReason = interactionDisabledReason || sourceDisabledReason(state, localTurn, 'deck');
  const discardDisabledReason = interactionDisabledReason || sourceDisabledReason(state, localTurn, 'discard');
  const commonDisabledReason =
    deckDisabledReason && discardDisabledReason && deckDisabledReason === discardDisabledReason ? deckDisabledReason : '';
  const selectedDiscard = localTurn && state.phase === 'choose-replacement' && state.selectedSource === 'discard';
  const hasLocalDrawnDecision = Boolean(state.drawnCard && localTurn);
  const discardButtonDisabled = Boolean(interactionDisabledReason || (discardDisabledReason && !selectedDiscard));
  const discardButtonTitle = selectedDiscard
    ? 'Put the discard card back.'
    : discardDisabledReason || 'Take the top discard card.';

  return (
    <section className="skyjo-panel skyjo-table-controls skyjo-table-glow" data-testid="table-center">
      <div
        aria-label="Turn status and opening progress"
        className="skyjo-table-band-side skyjo-table-band-side-start"
        role="region"
        tabIndex={0}
      >
        <FinalTurnCallout localPlayerId={localPlayerId} state={state} />
        <div className="skyjo-table-header flex items-center justify-between gap-3">
          <h2 className="skyjo-serif text-xl font-semibold">Table</h2>
          <span className="skyjo-kicker text-right">Round {state.round}</span>
        </div>
        <div className={`skyjo-turn-status skyjo-turn-status-${status.tone}`} aria-live="polite">
          <div className="skyjo-kicker">{status.eyebrow}</div>
          <h3 className="skyjo-serif mt-1 text-2xl font-bold leading-tight text-[#f5e6c8]">{status.title}</h3>
          <p className="mt-2 text-sm leading-6 text-[#f5e6c8]/72">{status.description}</p>
        </div>
        {state.phase === 'opening-reveal' ? (
          <div className="skyjo-opening-tracker" aria-label="Opening reveal progress">
            <div className="skyjo-kicker">Opening reveal</div>
            <div className="mt-2 grid gap-1">
              {state.players.map((player) => (
                <div className={`skyjo-opening-row ${player.id === activePlayer.id ? 'skyjo-opening-row-active' : ''}`} key={player.id}>
                  <span className="min-w-0 truncate">{player.name}{player.id === localPlayerId ? ' (you)' : ''}</span>
                  <span className="tabular-nums">{openingRevealCount(state, player)}/2</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="skyjo-table-piles grid grid-cols-2 gap-3" data-testid="table-piles">
        <button
          className="skyjo-button skyjo-pile-button text-center"
          disabled={Boolean(deckDisabledReason)}
          onClick={onDraw}
          title={deckDisabledReason || 'Draw blind from the deck.'}
          type="button"
        >
          <div className="skyjo-kicker">Deck</div>
          <div className="skyjo-card skyjo-card-hidden skyjo-table-card mx-auto">SKYJO</div>
          <div className="skyjo-table-count text-sm font-bold tabular-nums text-[#f5e6c8]/65">{state.drawPile.length} cards</div>
        </button>
        <button
          aria-label={selectedDiscard ? 'Put the discard card back.' : undefined}
          aria-pressed={selectedDiscard}
          className={`skyjo-button skyjo-pile-button text-center ${selectedDiscard ? 'skyjo-pile-button-active' : ''}`}
          disabled={discardButtonDisabled}
          onClick={selectedDiscard ? onCancelDiscard : onChooseDiscard}
          title={discardButtonTitle}
          type="button"
        >
          <div className="skyjo-kicker">{selectedDiscard ? 'Undo' : 'Discard'}</div>
          {topDiscard ? (
            <div className={`${cardClass(topDiscard, false)} skyjo-table-card mx-auto`}>{cardLabel(topDiscard)}</div>
          ) : (
            <div className="skyjo-card skyjo-card-removed skyjo-table-card mx-auto" />
          )}
          <div className="skyjo-table-count text-sm font-bold tabular-nums text-[#f5e6c8]/65">
            {selectedDiscard ? 'Tap to put back' : `${state.discardPile.length} cards`}
          </div>
        </button>
      </div>

      <div
        aria-label="Action guidance"
        className="skyjo-table-band-side skyjo-table-band-side-end"
        role="region"
        tabIndex={0}
      >
        {hasLocalDrawnDecision && state.drawnCard ? (
          <div className="skyjo-drawn-decision">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="skyjo-kicker">Drawn card waiting</div>
                <h3 className="skyjo-serif mt-1 text-xl font-bold text-[#f5e6c8]">Place it or discard it</h3>
                <p className="skyjo-drawn-description mt-2 text-sm leading-6 text-[#f5e6c8]/72">
                  Choose a mode, then select a highlighted card on your board.
                </p>
              </div>
              <div className={`${cardClass(state.drawnCard, false)} skyjo-drawn-card shrink-0`}>{cardLabel(state.drawnCard)}</div>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <button
                aria-pressed={drawIntent === 'place'}
                className={`skyjo-choice-button ${drawIntent === 'place' ? 'skyjo-choice-button-active' : ''}`}
                disabled={Boolean(interactionDisabledReason)}
                onClick={() => onSetDrawIntent('place')}
                title={interactionDisabledReason || 'Replace a card with the drawn card.'}
                type="button"
              >
                <span>Place drawn card</span>
                <small className="skyjo-choice-help">Replace any non-cleared card.</small>
              </button>
              <button
                aria-pressed={drawIntent === 'discard'}
                className={`skyjo-choice-button ${drawIntent === 'discard' ? 'skyjo-choice-button-active' : ''}`}
                disabled={Boolean(interactionDisabledReason) || !hasHiddenCard}
                onClick={() => onSetDrawIntent('discard')}
                title={
                  interactionDisabledReason ||
                  (hasHiddenCard ? 'Discard the drawn card and reveal a hidden card.' : 'No hidden cards remain to reveal.')
                }
                type="button"
              >
                <span>Discard + reveal</span>
                <small className="skyjo-choice-help">{hasHiddenCard ? 'Reveal one hidden card.' : 'No hidden cards remain.'}</small>
              </button>
            </div>
            <p className="skyjo-action-hint mt-3">
              {drawIntent === 'discard'
                ? 'Discard mode: select a highlighted hidden card.'
                : 'Place mode: select a highlighted card.'}
            </p>
          </div>
        ) : (
          <div className="skyjo-table-guidance" aria-live="polite">
            <div className="skyjo-kicker">Action guide</div>
            <p className="mt-2 text-sm font-bold leading-6 text-[#f5e6c8]/72">{status.description}</p>
            {!selectedDiscard && commonDisabledReason ? (
              <p className="skyjo-disabled-note mt-3"><span>Action unavailable:</span> {commonDisabledReason}</p>
            ) : !selectedDiscard && discardDisabledReason && !deckDisabledReason ? (
              <p className="skyjo-disabled-note mt-3"><span>Discard unavailable:</span> {discardDisabledReason}</p>
            ) : null}
          </div>
        )}
      </div>

      {selectedDiscard ? (
        <p className="sr-only" aria-live="polite">
          Discard selected. Tap discard again to put it back, or select a highlighted card.
        </p>
      ) : null}
    </section>
  );
}

export function GameTableLayout({
  state,
  localPlayerId,
  localTurn,
  drawIntent,
  interactionDisabledReason,
  onCardClick,
  onChooseDiscard,
  onCancelDiscard,
  onDraw,
  onSetDrawIntent
}: GameTableLayoutProps) {
  const playerCount = state.players.length;
  const opponentCount = state.players.filter((player) => player.id !== localPlayerId).length;

  return (
    <section
      aria-label="Game table"
      className={`skyjo-game-table-layout skyjo-table-roster-${playerCount}`}
      data-opponent-count={opponentCount}
      data-player-count={playerCount}
      data-testid="shared-game-table"
    >
      <PlayerBoardGrid
        drawIntent={drawIntent}
        interactionDisabledReason={interactionDisabledReason}
        localPlayerId={localPlayerId}
        onCardClick={onCardClick}
        state={state}
        variant="opponents"
      />
      <div className="skyjo-table-center-band" data-testid="table-center-band">
        <TableControls
          drawIntent={drawIntent}
          interactionDisabledReason={interactionDisabledReason}
          localPlayerId={localPlayerId}
          localTurn={localTurn}
          onCancelDiscard={onCancelDiscard}
          onChooseDiscard={onChooseDiscard}
          onDraw={onDraw}
          onSetDrawIntent={onSetDrawIntent}
          state={state}
        />
      </div>
      <PlayerBoardGrid
        drawIntent={drawIntent}
        interactionDisabledReason={interactionDisabledReason}
        localPlayerId={localPlayerId}
        onCardClick={onCardClick}
        state={state}
        variant="local"
      />
    </section>
  );
}
