Skyjo audio assets
==================

The source recordings are Creative Commons 0 Freesound previews. Attribution is
not required, but the source and processing trail is retained for reproducibility.

- `card-flip.mp3`: "flipCard.wav" by Splashdust, Freesound sound 84322, CC0.
- `card-pickup.mp3`: "Index Card Flip Manipulation" by ROBAMOS, Freesound sound
  339015, CC0. The production cue uses a dry card slide/lift from the source.
- `card-place.mp3`: "Pounding Cards On Table" by HogantheLogan, Freesound sound
  466789, CC0. The production cue uses the quieter third felt/table landing.

Cue build provenance
--------------------

The unedited source previews are the versions in release commit
`1209b172b7580cb5ede570a9e88283cddcaafbb1`:

- Pickup source SHA-256:
  `48DCA7187BF97AC3A37CB1C032F0C152B92A3A2A161E6EE6EC04949858EBA7D4`
- Place source SHA-256:
  `82CFC4CC7C82B9759E67917BBE495A6A18C77826948579E5B327F3182FD8C29F`

Stage those previews as `card-pickup-source.mp3` and `card-place-source.mp3`.
The production files were rendered with
`ffmpeg 8.1.1-full_build-www.gyan.dev` using:

```powershell
ffmpeg -hide_banner -y -i card-pickup-source.mp3 `
  -af "atrim=start=1.500:end=1.860,asetpts=PTS-STARTPTS,highpass=f=120,lowpass=f=9000,loudnorm=I=-24:LRA=7:TP=-3,aresample=44100,afade=t=in:st=0:d=0.006,afade=t=out:st=0.300:d=0.060" `
  -map_metadata -1 -ac 1 -ar 44100 -c:a libmp3lame -b:a 80k card-pickup.mp3

ffmpeg -hide_banner -y -i card-place-source.mp3 `
  -af "atrim=start=0.910:end=1.210,asetpts=PTS-STARTPTS,highpass=f=90,lowpass=f=5000,loudnorm=I=-26:LRA=7:TP=-4,volume=-5dB,aresample=44100,afade=t=in:st=0:d=0.004,afade=t=out:st=0.240:d=0.060" `
  -map_metadata -1 -ac 1 -ar 44100 -c:a libmp3lame -b:a 80k card-place.mp3
```

Production evidence
-------------------

Onset is the end of initial silence reported by
`silencedetect=noise=-30dB:d=0.002`. True peak is from `ebur128=peak=true`.

| Asset | Format | Duration | Onset | Mean | True peak | Bytes | SHA-256 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `card-flip.mp3` | MP3, 44.1 kHz mono | 0.940408 s | unchanged | unchanged | unchanged | 24,004 | `DC9C08E4B172D404CE2F1BA8380D552FDD1D302419E2872F067F0D761147DF90` |
| `card-pickup.mp3` | MP3, 44.1 kHz mono, 80 kbps | 0.360000 s | 19.0703 ms | -18.8 dB | -3.2 dBFS | 4,225 | `5D6B866EB280804F86AAE1D5D795DA1A2260075A5C18B11472B84B33D31F68DE` |
| `card-place.mp3` | MP3, 44.1 kHz mono, 80 kbps | 0.300000 s | 16.6893 ms | -29.4 dB | -6.4 dBFS | 3,702 | `37F3FB1CD7A08F741EB7431DE2CDE4AD5EEF129AA18496D379221461926373B8` |

The three effect cues total 31,931 bytes. `card-flip.mp3` was preserved
byte-for-byte.

Verification commands:

```powershell
ffprobe -v error -show_entries format=duration,size,bit_rate `
  -show_entries stream=codec_name,sample_rate,channels,channel_layout `
  -of default=noprint_wrappers=1 card-pickup.mp3
ffmpeg -hide_banner -i card-pickup.mp3 `
  -af "silencedetect=noise=-30dB:d=0.002,ebur128=peak=true" -f null NUL
ffmpeg -hide_banner -i card-pickup.mp3 -af volumedetect -f null NUL

ffprobe -v error -show_entries format=duration,size,bit_rate `
  -show_entries stream=codec_name,sample_rate,channels,channel_layout `
  -of default=noprint_wrappers=1 card-place.mp3
ffmpeg -hide_banner -i card-place.mp3 `
  -af "silencedetect=noise=-30dB:d=0.002,ebur128=peak=true" -f null NUL
ffmpeg -hide_banner -i card-place.mp3 -af volumedetect -f null NUL

Get-FileHash card-flip.mp3,card-pickup.mp3,card-place.mp3 -Algorithm SHA256
```
