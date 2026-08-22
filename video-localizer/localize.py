#!/usr/bin/env python3
"""Localize AI-generated kids videos into multiple languages.

Pipeline: master script CSV -> translated scripts (Gemini) -> per-scene
voiceover (Gemini TTS) -> timeline-synced audio track -> muxed MP4s (ffmpeg).

Requires: Python 3.9+, ffmpeg on PATH, GEMINI_API_KEY environment variable.
No third-party Python packages.

Usage:
  python3 localize.py translate --script master_script.csv
  python3 localize.py tts
  python3 localize.py mux --video final.mp4
  python3 localize.py all --script master_script.csv --video final.mp4

Outputs land in out/: scripts/<lang>.csv, audio/<lang>/, tracks/<lang>.m4a,
videos/<lang>.mp4 (or videos/multitrack.mp4 with --multitrack).
"""

import argparse
import base64
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
OUT_DIR = Path(os.environ.get("LOCALIZER_OUT", BASE_DIR / "out"))
API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"

SAMPLE_RATE = 24000  # Gemini TTS output: 16-bit mono PCM at 24 kHz

# ISO 639-2 codes for MP4 track metadata (YouTube and players read these).
ISO_639_2 = {
    "en": "eng", "es": "spa", "pt": "por", "fr": "fra", "de": "deu",
    "it": "ita", "hi": "hin", "ja": "jpn", "ko": "kor", "zh": "zho",
    "ar": "ara", "ru": "rus", "nl": "nld", "pl": "pol", "tr": "tur",
    "id": "ind", "vi": "vie", "th": "tha", "uk": "ukr", "sv": "swe",
    "da": "dan", "no": "nor", "fi": "fin",
}


def rel(path):
    try:
        return path.relative_to(BASE_DIR)
    except ValueError:
        return path


def load_config():
    with open(BASE_DIR / "config.json", encoding="utf-8") as f:
        return json.load(f)


def load_scenes(path):
    with open(path, encoding="utf-8") as f:
        scenes = list(csv.DictReader(f))
    for s in scenes:
        s["start"] = float(s["start"])
        s["duration"] = float(s["duration"])
    return scenes


def load_glossary(path):
    if not path or not Path(path).exists():
        return []
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def pick_languages(config, requested):
    langs = config["languages"]
    if not requested:
        return dict(langs)
    missing = [l for l in requested if l not in langs]
    if missing:
        sys.exit(f"Language(s) not in config.json: {', '.join(missing)}")
    return {l: langs[l] for l in requested}


# ---------------------------------------------------------------- Gemini API

def gemini_call(model, payload):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        sys.exit("Set the GEMINI_API_KEY environment variable first.")
    req = urllib.request.Request(
        f"{API_ROOT}/{model}:generateContent",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:500]
            if e.code in (429, 500, 502, 503) and attempt < 3:
                wait = 5 * 2 ** attempt
                print(f"  API {e.code}, retrying in {wait}s...")
                time.sleep(wait)
                continue
            sys.exit(f"Gemini API error {e.code}: {body}")
        except urllib.error.URLError as e:
            if attempt < 3:
                time.sleep(5 * 2 ** attempt)
                continue
            sys.exit(f"Network error calling Gemini: {e}")


def gemini_text(response):
    return response["candidates"][0]["content"]["parts"][0]["text"]


# ----------------------------------------------------------------- translate

def cmd_translate(args, config):
    scenes = load_scenes(args.script)
    glossary = load_glossary(args.glossary)
    languages = pick_languages(config, args.lang)
    (OUT_DIR / "scripts").mkdir(parents=True, exist_ok=True)

    glossary_text = "\n".join(f'- "{g["term"]}": {g["rule"]}' for g in glossary)
    narrations = [s["narration"] for s in scenes]

    for code, lang in languages.items():
        print(f"Translating -> {lang['name']} ({code})")
        prompt = (
            f"You are localizing narration for a video aimed at "
            f"{config['audience']}. Translate each line from "
            f"{config['source_language']} into {lang['name']}.\n"
            "Rules:\n"
            "- Natural spoken language a native-speaker child hears in "
            "stories, not literal translation.\n"
            "- Short sentences, simple words, keep the playful tone and "
            "sound effects.\n"
            "- Each translation should take roughly as long to read aloud "
            "as the original (it must fit the same video scene).\n"
            + (f"Glossary:\n{glossary_text}\n" if glossary_text else "")
            + "\nReturn ONLY a JSON array of strings, one per input line, "
            "same order, no commentary.\n\nLines:\n"
            + json.dumps(narrations, ensure_ascii=False, indent=2)
        )
        resp = gemini_call(config["translate_model"], {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.3,
                                 "responseMimeType": "application/json"},
        })
        text = gemini_text(resp)
        try:
            translated = json.loads(text)
        except json.JSONDecodeError:
            m = re.search(r"\[.*\]", text, re.S)
            translated = json.loads(m.group(0)) if m else None
        if not isinstance(translated, list) or len(translated) != len(scenes):
            sys.exit(f"Bad translation response for {code}:\n{text[:800]}")

        out_path = OUT_DIR / "scripts" / f"{code}.csv"
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["scene", "start", "duration", "visual", "narration"])
            for s, t in zip(scenes, translated):
                w.writerow([s["scene"], s["start"], s["duration"],
                            s["visual"], t])
        print(f"  wrote {rel(out_path)}")


