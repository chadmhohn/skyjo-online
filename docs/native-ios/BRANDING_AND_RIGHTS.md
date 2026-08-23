# External TestFlight Branding And Rights Gate

This document is the repository-owned inventory for [issue #193](https://github.com/chadmhohn/skyjo-online/issues/193). It is not legal advice and it does not assert ownership or permission. Until every owner decision and replacement below is complete, builds may be used for registered-device and internal TestFlight testing only; they must not be submitted for external TestFlight Beta App Review.

Last evidence pass: 2026-08-23, against `main` at `226c7ef5876a1d8e99b191296cf1e06e87edd1b5` and App Store Connect build `0.1.0 (4)`.

## Owner Decisions Still Required

- [ ] Chad selects the final external-beta working name.
- [ ] Chad confirms the exact Apple submitting legal entity. The observed Apple Developer team is `Chad Hohn` (`9X58YD7F8Y`), but this observation is not the required owner confirmation.
- [ ] Chad decides whether the established bundle ID, APNs topic, and backend hostname may remain private implementation identifiers after the public rename.
- [ ] Chad approves the original external icon and committed generation provenance.
- [ ] Chad approves the new nature-word bot roster.
- [ ] Chad approves the original reveal cue and the two retained, source-linked CC0 effects.

## Current Inventory

| Surface | Current state | External-beta disposition |
| --- | --- | --- |
| Product and store name | `Skyjo`, `Skyjo Online`, and `SKYJO` appear in the app display name, App Store Connect record, PWA title/icons, copy, source, invite language, and public hostname. Magilano currently markets the card game as [SKYJO](https://magilano.com/en/products/skyjo). No permission or license for that name is committed. | Replace every reviewer- and tester-facing use with the approved original name, or commit written permission. Do not infer permission from private/internal use. |
| Bundle and service identifiers | `com.groundworkrevops.skyjo`, `skyjo.groundworkrevops.com`, associated domains, APNs topic, keychain names, and internal code identifiers use `skyjo`. | The bundle ID/APNs topic cannot change after an App Store record is established without creating a new app. Chad must explicitly decide whether to retain the internal identifier while replacing public branding. Reviewer-visible invite/support URLs must use the approved identity consistently. Internal source identifiers need not be mechanically renamed for v0.1.0 unless they become user-facing. |
| Native iOS icon | Build 4 uses the retired `Skyjo-Internal-1024.png`, which had no committed source or license. This branch replaces it with the name-free `Original-External-1024.png`: an abstract descending-tile emblem with its exact prompt, generation method, dimensions, and SHA-256 committed in `APP_ICON_PROVENANCE.md`. | Ready for owner approval and archive inspection. Any future replacement needs a new provenance record. |
| PWA icons | This branch removes the old word-mark SVGs and derives every 180, 192, and 512 pixel PWA icon from the same original, name-free external icon used by iOS. Internal filenames retain `skyjo` only to avoid unnecessary cache/protocol churn. | Ready for owner approval. The installed PWA, browser favicon, notification icon, native app, and future screenshots now share one approved visual identity. |
| Native visual system | SwiftUI shapes, platform controls/SF Symbols, colored number-card surfaces, and a dark green/cream/gold/red palette. No third-party artwork or external Swift package is bundled. | May be retained if the final review confirms it is sufficiently original and the external icon/screenshots use the same approved identity. #190 owns the native visual-polish pass. |
| Bot names | This branch replaces the complete franchise-reference roster in both TypeScript and Swift with the nature-word roster below. The two engines remain aligned at the name level. | Ready for owner approval and deterministic parity verification. Future additions must follow the same original theme and be changed in both engines. |
| Sound effects | This branch replaces the unverified Freesound 84322 flip cue with an original, deterministic PCM WAVE synthesized by the committed `generate-original-card-flip.mjs` script. `public/audio/README.md` records its algorithm, hash, and evidence. Freesound identifies retained [sound 339015](https://freesound.org/people/ROBAMOS/sounds/339015/) and [sound 466789](https://freesound.org/people/HogantheLogan/sounds/466789/) as Creative Commons 0. No music is bundled. | Ready for owner approval and archive inspection. The original flip cue is reproducible; the retained cues remain pinned to source-linked CC0 records. |
| Fonts | Native uses Apple system fonts. The PWA names Manrope/Fraunces with system fallbacks but does not import or bundle those fonts. | No bundled font license is currently required. Re-audit if fonts are added to either artifact. |
| Store copy and screenshots | Build 4 completed functional real-device validation on iPhone and iPad, including force-quit resume, but its existing name/icon and external product-page copy are not certified. | Write all external copy after the name decision. App name, icon, screenshots, test notes, privacy/support URLs, and reviewer-facing identity must agree. |

### Replacement bot roster

`Acorn, Alder, Aster, Aspen, Birch, Bramble, Breeze, Brook, Canyon, Cedar, Clover, Coral, Cove, Cypress, Dahlia, Dawn, Dune, Echo, Elm, Ember, Fawn, Fern, Finch, Fjord, Flint, Forest, Gale, Garnet, Glade, Harbor, Hazel, Heather, Indigo, Ivy, Jade, Juniper, Kestrel, Lake, Lark, Laurel, Linden, Lotus, Maple, Marigold, Meadow, Mica, Mist, Moss, Moon, Olive, Onyx, Opal, Orchid, Pebble, Pine, Poppy, Prairie, Quartz, Rain, Reef, Ridge, River, Robin, Rowan, Ruby, Sage, Saffron, Sequoia, Sky, Slate, Sol, Sparrow, Spruce, Starling, Stone, Storm, Summit, Sunny, Terra, Thistle, Tide, Topaz, Vale, Violet, Willow, Wren, Zephyr`.

## Smallest Safe External-Beta Change Set

1. Record Chad's chosen original name and the exact submitting legal entity in this file and issue #193.
2. Replace the user-facing app/store/PWA/invite identity while preserving protocol compatibility. Decide explicitly whether the established bundle ID, APNs topic, and backend hostname remain internal implementation identifiers.
3. Replace the complete bot roster in both engines and regenerate/review every affected deterministic fixture and manifest together.
4. Install an original, provenance-backed app icon and use it consistently in the app, TestFlight, screenshots, and store metadata.
5. Retain only audio with refreshed CC0 evidence or original recordings; keep music absent unless separately cleared.
6. Audit the final Release archive and screenshots for the old name, old icons, franchise names, debug/test copy, and inconsistent reviewer-facing identity.
7. Commit the final rights inventory, update App Store Connect metadata, close #193, and only then add the build to an external TestFlight group or submit Beta App Review.

## Explicit Non-Goals

- This gate does not block current registered-device or internal TestFlight testing.
- It does not authorize a public App Store submission; issue #192 and the remaining metadata/privacy/owner gates still apply.
- It does not require renaming every private source symbol or historical release artifact when that symbol is not shipped or reviewer-facing.
- It does not claim that game mechanics themselves are cleared for distribution. The owner should obtain qualified legal advice if there is uncertainty about name, trade dress, rules expression, or other intellectual-property risk.
