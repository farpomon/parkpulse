// Historical wait-time collection and baselines.
//
// Every collection cycle appends one compact JSONL line per park to a daily
// file (data/history/YYYY-MM-DD.jsonl):
//   {"t":"2026-08-17T15:00:00Z","park":"epcot","rides":{"Test Track":45,...}}
// Closed rides are omitted. Only live-feed data is recorded — never samples.
//
// Baselines are per-ride medians over the last BASELINE_DAYS of snapshots,
// recomputed periodically; they power the app's "vs typical" deltas and
// are the raw material for future wait predictions. Point HISTORY_DIR at a
// mounted volume in production or the archive dies with each deploy.

const fs = require('node:fs');
const path = require('node:path');

const HISTORY_DIR = process.env.HISTORY_DIR || path.join(__dirname, 'data', 'history');
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

function stats() {
  let files = 0, bytes = 0;
  for (const f of fs.readdirSync(HISTORY_DIR)) {
    if (!f.endsWith('.jsonl')) continue;
    files += 1;
    try { bytes += fs.statSync(path.join(HISTORY_DIR, f)).size; } catch {}
  }
  return { files, bytes };
}

module.exports = { record, prune, computeBaselines, stats, HISTORY_DIR };
