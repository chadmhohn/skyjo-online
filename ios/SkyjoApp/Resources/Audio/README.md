# Native audio assets

IOS-7 bundles the three short card-effect cues already shipped by the PWA. The recordings are
Creative Commons Zero and need no attribution, but their source and processing trail remains in
[`public/audio/README.md`](../../../../public/audio/README.md) for reproducibility.

| Native resource | Purpose | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `card-flip.mp3` | Reveal and column-clear cue | 24,004 | `dc9c08e4b172d404ce2f1ba8380d552fdd1d302419e2872f067f0d761147df90` |
| `card-pickup.mp3` | Draw/discard pickup and local-turn cue | 4,225 | `5d6b866eb280804f86aae1d5d795da1a2260075a5c18b11472b84b33d31f68de` |
| `card-place.mp3` | Placement and round/game-complete cue | 3,702 | `37f3fb1cd7a08f741eb7431de2cde4ad5eef129aa18496d379221461926373b8` |

The files are byte-identical copies of `public/audio/`. `GameFeedbackController` uses the ambient
audio-session category so effects respect the silent switch and mix with existing audio. Effects
default on, haptics default on, and music defaults off. No music asset is distributed until an
original or licensed track is approved through issue #193.
