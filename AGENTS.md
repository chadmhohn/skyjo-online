# Skyjo Online Agent Guide

This repository is the source for the private Skyjo-style web app at `https://skyjo.groundworkrevops.com/`. Treat this file as the first stop for Codex/Nova/Hermes handoff work.

Last verified by Codex: 2026-05-20 America/Denver, after the Skyjo host-path decoupling pass.

## Current Operating State

- GitHub repo: `chadmhohn/skyjo-online`.
- Canonical live VPS checkout: `/srv/skyjo-online` on `hostinger-vps`.
- Compatibility symlink: `/root/.openclaw/workspace/skyjo-online -> /srv/skyjo-online`.
- Production service: `skyjo-online.service`, working directory `/srv/skyjo-online`.
- Service env file: `/etc/skyjo-online.env`. Do not print or commit secret values from this file.
- Room persistence file: `/var/lib/skyjo-online/rooms.json`, via `SKYJO_ROOMS_FILE`.
- App bind address: `127.0.0.1:4180`.
- Public hostname: `skyjo.groundworkrevops.com`.
- Cloudflare zone: `groundworkrevops.com`.
- Cloudflare DNS: `skyjo.groundworkrevops.com` is a proxied CNAME to tunnel `29eaa972-bcb7-4031-bfa3-950a9708197a.cfargotunnel.com`.
- Cloudflare Tunnel: `groundwork-nova`, id `29eaa972-bcb7-4031-bfa3-950a9708197a`, remote config enabled. The active Cloudflare-side ingress routes `skyjo.groundworkrevops.com` to `http://localhost:4180`.
- Local `/etc/cloudflared/config.yml` may not show Skyjo because this tunnel uses Cloudflare remote config. Verify with the Cloudflare API before editing tunnel routes.

The 2026-05-20 decoupling pass moved Skyjo out of the OpenClaw-owned workspace so OpenClaw can later move into Docker without taking Skyjo with it. Backup for that cutover lives at `/root/backups/skyjo-online-decouple-20260521T025019Z`.

As of the verification above, the VPS checkout had local uncommitted work from the most recent Nova pass:

- `server.mjs`: host reset creates a fresh room code and notifies old guests.
- `scripts/smoke-chat.mjs`: coverage for reset/share-room behavior.
- `src/App.tsx` and `src/index.css`: desktop/tablet responsive play-surface polish while keeping the phone layout intact.

Do not revert or overwrite those files blindly. Start every session with `git status --short --branch` and inspect the diff before making changes.

## Architecture Map

- `src/game.ts`: shared Skyjo game engine for single-player and multiplayer. Owns deck composition, opening reveal rules, turn progression, scoring, final-turn flow, column clears, and AI decisions.
- `src/types.ts`: shared client/server state types.
- `src/serverValidation.ts`: server-side legal multiplayer state validation. This compiles to `server-dist/` and is loaded by the Node server.
- `server.mjs`: production Node server. Handles password-gated HTTP, static `dist/` serving, `/healthz`, WebSocket rooms at `/rooms`, room chat, host controls, room reset, and persistence flush on shutdown.
- `server-room-persistence.mjs`: JSON persistence for rooms. Production uses `/var/lib/skyjo-online/rooms.json` through `SKYJO_ROOMS_FILE`; local/dev defaults to `.data/rooms.json`.
- `src/App.tsx`: React routes and UI for home, single-player, lobby, room play, table chat, rules, scoring, and responsive gameplay shells.
- `src/index.css`: most layout and visual behavior, including the mobile locked play surface and desktop/tablet responsive rules.
- `scripts/smoke-*.mjs`: focused release smoke tests for validation, AI, persistence, and room/chat flows.
- `docs/deployment-smoke-checklist.md`: operational release and smoke checklist.

## Safety Rules

