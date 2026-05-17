import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import {
  chooseDiscard,
  discardDrawnAndReveal,
  drawBlind,
  getBestAiMove,
  replaceCard,
  revealOpeningCard,
  singlePlayerAiOpponentRange,
  startFreshGame,
  startNextRound
} from './game';
import type { Card, GameState, MultiplayerRoom, Player, RoomChatMessage } from './types';

const rows = [0, 1, 2];
const columns = [0, 1, 2, 3];
const singlePlayerAiCounts = Array.from(
  { length: singlePlayerAiOpponentRange.max - singlePlayerAiOpponentRange.min + 1 },
  (_, index) => singlePlayerAiOpponentRange.min + index
);
type DrawIntent = 'place' | 'discard';
type TurnStatusTone = 'local' | 'waiting' | 'neutral';
type BoardGridEntry = {
  player: Player;
  isLocal: boolean;
};
type RulesHelpSection = {
  title: string;
  items: string[];
};
type TurnStatus = {
  eyebrow: string;
  title: string;
  description: string;
  tone: TurnStatusTone;
};

const responsiveBoardGridClass = 'grid gap-4 xl:grid-cols-2';
const opponentBoardGridClass = 'skyjo-opponent-strip grid gap-4 xl:grid-cols-2';
const fourPlayerDesktopBoardGridClass = 'hidden gap-4 md:grid md:grid-cols-2';
const fourPlayerMobileOpponentGridClass = 'skyjo-opponent-strip grid gap-3 md:hidden';
const fourPlayerMobileLocalGridClass = 'grid gap-4 md:hidden';
const rulesHelpSections: RulesHelpSection[] = [
  {
    title: 'Starting a round',
    items: [
      'Everyone gets 12 face-down cards and chooses two opening cards to reveal.',
      'For the first round, the highest shown opening-card sum starts.',
      'After later rounds, the player who ended the previous round starts once opening cards are revealed.'
    ]
  },
  {
    title: 'Taking a turn',
    items: [
      'Take the top discard if you want that card, or draw blind from the deck.',
      'If you draw blind, either place it on your board or discard it and reveal one hidden card.'
    ]
  },
  {
    title: 'Clearing columns',
    items: ['Three matching values in one column clear that column. Cleared cards stop counting against you.']
  },
  {
    title: 'Ending and scoring',
    items: [
      'When someone reveals their last card, everyone else gets one final turn.',
      "If the closer's positive round score is not strictly lowest, that score doubles.",
      'The game ends when someone reaches 100 or more total points. Lowest total wins.'
    ]
  }
];

