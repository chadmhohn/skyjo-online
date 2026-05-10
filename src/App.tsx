import { useEffect, useMemo, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import {
  chooseDiscard,
  discardDrawnAndReveal,
  drawBlind,
  getBestAiMove,
  replaceCard,
  startFreshGame,
  startNextRound
} from './game';
import type { Card, GameState, Player } from './types';

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
            Play a quick solo round now, then use the same table experience for friend rooms as multiplayer comes online.
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
  isHuman: boolean;
  state: GameState;
  onCardClick?: (index: number) => void;
}

function PlayerGrid({ player, isCurrent, isHuman, state, onCardClick }: GridProps) {
  const canSelect =
    isHuman &&
    isCurrent &&
    state.phase === 'choose-replacement' &&
    (state.selectedSource === 'discard' || state.selectedSource === 'draw');

  return (
    <section className={`rounded-lg border p-4 ${isCurrent ? 'border-sky-400 bg-slate-900' : 'border-slate-800 bg-slate-900/70'}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">{player.name}</h2>
          <p className="text-sm text-slate-400">{player.kind === 'ai' ? 'AI opponent' : 'Human player'}</p>
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

function SinglePlayer() {
  const [state, setState] = useState<GameState>(() => startFreshGame());
  const activePlayer = state.players[state.currentPlayerIndex];
  const humanTurn = activePlayer.kind === 'human';
  const topDiscard = state.discardPile[0];
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
    if (state.selectedSource === 'draw' && state.drawnCard) {
      setState((current) => replaceCard(current, index));
      return;
    }
    setState((current) => replaceCard(current, index));
  }

  function handleReveal(index: number) {
    if (!humanTurn) return;
    setState((current) => discardDrawnAndReveal(current, index));
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
                isHuman={player.kind === 'human'}
                key={player.id}
                onCardClick={handleCard}
                player={player}
                state={state}
              />
            ))}
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <h2 className="mb-3 text-lg font-bold">Table</h2>
            <div className="grid grid-cols-2 gap-3">
              <button
                className="rounded-md border border-slate-700 bg-slate-950 p-4 text-left disabled:opacity-50"
                disabled={!humanTurn || state.phase !== 'choose-source'}
                onClick={() => setState((current) => drawBlind(current))}
                type="button"
              >
                <div className="text-sm text-slate-400">Draw pile</div>
                <div className="mt-2 text-2xl font-black">{state.drawPile.length}</div>
              </button>
              <button
                className="rounded-md border border-slate-700 bg-white p-4 text-left text-slate-950 disabled:opacity-50"
                disabled={!humanTurn || state.phase !== 'choose-source' || !topDiscard}
                onClick={() => setState((current) => chooseDiscard(current))}
                type="button"
              >
                <div className="text-sm text-slate-600">Discard</div>
                <div className="mt-2 text-2xl font-black">{topDiscard?.value ?? '-'}</div>
              </button>
            </div>

            {state.drawnCard && humanTurn ? (
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
                      onClick={() => handleReveal(index)}
                      type="button"
                    >
                      {index + 1}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {state.phase === 'round-over' || state.phase === 'game-over' ? (
              <div className="mt-4 rounded-md border border-sky-500 bg-sky-950 p-3">
                <div className="font-bold">{state.phase === 'game-over' ? `${winner?.name} wins the game.` : 'Round complete.'}</div>
                <button
                  className="mt-3 w-full rounded-md bg-sky-400 px-4 py-2 font-bold text-slate-950 hover:bg-sky-300"
                  onClick={() => setState(state.phase === 'game-over' ? startFreshGame() : startNextRound(state))}
                  type="button"
                >
                  {state.phase === 'game-over' ? 'Start New Game' : 'Next Round'}
                </button>
              </div>
            ) : null}
          </section>

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
        </aside>
      </div>
    </main>
  );
}

function Lobby() {
  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <section className="mx-auto max-w-3xl rounded-lg border border-slate-800 bg-slate-900 p-6">
        <Link className="text-sm text-sky-300 hover:text-sky-200" to="/">
          Back
        </Link>
        <h1 className="mt-3 text-3xl font-black">Multiplayer Lobby</h1>
        <p className="mt-3 text-slate-300">
          Multiplayer is the next build phase. The plan is now documented in `PROJECT_PLAN.md`; single-player is being built first so
          multiplayer can reuse the same game engine instead of duplicating rules.
        </p>
      </section>
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
