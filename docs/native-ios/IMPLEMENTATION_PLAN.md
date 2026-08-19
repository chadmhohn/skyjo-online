# Native iOS v0.1.0 Implementation Plan

The target milestone is `Skyjo Native iOS v0.1.0`. Its release outcome is an independently buildable SwiftUI app distributed through internal TestFlight and, after issue #193 confirms distributable branding/content, external TestFlight. The existing PWA remains working. Public App Store submission has additional gates in `PRODUCT.md`.

Each issue gets one branch owner, a focused PR, acceptance checkboxes, test evidence, screenshots where UI changes, compatibility notes, rollout notes, and rollback notes. The author does not perform final review. A second agent reviews the final SHA, and CI is merge authority. Never place production credentials or Apple signing material in an issue, log, artifact, or PR.

GitHub sub-issues and issue dependencies are the machine-readable schedule; prose diagrams are explanatory. An unclaimed issue is workable only when GitHub reports no open blockers and it has `agent-ready`. Claim it by assigning yourself, adding `in-progress`, removing `agent-ready`, and commenting the branch `agent/issue-<number>-<slug>`. Every PR body includes `Closes #<number>`. The repository workflow reconciles `blocked`/`agent-ready` labels when dependencies close or reopen.

## Dependency Order

```text
IOS-1 bootstrap
  -> IOS-2 contracts and native access
       -> IOS-3 Swift rules/AI ---------> IOS-4 solo durability -> IOS-7 solo UI --\
       -> IOS-5 HTTP/account/stats ------> IOS-6 realtime -------> IOS-8 rooms -----+-> IOS-10 polish -> IOS-11 TestFlight
                                                    \------------> IOS-9 APNs ------/
```

IOS-3 and IOS-5 may run in parallel after IOS-2. IOS-4 and IOS-6 may then run in parallel. Server protocol, invite, and APNs changes remain serialized where they touch shared persistence or notification triggers.

