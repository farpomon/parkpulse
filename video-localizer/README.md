# Video Localizer

Turn one AI-generated kids video into many languages without regenerating the
video. The video stays language-neutral; this pipeline produces a
timeline-synced voiceover track per language and attaches it with ffmpeg.

```
master_script.csv ──translate──▶ out/scripts/<lang>.csv   (Gemini)
                  ─────tts─────▶ out/tracks/<lang>.m4a    (Gemini TTS + ffmpeg)
                  ─────mux─────▶ out/videos/<lang>.mp4    (ffmpeg)
```

## Requirements

- Python 3.9+ (standard library only — nothing to `pip install`)
- [ffmpeg](https://ffmpeg.org) on your PATH
- A Gemini API key: `export GEMINI_API_KEY=...`
  (get one at https://aistudio.google.com/apikey)

## 1. Write the master script first

Before generating any video, write the story as `master_script.csv` — one row
per scene (see `master_script.example.csv`):

| column | meaning |
|---|---|
| `scene` | scene number |
| `start` | when the scene starts in the video, in seconds |
| `duration` | how long the scene lasts, in seconds |
| `visual` | what's on screen (also your Veo/Gemini video prompt) |
| `narration` | the voiceover line for that scene |

Two rules that make dubbing painless:

- **No text baked into the video** — no signs, titles, or written words in the
  generated footage. Put titles in editing so they can be swapped per language.
- **Avoid close-up lip-sync** — animals, wide shots, and music-driven scenes
  dub into any language without looking wrong.

Optional: `glossary.csv` (`term,rule`) pins character names and catchphrases so
they stay consistent in every language (see `glossary.example.csv`).

## 2. Configure languages and voices

Edit `config.json`. Each language gets a Gemini TTS prebuilt voice (e.g.
`Kore`, `Puck`, `Aoede`, `Leda` — browse them in AI Studio's speech panel).
Keep the same voice per character across languages so kids recognize the
channel anywhere. `voice_style` controls the read (pace, warmth) and
`max_speedup` caps how much a too-long translation may be sped up to fit its
scene (default 1.25×).

## 3. Run the pipeline

```bash
export GEMINI_API_KEY=your-key

# Everything at once:
python3 localize.py all --script master_script.csv --video final.mp4

# Or step by step:
python3 localize.py translate --script master_script.csv          # -> out/scripts/
python3 localize.py tts                                           # -> out/tracks/
python3 localize.py mux --video final.mp4                         # -> out/videos/
```

Useful flags:

- `--lang es pt` — only some of the configured languages
- `mux --multitrack` — one MP4 with every language as a selectable audio
  track (each tagged with its ISO language code) instead of one file per
  language
- `mux --mix-original 0.25` — keep the video's own music/ambience under the
  voice at 25% volume instead of replacing the audio entirely
- `tts --force` — regenerate scene audio that already exists (by default,
  already-generated scenes are skipped, so re-runs after a fix are cheap)

Timing: each scene's audio is placed at its `start` time, padded with silence
between scenes. If a translation reads longer than its scene, it's sped up
(never past `max_speedup`); if it still doesn't fit you get a warning naming
the scene — shorten that line in `out/scripts/<lang>.csv` and re-run
`tts --force --lang <code>`.

Review pass: always listen to each track once before publishing — TTS in a
language you don't speak can mispronounce a name; fix the line in the
translated CSV and regenerate just that language.

## 4. Publish on YouTube

- **Best option — multi-language audio tracks**: upload the original video
  once, then in YouTube Studio add each `out/tracks/<lang>.m4a` as an audio
  track (Subtitles → Audio). Viewers hear their own language automatically and
  all watch time concentrates on one video. If your channel doesn't have the
  feature yet, upload the per-language MP4s from `out/videos/` instead.
- **Localize metadata**: in Studio, add translated titles + descriptions per
  language (Subtitles → titles & descriptions) — that's what makes the video
  discoverable in each market. The translated narration CSVs double as
  subtitle source text.
- **Mark it "Made for Kids"** (COPPA requirement for children's content).

## Web UI / deploy on Railway

`server.py` wraps the pipeline in a simple web page: upload the script CSV
(plus optional glossary and video), pick languages, watch the log, download
the tracks/MP4s. Run it locally with `python3 server.py` (port 8080), or
deploy it on [Railway](https://railway.com):

1. Push this folder to its own GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo** → pick the repo.
   The included `Dockerfile` + `railway.json` handle the build (ffmpeg
   included).
3. Add environment variables: `GEMINI_API_KEY` (required) and
   `APP_PASSWORD` (recommended — anyone with the URL can otherwise run jobs
   on your API key; any username + this password logs in).
4. Generate a domain under Settings → Networking.

Notes for Railway: the filesystem is ephemeral, so download results after
each job (they don't survive a redeploy); jobs run one at a time; very large
video uploads are better handled by running `mux` locally with the
downloaded audio tracks — or skip the video upload entirely and use the
tracks with YouTube multi-language audio.

## Notes

- Songs don't localize this way — a translated song must be re-sung and
  re-timed. Narrated stories scale across languages; keep songs simple and
  repetitive if you need them.
- Generated audio is cached per scene under `out/audio/<lang>/`, so
  iterating on one scene doesn't re-bill the whole video.
