# Skyjo Online Project Plan

## Goal

Build a private, password-gated Skyjo-style web app for friends with:

- Single-player mode against a simple AI.
- Multiplayer rooms for 2-8 players.
- Mobile-friendly play surface.
- VPS deployment behind the shared-password access gate.

## Phase 1: Playable Single-Player MVP

Status: MVP complete; refinement in progress

Deliverables:

- Shared game engine for deck creation, dealing, turns, replacement, reveal, column removal, scoring, and round end.
- Single-player route with a human player and one AI opponent.
- Clear turn controls for draw pile, discard pile, replacement, and reveal actions.
- Round score summary and new-round/new-game flow.
- Build/lint/deploy verification.
- Live deployment to `skyjo.groundworkrevops.com`.

Acceptance:

- A player can complete a full round against AI.
- Scores are calculated from visible/revealed cards, with cleared columns scoring zero.
- The AI takes legal turns without manual intervention.

Current notes:

- Single-player route is `/single-player`.
- AI is intentionally simple; better strategy belongs in Phase 4.
- Opening cards are auto-revealed for speed in the first MVP.

## Phase 2: Multiplayer Lobby and Rooms

Status: planned

Deliverables:

- Lobby route with create-room and join-room flows.
- Room codes/links that can be shared with friends.
- Firebase Realtime Database room state.
- Player presence, ready state, and host start controls.
- Validation to prevent invalid or out-of-turn moves.

Acceptance:

- Two browsers can join the same room and see synchronized game state.
- Only the current player can make a move.
- Players can reconnect to an active room.

## Phase 3: Multiplayer Game Completion

Status: planned

Deliverables:

- 2-8 player turn order.
- Round-end scoring across all players.
- New round flow until a configured target score.
- Basic room cleanup for stale games.

Acceptance:

- A friend group can complete a multi-round game from room creation to winner.

## Phase 4: Polish and Hardening

Status: planned

Deliverables:

- Better AI strategy.
- Rules/help overlay.
- Animations and clearer card states.
- Spectator-safe error handling and loading states.
- Firebase security rules review.
- Smoke test checklist for VPS deployment.

Acceptance:

- The app is understandable without instructions in Slack.
- Public hostname remains password gated, and game data access is scoped to intended rooms.
