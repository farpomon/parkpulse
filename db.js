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

migrateLegacy();

module.exports = { kv, users, alerts, passes, leads, DB_FILE };
