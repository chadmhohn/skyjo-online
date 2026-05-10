import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import {
  chooseDiscard,
  createMultiplayerGame,
  discardDrawnAndReveal,
  drawBlind,
  getBestAiMove,
  replaceCard,
  startFreshGame,
  startNextRound
} from './game';
import type { Card, GameState, MultiplayerRoom, Player } from './types';

const rows = [0, 1, 2];
const columns = [0, 1, 2, 3];

function Home() {
  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <section className="mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-center px-5 py-10">
        <div className="max-w-2xl">
          <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-sky-300">Private game table</p>
          <h1 className="text-6xl font-black tracking-normal sm:text-8xl">SKYJO</h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-slate-300">
            Play solo against the house AI or create a private room for friends on the VPS-hosted multiplayer table.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link className="rounded-md bg-sky-400 px-5 py-3 font-bold text-slate-950 hover:bg-sky-300" to="/single-player">
              Single Player
            </Link>
            <Link className="rounded-md border border-slate-600 px-5 py-3 font-bold text-slate-100 hover:border-sky-300" to="/lobby">
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
  if (card.faceUp) return card.value;
  return '?';
}

function cardClass(card: Card, isSelectable: boolean) {
  const base =
    'flex aspect-[3/4] min-h-16 items-center justify-center rounded-md border text-xl font-black shadow-sm transition sm:text-2xl';
  if (card.removed) return `${base} border-slate-800 bg-slate-950 text-slate-950`;
  if (!card.faceUp) return `${base} border-sky-700 bg-sky-950 text-sky-200`;
  const color = card.value <= 0 ? 'border-emerald-500 bg-emerald-100 text-emerald-950' : 'border-slate-300 bg-white text-slate-950';
  return `${base} ${color} ${isSelectable ? 'hover:-translate-y-1 hover:border-amber-300' : ''}`;
}

interface GridProps {
  player: Player;
  isCurrent: boolean;
  isLocal: boolean;
  state: GameState;
  onCardClick?: (index: number) => void;
}

