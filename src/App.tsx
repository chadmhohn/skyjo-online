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
  onCardClick?: (index: number) => void;
}

function PlayerGrid({ player, isCurrent, isLocal, state, onCardClick }: GridProps) {
  const canSelect =
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
    <section className="skyjo-panel skyjo-table-glow p-4">
      <h2 className="skyjo-serif mb-3 text-xl font-semibold">Table</h2>
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
          <p className="mt-3 text-sm text-[#f5e6c8]/75">Replace a card, or discard this and reveal one hidden card.</p>
          <div className="mt-3 grid grid-cols-4 gap-2">
            {activePlayer.grid.map((card, index) => (
              <button
                className="skyjo-button px-2 py-2 text-sm"
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
    <section className="skyjo-panel p-4">
      <h2 className="skyjo-serif mb-3 text-xl font-semibold">Move Log</h2>
      <div className="space-y-2 text-sm text-[#f5e6c8]/72">
        {state.log.map((entry) => (
          <div className="rounded-lg border border-white/[0.04] bg-white/[0.025] px-3 py-2" key={entry}>
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
    <main className="skyjo-surface px-4 py-5">
      <div className="skyjo-shell grid gap-5 lg:grid-cols-[1fr_330px]">
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Link className="text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/">
                Back
              </Link>
              <h1 className="skyjo-title mt-2 text-5xl">Single Player</h1>
              <p className="mt-1 text-[#f5e6c8]/55">Round {state.round}. Lowest score wins; first to 100 ends the game.</p>
            </div>
            <button className="skyjo-button px-4 py-2" onClick={() => setState(startFreshGame())} type="button">
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
            <section className="skyjo-panel skyjo-panel-current p-4">
              <div className="skyjo-serif text-lg font-bold">{state.phase === 'game-over' ? `${winner?.name} wins the game.` : 'Round complete.'}</div>
              <button
                className="skyjo-button skyjo-button-primary mt-3 w-full px-4 py-3"
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
    <main className="skyjo-surface px-4 py-8">
      <div className="skyjo-shell space-y-5">
        <div>
          <Link className="text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/">
            Back
          </Link>
          <h1 className="skyjo-title mt-2 text-5xl">Multiplayer Lobby</h1>
          <p className="mt-1 text-[#f5e6c8]/55">Rooms run entirely on this VPS over WebSockets. Share the room code with friends.</p>
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
            <section className="space-y-4">
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
                <div className="skyjo-panel p-6 text-[#f5e6c8]/70">
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
                    <section className="skyjo-panel skyjo-panel-current p-4">
                      <div className="skyjo-serif text-lg font-bold">{room.state.phase === 'game-over' ? 'Game complete.' : 'Round complete.'}</div>
                      {localPlayer?.host ? (
                        <button className="skyjo-button skyjo-button-primary mt-3 w-full px-4 py-3" onClick={handleNextRound} type="button">
                          {room.state.phase === 'game-over' ? 'Restart Game' : 'Next Round'}
                        </button>
                      ) : null}
                    </section>
                  ) : null}
                  <MoveLog state={room.state} />
                </>
              ) : (
                <section className="skyjo-panel p-4 text-sm text-[#f5e6c8]/70">
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
