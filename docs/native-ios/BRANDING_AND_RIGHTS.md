# External TestFlight Branding And Rights Gate

This document is the repository-owned inventory for [issue #193](https://github.com/chadmhohn/skyjo-online/issues/193). It is not legal advice and it does not assert ownership or permission. Until every owner decision and replacement below is complete, builds may be used for registered-device and internal TestFlight testing only; they must not be submitted for external TestFlight Beta App Review.

Last evidence pass: 2026-08-20, against production tag `v0.3.5`, native PR #224 head `5021b2906fa75b9d44b0fd57bc2e48db0da7b87b`, and App Store Connect build `0.1.0 (2)`.

## Owner Decisions Still Required

- [ ] Chad selects the final external-beta working name.
- [ ] Chad confirms the exact Apple submitting legal entity. The observed Apple Developer team is `Chad Hohn` (`9X58YD7F8Y`), but this observation is not the required owner confirmation.
- [ ] Chad confirms that the external icon is original or licensed and that its provenance may be recorded here.
- [ ] Chad approves a wholly original bot-name roster.
- [ ] Chad approves retaining the documented CC0 sound effects or replaces them with original recordings.

## Current Inventory

| Surface | Current state | External-beta disposition |
| --- | --- | --- |
| Product and store name | `Skyjo`, `Skyjo Online`, and `SKYJO` appear in the app display name, App Store Connect record, PWA title/icons, copy, source, invite language, and public hostname. Magilano currently markets the card game as [SKYJO](https://magilano.com/en/products/skyjo). No permission or license for that name is committed. | Replace every reviewer- and tester-facing use with the approved original name, or commit written permission. Do not infer permission from private/internal use. |
| Bundle and service identifiers | `com.groundworkrevops.skyjo`, `skyjo.groundworkrevops.com`, associated domains, APNs topic, keychain names, and internal code identifiers use `skyjo`. | The bundle ID/APNs topic cannot change after an App Store record is established without creating a new app. Chad must explicitly decide whether to retain the internal identifier while replacing public branding. Reviewer-visible invite/support URLs must use the approved identity consistently. Internal source identifiers need not be mechanically renamed for v0.1.0 unless they become user-facing. |
| Internal iOS icon | Build 2 uses `Skyjo-Internal-1024.png`, introduced by commit `e54339082e3108bc0fde139a9186faf845f23535`. It depicts generic playing cards without the word Skyjo, but the repository contains no source file, author statement, generation record, or license for the bitmap. | Internal-only until provenance is committed. Prefer a new original icon with an editable source or reproducible generation record and explicit owner approval. |
| PWA icons | `public/skyjo-icon-v2.svg` is repository-authored vector markup introduced by commit `279c9cb436417f2175278680c58d0740c1d85f34`; it visibly includes `SKYJO`. Raster variants are derived from it. | The artwork construction is traceable, but the retained name is not cleared. Replace the lettering and any confusingly similar product identity before using it in external metadata or screenshots. |
| Native visual system | SwiftUI shapes, platform controls/SF Symbols, colored number-card surfaces, and a dark green/cream/gold/red palette. No third-party artwork or external Swift package is bundled. | May be retained if the final review confirms it is sufficiently original and the external icon/screenshots use the same approved identity. #190 owns the native visual-polish pass. |
| Bot names | TypeScript and Swift currently share the roster listed below. As a collection it deliberately references characters from Star Trek, Battlestar Galactica, Marvel, Alien, The Matrix, and Star Wars. No permissions are committed. | Replace the entire roster in TypeScript, Swift, tests, and deterministic fixtures with an original theme. Do not attempt to preserve ambiguous/common entries selectively. |
| Sound effects | Three short effects are bundled. `public/audio/README.md` records source authors, Freesound IDs, processing commands, output hashes, and CC0 status. Freesound currently identifies [sound 339015](https://freesound.org/people/ROBAMOS/sounds/339015/) and [sound 466789](https://freesound.org/people/HogantheLogan/sounds/466789/) as Creative Commons 0. The original page for sound 84322 was not reachable during this pass, so its committed provenance could not be independently refreshed. | The two live CC0 records may be retained with the committed hashes. Archive or otherwise re-verify the license evidence for sound 84322 before external review, or replace that cue with an original recording. No music is bundled. |
| Fonts | Native uses Apple system fonts. The PWA names Manrope/Fraunces with system fallbacks but does not import or bundle those fonts. | No bundled font license is currently required. Re-audit if fonts are added to either artifact. |
| Store copy and screenshots | Build 2 is internal-only. App Store Connect has no external group; its `What to Test` field is blank and external product-page copy/screenshots are not certified. | Write all external copy after the name decision. App name, icon, screenshots, test notes, privacy/support URLs, and reviewer-facing identity must agree. |

### Current bot roster to replace

`Picard, Riker, Data, Worf, Geordi, Beverly, Troi, Sisko, Kira, Dax, Odo, Quark, Janeway, Seven, Tuvok, Kirk, Spock, Uhura, Sulu, Scotty, Bones, Pike, Saru, Burnham, Mariner, Boimler, Adama, Roslin, Starbuck, Apollo, Boomer, Athena, Helo, Tyrol, Tigh, Baltar, Six, Anders, Gaeta, Dualla, TChalla, Shuri, Okoye, Wanda, Vision, Natasha, Clint, Thor, Loki, Valkyrie, Carol, Monica, Kamala, Strange, Wong, Peter, Miles, Gwen, Logan, Ororo, Rogue, Gambit, Jean, Scott, Hank, Doom, Reed, Sue, Ben, Johnny, Ripley, Hicks, Vasquez, Sarah, Neo, Trinity, Morpheus, Luke, Leia, Han, Chewie, Lando, Rey, Finn, Poe, Ahsoka, Grogu`.

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
