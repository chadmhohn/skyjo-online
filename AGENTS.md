# Skyjo Online Agent Guide

This repository is the source for the private Skyjo-style web app at `https://skyjo.groundworkrevops.com/`. Treat this file as the first stop for Codex/Nova/Hermes handoff work.

Last reviewed by Codex: 2026-07-27 America/Denver, against the live v0.3.2 release and the portable native-iOS handoff. Re-check live release identity before claiming deployment status.

## Current Operating State

- GitHub repo: `chadmhohn/skyjo-online`.
- Immutable release root: `/srv/skyjo-online` on `hostinger-vps`; `current` and `previous` select release directories.
- Production service: `skyjo-online.service`, working directory `/srv/skyjo-online/current`.
- Service env file: `/etc/skyjo-online.env`. Do not print or commit secret values from this file.
- Signed room invites use `SKYJO_INVITE_SECRET`, `SKYJO_INVITE_TTL_HOURS`, and optional `SKYJO_INVITE_CODE_TTL_MINUTES`. Invites only bypass the shared site-password gate; multiplayer still requires account login and room membership rules.
- Room persistence file: `/var/lib/skyjo-online/rooms.json`, via `SKYJO_ROOMS_FILE`.
- Account and game-history database: `/var/lib/skyjo-online/skyjo.sqlite`, via `SKYJO_DB_FILE`.
- Initial admin bootstrap: `SKYJO_ADMIN_EMAIL=chad.hohn@groundworkrevops.com` plus `SKYJO_ADMIN_INITIAL_PASSWORD` for first setup. Treat that password as temporary.
- App bind address: `127.0.0.1:4180`.
- Public hostname: `skyjo.groundworkrevops.com`.
- Cloudflare zone: `groundworkrevops.com`.
- Cloudflare DNS: `skyjo.groundworkrevops.com` is a proxied CNAME to tunnel `29eaa972-bcb7-4031-bfa3-950a9708197a.cfargotunnel.com`.
- Cloudflare Tunnel: `groundwork-nova`, id `29eaa972-bcb7-4031-bfa3-950a9708197a`, remote config enabled. The active Cloudflare-side ingress routes `skyjo.groundworkrevops.com` to `http://localhost:4180`.
- Local `/etc/cloudflared/config.yml` may not show Skyjo because this tunnel uses Cloudflare remote config. Verify with the Cloudflare API before editing tunnel routes.

The 2026-05-20 decoupling pass moved Skyjo out of the OpenClaw-owned workspace so OpenClaw can later move into Docker without taking Skyjo with it. Backup for that cutover lives at `/root/backups/skyjo-online-decouple-20260521T025019Z`.

Production served immutable v0.3.2 at `130114e745c66c9f72305f05a0366e3f0ca10915` when this guide was reviewed. Treat that only as a dated observation: re-read `/version` and `/readyz` before any promotion or compatibility claim. Start every repository session with `git status --short --branch` and inspect the diff before making changes.

## Native iOS Work

The repository-owned native handoff starts at [`docs/native-ios/README.md`](docs/native-ios/README.md). A fresh Mac/Codex worker must read that directory completely and run `./scripts/ios-preflight.sh` before taking the first unblocked `Skyjo Native iOS v0.1.0` issue.

- The intended product is a true SwiftUI iPhone/iPad app, not a `WKWebView` or Capacitor wrapper.
- The existing Node server remains authoritative for multiplayer and shared/account state.
- The solo rules and AI are ported to Swift behind cross-language deterministic fixtures.
- Native implementation belongs under `ios/`; project files, shared schemes, test plans, sample configuration, and fixtures are committed.
- Apple credentials, signing assets, device tokens, local team configuration, and App Store Connect keys never enter git.
- No project requirement may depend on Nova/OpenClaw memory or another computer's local files. Move durable decisions into this repository.

## Architecture Map

- `src/game.ts`: shared Skyjo game engine for single-player and multiplayer. Owns deck composition, opening reveal rules, turn progression, scoring, final-turn flow, column clears, and AI decisions.
- `src/types.ts`: shared client/server state types.
- `src/serverValidation.ts`: server-side legal multiplayer state validation. This compiles to `server-dist/` and is loaded by the Node server.
- `server.mjs`: production Node server. Handles password-gated HTTP, invite install/browser handoff, static `dist/` serving, public `/healthz`, `/readyz`, and `/version`, WebSocket rooms at `/rooms`, room chat, host controls, room reset, and verified persistence flush on shutdown.
- `server-account-store.mjs`: SQLite account/session/game-history store using `node:sqlite`. Owns password hashing, admin bootstrap, account sessions, saved game records, stats visibility, and admin user operations.
- `server-room-persistence.mjs`: versioned JSON persistence for rooms with strict legacy readers and durable atomic v2 writes. Production uses `/var/lib/skyjo-online/rooms.json` through `SKYJO_ROOMS_FILE`; local/dev defaults to `.data/rooms.json`.
- `server-release.mjs` and `server-readiness.mjs`: checksum-validated build identity and sanitized public readiness/version contracts. The current baseline is schema 2 and protocol 2.
- `server-state-backup.mjs`: online SQLite backup, fixed-file checksum manifest verification, and fresh isolated restore safeguards.
- `src/App.tsx`: React routes and UI for home, single-player, lobby, room play, table chat, rules, scoring, and responsive gameplay shells.
- `src/account.tsx`: account context and client API helpers for login/signup/logout, stats, single-player save, and admin actions.
- `src/audio.ts`: client-only Web Audio settings and generated cues. Sound effects are on by default, background music is off by default, and settings persist in browser `localStorage`.
- `src/index.css`: most layout and visual behavior, including the mobile locked play surface and desktop/tablet responsive rules.
- `scripts/smoke-*.mjs`: focused release smoke tests for validation, AI, persistence, and room/chat flows.
- `deploy/` and `docs/atomic-vps-releases.md`: checksum-pinned Node 24 bootstrap, forced-command upload identity, hardened systemd units, isolated canary, atomic release controller, and code-only rollback contract.
- `docs/deployment-smoke-checklist.md`: operational release and smoke checklist.

