# Native audio assets

IOS-7 bundles the three short card-effect cues already shipped by the PWA. The reveal cue is original
and reproducibly synthesized; the other two are Creative Commons Zero. Their complete provenance is in
[`public/audio/README.md`](../../../../public/audio/README.md) for reproducibility.

| Native resource | Purpose | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `card-flip.wav` | Reveal and column-clear cue | 21,212 | `cd39c3d5f749b84b73db28ed581ef34fb37bd539eeb1a2389713350ca96d2ad3` |
| `card-pickup.mp3` | Draw/discard pickup and local-turn cue | 4,225 | `5d6b866eb280804f86aae1d5d795da1a2260075a5c18b11472b84b33d31f68de` |
| `card-place.mp3` | Placement and round/game-complete cue | 3,702 | `37f3fb1cd7a08f741eb7431de2cde4ad5eef129aa18496d379221461926373b8` |

The files are byte-identical copies of `public/audio/`. `GameFeedbackController` uses the ambient
audio-session category so effects respect the silent switch and mix with existing audio. Effects
default on, haptics default on, and music defaults off. No music asset is distributed until an
original or licensed track is approved through issue #193.
