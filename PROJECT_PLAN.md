# Skyjo Online Project Plan

> Historical MVP planning document. Several architecture statements below predate the server-authoritative multiplayer protocol and must not be used as current implementation guidance. Use `AGENTS.md`, executable tests, `src/protocolV2.ts`, and `docs/native-ios/` for the current PWA/native architecture.

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
- Single-player AI uses deterministic MVP heuristics for visible values, hidden-card risk, discard/drawn card value, column clears, and final turns.
- Opening cards are manually selected by the human and automatically selected by AI players.

## Phase 2: Multiplayer Lobby and Rooms

Status: MVP complete; validation hardening complete
GitHub issue: #3

Deliverables:

- Lobby route with create-room and join-room flows.
- Room codes/links that can be shared with friends.
- VPS-hosted WebSocket room state.
- Player presence, ready state, and host start controls.
- Server-side turn ownership checks and move-shape validation against legal shared-engine transitions.

Acceptance:

- Two browsers can join the same room and see synchronized game state.
- Only the current player can make a move.
- Players can reconnect to an active room.

Current notes:

- Multiplayer lobby route is `/lobby`.
- Rooms are stored in memory on the VPS process and persisted to local JSON at `.data/rooms.json` by default, with `SKYJO_ROOMS_FILE` available for deployments that want a different path.
- Persisted rooms restore after a service restart without socket handles; players come back offline until their browsers rejoin, and stale offline rooms are pruned after six hours.

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

- Game state is synchronized from the current player's browser after the VPS verifies room membership, turn ownership, and legal move shape.
- Host start, next-round, new-game, and reset boundaries are enforced server-side for the friends-only MVP.

## Phase 4: Polish and Hardening

Status: deployment smoke coverage complete; remaining polish in progress
GitHub issue: #2

Deliverables:

- Better single-player AI strategy is complete in #12.
- Rules/help overlay is complete in #10.
- Animations and clearer card states.
- Spectator-safe error handling and loading states.
- WebSocket room authorization and stale-room cleanup review.
- Server-side move-shape validation is complete; remaining hardening should focus on playtest findings and deployment smoke coverage.
- Smoke test checklist for VPS deployment is complete in #14.

Acceptance:

- The app is understandable without instructions in Slack.
- Public hostname remains password gated, and room access is scoped to room codes.

Current notes:

- Rules are available from compact in-game buttons on both the single-player and multiplayer routes.
- Issue #11 polish is complete: the play surface now calls out opening reveals, local vs waiting turns, drawn-card decisions, eligible cards, final-lap state, disabled action reasons, and round scoring.
- Issue #12 AI strategy is complete; `npm run smoke:ai` covers source choices, replacement targets, reveal targets, final-turn pressure, and removed-card safety.
- Issue #14 deployment smoke checklist is complete; `docs/deployment-smoke-checklist.md` covers local release checks, health endpoints, login/static bundle verification, single-player and two-client multiplayer smoke, restart guidance, and persistence-aware server-side release notes.
