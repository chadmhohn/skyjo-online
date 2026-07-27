# Native Product Definition And Parity

## Product Goal

Create a polished, board-first iPhone and iPad app that feels native while joining the same accounts and live rooms as the PWA. The app should preserve the tabletop mental model already established in v0.3.x: opponents above, one stable deck/discard/action band in the middle, and the local player's board below.

The native client is a companion to the PWA, not a replacement deployment. Players on web and native must be able to share one room without knowing which client anyone else uses.

## v0.1.0 Scope

| Capability | Native v0.1.0 behavior | Source of truth |
| --- | --- | --- |
| Outer access gate | Enter the shared access password or redeem a room invite; retain the signed server session cookie | `server.mjs` plus the planned native JSON access endpoint |
| Accounts | Sign up, sign in/out, edit display name, change password | `src/account.tsx`, `server.mjs`, `server-account-store.mjs` |
| Solo setup | Continue an existing game or explicitly replace it; choose 1-7 bots and Easy, Medium, Hard, Ultra Hard, or deterministic Mixed | `src/App.tsx`, `src/SoloSetupFlow.tsx`, `src/SoloGamePrompt.tsx`, `src/soloAiSetup.ts` |
| Solo play | Full rules, scoring, round continuity, bot identities/difficulties, offline play, atomic restore, and stats outbox | `src/game.ts`, `src/aiStrategy.ts`, `src/soloDurability.ts` |
| Multiplayer | Create/join rooms, reconnect to the same seat, opening reveal, turns, ready flow, leave/remove, reset, AI takeover, and mixed web/native play | protocol-v2 files listed in `BACKEND_CONTRACTS.md` |
| Invites | Share one HTTPS invite URL; open the installed app through a universal link or fall back to the existing web landing | `server-room-invites.mjs`, planned native invite redemption |
| Room chat | Compact unread affordance and native sheet/popover; never displace the core board | `RoomChat` behavior in `src/App.tsx` and protocol command `send-chat-message` |
| Stats | Summary, recent games, individual game detail, and co-player history for signed-in users | `src/account.tsx` and account API |
| Notifications | Native turn alerts through APNs, with permission and per-device controls | planned APNs server support; existing VAPID web push is not reusable |
| Settings | Sound effects, music, haptics, reduced-motion respect, account, and diagnostics | PWA behavior plus native platform conventions |
| Accessibility | VoiceOver, Dynamic Type through accessibility sizes, Switch Control/keyboard where applicable, sufficient contrast, and reduce motion | Apple accessibility APIs and the existing product intent |

## Intentional v0.1.0 Exclusions

- No `WKWebView` fallback UI.
- No watchOS, tvOS, visionOS, widgets, Live Activities, or Mac Catalyst target.
- No local multiplayer peer-to-peer mode.
- No Game Center, in-app purchases, ads, analytics SDK, or third-party authentication.
- No native admin console. Account administration remains available in the PWA.
- No migration of a PWA IndexedDB solo save into the native container. Web and native saves are independent in v0.1.0; completed signed-in stats still converge on the server.
- No external TestFlight or public App Store submission until naming, artwork, bot names, and intellectual-property rights are confirmed. Simulator, registered-device, and internal TestFlight testing may proceed under a working title.

## Interaction Principles

- The active turn and next legal action are always visible without opening a menu.
- Drawing, placing, discarding, and revealing never cause the table band to jump.
- On phones, normal gameplay must fit the safe-area viewport without scrolling the entire screen. Only the opponent region and explicit sheets may scroll.
- The drawn card belongs in the center action band and remains visible until the move commits.
- Chat is an overlay affordance, not a block below the local board.
- Destructive or replacing actions say what will be lost and require confirmation. Starting a new solo game must never silently overwrite the recoverable game.
- Server rejection or resynchronization explains what happened, preserves the authoritative board, and never guesses at a move locally.
- Native components should feel at home on Apple platforms, but the card colors, information hierarchy, and board geometry should remain recognizable to PWA players.

## Native Layout Baseline

- `NavigationStack` owns app-level destinations.
- The game screen uses a stable root geometry with safe-area insets.
- Opponents occupy the flexible top region using a horizontal/vertical adaptive collection.
- The center table band has a stable measured height and contains chat, deck, discard, drawn card, and contextual actions.
- The local board is bottom-anchored and gets priority over decorative chrome.
- iPad uses the extra width for opponent boards and optional persistent side panels; it does not merely stretch the phone layout.
- Sheets are used for setup, score details, rules/log, chat, account, and settings. Alert dialogs are reserved for short confirmations.

## Rules And AI Parity

Native code must match these repository contracts rather than a remembered version of Skyjo:

- 3 rows by 4 columns; 150-card deck with counts from `src/gameRules.ts`; game threshold 100.
- Two manual opening reveals per player. Highest visible opening sum starts game round one; the previous closer starts later rounds.
- Taking discard can be canceled before replacement. A blind draw is committed once revealed to the current player.
- Matching fully revealed columns clear in the established discard order.
- Every other player gets one final turn after a player exposes their last card.
- The closer's positive score doubles unless it is strictly the lowest score.
- Solo has 1-7 bots. A new game reshuffles themed names; the next round preserves identities and difficulty assignments.
- Difficulties are `easy`, `medium`, `hard`, and `ultra`; `mixed` assigns a deterministic balanced selection. Strategy version is currently 1.
- Multiplayer AI takeover stays server-owned and currently uses Hard behavior.

Every bullet above needs at least one shared golden fixture or a Swift unit test before native parity is declared.

## Distribution Stages

1. Simulator-only development with mocked and local backend tests.
2. Chad's registered iPhone/iPad with development signing.
3. Internal TestFlight with production-like backend access.
4. Complete [branding and asset-rights gate #193](https://github.com/chadmhohn/skyjo-online/issues/193).
5. External TestFlight for invited friends after Beta App Review.
6. Public App Store only after account deletion, privacy metadata, support URL, review account, and product-page assets are approved.

Apple's current review guidance requires original or licensed content and prohibits misleading/copycat metadata. Treat that as a release-planning constraint, not as a reason to block engineering under a working title.
