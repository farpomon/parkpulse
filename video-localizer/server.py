#!/usr/bin/env python3
"""Web UI for the video localizer, deployable on Railway.

Upload a master script (and optionally a glossary and the video), pick
languages, and download the per-language audio tracks / dubbed MP4s.
Jobs run one at a time in a background worker that shells out to
localize.py with a per-job output directory.

Environment:
  GEMINI_API_KEY   required for jobs to run
  APP_PASSWORD     optional; if set, the whole app requires this password
                   (HTTP Basic auth, any username)
  PORT             listen port (Railway sets this; default 8080)

Python stdlib only. Run: python3 server.py
"""

import base64
import html
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
JOBS_DIR = BASE_DIR / "jobs"
CONFIG = json.loads((BASE_DIR / "config.json").read_text(encoding="utf-8"))

job_queue = queue.Queue()

STYLE = """
body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;
padding:0 1rem;background:#fffdf7;color:#333}
h1{font-size:1.4rem}fieldset{border:1px solid #ddd;border-radius:8px;
margin:1rem 0;padding:1rem}label{display:block;margin:.4rem 0}
button{background:#5b8def;color:#fff;border:0;border-radius:6px;
padding:.6rem 1.4rem;font-size:1rem;cursor:pointer}
pre{background:#1e1e1e;color:#d7d7d7;padding:1rem;border-radius:8px;
overflow-x:auto;font-size:.85rem;max-height:24rem;overflow-y:auto}
a{color:#3563c4}.ok{color:#1a7f37}.err{color:#c0392b}
ul.files li{margin:.3rem 0}
"""


def page(title, body, refresh=None):
    meta = f'<meta http-equiv="refresh" content="{refresh}">' if refresh else ""
    return (f"<!doctype html><html><head><meta charset='utf-8'>{meta}"
            f"<meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<title>{html.escape(title)}</title><style>{STYLE}</style></head>"
            f"<body><h1>{html.escape(title)}</h1>{body}</body></html>").encode()


# ------------------------------------------------------------------- worker

def set_status(job_dir, **kv):
    status_file = job_dir / "status.json"
    status = json.loads(status_file.read_text()) if status_file.exists() else {}
    status.update(kv)
    status_file.write_text(json.dumps(status))


def run_step(job_dir, log, argv):
    env = dict(os.environ, LOCALIZER_OUT=str(job_dir / "out"))
    with open(log, "a", encoding="utf-8") as lf:
        lf.write(f"\n$ {' '.join(argv[1:])}\n")
        lf.flush()
        r = subprocess.run(argv, stdout=lf, stderr=subprocess.STDOUT,
                           env=env, cwd=BASE_DIR)
    if r.returncode != 0:
        raise RuntimeError(f"step failed (see log): {' '.join(argv[2:4])}")


def run_job(job_dir):
    params = json.loads((job_dir / "params.json").read_text())
    log = job_dir / "log.txt"
    loc = [sys.executable, str(BASE_DIR / "localize.py")]
    langs = params["langs"]
    try:
        set_status(job_dir, state="running", step="translate")
        cmd = loc + ["translate", "--script", str(job_dir / "in" / "script.csv"),
                     "--lang"] + langs
        if (job_dir / "in" / "glossary.csv").exists():
            cmd += ["--glossary", str(job_dir / "in" / "glossary.csv")]
        run_step(job_dir, log, cmd)

        set_status(job_dir, step="tts")
        run_step(job_dir, log, loc + ["tts", "--script-dir",
                                      str(job_dir / "out" / "scripts"),
                                      "--lang"] + langs)

        video = next((job_dir / "in").glob("video.*"), None)
        if video:
            set_status(job_dir, step="mux")
            cmd = loc + ["mux", "--video", str(video), "--lang"] + langs
            if params.get("multitrack"):
                cmd += ["--multitrack"]
            if params.get("mix_original"):
                cmd += ["--mix-original", str(params["mix_original"])]
            run_step(job_dir, log, cmd)

        set_status(job_dir, state="done", step="")
    except Exception as e:
        with open(log, "a", encoding="utf-8") as lf:
            lf.write(f"\nERROR: {e}\n")
        set_status(job_dir, state="error", step="")