function Home() {
  return (
    <main className="skyjo-surface">
      <section className="skyjo-shell flex min-h-screen flex-col justify-center px-5 py-10">
        <div className="max-w-2xl">
          <p className="skyjo-kicker mb-3">Private game table</p>
          <h1 className="skyjo-title text-7xl sm:text-9xl">Skyjo</h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-[#f5e6c8]/70">
            Play solo against the house AI or create a private room for friends at the multiplayer table.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link className="skyjo-button skyjo-button-primary px-5 py-3" to="/single-player">
              Single Player
            </Link>
            <Link className="skyjo-button px-5 py-3" to="/lobby">
              Multiplayer Lobby
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}

function RulesHelpButton({ className = '' }: { className?: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsOpen(false);
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <>
      <button
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className={`skyjo-button px-4 py-2 text-sm ${className}`}
        onClick={() => setIsOpen(true)}
        type="button"
      >
        Rules
      </button>

      {isOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 px-3 py-4 backdrop-blur-sm sm:items-center sm:px-5"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsOpen(false);
          }}
        >
          <section
            aria-describedby="skyjo-rules-help-intro"
            aria-labelledby="skyjo-rules-help-title"
            aria-modal="true"
            className="skyjo-panel w-full max-w-2xl overflow-hidden rounded-2xl bg-[#09110e]/95 shadow-2xl"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#f5e6c8]/10 p-4 sm:p-5">
              <div className="min-w-0">
                <p className="skyjo-kicker">Help</p>
                <h2 className="skyjo-serif mt-1 text-2xl font-black leading-tight text-[#f5e6c8] sm:text-3xl" id="skyjo-rules-help-title">
                  Skyjo Rules
                </h2>
                <p className="mt-2 text-sm leading-6 text-[#f5e6c8]/68" id="skyjo-rules-help-intro">
                  Quick reminders for playing at this table.
                </p>
              </div>
              <button
                aria-label="Close rules and help"
                className="skyjo-button shrink-0 px-3 py-2 text-sm"
                onClick={() => setIsOpen(false)}
                ref={closeButtonRef}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="max-h-[min(74vh,720px)] overflow-y-auto p-4 sm:p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                {rulesHelpSections.map((section) => (
                  <section className="rounded-xl border border-[#f5e6c8]/12 bg-white/[0.025] p-3 sm:p-4" key={section.title}>
                    <h3 className="skyjo-serif text-lg font-bold leading-tight text-[#f5e6c8]">{section.title}</h3>
                    <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-6 text-[#f5e6c8]/76">
                      {section.items.map((item) => (
                        <li className="break-words" key={item}>
                          {item}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
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
        description: 'Select any highlighted card on your board to replace.',
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

interface GridProps {
  player: Player;
  isCurrent: boolean;
  isLocal: boolean;
  state: GameState;
  drawIntent?: DrawIntent;
  onCardClick?: (index: number) => void;
}

function PlayerGrid({ player, isCurrent, isLocal, state, drawIntent = 'place', onCardClick }: GridProps) {
  const canSelectOpening =
    isLocal && isCurrent && state.phase === 'opening-reveal' && (state.openingRevealCounts[player.id] ?? 0) < 2;
  const canSelectReplacement =
    isLocal &&
    isCurrent &&
    state.phase === 'choose-replacement' &&
    (state.selectedSource === 'discard' || state.selectedSource === 'draw');
  const selectionMode = canSelectOpening || canSelectReplacement;
  const playerRole = player.kind === 'ai' ? 'AI opponent' : isLocal ? 'You' : 'Player';
  const playerStatus = isCurrent ? (isLocal ? 'Your move now' : 'Current turn') : isLocal ? 'Waiting for your turn' : 'Waiting';
  const openingRemaining = Math.max(0, 2 - openingRevealCount(state, player));

  return (
    <section
      className={`skyjo-panel skyjo-player-grid ${
        isLocal ? 'skyjo-player-grid-local' : 'skyjo-player-grid-opponent'
      } ${isCurrent ? 'skyjo-panel-current' : ''}`}
    >
      <div className="skyjo-player-grid-header mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="skyjo-serif text-xl font-semibold text-[#f5e6c8]">{player.name}</h2>
            {isCurrent ? (
              <span className={`skyjo-turn-pill ${isLocal ? 'skyjo-turn-pill-local' : ''}`}>
                {isLocal ? 'Your turn' : 'Current turn'}
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
              const selectable = Boolean(
                !card.removed &&
                  ((canSelectOpening && !card.faceUp) || (canSelectReplacement && (!revealAfterDiscard || !card.faceUp)))
              );
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
                selectable,
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
                  title={affordanceLabel}
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
  entries: BoardGridEntry[];
  state: GameState;
  drawIntent: DrawIntent;
  className?: string;
  onCardClick: (index: number) => void;
}

function PlayerBoardGrid({ entries, state, drawIntent, className = responsiveBoardGridClass, onCardClick }: PlayerBoardGridProps) {
  return (
    <div className={className}>
      {entries.map(({ player, isLocal }) => {
        const index = state.players.findIndex((item) => item.id === player.id);
        return (
          <PlayerGrid
            drawIntent={drawIntent}
            isCurrent={index === state.currentPlayerIndex}
            isLocal={isLocal}
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

interface TableControlsProps {
  state: GameState;
  localTurn: boolean;
  drawIntent: DrawIntent;
  localPlayerId?: string;
  onChooseDiscard: () => void;
  onDraw: () => void;
  onSetDrawIntent: (intent: DrawIntent) => void;
}

function TableControls({ state, localTurn, drawIntent, localPlayerId, onChooseDiscard, onDraw, onSetDrawIntent }: TableControlsProps) {
  const topDiscard = state.discardPile[0];
  const activePlayer = state.players[state.currentPlayerIndex];
  const hasHiddenCard = hiddenCardCount(activePlayer) > 0;
  const status = getTurnStatus(state, localTurn);
  const deckDisabledReason = sourceDisabledReason(state, localTurn, 'deck');
  const discardDisabledReason = sourceDisabledReason(state, localTurn, 'discard');
  const commonDisabledReason =
    deckDisabledReason && discardDisabledReason && deckDisabledReason === discardDisabledReason ? deckDisabledReason : '';
  const selectedDiscard = localTurn && state.phase === 'choose-replacement' && state.selectedSource === 'discard';

  return (
    <section className="skyjo-panel skyjo-table-controls skyjo-table-glow">
      <div className="skyjo-table-header mb-4 flex items-center justify-between gap-3">
        <h2 className="skyjo-serif text-xl font-semibold">Table</h2>
        <span className="skyjo-kicker text-right">Round {state.round}</span>
      </div>

      <div className={`skyjo-turn-status skyjo-turn-status-${status.tone}`} aria-live="polite">
        <div className="skyjo-kicker">{status.eyebrow}</div>
        <h3 className="skyjo-serif mt-1 text-2xl font-bold leading-tight text-[#f5e6c8]">{status.title}</h3>
        <p className="mt-2 text-sm leading-6 text-[#f5e6c8]/72">{status.description}</p>
      </div>

      {state.phase === 'opening-reveal' ? (
        <div className="skyjo-opening-tracker mt-3" aria-label="Opening reveal progress">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="skyjo-kicker">Opening reveal</div>
              <p className="mt-1 text-sm font-bold text-[#f5e6c8]">Each player chooses two face-down cards.</p>
            </div>
            <span className="rounded-full border border-[#f5e6c8]/18 px-3 py-1 text-xs font-extrabold text-[#f5e6c8]/70">
              {activePlayer.name}'s pick
            </span>
          </div>
          <div className="mt-3 grid gap-2">
            {state.players.map((player) => {
              const count = openingRevealCount(state, player);
              const active = player.id === activePlayer.id;
              const local = player.id === localPlayerId;
              return (
                <div className={`skyjo-opening-row ${active ? 'skyjo-opening-row-active' : ''}`} key={player.id}>
                  <span className="min-w-0 truncate">
                    {player.name}
                    {local ? ' (you)' : ''}
                  </span>
                  <span className="tabular-nums">{count}/2</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="skyjo-table-piles mt-4 grid grid-cols-2 gap-4">
        <button
          className="skyjo-button skyjo-pile-button text-center"
          disabled={Boolean(deckDisabledReason)}
          onClick={onDraw}
          title={deckDisabledReason || 'Draw blind from the deck.'}
          type="button"
        >
          <div className="skyjo-kicker">Deck</div>
          <div className="skyjo-card skyjo-card-hidden skyjo-table-card mx-auto mt-2">SKYJO</div>
          <div className="skyjo-table-count mt-2 text-sm font-bold tabular-nums text-[#f5e6c8]/65">{state.drawPile.length} cards</div>
        </button>
        <button
          className="skyjo-button skyjo-pile-button text-center"
          disabled={Boolean(discardDisabledReason)}
          onClick={onChooseDiscard}
          title={discardDisabledReason || 'Take the top discard card.'}
          type="button"
        >
          <div className="skyjo-kicker">Discard</div>
          {topDiscard ? (
            <div className={`${cardClass(topDiscard, false)} skyjo-table-card mx-auto mt-2`}>{cardLabel(topDiscard)}</div>
          ) : (
            <div className="skyjo-card skyjo-card-removed skyjo-table-card mx-auto mt-2" />
          )}
          <div className="skyjo-table-count mt-2 text-sm font-bold tabular-nums text-[#f5e6c8]/65">{state.discardPile.length} cards</div>
        </button>
      </div>
      {commonDisabledReason ? (
        <p className="skyjo-disabled-note mt-3">
          <span>Action unavailable:</span> {commonDisabledReason}
        </p>
      ) : !commonDisabledReason && discardDisabledReason && !deckDisabledReason ? (
        <p className="skyjo-disabled-note mt-3">
          <span>Discard unavailable:</span> {discardDisabledReason}
        </p>
      ) : null}

      {state.drawnCard && localTurn ? (
        <div className="skyjo-drawn-decision mt-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="skyjo-kicker">Drawn card waiting</div>
              <h3 className="skyjo-serif mt-1 text-xl font-bold text-[#f5e6c8]">Place it or discard it</h3>
              <p className="mt-2 text-sm leading-6 text-[#f5e6c8]/72">Choose a mode, then select a highlighted card on your board.</p>
            </div>
            <div className={`${cardClass(state.drawnCard, false)} skyjo-drawn-card shrink-0`}>{cardLabel(state.drawnCard)}</div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <button
              aria-pressed={drawIntent === 'place'}
              className={`skyjo-choice-button ${drawIntent === 'place' ? 'skyjo-choice-button-active' : ''}`}
              onClick={() => onSetDrawIntent('place')}
              type="button"
            >
              <span>Place drawn card</span>
              <small>Replace any non-cleared card.</small>
            </button>
            <button
              aria-pressed={drawIntent === 'discard'}
              className={`skyjo-choice-button ${drawIntent === 'discard' ? 'skyjo-choice-button-active' : ''}`}
              disabled={!hasHiddenCard}
              onClick={() => onSetDrawIntent('discard')}
              title={hasHiddenCard ? 'Discard the drawn card and reveal a hidden card.' : 'No hidden cards remain to reveal.'}
              type="button"
            >
              <span>Discard + reveal</span>
              <small>{hasHiddenCard ? 'Reveal one hidden card.' : 'No hidden cards remain.'}</small>
            </button>
          </div>
          <p className="skyjo-action-hint mt-3">
            {drawIntent === 'discard'
              ? 'Discard mode active: select a highlighted hidden card to reveal.'
              : 'Place mode active: select a highlighted card to replace with the drawn card.'}
          </p>
        </div>
      ) : null}

      {selectedDiscard ? (
        <p className="skyjo-action-hint mt-4">Discard card selected: choose any highlighted card on your board to replace.</p>
      ) : null}
    </section>
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
    <section aria-live="polite" className="skyjo-panel skyjo-final-turn-callout" role="status">
      <div className="flex items-start gap-3">
        <div className="skyjo-final-turn-mark" aria-hidden="true">
          !
        </div>
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

function MoveLog({ state }: { state: GameState }) {
  return (
    <section className="skyjo-panel p-4">
      <details>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
          <span className="skyjo-serif text-xl font-semibold">Move Log</span>
          <span className="skyjo-kicker">{state.log.length} moves</span>
        </summary>
        <div className="mt-3 space-y-2 text-sm text-[#f5e6c8]/72">
          {state.log.map((entry) => (
            <div className="rounded-lg border border-white/[0.04] bg-white/[0.025] px-3 py-2" key={entry}>
              {entry}
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

function formatChatTime(createdAt: number) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(createdAt));
}

interface RoomChatProps {
  messages: RoomChatMessage[];
  playerId: string;
  isOpen: boolean;
  unreadCount: number;
  onToggle: () => void;
  onSend: (text: string) => void;
}

function RoomChat({ messages, playerId, isOpen, unreadCount, onToggle, onSend }: RoomChatProps) {
  const [draft, setDraft] = useState('');
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const latestMessage = messages[messages.length - 1];

  useEffect(() => {
    if (!isOpen) return;
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [isOpen, messages.length]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  }

  return (
    <section className="skyjo-panel p-4">
      <button
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={onToggle}
        type="button"
      >
        <span className="min-w-0">
          <span className="skyjo-serif block text-xl font-semibold text-[#f5e6c8]">Table Chat</span>
          <span className="mt-1 block truncate text-sm text-[#f5e6c8]/55">
            {latestMessage ? `${latestMessage.playerName}: ${latestMessage.text}` : 'No messages yet'}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {unreadCount > 0 ? (
            <span className="rounded-full border border-amber-200/35 bg-amber-400/18 px-2 py-1 text-xs font-black text-amber-100">
              {unreadCount}
            </span>
          ) : null}
          <span className="skyjo-kicker">{isOpen ? 'Hide' : 'Open'}</span>
        </span>
      </button>

      {isOpen ? (
        <div className="mt-3 grid gap-3">
          <div
            aria-live="polite"
            className="max-h-64 space-y-2 overflow-y-auto rounded-xl border border-[#f5e6c8]/10 bg-black/10 p-2"
            ref={messagesRef}
          >
            {messages.length > 0 ? (
              messages.map((message) => {
                const mine = message.playerId === playerId;
                return (
                  <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`} key={message.id}>
                    <div
                      className={`max-w-[88%] rounded-xl border px-3 py-2 text-sm ${
                        mine
                          ? 'border-amber-200/24 bg-amber-300/12 text-amber-50'
                          : 'border-[#f5e6c8]/10 bg-white/[0.035] text-[#f5e6c8]/82'
                      }`}
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="font-black text-[#f5e6c8]">{mine ? 'You' : message.playerName}</span>
                        <time className="text-xs font-bold text-[#f5e6c8]/42" dateTime={new Date(message.createdAt).toISOString()}>
                          {formatChatTime(message.createdAt)}
                        </time>
                      </div>
                      <p className="mt-1 break-words leading-5">{message.text}</p>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="rounded-lg border border-dashed border-[#f5e6c8]/14 px-3 py-5 text-center text-sm font-bold text-[#f5e6c8]/45">
                Say hello when people join the table.
              </div>
            )}
          </div>

          <form className="flex gap-2" onSubmit={handleSubmit}>
            <input
              aria-label="Message"
              className="skyjo-input min-w-0 flex-1 px-3 py-2 text-sm"
              maxLength={280}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Message players"
              value={draft}
            />
            <button className="skyjo-button skyjo-button-primary px-4 py-2 text-sm" disabled={!draft.trim()} type="submit">
              Send
            </button>
          </form>
        </div>
      ) : null}
    </section>
  );
}

interface RoundSummaryProps {
  state: GameState;
  actionLabel?: string;
  actionDisabledReason?: string;
  onAction?: () => void;
}

function RoundSummary({ state, actionLabel, actionDisabledReason, onAction }: RoundSummaryProps) {
  const rankedPlayers = [...state.players].sort((a, b) => a.totalScore - b.totalScore || a.roundScore - b.roundScore);
  const leader = rankedPlayers[0];
  const winner = state.winnerId ? state.players.find((player) => player.id === state.winnerId) : null;
  const headline = state.phase === 'game-over' ? `${winner?.name || leader.name} wins the game.` : 'Round complete.';
  const outcome =
    state.phase === 'game-over'
      ? `${winner?.name || leader.name} finished lowest at ${(winner || leader).totalScore} total.`
      : `${leader.name} leads at ${leader.totalScore} total.`;
  const latestScoringNote = state.log[0];

  return (
    <section className="skyjo-panel skyjo-score-panel p-4">
      <div className="skyjo-kicker">{state.phase === 'game-over' ? 'Final totals' : 'Round scoring'}</div>
      <h2 className="skyjo-serif mt-1 text-2xl font-bold leading-tight text-[#f5e6c8]">{headline}</h2>
      <p className="mt-2 text-sm font-bold text-[#f5e6c8]/78">{outcome}</p>
      {latestScoringNote ? <p className="mt-1 text-xs leading-5 text-[#f5e6c8]/58">{latestScoringNote}</p> : null}

      <div className="skyjo-score-list mt-4" aria-label="Round score and total score">
        {rankedPlayers.map((player, index) => {
          const isWinner = winner ? player.id === winner.id : index === 0;
          return (
            <div className={`skyjo-score-row ${isWinner ? 'skyjo-score-row-leader' : ''}`} key={player.id}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="skyjo-score-rank">#{index + 1}</span>
                  <span className="truncate font-extrabold text-[#f5e6c8]">{player.name}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-right tabular-nums">
                <div>
                  <div className="skyjo-score-label">Round score</div>
                  <div className="font-black text-[#f5e6c8]">{player.roundScore}</div>
                </div>
                <div>
                  <div className="skyjo-score-label">Total score</div>
                  <div className="font-black text-[#f5e6c8]">{player.totalScore}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {onAction && actionLabel ? (
        <button className="skyjo-button skyjo-button-primary mt-4 w-full px-4 py-3" onClick={onAction} type="button">
          {actionLabel}
        </button>
      ) : actionDisabledReason ? (
        <p className="skyjo-disabled-note mt-4">
          <span>Action unavailable:</span> {actionDisabledReason}
        </p>
      ) : null}
    </section>
  );
}

function SinglePlayer() {
  const [aiOpponentCount, setAiOpponentCount] = useState<number>(singlePlayerAiOpponentRange.min);
  const [state, setState] = useState<GameState>(() => startFreshGame({ aiOpponentCount: singlePlayerAiOpponentRange.min }));
  const [drawIntent, setDrawIntent] = useState<DrawIntent>('place');
  const activePlayer = state.players[state.currentPlayerIndex];
  const humanTurn = activePlayer.kind === 'human';
  const localPlayers = state.players.filter((player) => player.kind === 'human');
  const opponentPlayers = state.players.filter((player) => player.kind !== 'human');
  const localBoardEntries = localPlayers.map((player) => ({ player, isLocal: true }));
  const opponentBoardEntries = opponentPlayers.map((player) => ({ player, isLocal: false }));
  const hasFourPlayerDesktopGrid = state.players.length === 4;
  const fourPlayerBoardEntries = [...opponentBoardEntries, ...localBoardEntries];
  const aiOpponentSummary = `${aiOpponentCount} AI opponent${aiOpponentCount === 1 ? '' : 's'}`;

  useEffect(() => {
    if (state.phase !== 'choose-replacement' || state.selectedSource !== 'draw' || !state.drawnCard) {
      setDrawIntent('place');
    }
  }, [state.drawnCard, state.phase, state.selectedSource]);

  useEffect(() => {
    if (activePlayer.kind !== 'ai' || state.phase === 'round-over' || state.phase === 'game-over') return;
    const timer = window.setTimeout(() => {
      setState((current) => {
        if (current.phase === 'opening-reveal') {
          const aiPlayer = current.players[current.currentPlayerIndex];
          const index = aiPlayer.grid.findIndex((card) => !card.faceUp && !card.removed);
          return revealOpeningCard(current, index);
        }
        const move = getBestAiMove(current);
        if (move.action === 'discard') return chooseDiscard(current);
        if (move.action === 'draw') return drawBlind(current);
        if (move.action === 'replace') return replaceCard(current, move.index || 0);
        return discardDrawnAndReveal(current, move.index || 0);
      });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [activePlayer.kind, state]);

  function handleCard(index: number) {
    if (!humanTurn || (state.phase !== 'opening-reveal' && state.phase !== 'choose-replacement')) return;
    if (state.phase === 'opening-reveal') {
      setState((current) => revealOpeningCard(current, index));
      return;
    }
    setState((current) =>
      drawIntent === 'discard' && current.selectedSource === 'draw' && current.drawnCard
        ? discardDrawnAndReveal(current, index)
        : replaceCard(current, index)
    );
  }

  function startSelectedGame() {
    setState(startFreshGame({ aiOpponentCount }));
  }

  return (
    <main className="skyjo-surface px-4 py-5">
      <div className="skyjo-shell grid gap-5 lg:grid-cols-[1fr_330px]">
        <section
          className={`space-y-4 ${
            hasFourPlayerDesktopGrid ? 'lg:col-span-2 lg:row-start-1' : 'lg:col-start-1 lg:row-start-1'
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <Link className="text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/">
                Back
              </Link>
              <h1 className="skyjo-title skyjo-game-title mt-2 text-5xl">Single Player</h1>
              <p className="skyjo-game-subtitle mt-1 text-[#f5e6c8]/55">Round {state.round}. Lowest score wins; first to 100 ends the game.</p>
            </div>
            <div className="flex w-full flex-col gap-3 sm:w-auto sm:items-end">
              <RulesHelpButton className="self-start sm:self-end" />
              <div className="skyjo-single-settings w-full rounded-2xl border border-[#f5e6c8]/15 bg-white/[0.025] sm:w-auto">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="skyjo-kicker">AI opponents</div>
                    <div className="text-sm font-bold text-[#f5e6c8]/75">{aiOpponentSummary}</div>
                  </div>
                  <button className="skyjo-button skyjo-new-game-button text-sm" onClick={startSelectedGame} type="button">
                    New Game
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-7 gap-1" role="group" aria-label="Choose AI opponent count">
                  {singlePlayerAiCounts.map((count) => (
                    <button
                      aria-pressed={count === aiOpponentCount}
                      className={`skyjo-button h-8 min-w-0 px-0 text-sm tabular-nums ${
                        count === aiOpponentCount ? 'skyjo-button-primary' : ''
                      }`}
                      key={count}
                      onClick={() => setAiOpponentCount(count)}
                      type="button"
                    >
                      {count}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {hasFourPlayerDesktopGrid ? (
            <PlayerBoardGrid
              className={fourPlayerDesktopBoardGridClass}
              drawIntent={drawIntent}
              entries={fourPlayerBoardEntries}
              onCardClick={handleCard}
              state={state}
            />
          ) : null}

          {opponentBoardEntries.length > 0 ? (
            <PlayerBoardGrid
              className={hasFourPlayerDesktopGrid ? fourPlayerMobileOpponentGridClass : opponentBoardGridClass}
              drawIntent={drawIntent}
              entries={opponentBoardEntries}
              onCardClick={handleCard}
              state={state}
            />
          ) : null}
        </section>

        <div className={`space-y-4 ${hasFourPlayerDesktopGrid ? 'lg:col-start-2 lg:row-start-2' : 'lg:col-start-2 lg:row-start-1'}`}>
          <FinalTurnCallout localPlayerId={localPlayers[0]?.id} state={state} />
          <TableControls
            drawIntent={drawIntent}
            localPlayerId={localPlayers[0]?.id}
            localTurn={humanTurn}
            onChooseDiscard={() => setState((current) => chooseDiscard(current))}
            onDraw={() => setState((current) => drawBlind(current))}
            onSetDrawIntent={setDrawIntent}
            state={state}
          />
        </div>

        <section className={hasFourPlayerDesktopGrid ? 'md:hidden lg:col-start-1 lg:row-start-2' : 'lg:col-start-1 lg:row-start-2'}>
          <PlayerBoardGrid
            className={hasFourPlayerDesktopGrid ? fourPlayerMobileLocalGridClass : responsiveBoardGridClass}
            drawIntent={drawIntent}
            entries={localBoardEntries}
            onCardClick={handleCard}
            state={state}
          />
        </section>

        <aside className={`space-y-4 ${hasFourPlayerDesktopGrid ? 'lg:col-start-1 lg:row-start-2' : 'lg:col-start-2 lg:row-start-2'}`}>
          {state.phase === 'round-over' || state.phase === 'game-over' ? (
            <RoundSummary
              actionLabel={state.phase === 'game-over' ? 'Start New Game' : 'Next Round'}
              onAction={() => setState(state.phase === 'game-over' ? startFreshGame({ aiOpponentCount }) : startNextRound(state))}
              state={state}
            />
          ) : null}

          <MoveLog state={state} />
        </aside>
      </div>
    </main>
  );
}

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

function roomSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/rooms`;
}

function Lobby() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const roomCodeRef = useRef(window.localStorage.getItem('skyjo-room-code') || '');
  const playerIdRef = useRef(window.localStorage.getItem('skyjo-player-id') || '');
  const [name, setName] = useState(() => window.localStorage.getItem('skyjo-player-name') || 'Player');
  const [joinCode, setJoinCode] = useState(() => window.localStorage.getItem('skyjo-room-code') || '');
  const [roomCode, setRoomCode] = useState(() => window.localStorage.getItem('skyjo-room-code') || '');
  const [playerId, setPlayerId] = useState(() => window.localStorage.getItem('skyjo-player-id') || '');
  const [room, setRoom] = useState<MultiplayerRoom | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [error, setError] = useState('');
  const [drawIntent, setDrawIntent] = useState<DrawIntent>('place');
  const [chatOpen, setChatOpen] = useState(false);
  const [lastSeenChatMessageId, setLastSeenChatMessageId] = useState('');
  const lastSeenChatRoomCodeRef = useRef('');
  const hasPendingDrawDecision = Boolean(
    room?.state && room.state.phase === 'choose-replacement' && room.state.selectedSource === 'draw' && room.state.drawnCard
  );
  const chatMessages = room?.chatMessages ?? [];
  const latestChatMessage = chatMessages[chatMessages.length - 1];
  const roomChatCode = room?.code || '';
  const lastSeenChatIndex = chatMessages.findIndex((message) => message.id === lastSeenChatMessageId);
  const unreadChatCount = chatMessages.reduce(
    (count, message, index) => (index > lastSeenChatIndex && message.playerId !== playerId ? count + 1 : count),
    0
  );

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
    },
    []
  );

  useEffect(() => {
    if (!hasPendingDrawDecision) {
      setDrawIntent('place');
    }
  }, [hasPendingDrawDecision]);

  useEffect(() => {
    roomCodeRef.current = roomCode;
  }, [roomCode]);

  useEffect(() => {
    playerIdRef.current = playerId;
  }, [playerId]);

  useEffect(() => {
    if (!roomChatCode) return;
    const latestId = latestChatMessage?.id || '';
    if (lastSeenChatRoomCodeRef.current !== roomChatCode) {
      lastSeenChatRoomCodeRef.current = roomChatCode;
      setLastSeenChatMessageId(latestId);
      return;
    }
    if (chatOpen || latestChatMessage?.playerId === playerId) {
      setLastSeenChatMessageId(latestId);
    }
  }, [chatOpen, latestChatMessage?.id, latestChatMessage?.playerId, playerId, roomChatCode]);

  function clearReconnectTimer() {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  function connect(action: 'create-room' | 'join-room', codeOverride?: string) {
    const cleanedName = name.trim() || 'Player';
    const cleanedCode = (codeOverride ?? joinCode).trim().toUpperCase();
    if (action === 'join-room' && !cleanedCode) {
      setError('Enter a room code.');
      return;
    }
    clearReconnectTimer();
    window.localStorage.setItem('skyjo-player-name', cleanedName);
    setConnection('connecting');
    setError('');
    wsRef.current?.close();
    const ws = new WebSocket(roomSocketUrl());
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify(
          action === 'create-room'
            ? { type: 'create-room', name: cleanedName }
            : { type: 'join-room', code: cleanedCode, name: cleanedName, playerId: playerId || undefined }
        )
      );
    });

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'joined') {
        setPlayerId(message.playerId);
        playerIdRef.current = message.playerId;
        window.localStorage.setItem('skyjo-player-id', message.playerId);
        setRoomCode(message.room.code);
        roomCodeRef.current = message.room.code;
        window.localStorage.setItem('skyjo-room-code', message.room.code);
        setJoinCode(message.room.code);
        setRoom(message.room);
        setConnection('connected');
        return;
      }
      if (message.type === 'room') {
        setRoom(message.room);
        setConnection('connected');
        return;
      }
      if (message.type === 'error') {
        setError(message.message || 'Room error.');
        setConnection('error');
      }
    });

    ws.addEventListener('close', () => {
      if (!mountedRef.current) return;
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      setConnection('idle');
      if (roomCodeRef.current && playerIdRef.current) {
        setError('');
        return;
      }
      setError('Room connection closed. Rejoin to continue.');
    });
  }

  const connectRef = useRef<((action: 'create-room' | 'join-room', codeOverride?: string) => void) | null>(null);
  connectRef.current = connect;

  useEffect(() => {
    function reconnectRoom() {
      const savedRoomCode = roomCodeRef.current;
      const savedPlayerId = playerIdRef.current;
      if (!savedRoomCode || !savedPlayerId) return;
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      if (reconnectTimerRef.current !== null) return;

      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!mountedRef.current) return;
        const currentWs = wsRef.current;
        if (currentWs && (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)) return;
        connectRef.current?.('join-room', roomCodeRef.current);
      }, 250);
    }

    const handleResume = () => {
      if (!mountedRef.current) return;
      if (document.visibilityState !== 'visible') return;
      reconnectRoom();
    };

    window.addEventListener('focus', handleResume);
    window.addEventListener('pageshow', handleResume);
    document.addEventListener('visibilitychange', handleResume);

    reconnectRoom();

    return () => {
      window.removeEventListener('focus', handleResume);
      window.removeEventListener('pageshow', handleResume);
      document.removeEventListener('visibilitychange', handleResume);
    };
    // Reconnect when the saved room session changes or the tab becomes active again.
  }, [playerId, roomCode]);

  function send(payload: unknown) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('Room connection is not open.');
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function startRoomGame() {
    if (!room || room.players.length < 2) return;
    send({ type: 'start-game' });
  }

  function updateGame(nextState: GameState) {
    send({ type: 'update-state', state: nextState });
  }

  function sendChatMessage(text: string) {
    send({ type: 'send-chat-message', text });
    setChatOpen(true);
  }

  function handleCard(index: number) {
    if (!room?.state || (room.state.phase !== 'opening-reveal' && room.state.phase !== 'choose-replacement')) return;
    const active = room.state.players[room.state.currentPlayerIndex];
    if (active.id !== playerId) return;
    if (room.state.phase === 'opening-reveal') {
      updateGame(revealOpeningCard(room.state, index));
      return;
    }
    updateGame(
      drawIntent === 'discard' && room.state.selectedSource === 'draw' && room.state.drawnCard
        ? discardDrawnAndReveal(room.state, index)
        : replaceCard(room.state, index)
    );
  }

  function handleNextRound() {
    if (!room?.state) return;
    send({ type: 'start-game' });
  }

  const localTurn = Boolean(room?.state && room.state.players[room.state.currentPlayerIndex]?.id === playerId);
  const localPlayer = room?.players.find((player) => player.id === playerId);
  const roomState = room?.state;
  const roomLocalPlayers = roomState?.players.filter((player) => player.id === playerId) || [];
  const roomOpponentPlayers = roomState?.players.filter((player) => player.id !== playerId) || [];
  const roomLocalBoardEntries = roomLocalPlayers.map((player) => ({ player, isLocal: true }));
  const roomOpponentBoardEntries = roomOpponentPlayers.map((player) => ({ player, isLocal: false }));
  const hasFourPlayerRoomDesktopGrid = roomState?.players.length === 4;
  const fourPlayerRoomBoardEntries = [...roomOpponentBoardEntries, ...roomLocalBoardEntries];
  const startGameDisabledReason = room && room.players.length < 2 ? 'Need at least two players to start.' : '';

  return (
    <main className="skyjo-surface px-4 py-8">
      <div className="skyjo-shell space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link className="text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/">
              Back
            </Link>
            <h1 className="skyjo-title skyjo-game-title mt-2 text-5xl">Multiplayer Lobby</h1>
            <p className="skyjo-game-subtitle mt-1 text-[#f5e6c8]/55">Create a private room and share the code with friends.</p>
          </div>
          <RulesHelpButton />
        </div>

        {!room ? (
          <section className="skyjo-panel grid gap-4 p-5 md:grid-cols-[1fr_1fr_auto]">
            <label className="grid gap-2 text-sm font-semibold text-[#f5e6c8]/75">
              Display name
              <input className="skyjo-input px-3 py-2" onChange={(event) => setName(event.target.value)} value={name} />
            </label>
            <label className="grid gap-2 text-sm font-semibold text-[#f5e6c8]/75">
              Room code
              <input
                className="skyjo-input px-3 py-2 uppercase"
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                placeholder="ABCDE"
                value={joinCode}
              />
            </label>
            <div className="flex flex-wrap items-end gap-2">
              <button
                className="skyjo-button skyjo-button-primary px-4 py-2"
                disabled={connection === 'connecting'}
                onClick={() => connect('create-room')}
                title={connection === 'connecting' ? 'Connecting to the room server.' : 'Create a private room.'}
                type="button"
              >
                Create Room
              </button>
              <button
                className="skyjo-button px-4 py-2"
                disabled={connection === 'connecting'}
                onClick={() => connect('join-room')}
                title={connection === 'connecting' ? 'Connecting to the room server.' : 'Join the room code.'}
                type="button"
              >
                Join
              </button>
            </div>
          </section>
        ) : null}

        {error ? <div className="rounded-xl border border-red-400/40 bg-red-950/70 px-4 py-3 text-red-100">{error}</div> : null}

        {room ? (
          <div className="grid gap-5 lg:grid-cols-[1fr_330px]">
            <section
              className={`space-y-4 ${
                hasFourPlayerRoomDesktopGrid ? 'lg:col-span-2 lg:row-start-1' : 'lg:col-start-1 lg:row-start-1'
              }`}
            >
              <div className="skyjo-panel skyjo-room-status-panel">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="skyjo-kicker">Room code</div>
                    <div className="skyjo-serif skyjo-room-code text-5xl font-black tracking-normal text-[#f5e6c8]">{room.code}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {localPlayer?.host && room.status === 'waiting' ? (
                      <button
                        className="skyjo-button skyjo-button-primary px-4 py-2"
                        disabled={Boolean(startGameDisabledReason)}
                        onClick={startRoomGame}
                        title={startGameDisabledReason || 'Start the multiplayer game.'}
                        type="button"
                      >
                        Start Game
                      </button>
                    ) : null}
                    {localPlayer?.host ? (
                      <button className="skyjo-button px-4 py-2" onClick={() => send({ type: 'reset-room' })} type="button">
                        Reset Room
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {room.players.map((player) => (
                    <span className="rounded-full border border-[#f5e6c8]/15 bg-white/[0.025] px-3 py-1 text-sm text-[#f5e6c8]/75" key={player.id}>
                      {player.name} {player.host ? 'host' : ''} {player.connected ? 'online' : 'offline'}
                    </span>
                  ))}
                </div>
                {localPlayer?.host && startGameDisabledReason ? (
                  <p className="skyjo-disabled-note mt-3">
                    <span>Action unavailable:</span> {startGameDisabledReason}
                  </p>
                ) : null}
              </div>

              {roomState ? (
                <>
                  {hasFourPlayerRoomDesktopGrid ? (
                    <PlayerBoardGrid
                      className={fourPlayerDesktopBoardGridClass}
                      drawIntent={drawIntent}
                      entries={fourPlayerRoomBoardEntries}
                      onCardClick={handleCard}
                      state={roomState}
                    />
                  ) : null}

                  <PlayerBoardGrid
                    className={hasFourPlayerRoomDesktopGrid ? fourPlayerMobileOpponentGridClass : opponentBoardGridClass}
                    drawIntent={drawIntent}
                    entries={roomOpponentBoardEntries}
                    onCardClick={handleCard}
                    state={roomState}
                  />
                </>
              ) : (
                <div className="skyjo-panel p-6 text-[#f5e6c8]/70">
                  Waiting for players. The host can start once at least two people are in the room.
                </div>
              )}
            </section>

            {roomState ? (
              <>
                <div
                  className={`space-y-4 ${
                    hasFourPlayerRoomDesktopGrid ? 'lg:col-start-2 lg:row-start-2' : 'lg:col-start-2 lg:row-start-1'
                  }`}
                >
                  <FinalTurnCallout localPlayerId={playerId} state={roomState} />
                  <TableControls
                    drawIntent={drawIntent}
                    localPlayerId={playerId}
                    localTurn={localTurn}
                    onChooseDiscard={() => updateGame(chooseDiscard(roomState))}
                    onDraw={() => updateGame(drawBlind(roomState))}
                    onSetDrawIntent={setDrawIntent}
                    state={roomState}
                  />
                </div>

                <section
                  className={
                    hasFourPlayerRoomDesktopGrid ? 'md:hidden lg:col-start-1 lg:row-start-2' : 'lg:col-start-1 lg:row-start-2'
                  }
                >
                  <PlayerBoardGrid
                    className={hasFourPlayerRoomDesktopGrid ? fourPlayerMobileLocalGridClass : responsiveBoardGridClass}
                    drawIntent={drawIntent}
                    entries={roomLocalBoardEntries}
                    onCardClick={handleCard}
                    state={roomState}
                  />
                </section>

                <aside
                  className={`space-y-4 ${
                    hasFourPlayerRoomDesktopGrid ? 'lg:col-start-1 lg:row-start-2' : 'lg:col-start-2 lg:row-start-2'
                  }`}
                >
                  <RoomChat
                    isOpen={chatOpen}
                    messages={chatMessages}
                    onSend={sendChatMessage}
                    onToggle={() => setChatOpen((current) => !current)}
                    playerId={playerId}
                    unreadCount={unreadChatCount}
                  />
                  {roomState.phase === 'round-over' || roomState.phase === 'game-over' ? (
                    <RoundSummary
                      actionDisabledReason={
                        localPlayer?.host
                          ? undefined
                          : roomState.phase === 'game-over'
                            ? 'Only the host can restart the game.'
                            : 'Only the host can start the next round.'
                      }
                      actionLabel={roomState.phase === 'game-over' ? 'Restart Game' : 'Next Round'}
                      onAction={localPlayer?.host ? handleNextRound : undefined}
                      state={roomState}
                    />
                  ) : null}
                  <MoveLog state={roomState} />
                </aside>
              </>
            ) : (
              <aside className="space-y-4 lg:col-start-2 lg:row-start-1">
                <section className="skyjo-panel p-4 text-sm text-[#f5e6c8]/70">Keep this tab open while friends join.</section>
                <RoomChat
                  isOpen={chatOpen}
                  messages={chatMessages}
                  onSend={sendChatMessage}
                  onToggle={() => setChatOpen((current) => !current)}
                  playerId={playerId}
                  unreadCount={unreadChatCount}
                />
              </aside>
            )}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function App() {
  return (
    <Router>
      <Routes>
        <Route element={<Home />} path="/" />
        <Route element={<SinglePlayer />} path="/single-player" />
        <Route element={<Lobby />} path="/lobby" />
      </Routes>
    </Router>
  );
}

export default App;