- The GitHub repo is public. Never commit `.env`, `/etc/skyjo-online.env`, cookies, passwords, session secrets, tunnel tokens, room dumps with private content, or OpenClaw secrets.
- Treat `/var/lib/skyjo-online/rooms.json` as runtime state, not a disposable build artifact. Back it up before persistence format changes.
- Do not restart `skyjo-online.service`, Cloudflare Tunnel, Traefik, OpenClaw, Docker, or the VPS unless Chad explicitly approved that disruptive action in the current conversation.
- Preserve unrelated dirty work. If the dirty files overlap your task, read the diff and build on it; do not reset it away.
- Do not rely on `curl -I -L /` as a login smoke. `HEAD /login` can redirect again because the server login handler is GET-specific. Use GET checks or `/healthz`.

## Standard Workflow

```sh
cd /srv/skyjo-online
git status --short --branch
git log --oneline --decorate -8
```

For code changes, make the smallest scoped patch and run the relevant checks. For almost all app changes, run:

```sh
npm run smoke:release
npm run smoke:chat
```

`npm run smoke:release` includes `git diff --check`, lint, build, high-severity audit, validation smoke, AI smoke, and persistence smoke. A known moderate `ws` advisory may print during audit; the high-severity gate should still pass unless the dependency state changes.

For layout changes, also perform visual QA at minimum widths around:

- `390x844` for phone.
- `820x1180` for tablet portrait.
- `1180x820` for tablet landscape.
- `1440x900` for desktop.

Use the browser/Playwright path when available, and verify text/buttons do not overlap, mobile remains locked as intended, and opponent/table/local-board regions scroll only where expected.

## Deployment Checks

Local service checks:

```sh
sudo systemctl status skyjo-online.service --no-pager
curl -fsS http://127.0.0.1:4180/healthz
```

Public checks:

```sh
curl -fsS https://skyjo.groundworkrevops.com/healthz
curl -sS -D - https://skyjo.groundworkrevops.com/login -o /dev/null
```

Restart is normally needed for:

- `server.mjs` changes.
- `server-room-persistence.mjs` changes.
- `src/serverValidation.ts`, `src/game.ts`, or compiled `server-dist/` changes that the Node server must load.
- Dependency, lockfile, service unit, or `/etc/skyjo-online.env` changes.

Restart is normally not needed for documentation-only work or client-only static bundle changes when the running Node process can keep serving the updated `dist/` files.

Approved restart sequence:

```sh
npm run smoke:release
npm run smoke:chat
sudo systemctl restart skyjo-online.service
sudo systemctl status skyjo-online.service --no-pager
curl -fsS http://127.0.0.1:4180/healthz
curl -fsS https://skyjo.groundworkrevops.com/healthz
```

## Product Rules And UX Notes

- Each player has a 3x4 grid and manually reveals two opening cards.
- Highest visible opening sum starts round one only; later rounds start with the previous closer.
- Round end begins when a player reveals their last card; every other player gets one final turn.
- If the closer does not have the strictly lowest round score and their score is positive, the closer's round score doubles.
- Matching revealed columns clear and score zero. Replacement-driven column clears should put the cleared column on top of the replaced card in the discard pile.
- Single-player supports 1-7 AI opponents with shuffled themed names. New game reshuffles names; next round preserves identities for scoring continuity.
- Mobile phone layout is intentionally board-first/locked: opponents scroll above, local board and table controls stay anchored. Be careful not to regress this when changing tablet/desktop layouts.
- Multiplayer rooms are friend-facing and password gated. Shared room links should prefill join without reusing a stale saved player identity for another room.

## Useful Nova Memory Summary

Recent Nova work centered on mobile-first then desktop/tablet polish:

- Mobile-first gameplay, final-lap warnings, compact panels, board-first layout, locked mobile local board, scrollable opponents, drawer indicators, chat/header polish, scoring modal polish.
- Multiplayer hardening: ready-gated next round, minimizable scoring so completed boards remain visible, resume/rejoin behavior, correct column-clear discard order, smaller chat bubble, and persistent shareable waiting rooms.
- Latest WIP before this guide: multiplayer reset creates a new room code; shared links avoid stale local identity; wider screens were being tuned to keep opponents visible/scrollable and the local board/table anchored near the bottom while preserving phone behavior.

When in doubt, check `/root/.openclaw/workspace/memory/channels/skyjo.md` for the detailed project-memory trail before relying on chat memory alone.
