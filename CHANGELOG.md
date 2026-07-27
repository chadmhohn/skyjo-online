# Changelog

## 0.3.1 - 2026-07-26

- Corrected the credentialless production PWA gate so it permits only Cloudflare's exact same-origin `POST /cdn-cgi/rum` analytics request while continuing to reject every application, off-origin, malformed, or lookalike mutation.
- Preserved the cookie, cache allowlist, offline cold-launch, and exact solo-restore release assertions; no application runtime, dependency, schema, protocol, or deployment behavior changed.

## 0.3.0 - 2026-07-26

- Reworked Home and the solo launcher so Continue, New Solo Game, and Multiplayer are distinct, saved-game metadata is visible, and merely opening setup never creates or replaces a game.
- Added an accessible 1-7 opponent setup flow with Easy, Medium, Hard, Ultra Hard, and deterministic Mixed AI profiles while preserving v0.2.2 saves as exact Hard games.
- Made solo replacement explicit, atomic, and reversible; active settings are read-only until the player chooses to set up another game, and game-over replay keeps same-setup and change-setup paths distinct.
- Added exact-SHA AI calibration evidence, setup/replacement accessibility and WebKit rollback coverage, an expiring exact advisory gate, and a credentialless production PWA offline/restore smoke.

## 0.2.2 - 2026-07-24

- Kept the existing card-flip cue while replacing the delayed pickup and place files with short, responsive table sounds.
- Removed the continuous ambience loop and added restrained, exact-once cues for local turns, cleared columns, and round or game completion.
- Added safe audio-setting migration, offline cue precaching, asset-budget validation, and deterministic audio controller coverage.

## 0.2.1 - 2026-07-24

- Patched the post-certification `brace-expansion` and `fast-uri` high-severity advisories without changing application runtime dependencies or the accepted PWA layout.
- Patched the PostCSS previous-source-map traversal and dev-only node-tar recursion advisories, and rejected protected-main SHA `100ff9ccace46be43a296dc25b40e9a21282022f` before tagging or deployment.
- Carried the complete v0.2.0 feature set into an immutable successor after the v0.2.0 tag failed closed before artifact creation, canary, deployment, or GitHub Release publication.
- Documented the remaining moderate React Router client-routing exposure and its release exception, which expires on 2026-08-21.

## 0.2.0 - 2026-07-13

- Replaced whole-state multiplayer writes with revisioned, idempotent, server-authoritative commands and player-specific redacted snapshots.
- Added deterministic reconnect, same-seat recovery, host transfer, disconnected-seat AI takeover, and later human reclaim behavior.
- Added durable solo sessions, an account-partitioned statistics outbox, persistent invite install codes, offline solo launch, and safe update handoff.
- Centered the deck, discard pile, and action guidance between opponents and the local board across phone, tablet, and desktop layouts.
- Completed keyboard, VoiceOver-oriented semantics, modal focus, 200% text, reduced-motion, touch-target, and large-roster interaction polish.
- Added exact-topology realtime load with process-stage RSS evidence, mutation-age-accurate SIGKILL persistence recovery traces, eight-client persona, nightly certification, and immutable release-evidence gates.

## 0.1.1 - 2026-07-12

- Standardized the runtime on Node.js 24 and patched dependency and CodeQL security findings.
- Added deterministic unit, browser, accessibility, visual, and performance test coverage.
- Added release identity, readiness checks, additive migrations, and verified backup and restore workflows.
- Added immutable artifacts, atomic VPS delivery, canary verification, and automatic code rollback.
- Added repository governance, dependency and code scanning, readiness monitoring, and incident automation.
