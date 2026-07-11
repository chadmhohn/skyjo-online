# Skyjo Online

Multiplayer online version of the popular card game Skyjo.

## Features
- Real-time multiplayer rooms (2-8 players)
- Single player mode vs AI
- Password protected access
- Optional user accounts with saved stats, game history, and admin password resets
- Built with React + Vite + TypeScript + Tailwind + a VPS-native WebSocket server

## Requirements

- Node.js 24 LTS
- npm 11 or newer

## Quick Start
1. Clone the repo
2. Select Node 24 (the repository's `.node-version` is supported by common version managers)
3. `npm ci`
4. Copy `.env.example` to `.env` and set the shared access password
5. `npm run dev`

## VPS Deployment

Production uses a CI-built, checksummed, attested runtime archive and atomic release symlinks. The VPS does not build from or pull into a live Git checkout. Full bootstrap, canary, promotion, rollback, and recovery instructions are in [the immutable deployment runbook](docs/immutable-deployment.md).

Create root-only `/etc/skyjo-online.env` with:

- `SKYJO_ACCESS_PASSWORD`
- `SKYJO_SESSION_SECRET`
- `SKYJO_INVITE_SECRET` for signed friend invite links
- `SKYJO_INVITE_TTL_HOURS=168` or your preferred invite lifetime
- `SKYJO_INVITE_CODE_TTL_MINUTES=30` for short Home Screen install-code handoff
- `SKYJO_ROOMS_FILE=/var/lib/skyjo-online/rooms.json`
- `SKYJO_DB_FILE=/var/lib/skyjo-online/skyjo.sqlite`
- `SKYJO_ADMIN_EMAIL=chad.hohn@groundworkrevops.com`
- `SKYJO_ADMIN_INITIAL_PASSWORD` for first admin bootstrap
- `SKYJO_DEPLOY_SMOKE_ACCOUNT_EMAIL` and `SKYJO_DEPLOY_SMOKE_ACCOUNT_PASSWORD` for the dedicated existing release-smoke account
- `HOST=127.0.0.1`
- `PORT=4180`

The hardened service runs as non-login user `skyjo` with the isolated runtime at `/opt/skyjo-online/node/bin/node`, reads immutable code through `/srv/skyjo-online/current`, and writes only `/var/lib/skyjo-online`. Cloudflare Tunnel remains in front of `127.0.0.1:4180`. The app server handles the friend-facing password screen and signed, HttpOnly cookies. Keep passwords, invite/session secrets, smoke credentials, and state out of git and GitHub.

Public service checks do not require cookies and are never cached:

- `GET /healthz` is plain liveness and returns `ok` even when durable state needs repair.
- `GET /readyz` returns only fixed `ok`/`error` checks for the database, room state, and last persistence operation. It returns 503 until all checks pass.
- `GET /version` returns the checksum-validated build SHA, build timestamp, and current protocol version.

Every `npm run build` writes `dist/release.json` and `dist/release.json.sha256`. Production builds require a full commit SHA; CI may set `SKYJO_RELEASE_SHA`, `SKYJO_BUILD_TIMESTAMP`, or `SOURCE_DATE_EPOCH` before building.

Health check:
`curl http://127.0.0.1:4180/healthz && curl http://127.0.0.1:4180/readyz && curl http://127.0.0.1:4180/version`

Hardened systemd files live in `deploy/systemd/`:

- `deploy/skyjo-online.env.example`
- `deploy/systemd/skyjo-online.service`
- `deploy/systemd/skyjo-online-canary@.service`
- `deploy/systemd/skyjo-online-smoke@.service`

Generate session and invite secrets with:
`openssl rand -base64 48`

Release smoke checklist:
[docs/deployment-smoke-checklist.md](docs/deployment-smoke-checklist.md)

Verified backup and isolated restore guide:
[docs/data-recovery.md](docs/data-recovery.md)

Agent handoff and operating guide:
[AGENTS.md](AGENTS.md)

## Tech Stack
- React 18 + TypeScript
- Vite
- Tailwind CSS + daisyUI
- Node WebSocket rooms for multiplayer state
- SQLite account and game-history store
- React Router for navigation

## Game Rules Summary
- 3x4 grid of cards per player (-2 to 12)
- Flip 2 cards at the start of each round
- Highest visible opening sum starts round one; the player who ended a round starts the next round
- Draw or take discard, replace a card in your grid
- Columns of 3 identical cards are removed (score 0)
- Round ends when one player has all cards face up
- Lowest score wins the round. First to 100+ loses.