## Safety Rules

- The GitHub repo is public. Never commit `.env`, `/etc/skyjo-online.env`, cookies, passwords, session secrets, tunnel tokens, room dumps with private content, or OpenClaw secrets.
- Treat `/var/lib/skyjo-online/rooms.json` and `/var/lib/skyjo-online/skyjo.sqlite` as runtime state, not disposable build artifacts. Back them up before persistence format changes.
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

`npm run smoke:release` includes `git diff --check`, lint, build, high-severity audit, validation smoke, AI smoke, persistence smoke, account/store smoke, operational readiness/recovery smoke, backup/restore smoke, controller transition tests, and the delivery contract smoke.

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
curl -fsS http://127.0.0.1:4180/readyz
curl -fsS http://127.0.0.1:4180/version
```

Public checks:

```sh
curl -fsS https://skyjo.groundworkrevops.com/healthz
curl -fsS https://skyjo.groundworkrevops.com/readyz
curl -fsS https://skyjo.groundworkrevops.com/version
curl -sS -D - https://skyjo.groundworkrevops.com/login -o /dev/null
```

Restart is normally needed for:

- `server.mjs` changes.
- `server-account-store.mjs` or account/session/game-history API changes.
- `server-room-persistence.mjs` changes.
- `src/serverValidation.ts`, `src/game.ts`, or compiled `server-dist/` changes that the Node server must load.
- Dependency, lockfile, service unit, or `/etc/skyjo-online.env` changes.

Restart is normally not needed for documentation-only work or client-only static bundle changes when the running Node process can keep serving the updated `dist/` files.

Once the immutable service cutover is active, do not deploy with `git pull`, an in-place build, `npm install`, or a manual service restart. Merge through the required CI checks; `main` exercises the exact attested artifact on the isolated canary, and only an immutable `vX.Y.Z` tag may promote it. Follow [docs/immutable-deployment.md](docs/immutable-deployment.md).

The legacy restart sequence below is valid only before the one-time immutable cutover or as an explicitly selected legacy recovery procedure:

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
- Per the Magilano rules, every round starts with each player revealing two cards. Highest visible opening sum starts round one only; later rounds start with the previous closer.
- Taking the discard pile is reversible until the player actually replaces a board card. Drawing blind is committed because the drawn card is revealed to that player.
- Round end begins when a player reveals their last card; every other player gets one final turn.
- If the closer does not have the strictly lowest round score and their score is positive, the closer's round score doubles.
- Matching revealed columns clear and score zero. Replacement-driven column clears should put the cleared column on top of the replaced card in the discard pile.
- Single-player supports 1-7 AI opponents with shuffled themed names and Easy, Medium, Hard, Ultra Hard, or deterministic Mixed profiles. New players default to Medium; v0.2.2 saves normalize to Hard without rewriting their v1 record. New game reshuffles names; next round preserves identities, Mixed assignments, and scoring continuity.
- Opening solo setup creates no game or durable record. Replacing an active save requires explicit review and confirmation, and a failed replacement must leave the prior game intact.
- The shared site password remains the outer gate. Single-player is playable without an account, but guest solo games do not save stats. Multiplayer requires a signed-in account, and room seats are tied to account user IDs.
- Account stats start from the account release forward. Do not attempt historical backfill from `rooms.json` unless Chad explicitly asks for a separate import pass.
- Mobile phone layout is intentionally board-first/locked: opponents scroll above, local board and table controls stay anchored. Be careful not to regress this when changing tablet/desktop layouts.
- Tablet landscape intentionally borrows the compact phone header: Rules, Log, and AI opponents stay as small disclosure buttons; the local "You" board is scaled down and bottom-anchored so opponent boards remain visible above it. Opponent boards should not exceed 4 columns in tablet landscape or 3 columns in tablet portrait.
- Multiplayer rooms are friend-facing and password gated. Shared room links should land on the install/browser choice page, and browser/install-code continuation should prefill join without reusing a stale saved player identity for another room.
- The long invite link is reusable for group threads. Each invite page load mints a fresh one-time Home Screen install code, so several recipients can use the same shared link without racing over one copied code.

## Repository Handoff Notes

Recent Nova work centered on mobile-first then desktop/tablet polish:

- Mobile-first gameplay, final-lap warnings, compact panels, board-first layout, locked mobile local board, scrollable opponents, drawer indicators, chat/header polish, scoring modal polish.
- Multiplayer hardening: ready-gated next round, minimizable scoring so completed boards remain visible, resume/rejoin behavior, correct column-clear discard order, smaller chat bubble, and persistent shareable waiting rooms.
- Latest WIP before this guide: multiplayer reset creates a new room code; shared links avoid stale local identity; wider screens were being tuned to keep opponents visible/scrollable and the local board/table anchored near the bottom while preserving phone behavior.

The notes above are historical orientation, not an external dependency. When in doubt, use current executable tests, the source paths in the architecture map, GitHub issues/PRs, and repository documentation. Update this guide when a durable decision changes.