Human gate [#193](https://github.com/chadmhohn/skyjo-online/issues/193) must close before IOS-11 uploads an external TestFlight build. Public App Store account deletion is separately tracked in [#192](https://github.com/chadmhohn/skyjo-online/issues/192) and does not block internal/external TestFlight unless Apple changes its requirements.

## [IOS-0 — Commit The Portable Native Handoff](https://github.com/chadmhohn/skyjo-online/issues/180)

This documentation change.

Acceptance:

- A new Mac worker has a repo-only start path, architecture, product scope, contract map, setup steps, test/release gates, manifest, and preflight.
- Root `AGENTS.md` no longer requires machine-local Nova/OpenClaw memory.
- The current PWA release/protocol baseline is verified and recorded.
- A GitHub milestone, program issue, and dependency-ordered child issues point back to these docs.

## [IOS-1 — Bootstrap The SwiftUI App And macOS CI](https://github.com/chadmhohn/skyjo-online/issues/181)

Create the committed `ios/` structure from `ARCHITECTURE.md`.

Acceptance:

- Universal iPhone/iPad SwiftUI app, deployment target iOS 18.0, Swift 6 strict concurrency.
- Checked-in Xcode project, shared scheme, `SkyjoCI.xctestplan`, `.xcconfig` chain, `Local.xcconfig.example`, assets placeholder, and privacy-manifest placeholder.
- Domain/network/persistence/design-system local packages compile with no circular dependency.
- Debug base URL is injected; Release is fixed to HTTPS production.
- Unsigned simulator build/test runs from one documented `xcodebuild` command on a clean clone.
- GitHub macOS jobs retain sanitized local `.xcresult` evidence and upload compact failure logs; no signing credentials are required.
- Root Node CI remains green.

## [IOS-2 — Publish Contracts, Golden-Fixture Harness, And Native Access API](https://github.com/chadmhohn/skyjo-online/issues/182)

Turn the current implementation map into executable compatibility assets.

Acceptance:

- Versioned JSON Schemas (or equivalently strict machine-readable specs) cover game state, protocol-v2 frames, account/stats DTOs, operational DTOs, and stable API errors.
- Sanitized fixtures cover every client/server frame type, hidden-card redaction, bounds, malformed payloads, stale/future revisions, exact replay, conflicting command IDs, and reset recovery.
- A deterministic fixture generator uses injected RNG/clock/UUID and refuses dirty unexpected output.
- TypeScript tests validate all fixtures against current producers/consumers.
- Additive JSON outer-access status/login/logout endpoints set/clear the established cookie and leave HTML `/login` behavior intact.
- Native URLSession contract tests prove cookie persistence and safe error decoding against a local Node server.
- Compatibility/versioning policy is documented.

IOS-2 repository verification commands are:

```sh
npm run contracts:fixtures:check
npm run test:unit:contracts
./scripts/ios-build-test.sh --networking-contracts
```

`contracts/v1` is an independent portable bundle version, not shorthand for the multiplayer protocol, snapshot envelope, database, persistence, release, or native app version. The access endpoint and stable API-error envelope must be promoted and verified through the immutable server-release workflow before a native build that depends on them is distributed; completing these repository checks does not claim production deployment.

## [IOS-3 — Port Rules, Scoring, AI, And Redaction Models To Swift](https://github.com/chadmhohn/skyjo-online/issues/183)

Implement `SkyjoDomain` without UI or I/O.

Acceptance:

- Deck counts, turn phases, opening flow, discard cancellation, blind draw, replacement, column clearing/discard order, final turns, scoring/doubling, next-round starter, and game threshold match fixtures.
- Easy/Medium/Hard/Ultra/Mixed AI and strategy version 1 match seeded decision fixtures; 1-7 bot rosters and themed-name rules match.
- Multiplayer wire models preserve hidden values as nil and cannot accidentally serialize hidden card data.
- Parameterized/property tests cover invariants and malformed snapshots.
- TypeScript and Swift fixture tests pass from one repo script.
- Domain target reaches at least 90% line coverage with all rule branches represented by named tests.

## [IOS-4 — Add Atomic Solo Saves And A Durable Stats Outbox](https://github.com/chadmhohn/skyjo-online/issues/184)

Implement the actor-owned SwiftData persistence contracts with versioned Codable payload envelopes.

Acceptance:

- Versioned owner-partitioned solo snapshots with stable game UUIDs.
- Explicit continue/new-game replacement flow; new write and prior deletion are one recoverable transaction.
- Account changes cannot expose or deliver another account's save/outbox.
- Completed signed-in games enter an idempotent outbox and retry with capped backoff; guest completion never queues server stats.
- Corruption, incompatible schema, low storage, write interruption, and stale-autosave conflicts are tested.
- Background/termination flush is best effort and never blocks a legal in-memory turn.
- No PWA IndexedDB-import claim is made.

Verification runs through `npm run test:domain:parity`, with independent 90% executable-line coverage floors for `SkyjoDomain` and `SkyjoPersistence`. Local envelopes allow 2 MiB for schema-bounded histories, while the current HTTP request boundary remains 256 KiB; IOS-7 must classify size, invalid-payload, and unsupported-version rejections as permanent outbox failures rather than retrying forever.

## [IOS-5 — Build Access, Account, Home, And Stats Foundations](https://github.com/chadmhohn/skyjo-online/issues/185)

Implement the typed HTTP client and first native navigation shell.

Acceptance:

- Access gate, signup/login/logout, profile, password change, current account, stats summary/list/detail, and session-expiry recovery.
- Dedicated cookie jar sends both session layers and is tested across app relaunch simulation.
- Passwords are never logged or stored; cookies are never exposed to UI.
- Stable server error codes map to accessible user messages with a safe unknown fallback.
- Loading, empty, offline, retry, disabled-account, and service-not-ready states are designed and tested.
- Admin remains web-only and is linked rather than reimplemented.
- Account-deletion dependency is visibly tracked for public App Store release.

## [IOS-6 — Implement The Protocol-v2 Realtime Client](https://github.com/chadmhohn/skyjo-online/issues/186)

Build the actor-owned WebSocket state machine before multiplayer UI.

Acceptance:

- Authenticated create/join/rejoin, personalized then shared snapshots, explicit presence, heartbeat compatibility, and seat recovery.
- Connection states and jittered 0.5/1/2/4/8/15/30-second backoff match the web contract.
- One in-flight command; exact replay; ack/snapshot convergence; stale/future resync; reset-room recovery; upgrade-required handling.
- No optimistic board mutation and no offline commands.
- Invalid or oversized server payloads fail closed without leaking frames.
- Local Node integration tests mix Swift clients with browser clients and cover disconnect, background, network loss, duplicate/stale commands, host transfer, AI takeover, and human reclaim.
- No hidden grid/deck/drawn value appears in non-viewer model state, logs, test attachments, or UI accessibility trees.

## [IOS-7 — Build The Native Solo Experience](https://github.com/chadmhohn/skyjo-online/issues/187)

Implement setup, game table, scoring, settings, audio, and restore on top of IOS-3/4.

Acceptance:

- Continue and New Game are unambiguous; replacement requires review and confirmation.
- Setup supports 1-7 bots and every fixed/Mixed difficulty with readable explanations.
- Stable table band keeps deck/discard/drawn card/actions from jumping.
- Phone gameplay does not scroll the entire screen; opponents and sheets have explicit scroll regions.
- Round/game summaries, minimization, settings, stats-save state, and corruption/quota recovery.
- Dynamic Type, VoiceOver actions/order, reduced motion, contrast, 44x44-point targets, landscape, safe areas, and iPad layouts pass.
- Sound assets have distribution provenance; music defaults off; haptics respect system/user settings.

## [IOS-8 — Build Multiplayer Rooms, Chat, And Universal Links](https://github.com/chadmhohn/skyjo-online/issues/188)

Implement native room UI and additive invite support.

Acceptance:

- Create/join/wait/start/play/ready/reset/leave/remove/AI-takeover flows render only authoritative state.
- Same board-first table layout supports web/native mixed rooms up to eight players.
- Chat is a compact overlay/sheet with unread state and cannot push the board off screen.
- Connection/pending/resync/offline states are visible within 500 ms and accessible.
- Server hosts a valid no-redirect `apple-app-site-association`; app has exact Associated Domains entitlement.
- Existing HTTPS invite opens the installed app or the existing web fallback; native redemption is token-safe and stale-room-aware.
- Invite URLs, tokens, room frames, and private values are absent from logs and analytics.
- Universal-link behavior is tested on a physical device because simulator/browser behavior is not final proof.

Backend sub-issue #202 lands before IOS-8 and owns only the additive AASA/native-redemption server contract, schemas, sanitized fixtures, deployment smoke, and rollout/rollback documentation. IOS-8 consumes that merged contract and still owns Swift URL routing, Associated Domains entitlement/signing, join review UI, Apple CDN verification, and installed/uninstalled physical-device proof.

Deterministic room UI evidence must remain repository-owned and `DEBUG`-only. Fixture states enter through the production realtime connection and strict frame codec, never by directly injecting authoritative snapshots into the room view model or weakening release transport validation.

## [IOS-9 — Add Native Turn Notifications Through APNs](https://github.com/chadmhohn/skyjo-online/issues/189)

Keep web push working while adding native device delivery.

Server sequencing is tracked separately by [rollback-envelope #203](https://github.com/chadmhohn/skyjo-online/issues/203) and [registry/provider #204](https://github.com/chadmhohn/skyjo-online/issues/204). #203 must merge, receive an explicitly approved immutable production promotion, and become the verified `previous` rollback anchor before #204 creates the already-frozen physical table. Both releases retain public database schema 2. After table creation, never roll back to code older than the envelope release.

Acceptance:

- Additive SQLite migration and authenticated device registration/unregistration contract with installation ID, environment, token rotation, multi-device support, and invalid-token cleanup.
- APNs provider authentication secrets remain server-only under `/etc/skyjo-online.env` or an approved secret store.
- Existing turn-trigger semantics fan out independently to Web Push and APNs without duplicate alerts to an active visible client.
- Notification payload contains only minimal routing data and no card values, room state, chat, account email, or invite token.
- Permission-denied, token failure, logout/account switch, reinstall/rotation, background tap, and stale-room cases are tested.
- Real locked/background iPhone delivery passes; simulator-only notification injection is not accepted as production proof.

## [IOS-10 — Complete Accessibility, Performance, Security, And Release Polish](https://github.com/chadmhohn/skyjo-online/issues/190)

Acceptance:

- `XCUIApplication.performAccessibilityAudit()` has no serious blockers on primary flows; manual VoiceOver and Switch Control paths complete a turn.
- Dynamic Type through accessibility sizes, Bold Text, Differentiate Without Color, Increase Contrast, Reduce Motion, rotation, and iPad multitasking are handled.
- Eight-player room remains responsive; opening animation <=3 seconds and <=1 second with reduced motion.
- Instruments shows no retain cycle in room reconnect, no runaway task/socket, and bounded memory during a 10-minute eight-player test.
- Cold launch, reconnect, and interaction performance budgets are recorded in XCTMetrics.
- Privacy manifest/reasons, data inventory, logging redaction, dependency/SBOM review, and App Store privacy-answer draft are complete.
- Account deletion implementation and policy are complete before this issue can authorize public App Store submission; TestFlight may proceed while it is separately tracked.
- Three independent agent personas and one consolidated physical iPhone/iPad session pass.

## [IOS-11 — Certify And Distribute Native iOS v0.1.0](https://github.com/chadmhohn/skyjo-online/issues/191)

Acceptance:

- Every prior issue is merged and every required web/native CI check is green.
- Compatibility matrix records native 0.1.0 against backend protocol/schema/release minimums.
- Clean Release archive is built with an App-Store-supported stable Xcode/SDK and contains no debug URL, secret, test account, or development entitlement.
- Backup/rollback exists for any accompanying server migration; PWA post-deploy smoke remains green.
- Internal TestFlight, then external TestFlight, passes install, launch, invite, account, solo restore, mixed-client multiplayer, APNs, accessibility, and update testing.
- Branding and asset-rights issue #193 is closed before external TestFlight upload.
- Create immutable tag `ios-v0.1.0` and a GitHub Release containing test evidence and compatibility notes, never the signed IPA or credentials unless an explicit secure distribution policy is adopted.
- App Store submission remains a separately recorded go/no-go based on final name/artwork/rights, metadata, privacy/support URLs, review account, and owner acceptance.

## Worker Scheduling Rules

- At most three implementation workers plus the orchestrator.
- One branch owner per issue; do not edit another active owner's files without coordination.
- Claim with assignee plus `in-progress`, publish the branch name in an issue comment, and use `Closes #N` in the PR.
- IOS-3/IOS-5 and IOS-4/IOS-6 are the intended parallel waves.
- A server contract change merges before the dependent native consumer.
- Failed CI or review returns to the same issue owner until green.
- Stop for user input only when Apple credentials/2FA or agreements are required, a provider is unavailable, a destructive production-data recovery needs a backup choice, or issue #193 needs the external-beta branding/rights decision.
