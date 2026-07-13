import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { usePhoneLayout, usePrefersReducedMotion } from './accessibility';
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

function visibleCardState(card: Card): string {
  if (card.removed) return 'cleared';
  if (!card.faceUp) return 'SKYJO face-down';
  return `face-up ${card.value < 0 ? `minus ${Math.abs(card.value)}` : card.value}`;
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
  column,
  isCurrent,
  isLocal,
  player,
  row,
  selectable,
  state
}: {
  card: Card;
  canSelectOpening: boolean;
  canSelectReplacement: boolean;
  drawIntent: DrawIntent;
  column: number;
  isCurrent: boolean;
  isLocal: boolean;
  player: Player;
  row: number;
  selectable: boolean;
  state: GameState;
}) {
  const position = `${player.name}, row ${row + 1}, column ${column + 1}, ${visibleCardState(card)}.`;
  if (selectable && canSelectOpening) return `${position} Reveal this opening card.`;
  if (selectable && state.selectedSource === 'discard') return `${position} Replace with the discard card.`;
  if (selectable && drawIntent === 'discard') return `${position} Reveal after discarding the drawn card.`;
  if (selectable) return `${position} Replace with the drawn card.`;
  if (!isLocal) return position;
  if (!isCurrent) return `${position} Waiting for your turn.`;
  if (canSelectOpening && card.faceUp) return `${position} Already revealed.`;
  if (canSelectReplacement && drawIntent === 'discard' && card.faceUp) return `${position} A face-down card is required.`;
  if (state.phase === 'choose-source') return `${position} Choose the deck or discard pile first.`;
  return `${position} Not currently actionable.`;
}

function cardIndexInDirection(index: number, key: string, actionableIndices: number[]): number | null {
  if (key === 'Home') return actionableIndices[0] ?? null;
  if (key === 'End') return actionableIndices[actionableIndices.length - 1] ?? null;
  const step = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : key === 'ArrowUp' ? -4 : key === 'ArrowDown' ? 4 : 0;
  if (!step) return null;

  const row = Math.floor(index / 4);
  for (let candidate = index + step; candidate >= 0 && candidate < 12; candidate += step) {
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && Math.floor(candidate / 4) !== row) break;
    if (actionableIndices.includes(candidate)) return candidate;
  }
  return null;
}

interface PlayerGridProps {
  player: Player;
  isCurrent: boolean;
  isLocal: boolean;
  state: GameState;
  drawIntent?: DrawIntent;
  interactionDisabledReason?: string;
  onCardClick?: (index: number) => void;
  focusFallbackRef?: RefObject<HTMLElement>;
}

