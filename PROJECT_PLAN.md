# Skyjo Online Project Plan

## Goal

Build a private, password-gated Skyjo-style web app for friends with:

- Single-player mode against a simple AI.
- Multiplayer rooms for 2-8 players.
- Mobile-friendly play surface.
- VPS deployment behind the shared-password access gate.
- VPS-native realtime room sync with the Node server and WebSockets.

## Phase 1: Playable Single-Player MVP

Status: MVP complete; refinement in progress

Deliverables:

- Shared game engine for deck creation, dealing, turns, replacement, reveal, column removal, scoring, and round end.
- Single-player route with a human player and 1-7 configurable AI opponents.
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
- Opening cards are manually selected by the human and automatically selected by AI players.

## Phase 2: Multiplayer Lobby and Rooms

Status: MVP complete; validation hardening in progress
GitHub issue: #3

Deliverables:

- Lobby route with create-room and join-room flows.
- Room codes/links that can be shared with friends.
- VPS-hosted WebSocket room state.
- Player presence, ready state, and host start controls.
- Server-side turn ownership checks; deeper move-shape validation remains in Phase 4 hardening.

Acceptance:

- Two browsers can join the same room and see synchronized game state.
- Only the current player can make a move.
- Players can reconnect to an active room.

Current notes:

- Multiplayer lobby route is `/lobby`.
- Rooms are stored in memory on the VPS process for the friends-only MVP.
- A service restart clears active rooms; persistence can be added later if needed.

## Phase 3: Multiplayer Game Completion

Status: MVP complete; multi-browser playtest and persistence refinement in progress
GitHub issue: #1

Deliverables:

- 2-8 player turn order.
- Round-end scoring across all players.
- New round flow until a configured target score.
- Basic room cleanup for stale games.

Acceptance:

- A friend group can complete a multi-round game from room creation to winner.

Current notes:

- Game state is synchronized optimistically from the current player's browser after the VPS verifies room membership and turn ownership.
- The next hardening pass should move more move validation into the server before treating this as abuse-resistant.

## Phase 4: Polish and Hardening

Status: planned
GitHub issue: #2

Deliverables:

- Better AI strategy.
- Rules/help overlay.
- Animations and clearer card states.
- Spectator-safe error handling and loading states.
- WebSocket room authorization and stale-room cleanup review.
- Smoke test checklist for VPS deployment.

Acceptance:

- The app is understandable without instructions in Slack.
- Public hostname remains password gated, and room access is scoped to room codes.