def worker():
    while True:
        run_job(job_queue.get())


# ------------------------------------------------------------------ uploads

def parse_multipart(body, content_type):
    """Minimal multipart/form-data parser: returns {name: (filename, bytes)}."""
    m = re.search(r'boundary="?([^";]+)"?', content_type)
    if not m:
        return {}
    boundary = b"--" + m.group(1).encode()
    fields = {}
    for part in body.split(boundary):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        if b"\r\n\r\n" not in part:
            continue
        header_blob, value = part.split(b"\r\n\r\n", 1)
        headers = header_blob.decode(errors="replace")
        name_m = re.search(r'name="([^"]+)"', headers)
        if not name_m:
            continue
        file_m = re.search(r'filename="([^"]*)"', headers)
        fields.setdefault(name_m.group(1), []).append(
            (file_m.group(1) if file_m else None, value))
    return fields


# ------------------------------------------------------------------ handler

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_page(self, data, code=200, ctype="text/html; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def check_auth(self):
        password = os.environ.get("APP_PASSWORD")
        if not password:
            return True
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Basic "):
            try:
                decoded = base64.b64decode(auth[6:]).decode()
                if decoded.split(":", 1)[-1] == password:
                    return True
            except Exception:
                pass
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="video-localizer"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def do_GET(self):
        if not self.check_auth():
            return
        if self.path == "/":
            return self.send_page(page("Video Localizer", self.form_html()))
        m = re.fullmatch(r"/jobs/([0-9a-f]{12})", self.path)
        if m:
            return self.job_page(m.group(1))
        m = re.fullmatch(r"/jobs/([0-9a-f]{12})/files/([\w./-]+)", self.path)
        if m:
            return self.serve_file(m.group(1), m.group(2))
        self.send_page(page("Not found", "<p>Nothing here.</p>"), 404)

    def do_POST(self):
        if not self.check_auth():
            return
        if self.path != "/jobs":
            return self.send_page(page("Not found", ""), 404)
        length = int(self.headers.get("Content-Length", 0))
        if length > 2_000_000_000:
            return self.send_page(page("Too large", "<p>Upload too big.</p>"), 413)
        fields = parse_multipart(self.rfile.read(length),
                                 self.headers.get("Content-Type", ""))

        script = fields.get("script", [(None, b"")])[0][1]
        if not script.strip():
            return self.send_page(
                page("Missing script", "<p>The master script CSV is required. "
                     "<a href='/'>Back</a></p>"), 400)
        langs = [v[1].decode() for v in fields.get("lang", [])
                 if v[1].decode() in CONFIG["languages"]]
        if not langs:
            return self.send_page(
                page("No languages", "<p>Pick at least one language. "
                     "<a href='/'>Back</a></p>"), 400)

        job_id = uuid.uuid4().hex[:12]
        job_dir = JOBS_DIR / job_id
        (job_dir / "in").mkdir(parents=True)
        (job_dir / "out").mkdir()
        (job_dir / "in" / "script.csv").write_bytes(script)
        glossary = fields.get("glossary", [(None, b"")])[0]
        if glossary[1].strip():
            (job_dir / "in" / "glossary.csv").write_bytes(glossary[1])
        video = fields.get("video", [(None, b"")])[0]
        if video[0] and video[1]:
            ext = Path(video[0]).suffix.lower() or ".mp4"
            (job_dir / "in" / f"video{ext}").write_bytes(video[1])

        mix = fields.get("mix_original", [(None, b"0")])[0][1].decode() or "0"
        try:
            mix_val = max(0.0, min(1.0, float(mix)))
        except ValueError:
            mix_val = 0.0
        (job_dir / "params.json").write_text(json.dumps({
            "langs": langs,
            "multitrack": "multitrack" in fields,
            "mix_original": mix_val,
            "created": time.time(),
        }))
        (job_dir / "log.txt").write_text("")
        set_status(job_dir, state="queued", step="")
        job_queue.put(job_dir)

        self.send_response(303)
        self.send_header("Location", f"/jobs/{job_id}")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def form_html(self):
        langs = "".join(
            f"<label><input type='checkbox' name='lang' value='{c}' checked> "
            f"{html.escape(l['name'])} — voice: {html.escape(l['voice'])}</label>"
            for c, l in CONFIG["languages"].items())
        key_warn = ("" if os.environ.get("GEMINI_API_KEY") else
                    "<p class='err'>⚠ GEMINI_API_KEY is not set — jobs will "
                    "fail until you add it to the environment.</p>")
        return f"""{key_warn}
<form method="post" action="/jobs" enctype="multipart/form-data">
<fieldset><legend>Master script (required)</legend>
<p>CSV with columns: scene, start, duration, visual, narration.</p>
<input type="file" name="script" accept=".csv" required>
</fieldset>
<fieldset><legend>Glossary (optional)</legend>
<p>CSV with columns: term, rule — keeps character names consistent.</p>
<input type="file" name="glossary" accept=".csv">
</fieldset>
<fieldset><legend>Video (optional)</legend>
<p>The language-neutral video. Leave empty to get audio tracks only
(for YouTube multi-language audio, tracks are all you need).</p>
<input type="file" name="video" accept="video/*">
<label><input type="checkbox" name="multitrack"> One MP4 with all
languages as selectable tracks (instead of one MP4 per language)</label>
<label>Keep original audio under the voice at volume (0–1, 0 = replace):
<input type="number" name="mix_original" min="0" max="1" step="0.05"
value="0"></label>
</fieldset>
<fieldset><legend>Languages</legend>{langs}
<p>Voices are set in config.json.</p></fieldset>
<button>Localize</button>
</form>"""

    def job_page(self, job_id):
        job_dir = JOBS_DIR / job_id
        if not job_dir.exists():
            return self.send_page(page("Not found", "<p>No such job.</p>"), 404)
        status = json.loads((job_dir / "status.json").read_text())
        state = status.get("state", "?")
        log_text = (job_dir / "log.txt").read_text(encoding="utf-8",
                                                   errors="replace")[-8000:]
        files = []
        for sub in ("tracks", "videos", "scripts"):
            d = job_dir / "out" / sub
            if d.is_dir():
                files += sorted(f"{sub}/{f.name}" for f in d.iterdir())
        file_list = "".join(
            f"<li><a href='/jobs/{job_id}/files/{f}'>{html.escape(f)}</a></li>"
            for f in files)
        badge = {"done": "<p class='ok'>✔ Done</p>",
                 "error": "<p class='err'>✘ Failed — see log below</p>"}.get(
            state, f"<p>⏳ {state} {html.escape(status.get('step', ''))}...</p>")
        body = (f"{badge}"
                + (f"<h2>Downloads</h2><ul class='files'>{file_list}</ul>"
                   if files else "")
                + f"<h2>Log</h2><pre>{html.escape(log_text) or '(empty)'}</pre>"
                + "<p><a href='/'>← New job</a></p>")
        refresh = None if state in ("done", "error") else 3
        self.send_page(page(f"Job {job_id}", body, refresh=refresh))

    def serve_file(self, job_id, relpath):
        path = (JOBS_DIR / job_id / "out" / relpath).resolve()
        if not str(path).startswith(str((JOBS_DIR / job_id).resolve())) \
                or not path.is_file():
            return self.send_page(page("Not found", "<p>No such file.</p>"), 404)
        ctype = {"m4a": "audio/mp4", "mp4": "video/mp4",
                 "csv": "text/csv"}.get(path.suffix.lstrip("."),
                                        "application/octet-stream")
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Disposition",
                         f'attachment; filename="{path.name}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.address_string()} {fmt % args}\n")


def main():
    JOBS_DIR.mkdir(exist_ok=True)
    if shutil.which("ffmpeg") is None:
        print("WARNING: ffmpeg not found — jobs will fail.", file=sys.stderr)
    threading.Thread(target=worker, daemon=True).start()
    port = int(os.environ.get("PORT", 8080))
    print(f"video-localizer listening on :{port}")
    ThreadingHTTPServer(("", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
