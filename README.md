# Skyjo Online

Multiplayer online version of the popular card game Skyjo.

## Features
- Real-time multiplayer rooms (2-8 players)
- Single player mode vs AI
- Password protected access
- Optional user accounts with saved stats, game history, and admin password resets
- Built with React + Vite + TypeScript + Tailwind + a VPS-native WebSocket server

## Quick Start
1. Clone the repo
2. `npm install`
3. Copy `.env.example` to `.env` and set the shared access password
4. `npm run dev`

## VPS Deployment

The VPS deployment uses the normal Vite build plus a small Node server with a shared-password gate.

1. Install dependencies:
   `npm install`
2. Create `/etc/skyjo-online.env` or another service env file with:
   - `SKYJO_ACCESS_PASSWORD`
   - `SKYJO_SESSION_SECRET`
   - `SKYJO_INVITE_SECRET` for signed friend invite links
   - `SKYJO_INVITE_TTL_HOURS=168` or your preferred invite lifetime
   - `SKYJO_INVITE_CODE_TTL_MINUTES=30` for short Home Screen install-code handoff
   - `SKYJO_DB_FILE=/var/lib/skyjo-online/skyjo.sqlite`
   - `SKYJO_ADMIN_EMAIL=chad.hohn@groundworkrevops.com`
   - `SKYJO_ADMIN_INITIAL_PASSWORD` for first admin bootstrap
   - `HOST=127.0.0.1`
   - `PORT=4180`
3. Load the env file and build:
   `set -a && . /etc/skyjo-online.env && set +a && npm run build`
4. Start the production server:
   `set -a && . /etc/skyjo-online.env && set +a && npm start`

Put Caddy, Nginx, Traefik, or Cloudflare Tunnel in front of `127.0.0.1:4180`. The app server handles the friend-facing password screen and sets signed, HttpOnly cookies for both the shared gate and user accounts. Room invite links open an install/browser choice page; browser continuation grants only the shared-gate cookie and redirects to `/lobby?room=CODE`, while the short install code can be pasted into the Home Screen app login page for the same gate-cookie handoff. Multiplayer still requires account login. Keep passwords, invite/session secrets, and the SQLite database out of git.

Health check:
`curl http://127.0.0.1:4180/healthz`

Example systemd files live in `deploy/`:
- `deploy/skyjo-online.env.example`
- `deploy/skyjo-online.service`

Generate session and invite secrets with:
`openssl rand -base64 48`

Release smoke checklist:
[docs/deployment-smoke-checklist.md](docs/deployment-smoke-checklist.md)

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