# ----------------------------------------------------------------------- tts

def write_wav(path, pcm, rate=SAMPLE_RATE):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)


def wav_duration(path):
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / w.getframerate()


def make_silence(path, seconds):
    write_wav(path, b"\x00" * (2 * int(SAMPLE_RATE * seconds)))


def ffmpeg(args_list):
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error"] + args_list,
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"ffmpeg failed: {r.stderr.strip()}")


def tts_scene(config, lang, text):
    style = config["voice_style"]
    resp = gemini_call(config["tts_model"], {
        "contents": [{"parts": [{"text": f"{style}\n\nRead this aloud:\n{text}"}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {
                "voiceName": lang["voice"]}}},
        },
    })
    part = resp["candidates"][0]["content"]["parts"][0]["inlineData"]
    rate_m = re.search(r"rate=(\d+)", part.get("mimeType", ""))
    rate = int(rate_m.group(1)) if rate_m else SAMPLE_RATE
    return base64.b64decode(part["data"]), rate


def fit_to_slot(raw_wav, fitted_wav, slot, max_speedup):
    """Copy raw scene audio, sped up (never slowed) to fit its scene slot.

    The raw TTS file is never modified, so re-running assembly can't
    compound speed-ups.
    """
    dur = wav_duration(raw_wav)
    if dur <= slot:
        shutil.copyfile(raw_wav, fitted_wav)
        return
    factor = min(dur / slot, max_speedup)
    ffmpeg(["-i", str(raw_wav), "-filter:a", f"atempo={factor:.4f}",
            "-ar", str(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le",
            str(fitted_wav)])
    new_dur = wav_duration(fitted_wav)
    if new_dur > slot + 0.3:
        print(f"  WARNING: audio still {new_dur - slot:.1f}s over its "
              f"{slot:.0f}s slot after max speedup; it will spill into the "
              "gap before the next scene. Consider a shorter translation.")


def cmd_tts(args, config):
    if shutil.which("ffmpeg") is None:
        sys.exit("ffmpeg not found on PATH — install it first.")
    languages = pick_languages(config, args.lang)
    script_dir = Path(args.script_dir)

    for code, lang in languages.items():
        script = script_dir / f"{code}.csv"
        if not script.exists():
            sys.exit(f"{script} not found — run `translate` first.")
        scenes = load_scenes(script)
        audio_dir = OUT_DIR / "audio" / code
        audio_dir.mkdir(parents=True, exist_ok=True)
        print(f"Voicing {lang['name']} ({code}), {len(scenes)} scenes, "
              f"voice: {lang['voice']}")

        # One raw WAV per scene (cached), plus a fitted copy that is sped
        # up if the read overruns its scene slot.
        pieces = []  # (scene_start, fitted_wav_path, actual_duration)
        for s in scenes:
            wav = audio_dir / f"scene_{s['scene']}.wav"
            if wav.exists() and not args.force:
                print(f"  scene {s['scene']}: exists, skipping (use --force)")
            else:
                print(f"  scene {s['scene']}: generating...")
                pcm, rate = tts_scene(config, lang, s["narration"])
                write_wav(wav, pcm, rate)
                if rate != SAMPLE_RATE:
                    norm = wav.with_name(wav.stem + "_norm.wav")
                    ffmpeg(["-i", str(wav), "-ar", str(SAMPLE_RATE), "-ac",
                            "1", "-c:a", "pcm_s16le", str(norm)])
                    shutil.move(str(norm), str(wav))
            fitted = audio_dir / f"scene_{s['scene']}.fit.wav"
            fit_to_slot(wav, fitted, s["duration"],
                        float(config.get("max_speedup", 1.25)))
            pieces.append((s["start"], fitted, wav_duration(fitted)))

        # Assemble the timeline: silence gaps + scene audio, concatenated.
        concat_list = audio_dir / "concat.txt"
        entries, pos = [], 0.0
        for i, (start, wav, dur) in enumerate(pieces):
            gap = start - pos
            if gap > 0.01:
                sil = audio_dir / f"sil_{i}.wav"
                make_silence(sil, gap)
                entries.append(sil)
                pos += gap
            elif gap < -0.3:
                print(f"  WARNING: scene at {start}s overlaps previous audio "
                      f"by {-gap:.1f}s")
            entries.append(wav)
            pos += dur
        # Pad to the scripted end so the track never cuts the video short.
        timeline_end = max(s["start"] + s["duration"] for s in scenes)
        if timeline_end - pos > 0.01:
            tail = audio_dir / "sil_tail.wav"
            make_silence(tail, timeline_end - pos)
            entries.append(tail)
        concat_list.write_text(
            "".join(f"file '{p.name}'\n" for p in entries), encoding="utf-8")

        full = audio_dir / "full.wav"
        ffmpeg(["-f", "concat", "-safe", "0", "-i", str(concat_list),
                "-c", "copy", str(full)])
        (OUT_DIR / "tracks").mkdir(parents=True, exist_ok=True)
        track = OUT_DIR / "tracks" / f"{code}.m4a"
        ffmpeg(["-i", str(full), "-c:a", "aac", "-b:a", "192k", str(track)])
        print(f"  wrote {rel(track)} "
              f"({wav_duration(full):.1f}s)")


# ----------------------------------------------------------------------- mux

def cmd_mux(args, config):
    if shutil.which("ffmpeg") is None:
        sys.exit("ffmpeg not found on PATH — install it first.")
    languages = pick_languages(config, args.lang)
    video = Path(args.video)
    if not video.exists():
        sys.exit(f"Video not found: {video}")
    (OUT_DIR / "videos").mkdir(parents=True, exist_ok=True)

    tracks = {}
    for code in languages:
        t = OUT_DIR / "tracks" / f"{code}.m4a"
        if not t.exists():
            sys.exit(f"{t} not found — run `tts` first.")
        tracks[code] = t

    if args.multitrack:
        # One MP4 carrying every language as a selectable audio track.
        out = OUT_DIR / "videos" / "multitrack.mp4"
        cmd = ["-i", str(video)]
        for t in tracks.values():
            cmd += ["-i", str(t)]
        cmd += ["-map", "0:v"]
        for i in range(len(tracks)):
            cmd += ["-map", f"{i + 1}:a"]
        cmd += ["-c", "copy"]
        for i, code in enumerate(tracks):
            cmd += [f"-metadata:s:a:{i}",
                    f"language={ISO_639_2.get(code, 'und')}"]
            cmd += [f"-disposition:a:{i}", "default" if i == 0 else "0"]
        ffmpeg(cmd + [str(out)])
        print(f"wrote {rel(out)}")
        return

    for code in tracks:
        out = OUT_DIR / "videos" / f"{code}.mp4"
        if args.mix_original > 0:
            # Keep the video's own audio (music/ambience) under the voice.
            ffmpeg(["-i", str(video), "-i", str(tracks[code]),
                    "-filter_complex",
                    f"[0:a]volume={args.mix_original}[bg];"
                    "[bg][1:a]amix=inputs=2:duration=first:normalize=0[a]",
                    "-map", "0:v", "-map", "[a]", "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "192k", "-shortest",
                    "-metadata:s:a:0",
                    f"language={ISO_639_2.get(code, 'und')}", str(out)])
        else:
            ffmpeg(["-i", str(video), "-i", str(tracks[code]),
                    "-map", "0:v", "-map", "1:a", "-c", "copy",
                    "-metadata:s:a:0",
                    f"language={ISO_639_2.get(code, 'und')}", str(out)])
        print(f"wrote {rel(out)}")


# ---------------------------------------------------------------------- main

def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--lang", nargs="*", default=None,
                        help="Language codes to process (default: all in config)")

    t = sub.add_parser("translate", parents=[common],
                       help="Translate the master script into each language")
    t.add_argument("--script", required=True, help="Master script CSV")
    t.add_argument("--glossary", default=str(BASE_DIR / "glossary.csv"),
                   help="Glossary CSV (term,rule)")

    s = sub.add_parser("tts", parents=[common],
                       help="Generate voiceover and build synced audio tracks")
    s.add_argument("--script-dir", default=str(OUT_DIR / "scripts"))
    s.add_argument("--force", action="store_true",
                   help="Regenerate scenes that already have audio")

    m = sub.add_parser("mux", parents=[common],
                       help="Attach audio tracks to the video")
    m.add_argument("--video", required=True, help="Language-neutral video file")
    m.add_argument("--multitrack", action="store_true",
                   help="One MP4 with all languages instead of one MP4 each")
    m.add_argument("--mix-original", type=float, default=0.0, metavar="VOL",
                   help="Mix the video's own audio under the voice at this "
                        "volume (0-1, e.g. 0.25). Default: replace it.")

    a = sub.add_parser("all", parents=[common],
                       help="translate + tts + mux in one go")
    a.add_argument("--script", required=True)
    a.add_argument("--glossary", default=str(BASE_DIR / "glossary.csv"))
    a.add_argument("--video", required=True)
    a.add_argument("--multitrack", action="store_true")
    a.add_argument("--mix-original", type=float, default=0.0)
    a.add_argument("--force", action="store_true")

    args = p.parse_args()
    config = load_config()

    if args.command == "translate":
        cmd_translate(args, config)
    elif args.command == "tts":
        cmd_tts(args, config)
    elif args.command == "mux":
        cmd_mux(args, config)
    elif args.command == "all":
        cmd_translate(args, config)
        args.script_dir = str(OUT_DIR / "scripts")
        cmd_tts(args, config)
        cmd_mux(args, config)


if __name__ == "__main__":
    main()
