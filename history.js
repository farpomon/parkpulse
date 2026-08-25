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

// --- Wait bands by crowd level ----------------------------------------------
// The table that turns "45 min" into "45 is bad for a Tuesday": for each ride,
// the range of waits observed on days that turned out to be each crowd level.
//
// Two decisions worth stating.
//
// Days are bucketed by the level they ACTUALLY were, measured from that day's
// own snapshots, not by the level the forecast predicted. Predicting a 4 and
// bucketing by that prediction would make the table agree with the forecast by
// construction and teach us nothing. The thresholds are the forecast's, so the
// two scales line up: "tomorrow is a 4" and "this ride runs 45-70 at a 4" are
// the same 4.
//
// The published figure is the 25th-75th percentile -- the middle half of what
// was seen. A mean is dragged around by one breakdown or one early close; the
// interquartile band is what a visitor can actually plan against, and stating
// a range rather than a point is honest about what a queue is.

// Same cut points as forecastFor(), deliberately.
const levelOf = (factor) => (factor < 0.88 ? 1 : factor < 0.97 ? 2 : factor < 1.07 ? 3 : factor < 1.22 ? 4 : 5);

const BAND_MIN_OBS = 20;  // observations before a cell is publishable
const BAND_MIN_DAYS = 2;  // distinct days, so one odd day cannot define a level
const BAND_CAP = 400;     // minutes; anything above is almost certainly a data error

// Percentiles come out of a count histogram rather than a sorted array: exact,
// and it keeps memory flat no matter how many months accumulate.
function histPercentile(counts, total, p) {
  if (!total) return null;
  const target = (total - 1) * p;
  let seen = 0;
  for (let v = 0; v <= BAND_CAP; v++) {
    const c = counts[v];
    if (!c) continue;
    if (seen + c > target) return v;
    seen += c;
  }
  return BAND_CAP;
}

function eachLine(fn) {
  let files;
  try { files = fs.readdirSync(HISTORY_DIR); } catch { return; }
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m) continue;
    let content;
    try { content = fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line) continue;
      // Parse failures are expected -- a torn last line after a hard restart --
      // and are skipped. Errors from the callback are NOT: wrapping those too
      // turns any bug in a consumer into silently empty results with nothing
      // logged anywhere, which is exactly how a broken curve went unnoticed.
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      fn(entry, m[1]);
    }
  }
}

// How busy each recorded day actually turned out to be, per park, on the
// forecast's own 1-5 scale. Shared by the bands table and the hourly curve so
// the two can never disagree about what a level 4 day was.
function computeDayLevels() {
  const dayTotals = {}; // slug -> date -> {sum, n}
  eachLine((e, date) => {
    const waits = Object.values(e.rides || {});
    if (!waits.length) return;
    const d = ((dayTotals[e.park] ??= {})[date] ??= { sum: 0, n: 0 });
    d.sum += waits.reduce((a, b) => a + b, 0);
    d.n += waits.length;
  });

  // A park's own median day is its 1.0. Median, not mean, so a single holiday
  // week does not redefine what normal looks like for that park.
  const dayLevel = {}; // slug -> date -> level
  for (const [slug, days] of Object.entries(dayTotals)) {
    const means = Object.values(days).map((d) => d.sum / d.n).sort((a, b) => a - b);
    if (means.length < BAND_MIN_DAYS) continue;
    const mid = means.length % 2 ? means[(means.length - 1) / 2]
      : (means[means.length / 2 - 1] + means[means.length / 2]) / 2;
    if (!mid) continue;
    dayLevel[slug] = {};
    for (const [date, d] of Object.entries(days)) dayLevel[slug][date] = levelOf((d.sum / d.n) / mid);
  }
  return dayLevel;
}

