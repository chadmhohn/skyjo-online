# Deployment Smoke Checklist

Use this checklist before and after Skyjo Online releases. Do not restart the live `skyjo-online.service` or the OpenClaw Gateway unless the release actually needs it.

## Local Release Checks

Run the aggregate smoke script from a clean, current `main` branch:

```sh
npm run smoke:release
```

It runs:

- `git diff --check`
- `npm run lint`
- `npm run build`
- `npm audit --audit-level=high`
- `npm run smoke:validation`
- `npm run smoke:ai`
- `npm run smoke:persistence`

If you need to isolate a failure, run the same commands one at a time in that order.

## Service Health

After deploying the built release, check the local service before using the public hostname:

```sh
systemctl status skyjo-online.service --no-pager
curl -fsS http://127.0.0.1:4180/healthz
```

Expected result: systemd reports the service as active and the service health endpoint returns `ok`.

## Public Health

Check the public `/healthz` endpoint through the production edge:

```sh
curl -fsS https://skyjo.groundworkrevops.com/healthz
```

Expected result: the public health check returns `ok` without requiring the shared game password. If the local health check passes but public health fails, inspect the public gateway or reverse proxy before changing the app.

## Login And Static Bundle

Use a private browser session so cached cookies and assets do not hide release issues.

- Open `https://skyjo.groundworkrevops.com/` and confirm it redirects to the password login screen.
- Submit the shared password and confirm the app shell loads.
- Hard refresh once after login and confirm the app still loads from the built static bundle.
- Open browser devtools and confirm there are no failed `/assets/...` requests, missing JS/CSS bundles, or console errors during first load.
- Optionally verify from the shell that unauthenticated app routes redirect while `/healthz` remains public:

```sh
curl -I https://skyjo.groundworkrevops.com/
curl -fsS https://skyjo.groundworkrevops.com/healthz
```

## Single-Player Smoke

- Go to `/single-player`.
- Start a game with the default AI setup.
- Reveal the opening cards and play at least two human turns.
- Confirm the AI moves automatically, legal action buttons enable only at the right time, the discard/draw piles update, and no browser console errors appear.

## Multiplayer Two-Client Smoke

Use two separate clients, such as two browsers or one normal window plus one private window.

- Client A logs in, opens `/lobby`, creates a room, and copies the room code or link.
- Client B logs in, joins the same room, and appears in Client A's room list.
- Start the game from the host client.
- Complete both clients' opening reveals.
- Make one legal move from Client A and confirm Client B sees the updated board, turn, discard pile, and log.
- Make one legal move from Client B and confirm Client A sees the same synchronized state.
- Refresh one client and rejoin with the same room; confirm room persistence and reconnect handling keep the game state available.

## Restart Guidance

A `skyjo-online.service` restart is needed when the running Node process must load new code or configuration:

- `server.mjs`, `server-room-persistence.mjs`, or server validation code changes.
- Shared game-engine changes that affect `server-dist/` validation used by the Node process.
- Runtime dependency changes or `package-lock.json` changes that affect production install output.
- Environment variable changes in `/etc/skyjo-online.env` or the service unit.
- The service is unhealthy after deployment and normal health checks do not recover.

A service restart is usually not needed for:

- Documentation-only changes.
- Project plan or README updates.
- Client-only static bundle changes when the existing Node process keeps serving the same `dist` path and the deploy replaces files atomically.
- Local-only script changes that are not deployed to the VPS.
- Reverse proxy or gateway-only changes, unless that component's own procedure requires a reload.

When a restart is needed, use the normal systemd procedure after the local release checks pass and the new files are deployed:

```sh
sudo systemctl restart skyjo-online.service
sudo systemctl status skyjo-online.service --no-pager
curl -fsS http://127.0.0.1:4180/healthz
curl -fsS https://skyjo.groundworkrevops.com/healthz
```

## Server-Side Changes And Room Persistence

Room state persists to `SKYJO_ROOMS_FILE` when set, or `.data/rooms.json` by default. Treat this file as release state, not a disposable build artifact.

- Before server-side room, validation, or persistence changes, identify the active rooms file used by the service environment.
- Preserve the rooms file and its parent directory across deploys; do not delete `.data/rooms.json` as part of cleanup.
- Back up the rooms file before deploying persistence format changes.
- On graceful shutdown, the server marks players disconnected and flushes rooms before exiting. After restart, restored rooms have empty socket clients and players appear offline until their browsers reconnect.
- Rooms older than the stale-room window are pruned on load or later cleanup, so check `updatedAt` before assuming a missing room indicates a deploy failure.
- After any server-side change, include the multiplayer two-client smoke and a refresh/rejoin check so persisted room state, WebSocket reconnect, and move validation are all exercised.
