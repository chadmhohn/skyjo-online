# Audio asset provenance

The app ships three short, music-free feedback cues. The reveal cue is original and reproducibly
synthesized from repository code. The pickup and placement cues are trimmed Creative Commons Zero
Freesound previews; attribution is not required, but their source and processing trail is retained.

- `card-flip.wav`: original deterministic synthesis created for this repository.
- `card-pickup.mp3`: "Index Card Flip Manipulation" by ROBAMOS, Freesound sound
  [339015](https://freesound.org/people/ROBAMOS/sounds/339015/), CC0.
- `card-place.mp3`: "Pounding Cards On Table" by HogantheLogan, Freesound sound
  [466789](https://freesound.org/people/HogantheLogan/sounds/466789/), CC0.

## Original reveal cue

Run `npm run generate:audio` from the repository root. The committed
`scripts/generate-original-card-flip.mjs` writes the exact same 44.1 kHz, mono, signed 16-bit PCM
WAVE bytes to the public and native resource directories. Its deterministic seeded noise, descending
tone, and short second transient were authored for this app; it uses no recording, sample, or model
output from a third party.

## CC0 cue build provenance

The unedited source previews are the versions in release commit
`1209b172b7580cb5ede570a9e88283cddcaafbb1`:

- Pickup source SHA-256:
  `48DCA7187BF97AC3A37CB1C032F0C152B92A3A2A161E6EE6EC04949858EBA7D4`
- Place source SHA-256:
  `82CFC4CC7C82B9759E67917BBE495A6A18C77826948579E5B327F3182FD8C29F`

Stage those previews as `card-pickup-source.mp3` and `card-place-source.mp3`. The production files
were rendered with `ffmpeg 8.1.1-full_build-www.gyan.dev` using:

```powershell
ffmpeg -hide_banner -y -i card-pickup-source.mp3 `
  -af "atrim=start=1.500:end=1.860,asetpts=PTS-STARTPTS,highpass=f=120,lowpass=f=9000,loudnorm=I=-24:LRA=7:TP=-3,aresample=44100,afade=t=in:st=0:d=0.006,afade=t=out:st=0.300:d=0.060" `
  -map_metadata -1 -ac 1 -ar 44100 -c:a libmp3lame -b:a 80k card-pickup.mp3

ffmpeg -hide_banner -y -i card-place-source.mp3 `
  -af "atrim=start=0.910:end=1.210,asetpts=PTS-STARTPTS,highpass=f=90,lowpass=f=5000,loudnorm=I=-26:LRA=7:TP=-4,volume=-5dB,aresample=44100,afade=t=in:st=0:d=0.004,afade=t=out:st=0.240:d=0.060" `
  -map_metadata -1 -ac 1 -ar 44100 -c:a libmp3lame -b:a 80k card-place.mp3
```

## Committed production evidence

| Asset | Format | Duration | Onset | Bytes | SHA-256 |
| --- | --- | ---: | ---: | ---: | --- |
| `card-flip.wav` | PCM WAVE, 44.1 kHz mono, signed 16-bit | 0.2400 s | 0 ms | 21,212 | `CD39C3D5F749B84B73DB28ED581EF34FB37BD539EEB1A2389713350CA96D2AD3` |
| `card-pickup.mp3` | MP3, 44.1 kHz mono, 80 kbps | 0.3918 s | 30.1 ms | 4,225 | `5D6B866EB280804F86AAE1D5D795DA1A2260075A5C18B11472B84B33D31F68DE` |
| `card-place.mp3` | MP3, 44.1 kHz mono, 80 kbps | 0.3396 s | 25.1 ms | 3,702 | `37F3FB1CD7A08F741EB7431DE2CDE4AD5EEF129AA18496D379221461926373B8` |

The three effect cues total 29,139 bytes. `npm run check:audio` verifies their exact hashes, bounded
size, mono sample format, short duration, prompt onset, clean tail, byte-identical native copies, and
the absence of unreviewed bundled media.