function computeCrowdBands(normName = (s) => s) {
  const dayLevel = computeDayLevels();

  // Pass 2 -- histogram every observation into (park, ride, level).
  const cells = {}; // slug -> key -> level -> {counts, total, days:Set, name}
  eachLine((e, date) => {
    const level = dayLevel[e.park]?.[date];
    if (!level) return;
    const park = (cells[e.park] ??= {});
    for (const [name, wait] of Object.entries(e.rides || {})) {
      if (!Number.isFinite(wait) || wait < 0 || wait > BAND_CAP) continue;
      const ride = (park[normName(name)] ??= { name, levels: {} });
      const cell = (ride.levels[level] ??= { counts: new Uint32Array(BAND_CAP + 1), total: 0, days: new Set() });
      cell.counts[wait] += 1;
      cell.total += 1;
      cell.days.add(date);
    }
  });

  const out = {};
  for (const [slug, rides] of Object.entries(cells)) {
    const rows = [];
    for (const ride of Object.values(rides)) {
      const levels = {};
      let publishable = 0;
      for (const [lvl, c] of Object.entries(ride.levels)) {
        if (c.total < BAND_MIN_OBS || c.days.size < BAND_MIN_DAYS) continue;
        levels[lvl] = {
          low: histPercentile(c.counts, c.total, 0.25),
          high: histPercentile(c.counts, c.total, 0.75),
          typical: histPercentile(c.counts, c.total, 0.5),
          days: c.days.size,
        };
        publishable += 1;
      }
      if (publishable) rows.push({ name: ride.name, levels });
    }
    // Busiest first: the rides people actually screenshot.
    rows.sort((a, b) => {
      const peak = (r) => Math.max(...Object.values(r.levels).map((l) => l.high), 0);
      return peak(b) - peak(a);
    });
    if (rows.length) out[slug] = rows;
  }
  return out;
}

// --- Hourly wait curves ------------------------------------------------------
// How the posted wait moves through the day, per park, per crowd level. The
// hour is the hour in the PARK's timezone -- a curve plotted in UTC would put
// Tokyo's rope drop in the middle of the night.
//
// One honest limit, stated here because it shapes what can be drawn from this:
// every figure is a POSTED wait, the number on the sign. It is not how long
// anyone actually stood in line. We do not collect observed queue times, so
// nothing downstream should claim to plot them.

const CURVE_MIN_OBS = 8; // observations before an hour is publishable

function computeHourlyCurves(normName = (s) => s, tzOf = () => 'UTC') {
  const dayLevel = computeDayLevels();
  const fmt = {}; // one cached formatter per timezone; Intl construction is the cost
  const hourIn = (tz, iso) => {
    const f = (fmt[tz] ??= new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }));
    const h = parseInt(f.format(new Date(iso)), 10);
    return Number.isFinite(h) ? h % 24 : null;
  };

  // slug -> level -> hour -> {counts, total}
  const cells = {};
  eachLine((e, date) => {
    const level = dayLevel[e.park]?.[date];
    if (!level) return;
    const hour = hourIn(tzOf(e.park) || 'UTC', e.t);
    if (hour === null) return;
    const waits = Object.values(e.rides || {}).filter((w) => Number.isFinite(w) && w >= 0 && w <= BAND_CAP);
    if (!waits.length) return;
    const cell = (((cells[e.park] ??= {})[level] ??= {})[hour] ??= { counts: new Uint32Array(BAND_CAP + 1), total: 0 });
    for (const w of waits) { cell.counts[w] += 1; cell.total += 1; }
  });

  const out = {};
  for (const [slug, levels] of Object.entries(cells)) {
    const byLevel = {};
    for (const [lvl, hours] of Object.entries(levels)) {
      const points = [];
      for (const [h, c] of Object.entries(hours)) {
        if (c.total < CURVE_MIN_OBS) continue;
        points.push({
          hour: Number(h),
          median: histPercentile(c.counts, c.total, 0.5),
          low: histPercentile(c.counts, c.total, 0.25),
          high: histPercentile(c.counts, c.total, 0.75),
          n: c.total,
        });
      }
      points.sort((a, b) => a.hour - b.hour);
      if (points.length >= 3) byLevel[lvl] = points;
    }
    if (Object.keys(byLevel).length) out[slug] = byLevel;
  }
  return out;
}

module.exports = { record, prune, computeBaselines, computeDowIndex, computeCrowdBands, computeHourlyCurves, stats, HISTORY_DIR };
