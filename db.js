// SQLite data layer (node:sqlite — built in, no native deps; requires Node 22.5+).
// One file holds users, passes, alerts, leads, and key-value config. Point
// DB_FILE at the mounted volume in production (e.g. /data/parkpulse.db).
//
// On first boot with an empty database, any legacy flat files (users.json,
// alerts.json, passes.jsonl, leads.jsonl, vapid.json) are imported so
// existing accounts and alerts survive the migration. Legacy files are left
// in place untouched; each table imports only when it is empty.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'parkpulse.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    plan TEXT,
    plan_exp INTEGER,
    reset_token TEXT,
    reset_exp INTEGER
  );
  CREATE TABLE IF NOT EXISTS passes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan TEXT NOT NULL,
    stripe_session TEXT,
    email TEXT,
    at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL,
    subscription TEXT NOT NULL,
    park TEXT NOT NULL,
    ride TEXT NOT NULL,
    threshold INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS alerts_park ON alerts (park);
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    plan TEXT,
    at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hits (
    day TEXT NOT NULL,
    path TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, path)
  );
  CREATE TABLE IF NOT EXISTS advisor_memory (
    email TEXT PRIMARY KEY,
    notes TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS advisor_chats (
    email TEXT PRIMARY KEY,
    messages TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ride_info (
    park TEXT NOT NULL,
    ride TEXT NOT NULL,
    lang TEXT NOT NULL,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (park, ride, lang)
  );
  CREATE TABLE IF NOT EXISTS dining (
    park TEXT NOT NULL,
    lang TEXT NOT NULL,
    json TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (park, lang)
  );
  CREATE TABLE IF NOT EXISTS ride_tags (
    park TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trips (
    email TEXT PRIMARY KEY,
    dest TEXT NOT NULL,
    start TEXT NOT NULL,
    days INTEGER NOT NULL,
    plan TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS advisor_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    park TEXT,
    vote TEXT NOT NULL,
    message TEXT,
    at TEXT NOT NULL
  );
`);

// --- Legacy flat-file import (runs once per empty table) ---------------------
function migrateLegacy() {
  const readJson = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch { return null; }
  };
  const readJsonl = (name) => {
    try {
      return fs.readFileSync(path.join(DATA_DIR, name), 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  };
  const empty = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n === 0;
  let migrated = [];

  if (empty('users')) {
    const legacy = readJson('users.json');
    if (legacy && Object.keys(legacy).length) {
      const ins = db.prepare('INSERT OR IGNORE INTO users (email, salt, hash, created_at, plan, plan_exp) VALUES (?, ?, ?, ?, ?, ?)');
      for (const [email, u] of Object.entries(legacy)) {
        ins.run(email, u.salt, u.hash, u.createdAt || new Date().toISOString(), u.pass?.plan ?? null, u.pass?.exp ?? null);
      }
      migrated.push(`users:${Object.keys(legacy).length}`);
    }
  }
  if (empty('alerts')) {
    const legacy = readJson('alerts.json');
    if (Array.isArray(legacy) && legacy.length) {
      const ins = db.prepare('INSERT INTO alerts (endpoint, subscription, park, ride, threshold, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const a of legacy) {
        ins.run(a.subscription.endpoint, JSON.stringify(a.subscription), a.park, a.ride, a.threshold, a.createdAt || new Date().toISOString());
      }
      migrated.push(`alerts:${legacy.length}`);
    }
  }
  if (empty('passes')) {
    const legacy = readJsonl('passes.jsonl');
    if (legacy.length) {
      const ins = db.prepare('INSERT INTO passes (plan, stripe_session, email, at) VALUES (?, ?, ?, ?)');
      for (const p of legacy) ins.run(p.plan, p.session ?? null, p.email ?? null, p.at || new Date().toISOString());
      migrated.push(`passes:${legacy.length}`);
    }
  }
  if (empty('leads')) {
    const legacy = readJsonl('leads.jsonl');
    if (legacy.length) {
      const ins = db.prepare('INSERT INTO leads (email, plan, at) VALUES (?, ?, ?)');
      for (const l of legacy) ins.run(l.email, l.plan ?? null, l.at || new Date().toISOString());
      migrated.push(`leads:${legacy.length}`);
    }
  }
  if (!kv.get('vapid')) {
    const legacy = readJson('vapid.json');
    if (legacy?.publicKey) { kv.set('vapid', JSON.stringify(legacy)); migrated.push('vapid'); }
  }
  if (migrated.length) console.log(`DB migration imported legacy data: ${migrated.join(', ')}`);
}

// --- Helpers -----------------------------------------------------------------
const kv = {
  get: (key) => db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null,
  set: (key, value) => db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value),
};

const users = {
  get: (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email) ?? null,
  create: (email, salt, hash) =>
    db.prepare('INSERT INTO users (email, salt, hash, created_at) VALUES (?, ?, ?, ?)').run(email, salt, hash, new Date().toISOString()),
  grant: (email, plan, exp) =>
    db.prepare('UPDATE users SET plan = ?, plan_exp = ? WHERE email = ?').run(plan, exp, email),
  setResetToken: (email, token, exp) =>
    db.prepare('UPDATE users SET reset_token = ?, reset_exp = ? WHERE email = ?').run(token, exp, email),
  resetPassword: (email, salt, hash) =>
    db.prepare('UPDATE users SET salt = ?, hash = ?, reset_token = NULL, reset_exp = NULL WHERE email = ?').run(salt, hash, email),
};

const alerts = {
  all: () => db.prepare('SELECT * FROM alerts').all(),
  parks: () => db.prepare('SELECT DISTINCT park FROM alerts').all().map((r) => r.park),
  byPark: (park) => db.prepare('SELECT * FROM alerts WHERE park = ?').all(park),
  add: (subscription, park, ride, threshold) => {
    db.prepare('DELETE FROM alerts WHERE endpoint = ? AND ride = ? COLLATE NOCASE').run(subscription.endpoint, ride);
    return db.prepare('INSERT INTO alerts (endpoint, subscription, park, ride, threshold, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(subscription.endpoint, JSON.stringify(subscription), park, ride, threshold, new Date().toISOString()).lastInsertRowid;
  },
  remove: (id) => db.prepare('DELETE FROM alerts WHERE id = ?').run(id),
  removeByEndpoint: (endpoint, ride) => {
    const result = ride
      ? db.prepare('DELETE FROM alerts WHERE endpoint = ? AND ride = ? COLLATE NOCASE').run(endpoint, ride)
      : db.prepare('DELETE FROM alerts WHERE endpoint = ?').run(endpoint);
    return result.changes;
  },
};

const passes = {
  add: (plan, stripeSession, email) =>
    db.prepare('INSERT INTO passes (plan, stripe_session, email, at) VALUES (?, ?, ?, ?)').run(plan, stripeSession ?? null, email ?? null, new Date().toISOString()),
};

const leads = {
  add: (email, plan) =>
    db.prepare('INSERT INTO leads (email, plan, at) VALUES (?, ?, ?)').run(email, plan ?? null, new Date().toISOString()),
};

// Aggregate page-view counts — one number per page per day, nothing about who.
const hits = {
  bump: (p) => db.prepare('INSERT INTO hits (day, path, n) VALUES (?, ?, 1) ON CONFLICT(day, path) DO UPDATE SET n = n + 1')
    .run(new Date().toISOString().slice(0, 10), p),
  since: (days) => db.prepare('SELECT day, path, n FROM hits WHERE day >= ? ORDER BY day DESC, n DESC')
    .all(new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)),
  totals: (days) => db.prepare('SELECT path, SUM(n) AS n FROM hits WHERE day >= ? GROUP BY path ORDER BY n DESC')
    .all(new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)),
};

// Advisor state: per-account trip notes (the agent's `remember` tool), the
// saved conversation, and reply feedback votes.
const advisor = {
  getMemory: (email) => db.prepare('SELECT notes FROM advisor_memory WHERE email = ?').get(email)?.notes ?? null,
  setMemory: (email, notes) =>
    db.prepare('INSERT INTO advisor_memory (email, notes, updated_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET notes = excluded.notes, updated_at = excluded.updated_at')
      .run(email, notes, new Date().toISOString()),
  getChat: (email) => db.prepare('SELECT messages FROM advisor_chats WHERE email = ?').get(email)?.messages ?? null,
  saveChat: (email, messages) =>
    db.prepare('INSERT INTO advisor_chats (email, messages, updated_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at')
      .run(email, messages, new Date().toISOString()),
  addFeedback: (email, park, vote, message) =>
    db.prepare('INSERT INTO advisor_feedback (email, park, vote, message, at) VALUES (?, ?, ?, ?, ?)')
      .run(email ?? null, park ?? null, vote, message ?? null, new Date().toISOString()),
  feedbackSummary: (days) => {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    return {
      votes: db.prepare('SELECT vote, COUNT(*) AS n FROM advisor_feedback WHERE at >= ? GROUP BY vote').all(since),
      recentDown: db.prepare("SELECT park, message, at FROM advisor_feedback WHERE vote = 'down' AND at >= ? ORDER BY id DESC LIMIT 10").all(since),
    };
  },
};

// AI-generated one-time ride descriptions, cached forever per language.
const rideinfo = {
  get: (park, ride, lang) => db.prepare('SELECT text FROM ride_info WHERE park = ? AND ride = ? AND lang = ?').get(park, ride, lang)?.text ?? null,
  set: (park, ride, lang, name, text) =>
    db.prepare('INSERT OR REPLACE INTO ride_info (park, ride, lang, name, text, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(park, ride, lang, name, text, new Date().toISOString()),
};

// AI-generated park dining guides, cached per park per language.
const dining = {
  get: (park, lang) => db.prepare('SELECT json FROM dining WHERE park = ? AND lang = ?').get(park, lang)?.json ?? null,
  set: (park, lang, json) =>
    db.prepare('INSERT OR REPLACE INTO dining (park, lang, json, at) VALUES (?, ?, ?, ?)').run(park, lang, json, new Date().toISOString()),
};

// AI-classified ride tags (vibe + age band) per park, cached.
const ridetags = {
  get: (park) => db.prepare('SELECT json FROM ride_tags WHERE park = ?').get(park)?.json ?? null,
  set: (park, json) => db.prepare('INSERT OR REPLACE INTO ride_tags (park, json, at) VALUES (?, ?, ?)').run(park, json, new Date().toISOString()),
};

// Multi-day trip plans, one per account (the current/next trip).
const trips = {
  get: (email) => db.prepare('SELECT dest, start, days, plan FROM trips WHERE email = ?').get(email) ?? null,
  set: (email, dest, start, days, plan) =>
    db.prepare('INSERT INTO trips (email, dest, start, days, plan, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET dest = excluded.dest, start = excluded.start, days = excluded.days, plan = excluded.plan, updated_at = excluded.updated_at')
      .run(email, dest, start, days, plan, new Date().toISOString()),
  clear: (email) => db.prepare('DELETE FROM trips WHERE email = ?').run(email),
};

migrateLegacy();

module.exports = { kv, users, alerts, passes, leads, hits, advisor, trips, rideinfo, dining, ridetags, DB_FILE };
