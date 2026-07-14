# Changelog

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
