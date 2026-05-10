import { useEffect, useMemo, useRef, useState } from 'react';
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
import type { Card, GameState, MultiplayerRoom, Player } from './types';

const rows = [0, 1, 2];
const columns = [0, 1, 2, 3];
const singlePlayerAiCounts = Array.from(
  { length: singlePlayerAiOpponentRange.max - singlePlayerAiOpponentRange.min + 1 },
  (_, index) => singlePlayerAiOpponentRange.min + index
);
type DrawIntent = 'place' | 'discard';
type BoardGridEntry = {
  player: Player;
  isLocal: boolean;
};

const responsiveBoardGridClass = 'grid gap-4 xl:grid-cols-2';
const fourPlayerDesktopBoardGridClass = 'hidden gap-4 md:grid md:grid-cols-2';
const fourPlayerMobileBoardGridClass = 'grid gap-4 md:hidden';

function Home() {
  return (
    <main className="skyjo-surface">
      <section className="skyjo-shell flex min-h-screen flex-col justify-center px-5 py-10">
        <div className="max-w-2xl">
          <p className="skyjo-kicker mb-3">Private game table</p>
          <h1 className="skyjo-title text-7xl sm:text-9xl">Skyjo</h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-[#f5e6c8]/70">
            Play solo against the house AI or create a private room for friends on the VPS-hosted multiplayer table.
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

  return (
    <section className={`skyjo-panel p-4 sm:p-5 ${isCurrent ? 'skyjo-panel-current' : ''}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="skyjo-serif text-xl font-semibold text-[#f5e6c8]">{player.name}</h2>
          <p className="text-sm text-[#f5e6c8]/45">{player.kind === 'ai' ? 'AI opponent' : isLocal ? 'You' : 'Player'}</p>
        </div>
        <div className="flex items-baseline gap-2 text-right text-sm">
          <span className="skyjo-kicker">Shown</span>
          <span className="font-bold tabular-nums text-[#f5e6c8]">{player.roundScore}</span>
          <span className="skyjo-kicker ml-1">Total</span>
          <span className="font-bold tabular-nums text-[#f5e6c8]">{player.totalScore}</span>
        </div>
      </div>
      <div className="grid gap-2">
        {rows.map((row) => (
          <div className="grid grid-cols-4 gap-2" key={row}>
            {columns.map((column) => {
              const index = row * 4 + column;
              const card = player.grid[index];
              const revealAfterDiscard = state.selectedSource === 'draw' && state.drawnCard && drawIntent === 'discard';
              const selectable = Boolean(
                !card.removed &&
                  ((canSelectOpening && !card.faceUp) || (canSelectReplacement && (!revealAfterDiscard || !card.faceUp)))
              );
              return (
                <button
                  className={cardClass(card, selectable)}
                  disabled={!selectable}
                  key={card.id}
                  onClick={() => onCardClick?.(index)}
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
  onChooseDiscard: () => void;
  onDraw: () => void;
  onSetDrawIntent: (intent: DrawIntent) => void;
}

function TableControls({ state, localTurn, drawIntent, onChooseDiscard, onDraw, onSetDrawIntent }: TableControlsProps) {
  const topDiscard = state.discardPile[0];
  const activePlayer = state.players[state.currentPlayerIndex];
  const hasHiddenCard = activePlayer.grid.some((card) => !card.faceUp && !card.removed);
  const openingPlayer = state.phase === 'opening-reveal' ? activePlayer : null;
  const openingCount = openingPlayer ? state.openingRevealCounts[openingPlayer.id] ?? 0 : 0;

  return (
    <section className="skyjo-panel skyjo-table-glow p-4">
      <h2 className="skyjo-serif mb-3 text-xl font-semibold">Table</h2>
      {openingPlayer ? (
        <div className="mb-4 rounded-xl border border-[#f5e6c8]/25 bg-[#f5e6c8]/10 p-3 text-sm text-[#f5e6c8]/75">
          {openingPlayer.kind === 'human'
            ? `Tap ${2 - openingCount} card${2 - openingCount === 1 ? '' : 's'} on your board to reveal.`
            : `${openingPlayer.name} is choosing opening cards.`}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-4">
        <button
          className="skyjo-button p-4 text-center"
          disabled={!localTurn || state.phase !== 'choose-source'}
          onClick={onDraw}
          type="button"
        >
          <div className="skyjo-kicker">Deck</div>
          <div className="skyjo-card skyjo-card-hidden mx-auto mt-2 w-20">SKYJO</div>
          <div className="mt-2 text-sm font-bold tabular-nums text-[#f5e6c8]/65">{state.drawPile.length} cards</div>
        </button>
        <button
          className="skyjo-button p-4 text-center"
          disabled={!localTurn || state.phase !== 'choose-source' || !topDiscard}
          onClick={onChooseDiscard}
          type="button"
        >
          <div className="skyjo-kicker">Discard</div>
          {topDiscard ? (
            <div className={`${cardClass(topDiscard, false)} mx-auto mt-2 w-20`}>{cardLabel(topDiscard)}</div>
          ) : (
            <div className="skyjo-card skyjo-card-removed mx-auto mt-2 w-20" />
          )}
          <div className="mt-2 text-sm font-bold tabular-nums text-[#f5e6c8]/65">{state.discardPile.length} cards</div>
        </button>
      </div>

      {state.drawnCard && localTurn ? (
        <div className="mt-4 rounded-xl border border-[#f5e6c8]/25 bg-[#f5e6c8]/10 p-3">
          <div className="skyjo-kicker">Drawn</div>
          <div className={`${cardClass(state.drawnCard, false)} mt-2 w-20`}>{cardLabel(state.drawnCard)}</div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              className={`skyjo-button px-3 py-2 text-sm ${drawIntent === 'place' ? 'skyjo-button-primary' : ''}`}
              onClick={() => onSetDrawIntent('place')}
              type="button"
            >
              Place
            </button>
            <button
              className={`skyjo-button px-3 py-2 text-sm ${drawIntent === 'discard' ? 'skyjo-button-primary' : ''}`}
              disabled={!hasHiddenCard}
              onClick={() => onSetDrawIntent('discard')}
              type="button"
            >
              Discard
            </button>
          </div>
          {drawIntent === 'discard' ? (
            <button className="skyjo-button mt-2 w-full px-3 py-2 text-sm" onClick={() => onSetDrawIntent('place')} type="button">
              Undo discard
            </button>
          ) : null}
          <p className="mt-3 text-sm text-[#f5e6c8]/70">
            {drawIntent === 'discard' ? 'Select a hidden card on your board to reveal.' : 'Select a card on your board to replace.'}
          </p>
        </div>
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
    <section aria-live="polite" className="skyjo-panel skyjo-final-turn-callout p-4" role="status">
      <div className="flex items-start gap-3">
        <div className="skyjo-final-turn-mark" aria-hidden="true">
          !
        </div>
        <div className="min-w-0">
          <div className="skyjo-kicker text-amber-100/75">Final turn lap</div>
          <h2 className="skyjo-serif mt-1 text-xl font-bold leading-tight text-[#fff6df]">{closerName} went out.</h2>
          <p className="mt-2 text-sm font-extrabold leading-5 text-amber-100">{turnMessage}</p>
          <p className="mt-1 text-xs leading-5 text-[#f5e6c8]/68">
            {closerName} revealed their last card. The round scores after this lap.
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

function SinglePlayer() {
  const [aiOpponentCount, setAiOpponentCount] = useState<number>(singlePlayerAiOpponentRange.min);
  const [state, setState] = useState<GameState>(() => startFreshGame({ aiOpponentCount: singlePlayerAiOpponentRange.min }));
  const [drawIntent, setDrawIntent] = useState<DrawIntent>('place');
  const activePlayer = state.players[state.currentPlayerIndex];
  const humanTurn = activePlayer.kind === 'human';
  const winner = useMemo(() => state.players.find((player) => player.id === state.winnerId), [state.players, state.winnerId]);
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
            <div>
              <Link className="text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/">
                Back
              </Link>
              <h1 className="skyjo-title mt-2 text-5xl">Single Player</h1>
              <p className="mt-1 text-[#f5e6c8]/55">Round {state.round}. Lowest score wins; first to 100 ends the game.</p>
            </div>
            <div className="w-full rounded-2xl border border-[#f5e6c8]/15 bg-white/[0.025] p-3 sm:w-auto">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="skyjo-kicker">AI opponents</div>
                  <div className="text-sm font-bold text-[#f5e6c8]/75">{aiOpponentSummary}</div>
                </div>
                <button className="skyjo-button px-4 py-2 text-sm" onClick={startSelectedGame} type="button">
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
              className={hasFourPlayerDesktopGrid ? fourPlayerMobileBoardGridClass : responsiveBoardGridClass}
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
            localTurn={humanTurn}
            onChooseDiscard={() => setState((current) => chooseDiscard(current))}
            onDraw={() => setState((current) => drawBlind(current))}
            onSetDrawIntent={setDrawIntent}
            state={state}
          />
        </div>

        <section className={hasFourPlayerDesktopGrid ? 'md:hidden lg:col-start-1 lg:row-start-2' : 'lg:col-start-1 lg:row-start-2'}>
          <PlayerBoardGrid
            className={hasFourPlayerDesktopGrid ? fourPlayerMobileBoardGridClass : responsiveBoardGridClass}
            drawIntent={drawIntent}
            entries={localBoardEntries}
            onCardClick={handleCard}
            state={state}
          />
        </section>

        <aside className={`space-y-4 ${hasFourPlayerDesktopGrid ? 'lg:col-start-1 lg:row-start-2' : 'lg:col-start-2 lg:row-start-2'}`}>
          {state.phase === 'round-over' || state.phase === 'game-over' ? (
            <section className="skyjo-panel skyjo-panel-current p-4">
              <div className="skyjo-serif text-lg font-bold">{state.phase === 'game-over' ? `${winner?.name} wins the game.` : 'Round complete.'}</div>
              <button
                className="skyjo-button skyjo-button-primary mt-3 w-full px-4 py-3"
                onClick={() => setState(state.phase === 'game-over' ? startFreshGame({ aiOpponentCount }) : startNextRound(state))}
                type="button"
              >
                {state.phase === 'game-over' ? 'Start New Game' : 'Next Round'}
              </button>
            </section>
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
  const [name, setName] = useState(() => window.localStorage.getItem('skyjo-player-name') || 'Player');
  const [joinCode, setJoinCode] = useState('');
  const [playerId, setPlayerId] = useState(() => window.localStorage.getItem('skyjo-player-id') || '');
  const [room, setRoom] = useState<MultiplayerRoom | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [error, setError] = useState('');
  const [drawIntent, setDrawIntent] = useState<DrawIntent>('place');
  const hasPendingDrawDecision = Boolean(
    room?.state && room.state.phase === 'choose-replacement' && room.state.selectedSource === 'draw' && room.state.drawnCard
  );

  useEffect(() => () => wsRef.current?.close(), []);

  useEffect(() => {
    if (!hasPendingDrawDecision) {
      setDrawIntent('place');
    }
  }, [hasPendingDrawDecision]);

  function connect(action: 'create-room' | 'join-room') {
    const cleanedName = name.trim() || 'Player';
    const cleanedCode = joinCode.trim().toUpperCase();
    if (action === 'join-room' && !cleanedCode) {
      setError('Enter a room code.');
      return;
    }
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
        window.localStorage.setItem('skyjo-player-id', message.playerId);
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
      setConnection((current) => (current === 'connected' ? 'error' : current));
      setError('Room connection closed. Rejoin to continue.');
    });
  }

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

  return (
    <main className="skyjo-surface px-4 py-8">
      <div className="skyjo-shell space-y-5">
        <div>
          <Link className="text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/">
            Back
          </Link>
          <h1 className="skyjo-title mt-2 text-5xl">Multiplayer Lobby</h1>
          <p className="mt-1 text-[#f5e6c8]/55">Create a private room and share the code with friends.</p>
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
              <button className="skyjo-button skyjo-button-primary px-4 py-2" disabled={connection === 'connecting'} onClick={() => connect('create-room')} type="button">
                Create Room
              </button>
              <button className="skyjo-button px-4 py-2" disabled={connection === 'connecting'} onClick={() => connect('join-room')} type="button">
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
              <div className="skyjo-panel p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="skyjo-kicker">Room code</div>
                    <div className="skyjo-serif text-5xl font-black tracking-normal text-[#f5e6c8]">{room.code}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {localPlayer?.host && room.status === 'waiting' ? (
                      <button className="skyjo-button skyjo-button-primary px-4 py-2" disabled={room.players.length < 2} onClick={startRoomGame} type="button">
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
                    className={hasFourPlayerRoomDesktopGrid ? fourPlayerMobileBoardGridClass : responsiveBoardGridClass}
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
                    className={hasFourPlayerRoomDesktopGrid ? fourPlayerMobileBoardGridClass : responsiveBoardGridClass}
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
                  {roomState.phase === 'round-over' || roomState.phase === 'game-over' ? (
                    <section className="skyjo-panel skyjo-panel-current p-4">
                      <div className="skyjo-serif text-lg font-bold">{roomState.phase === 'game-over' ? 'Game complete.' : 'Round complete.'}</div>
                      {localPlayer?.host ? (
                        <button className="skyjo-button skyjo-button-primary mt-3 w-full px-4 py-3" onClick={handleNextRound} type="button">
                          {roomState.phase === 'game-over' ? 'Restart Game' : 'Next Round'}
                        </button>
                      ) : null}
                    </section>
                  ) : null}
                  <MoveLog state={roomState} />
                </aside>
              </>
            ) : (
              <aside className="space-y-4 lg:col-start-2 lg:row-start-1">
                <section className="skyjo-panel p-4 text-sm text-[#f5e6c8]/70">Keep this tab open while friends join.</section>
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
