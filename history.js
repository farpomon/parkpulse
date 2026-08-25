// Historical wait-time collection and baselines.
//
// Every collection cycle appends one compact JSONL line per park to a daily
// file (data/history/YYYY-MM-DD.jsonl):
//   {"t":"2026-08-17T15:00:00Z","park":"epcot","rides":{"Test Track":45,...}}
// Closed rides are omitted. Only live-feed data is recorded — never samples.
//
// Baselines are per-ride medians over the last BASELINE_DAYS of snapshots,
// recomputed periodically; they power the app's "vs typical" deltas and
// are the raw material for future wait predictions.

const fs = require('node:fs');
const path = require('node:path');

// The archive lives beside the database, because it is the same kind of thing:
// state that must outlive the container. It used to default to a path inside
// the repo and need its own variable, which meant a deployment could mount a
// volume, point DB_FILE at it, look completely correct -- and still discard
// every wait snapshot on each redeploy, silently zeroing the day-of-week model
// that the crowd forecast is built on. One volume, one variable, both persist.
// HISTORY_DIR remains an explicit override for anyone who wants them apart.
const DB_DIR = process.env.DB_FILE ? path.dirname(process.env.DB_FILE) : path.join(__dirname, 'data');
const HISTORY_DIR = process.env.HISTORY_DIR || path.join(DB_DIR, 'history');
const BASELINE_DAYS = 14;
const RETENTION_DAYS = 60;
const MIN_SAMPLES = 12; // ~3 hours of snapshots before we trust a median

fs.mkdirSync(HISTORY_DIR, { recursive: true });

const dayFile = (d) => path.join(HISTORY_DIR, `${d.toISOString().slice(0, 10)}.jsonl`);

function record(slug, waits) {
  if (waits.source !== 'live') return false;
  const rides = {};
  for (const r of waits.rides) {
    if (r.open && Number.isFinite(r.wait)) rides[r.name] = r.wait;
  }
  if (!Object.keys(rides).length) return false;
  const line = JSON.stringify({ t: new Date().toISOString(), park: slug, rides });
  fs.appendFileSync(dayFile(new Date()), line + '\n');
  return true;
}

function prune() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  for (const f of fs.readdirSync(HISTORY_DIR)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && new Date(m[1]).getTime() < cutoff) {
      try { fs.unlinkSync(path.join(HISTORY_DIR, f)); } catch {}
    }
  }
}

// Returns {slug: Map(normalizedRideName -> medianWait)} from recent history.
function computeBaselines(normName) {
  const samples = {}; // slug -> normName -> number[]
  for (let i = 0; i < BASELINE_DAYS; i++) {
    const file = dayFile(new Date(Date.now() - i * 86400000));
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const park = (samples[entry.park] ??= {});
      for (const [name, wait] of Object.entries(entry.rides || {})) {
        (park[normName(name)] ??= []).push(wait);
      }
    }
  }
  const baselines = {};
  for (const [slug, rides] of Object.entries(samples)) {
    const map = new Map();
    for (const [key, values] of Object.entries(rides)) {
      if (values.length < MIN_SAMPLES) continue;
      values.sort((a, b) => a - b);
      map.set(key, values[Math.floor(values.length / 2)]);
    }
    if (map.size) baselines[slug] = map;
  }
  return baselines;
}

// Day-of-week crowd index per park: how each weekday's average wait compares
// to the park's overall average, plus how many distinct days back it. Powers
// the 7-day forecast (blended with priors until enough history accrues).
function computeDowIndex() {
  const perParkDay = {}; // slug -> date -> {sum, n}
  for (const f of fs.readdirSync(HISTORY_DIR)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m) continue;
    let content;
    try { content = fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const waits = Object.values(e.rides || {});
      if (!waits.length) continue;
      const d = ((perParkDay[e.park] ??= {})[m[1]] ??= { sum: 0, n: 0 });
      d.sum += waits.reduce((s, w) => s + w, 0);
      d.n += waits.length;
    }
  }
  const out = {};
  for (const [slug, days] of Object.entries(perParkDay)) {
    const byDow = [[], [], [], [], [], [], []];
    const all = [];
    for (const [date, { sum, n }] of Object.entries(days)) {
      if (n < 20) continue; // ignore days with barely any snapshots
      const avg = sum / n;
      byDow[new Date(`${date}T12:00:00Z`).getUTCDay()].push(avg);
      all.push(avg);
    }
    if (all.length < 3) continue;
    const overall = all.reduce((s, v) => s + v, 0) / all.length;
    out[slug] = {
      factors: byDow.map((v) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length / overall : null)),
      days: all.length,
    };
  }
  return out;
}

function stats() {
  let files = 0, bytes = 0;
  for (const f of fs.readdirSync(HISTORY_DIR)) {
    if (!f.endsWith('.jsonl')) continue;
    files += 1;
    try { bytes += fs.statSync(path.join(HISTORY_DIR, f)).size; } catch {}
  }
  return { files, bytes };
}

module.exports = { record, prune, computeBaselines, computeDowIndex, stats, HISTORY_DIR };