function PlayerGrid({
  player,
  isCurrent,
  isLocal,
  state,
  drawIntent = 'place',
  interactionDisabledReason,
  onCardClick,
  focusFallbackRef
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
  const cardsRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const revealAfterDiscard = state.selectedSource === 'draw' && state.drawnCard && drawIntent === 'discard';
  const actionableIndices = useMemo(
    () =>
      player.grid.flatMap((card, index) => {
        const selectable = Boolean(
          !interactionDisabledReason &&
            !card.removed &&
            ((canSelectOpening && !card.faceUp) || (canSelectReplacement && (!revealAfterDiscard || !card.faceUp)))
        );
        return selectable ? [index] : [];
      }),
    [canSelectOpening, canSelectReplacement, interactionDisabledReason, player.grid, revealAfterDiscard]
  );
  const actionableKey = actionableIndices.join(',');
  const [rovingIndex, setRovingIndex] = useState(actionableIndices[0] ?? -1);
  const activeRovingIndex = actionableIndices.includes(rovingIndex) ? rovingIndex : actionableIndices[0] ?? -1;

  useEffect(() => {
    if (rovingIndex !== activeRovingIndex) setRovingIndex(activeRovingIndex);
  }, [activeRovingIndex, rovingIndex]);

  useEffect(() => {
    const previousIndex = pendingFocusIndexRef.current;
    if (previousIndex === null) return undefined;
    pendingFocusIndexRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      const nextIndex = actionableIndices.find((index) => index > previousIndex) ?? actionableIndices[0];
      if (typeof nextIndex === 'number') {
        setRovingIndex(nextIndex);
        cardsRef.current?.querySelector<HTMLElement>(`[data-card-index="${nextIndex}"]`)?.focus({ preventScroll: true });
      } else {
        focusFallbackRef?.current?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [actionableIndices, actionableKey, focusFallbackRef]);

  function handleCardKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const targetIndex = cardIndexInDirection(index, event.key, actionableIndices);
    if (targetIndex === null || targetIndex === index) return;
    event.preventDefault();
    setRovingIndex(targetIndex);
    cardsRef.current?.querySelector<HTMLElement>(`[data-card-index="${targetIndex}"]`)?.focus({ preventScroll: true });
  }

  function handleCardClick(index: number) {
    pendingFocusIndexRef.current = index;
    onCardClick?.(index);
  }

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
      <div
        aria-colcount={4}
        aria-label={`${isLocal ? 'Your' : `${player.name}'s`} card grid`}
        aria-rowcount={3}
        className="skyjo-player-card-rows grid"
        ref={cardsRef}
        role="grid"
      >
        {rows.map((row) => (
          <div aria-rowindex={row + 1} className="skyjo-player-card-row grid" key={row} role="row">
            {columns.map((column) => {
              const index = row * 4 + column;
              const card = player.grid[index];
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
                column,
                drawIntent,
                isCurrent,
                isLocal,
                player,
                row,
                selectable,
                state
              });
              return (
                <div
                  aria-colindex={column + 1}
                  aria-label={selectable ? undefined : affordanceLabel}
                  className="skyjo-player-card-cell"
                  key={card.id}
                  role="gridcell"
                >
                  {selectable ? (
                    <button
                      aria-label={affordanceLabel}
                      className={`${cardClass(card, true)} skyjo-card-eligible`}
                      data-card-index={index}
                      onClick={() => handleCardClick(index)}
                      onKeyDown={(event) => handleCardKeyDown(event, index)}
                      tabIndex={index === activeRovingIndex ? 0 : -1}
                      title={affordanceLabel}
                      type="button"
                    >
                      {cardLabel(card)}
                    </button>
                  ) : (
                    <div
                      aria-hidden="true"
                      className={`${cardClass(card, false)} ${dimDuringSelection ? 'skyjo-card-ineligible' : ''}`}
                      title={interactionDisabledReason || affordanceLabel}
                    >
                      {cardLabel(card)}
                    </div>
                  )}
                </div>
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
  focusFallbackRef?: RefObject<HTMLElement>;
}

export function PlayerBoardGrid({
  variant,
  state,
  localPlayerId,
  drawIntent,
  interactionDisabledReason,
  onCardClick,
  focusFallbackRef
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
  const reducedMotion = usePrefersReducedMotion();

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
      element.scrollTo({ left, behavior: reducedMotion ? 'auto' : 'smooth' });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [currentOpponentId, isOpponents, reducedMotion, state.log.length, state.phase]);

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
            focusFallbackRef={focusFallbackRef}
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
    <section aria-label="Final lap status" className="skyjo-final-turn-callout">
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
  guidanceRef: RefObject<HTMLDivElement>;
  showSideGuidance: boolean;
}

function ActionGuidance({
  status,
  disabledReason,
  className = '',
  headingLevel = 3
}: {
  status: TurnStatus;
  disabledReason?: string;
  className?: string;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className={`skyjo-table-guidance skyjo-action-guidance skyjo-action-guidance-${status.tone} ${className}`}>
      <div className="skyjo-kicker">{status.eyebrow}</div>
      <Heading className="skyjo-serif skyjo-action-guidance-title mt-1 font-bold leading-tight text-[#f5e6c8]">{status.title}</Heading>
      <p className="skyjo-action-guidance-instruction mt-2 text-sm font-bold leading-6 text-[#f5e6c8]/72">
        {status.description}
      </p>
      {disabledReason ? (
        <p className="skyjo-disabled-note mt-3">
          <span>Action unavailable:</span> {disabledReason}
        </p>
      ) : null}
    </div>
  );
}

function actionGuidanceDisabledReason(
  state: GameState,
  localTurn: boolean,
  interactionDisabledReason?: string
): string {
  const deckDisabledReason = interactionDisabledReason || sourceDisabledReason(state, localTurn, 'deck');
  const discardDisabledReason = interactionDisabledReason || sourceDisabledReason(state, localTurn, 'discard');
  const selectedDiscard = localTurn && state.phase === 'choose-replacement' && state.selectedSource === 'discard';
  const commonDisabledReason =
    deckDisabledReason && discardDisabledReason && deckDisabledReason === discardDisabledReason ? deckDisabledReason : '';
  return selectedDiscard
    ? ''
    : commonDisabledReason || (!deckDisabledReason && discardDisabledReason ? discardDisabledReason : '');
}

function turnAnnouncement(
  state: GameState,
  localTurn: boolean,
  drawIntent: DrawIntent,
  interactionDisabledReason: string | undefined,
  status: TurnStatus
): { key: string; message: string } {
  if (interactionDisabledReason) {
    return {
      key: `disabled:${interactionDisabledReason}`,
      message: `Game controls paused. ${interactionDisabledReason}`
    };
  }
  if (!localTurn && state.phase !== 'round-over' && state.phase !== 'game-over') {
    return { key: 'waiting', message: 'Waiting for other players.' };
  }
  if (state.phase === 'opening-reveal') {
    const activePlayer = state.players[state.currentPlayerIndex];
    const remaining = Math.max(0, 2 - openingRevealCount(state, activePlayer));
    return {
      key: `opening:${remaining}`,
      message: remaining === 1 ? 'Choose one more face-down opening card.' : 'Choose two face-down opening cards.'
    };
  }
  if (state.phase === 'choose-source') {
    return { key: 'choose-source', message: 'Your turn. Choose the discard pile or draw blind from the deck.' };
  }
  if (state.phase === 'choose-replacement' && state.selectedSource === 'discard') {
    return { key: 'selected-discard', message: 'Discard selected. Choose a highlighted board card, or put the discard back.' };
  }
  if (state.phase === 'choose-replacement' && state.selectedSource === 'draw' && state.drawnCard) {
    return drawIntent === 'discard'
      ? { key: 'drawn:discard', message: 'Discard mode selected. Choose a highlighted face-down card to reveal.' }
      : { key: 'drawn:place', message: 'Place mode selected. Choose a highlighted board card to replace.' };
  }
  return { key: `${state.phase}:${status.title}`, message: `${status.title}. ${status.description}` };
}

function TurnAnnouncer({
  state,
  localTurn,
  drawIntent,
  interactionDisabledReason,
  status
}: {
  state: GameState;
  localTurn: boolean;
  drawIntent: DrawIntent;
  interactionDisabledReason?: string;
  status: TurnStatus;
}) {
  const next = turnAnnouncement(state, localTurn, drawIntent, interactionDisabledReason, status);
  const lastKeyRef = useRef('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (lastKeyRef.current === next.key) return undefined;
    lastKeyRef.current = next.key;
    setMessage('');
    const timer = window.setTimeout(() => setMessage(next.message), 0);
    return () => window.clearTimeout(timer);
  }, [next.key, next.message]);

  return (
    <p aria-atomic="true" aria-live="polite" className="sr-only" data-testid="turn-announcer" role="status">
      {message}
    </p>
  );
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
  onSetDrawIntent,
  guidanceRef,
  showSideGuidance
}: TableControlsProps) {
  const topDiscard = state.discardPile[0];
  const activePlayer = state.players[state.currentPlayerIndex];
  const hasHiddenCard = hiddenCardCount(activePlayer) > 0;
  const status = getTurnStatus(state, localTurn);
  const deckDisabledReason = interactionDisabledReason || sourceDisabledReason(state, localTurn, 'deck');
  const discardDisabledReason = interactionDisabledReason || sourceDisabledReason(state, localTurn, 'discard');
  const selectedDiscard = localTurn && state.phase === 'choose-replacement' && state.selectedSource === 'discard';
  const hasLocalDrawnDecision = Boolean(state.drawnCard && localTurn);
  const discardButtonDisabled = Boolean(interactionDisabledReason || (discardDisabledReason && !selectedDiscard));
  const discardButtonTitle = selectedDiscard
    ? 'Put the discard card back.'
    : discardDisabledReason || 'Take the top discard card.';
  const guidanceDisabledReason = actionGuidanceDisabledReason(state, localTurn, interactionDisabledReason);

  return (
    <section className="skyjo-panel skyjo-table-controls skyjo-table-glow" data-testid="table-center">
      <div
        aria-label="Opening and final-turn progress"
        className="skyjo-table-band-side skyjo-table-band-side-start"
        role="region"
        tabIndex={0}
      >
        <FinalTurnCallout localPlayerId={localPlayerId} state={state} />
        <div className="skyjo-table-header flex items-center justify-between gap-3">
          <h2 className="skyjo-serif text-xl font-semibold">Table</h2>
          <span className="skyjo-kicker text-right">Round {state.round}</span>
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

      <div className="skyjo-table-piles grid grid-cols-2" data-testid="table-piles">
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
        aria-label={showSideGuidance ? 'Action guidance' : hasLocalDrawnDecision ? 'Drawn card decision' : undefined}
        className="skyjo-table-band-side skyjo-table-band-side-end"
        ref={guidanceRef}
        role={showSideGuidance || hasLocalDrawnDecision ? 'region' : undefined}
        tabIndex={showSideGuidance || hasLocalDrawnDecision ? 0 : undefined}
      >
        {showSideGuidance ? (
          <ActionGuidance className="skyjo-side-action-guidance" disabledReason={guidanceDisabledReason} status={status} />
        ) : null}
        {hasLocalDrawnDecision && state.drawnCard ? (
          <div className="skyjo-drawn-decision">
            <div className="flex justify-end">
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
        ) : null}
      </div>
      <TurnAnnouncer
        drawIntent={drawIntent}
        interactionDisabledReason={interactionDisabledReason}
        localTurn={localTurn}
        state={state}
        status={status}
      />
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
  const phoneLayout = usePhoneLayout();
  const sideGuidanceRef = useRef<HTMLDivElement | null>(null);
  const phoneGuidanceRef = useRef<HTMLDivElement | null>(null);
  const focusFallbackRef = phoneLayout ? phoneGuidanceRef : sideGuidanceRef;
  const status = getTurnStatus(state, localTurn);
  const guidanceDisabledReason = actionGuidanceDisabledReason(state, localTurn, interactionDisabledReason);

  return (
    <section aria-label="Game table" className="skyjo-game-table-shell">
      {phoneLayout ? (
        <div
          aria-label="Action guidance"
          className="skyjo-phone-action-guidance"
          ref={phoneGuidanceRef}
          role="region"
          tabIndex={0}
        >
          <ActionGuidance disabledReason={guidanceDisabledReason} headingLevel={2} status={status} />
        </div>
      ) : null}
      <div
        className={`skyjo-game-table-layout skyjo-table-roster-${playerCount}`}
        data-opponent-count={opponentCount}
        data-phase={state.phase}
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
            guidanceRef={sideGuidanceRef}
            interactionDisabledReason={interactionDisabledReason}
            localPlayerId={localPlayerId}
            localTurn={localTurn}
            onCancelDiscard={onCancelDiscard}
            onChooseDiscard={onChooseDiscard}
            onDraw={onDraw}
            onSetDrawIntent={onSetDrawIntent}
            showSideGuidance={!phoneLayout}
            state={state}
          />
        </div>
        <PlayerBoardGrid
          drawIntent={drawIntent}
          focusFallbackRef={focusFallbackRef}
          interactionDisabledReason={interactionDisabledReason}
          localPlayerId={localPlayerId}
          onCardClick={onCardClick}
          state={state}
          variant="local"
        />
      </div>
    </section>
  );
}
