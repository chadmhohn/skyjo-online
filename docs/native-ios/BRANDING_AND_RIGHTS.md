# External TestFlight Branding And Rights Gate

This document is the repository-owned inventory for [issue #193](https://github.com/chadmhohn/skyjo-online/issues/193). It is not legal advice and it does not assert ownership or permission beyond the original and source-linked assets recorded here. The owner decisions below apply to the first external TestFlight beta candidate.

Last evidence pass: 2026-08-23, against `main` at `226c7ef5876a1d8e99b191296cf1e06e87edd1b5` and App Store Connect build `0.1.0 (4)`.

## Confirmed Owner Decisions

- [x] The public external-beta name is **Flipvale**.
- [x] The Apple submitting legal entity is **Chad Hohn**, using Apple Developer team `9X58YD7F8Y`.
- [x] The established bundle ID, APNs topic, backend hostname, environment variables, and private source identifiers may retain `skyjo` as implementation identifiers. They are not the public product identity.
- [x] The original external icon and committed generation provenance are approved.
- [x] The nature-word bot roster is approved.
- [x] The original reveal cue and the two retained, source-linked CC0 effects are approved.

## Current Inventory

| Surface | Current state | External-beta disposition |
| --- | --- | --- |
| Product and store name | **Flipvale** is the approved public product name. This change replaces the old name in the native display name, PWA title/manifest, card backs, notifications, account/invite copy, protocol error text, and tester-facing accessibility labels. A preliminary exact-name App Store/web screen found no obvious collision; that is a practical screen, not trademark clearance. | Use Flipvale consistently in the final archive, App Store Connect localization, screenshots, Beta App Review notes, and tester communications. Do not restore the prior public name without a separately documented rights decision. |
| Bundle and service identifiers | `com.groundworkrevops.skyjo`, `skyjo.groundworkrevops.com`, associated domains, APNs topic, keychain names, and internal code identifiers retain `skyjo`. | Chad approved retaining these established private implementation identifiers. Reviewer-visible content uses Flipvale; compatibility-sensitive identifiers are not mechanically renamed for v0.1.0. |
| Native iOS icon | Build 4 used the retired `Skyjo-Internal-1024.png`, which had no committed source or license. This branch replaces it with the approved, name-free `Original-External-1024.png`: an abstract descending-tile emblem with its exact prompt, generation method, dimensions, and SHA-256 committed in `APP_ICON_PROVENANCE.md`. | Approved for the Flipvale beta. Audit the final archive before upload. Any future replacement needs a new provenance record. |
| PWA icons | This branch removes the old word-mark SVGs and derives every 180, 192, and 512 pixel PWA icon from the same approved, name-free external icon used by iOS. Internal filenames retain `skyjo` only to avoid unnecessary cache/protocol churn. | Approved for the Flipvale beta. The installed PWA, browser favicon, notification icon, native app, and future screenshots share one visual identity. |
| Native visual system | SwiftUI shapes, platform controls/SF Symbols, colored number-card surfaces, and a dark green/cream/gold/red palette. No third-party artwork or external Swift package is bundled. | May be retained if the final review confirms it is sufficiently original and the external icon/screenshots use the same approved identity. #190 owns the native visual-polish pass. |
| Bot names | This branch replaces the complete franchise-reference roster in both TypeScript and Swift with the approved nature-word roster below. The two engines remain aligned at the name level. | Approved for the Flipvale beta and covered by deterministic parity checks. Future additions must follow the same original theme and be changed in both engines. |
| Sound effects | This branch replaces the unverified Freesound 84322 flip cue with an approved original, deterministic PCM WAVE synthesized by the committed `generate-original-card-flip.mjs` script. `public/audio/README.md` records its algorithm, hash, and evidence. Freesound identifies retained [sound 339015](https://freesound.org/people/ROBAMOS/sounds/339015/) and [sound 466789](https://freesound.org/people/HogantheLogan/sounds/466789/) as Creative Commons 0. No music is bundled. | Approved for the Flipvale beta. The original flip cue is reproducible; the retained cues remain pinned to source-linked CC0 records. Audit the final archive before upload. |
| Fonts | Native uses Apple system fonts. The PWA names Manrope/Fraunces with system fallbacks but does not import or bundle those fonts. | No bundled font license is currently required. Re-audit if fonts are added to either artifact. |
| Store copy and screenshots | Build 4 completed functional real-device validation on iPhone and iPad, including force-quit resume, but predates the Flipvale identity. The first external candidate must use the new name/icon and fresh screenshots; no Build 4 screenshot is approved for external use. | App Store Connect name, icon, screenshots, concise beta description, test notes, privacy/support URLs, and reviewer-facing identity must all say Flipvale. Capture screenshots from the final consolidated candidate rather than producing an extra branding-only build. |

### Replacement bot roster

`Acorn, Alder, Aster, Aspen, Birch, Bramble, Breeze, Brook, Canyon, Cedar, Clover, Coral, Cove, Cypress, Dahlia, Dawn, Dune, Echo, Elm, Ember, Fawn, Fern, Finch, Fjord, Flint, Forest, Gale, Garnet, Glade, Harbor, Hazel, Heather, Indigo, Ivy, Jade, Juniper, Kestrel, Lake, Lark, Laurel, Linden, Lotus, Maple, Marigold, Meadow, Mica, Mist, Moss, Moon, Olive, Onyx, Opal, Orchid, Pebble, Pine, Poppy, Prairie, Quartz, Rain, Reef, Ridge, River, Robin, Rowan, Ruby, Sage, Saffron, Sequoia, Sky, Slate, Sol, Sparrow, Spruce, Starling, Stone, Storm, Summit, Sunny, Terra, Thistle, Tide, Topaz, Vale, Violet, Willow, Wren, Zephyr`.

## External Beta Metadata Draft

- **App name:** Flipvale
- **Submitting legal entity:** Chad Hohn, Apple Developer team `9X58YD7F8Y`
- **Beta description:** Flipvale is a casual number-card game for solo play or private rooms with friends. Reveal, draw, swap, and clear matching columns while aiming for the lowest score.
- **What to test:** Create or sign in to an account, start and resume a solo game, create or join a private room, complete a multiplayer turn, and optionally enable turn notifications. Test both portrait and landscape on iPhone or iPad.
- **Review account:** Supply a dedicated non-admin account only through App Store Connect Beta App Review information. Never commit or paste its credentials into source, issues, CI, or test artifacts.
- **Screenshots:** Capture fresh iPhone and iPad screenshots from the final consolidated Flipvale candidate after functional validation. Build 4 screenshots and the retired icon/name are not approved.
- **Identifiers and URLs:** The bundle ID, APNs topic, and current backend hostname remain compatibility identifiers. Product copy around any visible URL must identify the app as Flipvale.

## Smallest Safe External-Beta Change Set

1. Record Chad's chosen original name and exact submitting legal entity in this file and issue #193. **Complete.**
2. Replace the user-facing app/PWA/invite identity while preserving protocol compatibility; retain the approved established implementation identifiers. **Complete in this branch; App Store Connect follows the reviewed build.**
3. Replace the complete bot roster in both engines and regenerate/review every affected deterministic fixture and manifest together. **Complete.**
4. Install an original, provenance-backed app icon and use it consistently in the app, TestFlight, screenshots, and store metadata. **Code and provenance complete; final-candidate screenshot capture remains.**
5. Retain only audio with refreshed CC0 evidence or original recordings; keep music absent unless separately cleared. **Complete.**
6. Audit the final Release archive and screenshots for the old name, old icons, franchise names, debug/test copy, and inconsistent reviewer-facing identity.
7. Commit the final rights inventory and close #193. During #191, update App Store Connect metadata for the reviewed candidate before adding that build to an external TestFlight group or submitting Beta App Review.

## Explicit Non-Goals

- This gate does not block current registered-device or internal TestFlight testing.
- It does not authorize a public App Store submission; issue #192 and the remaining metadata/privacy/owner gates still apply.
- It does not require renaming every private source symbol or historical release artifact when that symbol is not shipped or reviewer-facing.
- It does not claim that game mechanics themselves are cleared for distribution. The owner should obtain qualified legal advice if there is uncertainty about name, trade dress, rules expression, or other intellectual-property risk.
