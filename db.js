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
  CREATE TABLE IF NOT EXISTS daystate (
    email TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wa_links (
    phone TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    history TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS geo (
    park TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invites (
    token TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    target TEXT,
    days INTEGER NOT NULL,
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    redeemed_by TEXT,
    redeemed_at TEXT
  );
`);

// Guarded column additions (CREATE TABLE IF NOT EXISTS won't alter existing
// tables). verified defaults to 1 so pre-existing accounts are grandfathered;
// new signups insert 0 explicitly until they confirm their email code.
for (const ddl of [
  "ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 1",
  "ALTER TABLE users ADD COLUMN verify_code TEXT",
  "ALTER TABLE users ADD COLUMN verify_exp INTEGER",
  "ALTER TABLE trips ADD COLUMN onsite INTEGER DEFAULT 0",
  "ALTER TABLE trips ADD COLUMN push_sub TEXT",
  "ALTER TABLE trips ADD COLUMN notified INTEGER DEFAULT 0",
  "ALTER TABLE users ADD COLUMN delete_at INTEGER",
  "ALTER TABLE users ADD COLUMN delete_token TEXT",
]) { try { db.exec(ddl); } catch {} }

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    device TEXT NOT NULL,
    ua TEXT,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_email ON sessions (email);
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
  create: (email, salt, hash, verified = 0) =>
    db.prepare('INSERT INTO users (email, salt, hash, created_at, verified) VALUES (?, ?, ?, ?, ?)').run(email, salt, hash, new Date().toISOString(), verified),
  setVerifyCode: (email, codeHash, exp) =>
    db.prepare('UPDATE users SET verify_code = ?, verify_exp = ? WHERE email = ?').run(codeHash, exp, email),
  markVerified: (email) =>
    db.prepare('UPDATE users SET verified = 1, verify_code = NULL, verify_exp = NULL WHERE email = ?').run(email),
  grant: (email, plan, exp) =>
    db.prepare('UPDATE users SET plan = ?, plan_exp = ? WHERE email = ?').run(plan, exp, email),
  setResetToken: (email, token, exp) =>
    db.prepare('UPDATE users SET reset_token = ?, reset_exp = ? WHERE email = ?').run(token, exp, email),
  scheduleDeletion: (email, at, token) =>
    db.prepare('UPDATE users SET delete_at = ?, delete_token = ? WHERE email = ?').run(at, token, email),
  cancelDeletion: (email) =>
    db.prepare('UPDATE users SET delete_at = NULL, delete_token = NULL WHERE email = ?').run(email).changes,
  resetPassword: (email, salt, hash) =>
    db.prepare('UPDATE users SET salt = ?, hash = ?, reset_token = NULL, reset_exp = NULL, verified = 1 WHERE email = ?').run(salt, hash, email),
  // Password change that does NOT vouch for the email — used when an
  // unverified signup retries; the code check still gates verification.
  setPassword: (email, salt, hash) =>
    db.prepare('UPDATE users SET salt = ?, hash = ? WHERE email = ?').run(salt, hash, email),
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

// Server-side sessions: one row per login, revocable, device-tagged. The
// signed token carries the row id; a missing row means signed-out/evicted.
const sessions = {
  create: (id, email, device, ua) =>
    db.prepare('INSERT INTO sessions (id, email, device, ua, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, email, device, ua ?? null, new Date().toISOString(), new Date().toISOString()),
  get: (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) ?? null,
  touch: (id) => db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), id),
  forEmail: (email) => db.prepare('SELECT * FROM sessions WHERE email = ? ORDER BY last_seen DESC').all(email),
  devices: (email) => db.prepare('SELECT device, MAX(last_seen) AS last_seen FROM sessions WHERE email = ? GROUP BY device ORDER BY last_seen DESC').all(email),
  deleteByDevice: (email, device) => db.prepare('DELETE FROM sessions WHERE email = ? AND device = ?').run(email, device).changes,
  deleteForEmail: (email, exceptId) => (exceptId
    ? db.prepare('DELETE FROM sessions WHERE email = ? AND id != ?').run(email, exceptId)
    : db.prepare('DELETE FROM sessions WHERE email = ?').run(email)).changes,
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
  get: (email) => db.prepare('SELECT dest, start, days, plan, onsite FROM trips WHERE email = ?').get(email) ?? null,
  // Each save resets the reminder flag: a new/changed trip earns a fresh ping.
  set: (email, dest, start, days, plan, onsite = 0, pushSub = null) =>
    db.prepare('INSERT INTO trips (email, dest, start, days, plan, onsite, push_sub, notified, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(email) DO UPDATE SET dest = excluded.dest, start = excluded.start, days = excluded.days, plan = excluded.plan, onsite = excluded.onsite, push_sub = excluded.push_sub, notified = 0, updated_at = excluded.updated_at')
      .run(email, dest, start, days, plan, onsite, pushSub, new Date().toISOString()),
  pendingReminders: () => db.prepare('SELECT email, dest, start, onsite, push_sub FROM trips WHERE push_sub IS NOT NULL AND notified = 0').all(),
  markNotified: (email) => db.prepare('UPDATE trips SET notified = 1 WHERE email = ?').run(email),
  clear: (email) => db.prepare('DELETE FROM trips WHERE email = ?').run(email),
};

// Account deletion (required by both app stores, and the right default anyway).
// Personal data is destroyed; two tables are de-identified instead of dropped:
// `passes` are sale records worth keeping for accounting, and `advisor_feedback`
// is product signal — both have their email cleared so nothing points at a
// person. Wait-drop alerts are keyed by push endpoint rather than account, so
// the best we can do is drop any that match this account's stored endpoint.
const accounts = {
  due: (now) => db.prepare('SELECT email FROM users WHERE delete_at IS NOT NULL AND delete_at <= ?').all(now).map((r) => r.email),
  purge: (email) => {
    const counts = {};
    const run = (label, sql) => { counts[label] = db.prepare(sql).run(email).changes; };
    let endpoint = null;
    try {
      const trip = db.prepare('SELECT push_sub FROM trips WHERE email = ?').get(email);
      if (trip?.push_sub) endpoint = JSON.parse(trip.push_sub).endpoint || null;
    } catch {}

    db.exec('BEGIN');
    try {
      run('sessions', 'DELETE FROM sessions WHERE email = ?');
      run('trips', 'DELETE FROM trips WHERE email = ?');
      run('daystate', 'DELETE FROM daystate WHERE email = ?');
      run('whatsappLinks', 'DELETE FROM wa_links WHERE email = ?');
      run('advisorMemory', 'DELETE FROM advisor_memory WHERE email = ?');
      run('advisorChats', 'DELETE FROM advisor_chats WHERE email = ?');
      run('leads', 'DELETE FROM leads WHERE email = ?');
      run('feedbackAnonymized', 'UPDATE advisor_feedback SET email = NULL WHERE email = ?');
      run('passesAnonymized', 'UPDATE passes SET email = NULL WHERE email = ?');
      run('user', 'DELETE FROM users WHERE email = ?');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    // Outside the transaction: alerts live on their own endpoint key.
    if (endpoint) {
      try { counts.alerts = db.prepare('DELETE FROM alerts WHERE endpoint = ?').run(endpoint).changes; } catch {}
    }
    return counts;
  },
};

// Aggregate queries for the operator dashboard (/admin). Counts only — no
// passwords, hashes, or chat contents ever leave this module.
const daysAgoIso = (days) => new Date(Date.now() - days * 86400000).toISOString();
const admin = {
  userTotals: () => db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(verified), 0) AS verified FROM users').get(),
  newUsers: (days) => db.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?').get(daysAgoIso(days)).n,
  signupsByDay: (days) => db.prepare('SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day ORDER BY day').all(daysAgoIso(days)),
  recentUsers: (limit) => db.prepare('SELECT email, created_at, verified, plan, plan_exp FROM users ORDER BY created_at DESC LIMIT ?').all(limit),
  activeAccounts: (days) => db.prepare('SELECT COUNT(DISTINCT email) AS n FROM sessions WHERE last_seen >= ?').get(daysAgoIso(days)).n,
  liveSessions: () => db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
  counts: () => Object.fromEntries(['alerts', 'leads', 'passes', 'trips', 'advisor_chats', 'advisor_feedback'].map(
    (t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n],
  )),
  recentLeads: (limit) => db.prepare('SELECT email, plan, at FROM leads ORDER BY id DESC LIMIT ?').all(limit),
};

migrateLegacy();

// Today's in-park choices, mirrored from the device so the WhatsApp agent
// (and a reinstalled app) can see what the visitor already set up.
const daystate = {
  get: (email) => {
    const row = db.prepare('SELECT data, updated_at FROM daystate WHERE email = ?').get(email);
    if (!row) return null;
    try { return { ...JSON.parse(row.data), updatedAt: row.updated_at }; } catch { return null; }
  },
  set: (email, data) =>
    db.prepare(`INSERT INTO daystate (email, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
      .run(email, JSON.stringify(data), new Date().toISOString()),
  delete: (email) => db.prepare('DELETE FROM daystate WHERE email = ?').run(email),
};

const wa = {
  get: (phone) => db.prepare('SELECT * FROM wa_links WHERE phone = ?').get(phone),
  link: (phone, email) =>
    db.prepare(`INSERT INTO wa_links (phone, email, history, created_at) VALUES (?, ?, '[]', ?)
      ON CONFLICT(phone) DO UPDATE SET email = excluded.email, history = '[]'`)
      .run(phone, email, new Date().toISOString()),
  unlink: (phone) => db.prepare('DELETE FROM wa_links WHERE phone = ?').run(phone).changes,
  unlinkEmail: (email) => db.prepare('DELETE FROM wa_links WHERE email = ?').run(email).changes,
  history: (phone) => {
    const row = db.prepare('SELECT history FROM wa_links WHERE phone = ?').get(phone);
    try { return row ? JSON.parse(row.history) : []; } catch { return []; }
  },
  saveHistory: (phone, history) =>
    db.prepare('UPDATE wa_links SET history = ? WHERE phone = ?').run(JSON.stringify(history.slice(-12)), phone),
};

// Ride coordinates per park, extracted once from OpenStreetMap via Overpass.
const geo = {
  get: (park) => {
    const row = db.prepare('SELECT * FROM geo WHERE park = ?').get(park);
    if (!row) return null;
    try { return { status: row.status, rides: JSON.parse(row.data), updatedAt: row.updated_at }; } catch { return null; }
  },
  set: (park, status, rides) =>
    db.prepare(`INSERT INTO geo (park, status, data, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(park) DO UPDATE SET status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`)
      .run(park, status, JSON.stringify(rides), new Date().toISOString()),
};

// Admin-minted comp-access invites: single-use, optionally bound to an email.
const invites = {
  create: (token, channel, target, days, note, createdBy) =>
    db.prepare('INSERT INTO invites (token, channel, target, days, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(token, channel, target, days, note, createdBy, new Date().toISOString()),
  get: (token) => db.prepare('SELECT * FROM invites WHERE token = ?').get(token),
  redeem: (token, email) =>
    db.prepare('UPDATE invites SET redeemed_by = ?, redeemed_at = ? WHERE token = ? AND redeemed_by IS NULL')
      .run(email, new Date().toISOString(), token).changes,
  revoke: (token) => db.prepare('DELETE FROM invites WHERE token = ? AND redeemed_by IS NULL').run(token).changes,
  list: (limit = 50) => db.prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT ?').all(limit),
};

module.exports = { kv, users, accounts, sessions, alerts, passes, leads, hits, advisor, trips, rideinfo, dining, ridetags, admin, daystate, wa, invites, geo, DB_FILE };
