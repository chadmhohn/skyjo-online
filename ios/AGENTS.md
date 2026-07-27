# Native iOS Scoped Agent Guide

These instructions apply to every file under `ios/`.

Before making changes, read the root `AGENTS.md` and every file in `docs/native-ios/`. The current execution order is tracked by milestone `Skyjo Native iOS v0.1.0` and program issue #179.

## Architecture Boundaries

- Build a true SwiftUI iPhone/iPad app targeting iOS/iPadOS 18 or later. Do not embed the PWA as the production app.
- Keep the Node server authoritative for multiplayer, randomness, revisions, redaction, rooms, shared stats, and accounts.
- Port only the offline solo rules/AI and prove them against the shared TypeScript/Swift fixture corpus.
- Use Swift 6 strict concurrency. UI models are `@MainActor`; networking, persistence, and long-lived mutable services are actor-isolated.
- Use SwiftData versioned records with Codable payload envelopes for solo/outbox persistence. Do not enable CloudKit in v0.1.0.
- Prefer Apple frameworks and Swift Package Manager. An architectural dependency requires an ADR and privacy/license review.

## Required Hygiene

- Commit the Xcode project, shared schemes, test plans, configuration templates, fixtures, and scripts.
- Never commit local xcconfig values, `xcuserdata`, DerivedData, result bundles, signing material, Apple/API/APNs keys, credentials, cookies, device tokens, production room/database state, or raw private frames.
- Hidden card values remain optional. Never substitute a sentinel value or expose hidden/deck/drawn data in logs, accessibility output, notifications, screenshots, persistence, or test artifacts.
- Do not optimistically mutate multiplayer state. Render server snapshots and allow only one idempotent command in flight.
- Every behavior change includes Swift tests and, when it affects shared contracts, TypeScript/PWA compatibility tests.
- Use available iPhone/iPad simulators rather than assuming a device name. APNs, real background/lock, haptics, universal-link CDN behavior, and final accessibility require a physical-device gate.

## Standard Check

Issue #181 must establish one stable command for an unsigned simulator build/test through `xcodebuild`. Later changes use that command and the committed `SkyjoCI.xctestplan`; do not rely on a personal Xcode Run configuration.