function PlayerGrid({ player, isCurrent, isLocal, state, onCardClick }: GridProps) {
  const canSelect =
    isLocal &&
    isCurrent &&
    state.phase === 'choose-replacement' &&
    (state.selectedSource === 'discard' || state.selectedSource === 'draw');

  return (
    <section className={`rounded-lg border p-4 ${isCurrent ? 'border-sky-400 bg-slate-900' : 'border-slate-800 bg-slate-900/70'}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">{player.name}</h2>
          <p className="text-sm text-slate-400">{player.kind === 'ai' ? 'AI opponent' : isLocal ? 'You' : 'Player'}</p>
        </div>
        <div className="text-right text-sm">
          <div className="font-bold text-slate-100">Round {player.roundScore}</div>
          <div className="text-slate-400">Total {player.totalScore}</div>
        </div>
      </div>
      <div className="grid gap-2">
        {rows.map((row) => (
          <div className="grid grid-cols-4 gap-2" key={row}>
            {columns.map((column) => {
              const index = row * 4 + column;
              const card = player.grid[index];
              const selectable = Boolean(canSelect && !card.removed && (state.selectedSource !== 'draw' || state.drawnCard || !card.faceUp));
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

interface TableControlsProps {
  state: GameState;
  localTurn: boolean;
  onChooseDiscard: () => void;
  onDraw: () => void;
  onReveal: (index: number) => void;
}

function TableControls({ state, localTurn, onChooseDiscard, onDraw, onReveal }: TableControlsProps) {
  const topDiscard = state.discardPile[0];
  const activePlayer = state.players[state.currentPlayerIndex];

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <h2 className="mb-3 text-lg font-bold">Table</h2>
      <div className="grid grid-cols-2 gap-3">
        <button
          className="rounded-md border border-slate-700 bg-slate-950 p-4 text-left disabled:opacity-50"
          disabled={!localTurn || state.phase !== 'choose-source'}
          onClick={onDraw}
          type="button"
        >
          <div className="text-sm text-slate-400">Draw pile</div>
          <div className="mt-2 text-2xl font-black">{state.drawPile.length}</div>
        </button>
        <button
          className="rounded-md border border-slate-700 bg-white p-4 text-left text-slate-950 disabled:opacity-50"
          disabled={!localTurn || state.phase !== 'choose-source' || !topDiscard}
          onClick={onChooseDiscard}
          type="button"
        >
          <div className="text-sm text-slate-600">Discard</div>
          <div className="mt-2 text-2xl font-black">{topDiscard?.value ?? '-'}</div>
        </button>
      </div>

      {state.drawnCard && localTurn ? (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-100 p-3 text-slate-950">
          <div className="text-sm font-semibold">You drew</div>
          <div className="text-3xl font-black">{state.drawnCard.value}</div>
          <p className="mt-2 text-sm">Click one of your cards to replace it, or reveal a hidden card instead.</p>
          <div className="mt-3 grid grid-cols-4 gap-2">
            {activePlayer.grid.map((card, index) => (
              <button
                className="rounded bg-slate-900 px-2 py-2 text-sm font-bold text-white disabled:opacity-30"
                disabled={card.faceUp || card.removed}
                key={card.id}
                onClick={() => onReveal(index)}
                type="button"
              >
                {index + 1}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function MoveLog({ state }: { state: GameState }) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <h2 className="mb-3 text-lg font-bold">Move Log</h2>
      <div className="space-y-2 text-sm text-slate-300">
        {state.log.map((entry) => (
          <div className="rounded bg-slate-950 px-3 py-2" key={entry}>
            {entry}
          </div>
        ))}
      </div>
    </section>
  );
}

function SinglePlayer() {
  const [state, setState] = useState<GameState>(() => startFreshGame());
  const activePlayer = state.players[state.currentPlayerIndex];
  const humanTurn = activePlayer.kind === 'human';
  const winner = useMemo(() => state.players.find((player) => player.id === state.winnerId), [state.players, state.winnerId]);

  useEffect(() => {
    if (activePlayer.kind !== 'ai' || state.phase === 'round-over' || state.phase === 'game-over') return;
    const timer = window.setTimeout(() => {
      setState((current) => {
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
    if (!humanTurn || state.phase !== 'choose-replacement') return;
    setState((current) => replaceCard(current, index));
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-5 text-slate-100">
      <div className="mx-auto grid max-w-7xl gap-4 lg:grid-cols-[1fr_320px]">
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Link className="text-sm text-sky-300 hover:text-sky-200" to="/">
                Back
              </Link>
              <h1 className="text-3xl font-black">Single Player</h1>
              <p className="text-slate-400">Round {state.round}. Lowest score wins; first to 100 ends the game.</p>
            </div>
            <button className="rounded-md border border-slate-700 px-4 py-2 font-semibold hover:border-sky-300" onClick={() => setState(startFreshGame())} type="button">
              New Game
            </button>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            {state.players.map((player, index) => (
              <PlayerGrid
                isCurrent={index === state.currentPlayerIndex}
                isLocal={player.kind === 'human'}
                key={player.id}
                onCardClick={handleCard}
                player={player}
                state={state}
              />
            ))}
          </div>
        </section>

        <aside className="space-y-4">
          <TableControls
            localTurn={humanTurn}
            onChooseDiscard={() => setState((current) => chooseDiscard(current))}
            onDraw={() => setState((current) => drawBlind(current))}
            onReveal={(index) => setState((current) => discardDrawnAndReveal(current, index))}
            state={state}
          />

          {state.phase === 'round-over' || state.phase === 'game-over' ? (
            <section className="rounded-lg border border-sky-500 bg-sky-950 p-4">
              <div className="font-bold">{state.phase === 'game-over' ? `${winner?.name} wins the game.` : 'Round complete.'}</div>
              <button
                className="mt-3 w-full rounded-md bg-sky-400 px-4 py-2 font-bold text-slate-950 hover:bg-sky-300"
                onClick={() => setState(state.phase === 'game-over' ? startFreshGame() : startNextRound(state))}
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

  useEffect(() => () => wsRef.current?.close(), []);

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
    const game = createMultiplayerGame(room.players.map((player) => ({ id: player.id, name: player.name })));
    send({ type: 'start-game', state: game });
  }

  function updateGame(nextState: GameState) {
    send({ type: 'update-state', state: nextState });
  }

  function handleCard(index: number) {
    if (!room?.state || room.state.phase !== 'choose-replacement') return;
    const active = room.state.players[room.state.currentPlayerIndex];
    if (active.id !== playerId) return;
    updateGame(replaceCard(room.state, index));
  }

  function handleNextRound() {
    if (!room?.state) return;
    const next = createMultiplayerGame(
      room.state.players.map((player) => ({ id: player.id, name: player.name, totalScore: player.totalScore })),
      room.state.round + 1
    );
    send({ type: 'start-game', state: next });
  }

  const localTurn = Boolean(room?.state && room.state.players[room.state.currentPlayerIndex]?.id === playerId);
  const localPlayer = room?.players.find((player) => player.id === playerId);

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-7xl space-y-4">
        <div>
          <Link className="text-sm text-sky-300 hover:text-sky-200" to="/">
            Back
          </Link>
          <h1 className="mt-2 text-3xl font-black">Multiplayer Lobby</h1>
          <p className="text-slate-400">Rooms run entirely on this VPS over WebSockets. Share the room code with friends.</p>
        </div>

        {!room ? (
          <section className="grid gap-4 rounded-lg border border-slate-800 bg-slate-900 p-5 md:grid-cols-[1fr_1fr_auto]">
            <label className="grid gap-2 text-sm font-semibold">
              Display name
              <input className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2" onChange={(event) => setName(event.target.value)} value={name} />
            </label>
            <label className="grid gap-2 text-sm font-semibold">
              Room code
              <input
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 uppercase"
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                placeholder="ABCDE"
                value={joinCode}
              />
            </label>
            <div className="flex flex-wrap items-end gap-2">
              <button className="rounded-md bg-sky-400 px-4 py-2 font-bold text-slate-950" disabled={connection === 'connecting'} onClick={() => connect('create-room')} type="button">
                Create Room
              </button>
              <button className="rounded-md border border-slate-600 px-4 py-2 font-bold" disabled={connection === 'connecting'} onClick={() => connect('join-room')} type="button">
                Join
              </button>
            </div>
          </section>
        ) : null}

        {error ? <div className="rounded-md border border-red-500 bg-red-950 px-4 py-3 text-red-100">{error}</div> : null}

        {room ? (
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <section className="space-y-4">
              <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm text-slate-400">Room code</div>
                    <div className="text-4xl font-black tracking-normal text-sky-300">{room.code}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {localPlayer?.host && room.status === 'waiting' ? (
                      <button className="rounded-md bg-sky-400 px-4 py-2 font-bold text-slate-950 disabled:opacity-50" disabled={room.players.length < 2} onClick={startRoomGame} type="button">
                        Start Game
                      </button>
                    ) : null}
                    {localPlayer?.host ? (
                      <button className="rounded-md border border-slate-700 px-4 py-2 font-semibold" onClick={() => send({ type: 'reset-room' })} type="button">
                        Reset Room
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {room.players.map((player) => (
                    <span className="rounded-full border border-slate-700 px-3 py-1 text-sm" key={player.id}>
                      {player.name} {player.host ? 'host' : ''} {player.connected ? 'online' : 'offline'}
                    </span>
                  ))}
                </div>
              </div>

              {room.state ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  {room.state.players.map((player, index) => (
                    <PlayerGrid
                      isCurrent={index === room.state?.currentPlayerIndex}
                      isLocal={player.id === playerId}
                      key={player.id}
                      onCardClick={handleCard}
                      player={player}
                      state={room.state as GameState}
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-slate-300">
                  Waiting for players. The host can start once at least two people are in the room.
                </div>
              )}
            </section>

            <aside className="space-y-4">
              {room.state ? (
                <>
                  <TableControls
                    localTurn={localTurn}
                    onChooseDiscard={() => updateGame(chooseDiscard(room.state as GameState))}
                    onDraw={() => updateGame(drawBlind(room.state as GameState))}
                    onReveal={(index) => updateGame(discardDrawnAndReveal(room.state as GameState, index))}
                    state={room.state}
                  />
                  {room.state.phase === 'round-over' || room.state.phase === 'game-over' ? (
                    <section className="rounded-lg border border-sky-500 bg-sky-950 p-4">
                      <div className="font-bold">{room.state.phase === 'game-over' ? 'Game complete.' : 'Round complete.'}</div>
                      {localPlayer?.host ? (
                        <button className="mt-3 w-full rounded-md bg-sky-400 px-4 py-2 font-bold text-slate-950 hover:bg-sky-300" onClick={handleNextRound} type="button">
                          {room.state.phase === 'game-over' ? 'Restart Game' : 'Next Round'}
                        </button>
                      ) : null}
                    </section>
                  ) : null}
                  <MoveLog state={room.state} />
                </>
              ) : (
                <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm text-slate-300">
                  Keep this tab open while friends join.
                </section>
              )}
            </aside>
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
