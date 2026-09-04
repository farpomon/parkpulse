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
  CREATE TABLE IF NOT EXISTS park_flavor (
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
  CREATE TABLE IF NOT EXISTS saved_plans (
    email TEXT NOT NULL,
    park TEXT NOT NULL,
    date TEXT NOT NULL,
    stops TEXT NOT NULL,
    saved_min INTEGER DEFAULT 0,
    mailed_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (email, park, date)
  );
  CREATE TABLE IF NOT EXISTS ride_ratings (
    email TEXT NOT NULL,
    park TEXT NOT NULL,
    ride TEXT NOT NULL,
    kind TEXT NOT NULL,
    vote INTEGER NOT NULL,
    ages TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (email, park, ride, kind)
  );
  CREATE TABLE IF NOT EXISTS advisor_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    park TEXT,
    vote TEXT NOT NULL,
    message TEXT,
    at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    who TEXT NOT NULL,
    kind TEXT NOT NULL,
    score INTEGER NOT NULL,
    comment TEXT,
    park TEXT,
    lang TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS nps_who ON nps (who, at);
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
  -- Observed waits, reported by visitors after they ride. The posted wait at
  -- the moment of the report is stored alongside, because the difference
  -- between the two is the whole point -- storing only the observed figure
  -- would leave nothing to compare it against later.
  CREATE TABLE IF NOT EXISTS wait_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    park TEXT NOT NULL,
    ride TEXT NOT NULL,
    ride_key TEXT NOT NULL,
    actual_min INTEGER NOT NULL,
    posted_min INTEGER,
    hour_local INTEGER NOT NULL,
    day TEXT NOT NULL,
    reporter TEXT NOT NULL,
    at TEXT NOT NULL
  );
  -- One report per person per ride per day: a second is a correction, not a
  -- second observation, and letting both count would let one visitor outvote
  -- a whole afternoon.
  CREATE UNIQUE INDEX IF NOT EXISTS wait_reports_once ON wait_reports (reporter, park, ride_key, day);
  CREATE INDEX IF NOT EXISTS wait_reports_lookup ON wait_reports (park, ride_key, hour_local);

  CREATE TABLE IF NOT EXISTS geo (
    park TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_usage (
    day TEXT NOT NULL,
    feature TEXT NOT NULL,
    model TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (day, feature, model)
  );
  -- Mila's read of a drafted running order, keyed on a hash of every input
  -- that reaches her prompt. The same plan asked twice -- a refresh, a second
  -- device, a visitor who left the tab and came back -- replays instead of
  -- buying another Opus call. Live wait times deliberately do NOT feed the
  -- key (they move every few minutes and would make it never hit); staleness
  -- is bounded by the caller's TTL instead.
  CREATE TABLE IF NOT EXISTS plan_advice (
    sig TEXT PRIMARY KEY,
    park TEXT NOT NULL,
    day TEXT NOT NULL,
    text TEXT NOT NULL,
    actions TEXT NOT NULL DEFAULT '[]',
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS plan_advice_at ON plan_advice (at);
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
  "ALTER TABLE passes ADD COLUMN usd REAL",
  "ALTER TABLE users ADD COLUMN name TEXT",
  "ALTER TABLE users ADD COLUMN verify_code TEXT",
  "ALTER TABLE users ADD COLUMN verify_exp INTEGER",
  "ALTER TABLE trips ADD COLUMN onsite INTEGER DEFAULT 0",
  "ALTER TABLE trips ADD COLUMN push_sub TEXT",
  "ALTER TABLE trips ADD COLUMN notified INTEGER DEFAULT 0",
  "ALTER TABLE users ADD COLUMN delete_at INTEGER",
  "ALTER TABLE users ADD COLUMN delete_token TEXT",
  "ALTER TABLE users ADD COLUMN evening_mail INTEGER DEFAULT 1",
  // When this account first built a plan. The funnel's middle step: signing up
  // and actually planning a day are very different things, and nothing
  // recorded the second one.
  "ALTER TABLE users ADD COLUMN first_plan_at TEXT",
  // Bought extra time with Mila. Dollars of model spend, not minutes and not
  // a question count -- it is drawn down by what the answers actually cost,
  // and it does not expire with the day.
  "ALTER TABLE users ADD COLUMN ai_credit_usd REAL DEFAULT 0",
  // Where this account came from, captured on the visitor's FIRST page view
  // and carried through to signup. Last-touch would credit whatever they typed
  // into the address bar on the day they finally paid; first-touch credits
  // whatever actually found them.
  // What the account agreed to, and when. A ticked box with no record of which
  // version was ticked is most of the way to worthless: the enforceable fact
  // is that THIS person accepted THAT text on THAT date. terms_at is null for
  // accounts created before the box existed -- they are not retro-consented,
  // because that would be a fiction.
  // Commercial email, kept apart from the contract on purpose. Canada's CASL
  // wants EXPRESS consent -- separately asked, never pre-ticked, never bundled
  // into agreeing to the terms -- and it wants proof: when it was given, and
  // what the person was actually shown when they gave it. Null means never
  // asked, 0 means asked and declined; the two are different facts.
  "ALTER TABLE users ADD COLUMN marketing_ok INTEGER",
  "ALTER TABLE users ADD COLUMN marketing_at TEXT",
  "ALTER TABLE users ADD COLUMN marketing_wording TEXT",
  "ALTER TABLE users ADD COLUMN terms_at TEXT",
  "ALTER TABLE users ADD COLUMN terms_version TEXT",
  "ALTER TABLE users ADD COLUMN signup_source TEXT",
  "ALTER TABLE users ADD COLUMN signup_medium TEXT",
  "ALTER TABLE users ADD COLUMN signup_campaign TEXT",
  // One Stripe checkout is one sale. The claim endpoint already refuses to
  // bank the same session twice; this is the floor under it, so no future
  // caller can inflate the revenue dashboard by replaying a receipt link.
  // Fails harmlessly (and leaves the table as it was) if duplicates predate it.
  "CREATE UNIQUE INDEX IF NOT EXISTS passes_session ON passes (stripe_session) WHERE stripe_session IS NOT NULL",
]) { try { db.exec(ddl); } catch {} }

db.exec(`
  -- Where a page view came from. The hits table counts paths and nothing else,
  -- so "1,645 views, 3 signups" could not be read: no referrer, no campaign,
  -- and crawlers counted the same as people.
  --
  -- Aggregate, not per-visitor: a row is a day, a source and a count. Nothing
  -- here identifies anybody.
  CREATE TABLE IF NOT EXISTS visits (
    day TEXT NOT NULL,
    source TEXT NOT NULL,      -- google, reddit, direct, a domain, a utm_source
    medium TEXT NOT NULL,      -- search | social | referral | direct | campaign | bot
    campaign TEXT NOT NULL DEFAULT '',
    landing TEXT NOT NULL DEFAULT '',
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, source, medium, campaign, landing)
  );
  CREATE INDEX IF NOT EXISTS visits_day ON visits (day);
`);

db.exec(`
  -- What each account has actually cost us in model calls, by day.
  -- ai_usage answers "what did the product spend"; this answers "what did this
  -- visitor spend", which is the only question a per-account budget can be
  -- built on. Counting conversations cannot do it: one question costs six
  -- times another depending on whether Mila reaches for a tool.
  CREATE TABLE IF NOT EXISTS ai_spend (
    email TEXT NOT NULL,
    day TEXT NOT NULL,
    usd REAL NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (email, day)
  );
  CREATE INDEX IF NOT EXISTS ai_spend_day ON ai_spend (day);
`);

db.exec(`
  -- One row per account per day it was seen. Retention cannot be read off
  -- sessions: the five-device cap evicts them and logging out deletes them, so
  -- somebody who came back every day of their trip on one phone can leave no
  -- trace of having returned at all. This is the durable record -- an address
  -- and a date, nothing about what they did.
  CREATE TABLE IF NOT EXISTS account_days (
    email TEXT NOT NULL,
    day TEXT NOT NULL,
    PRIMARY KEY (email, day)
  );
  CREATE INDEX IF NOT EXISTS account_days_day ON account_days (day);
`);

db.exec(`
  -- Sign-in with Google or Apple. Keyed on the provider's own subject rather
  -- than the email, because an email can change at the provider and the
  -- subject cannot: matching on the address would hand somebody else's new
  -- Gmail an existing ParkPulse account. One account can carry several.
  CREATE TABLE IF NOT EXISTS identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (provider, subject)
  );
  CREATE INDEX IF NOT EXISTS identities_email ON identities (email);
`);

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
  // Spending a one-time code should leave nothing behind. Blanking the value
  // instead of removing the row meant every sign-in kept a tombstone forever,
  // and -- worse -- a claim for a code that never existed CREATED one, so
  // anybody could add rows by posting nonsense at the endpoint.
  del: (key) => db.prepare('DELETE FROM kv WHERE key = ?').run(key).changes,
};

const users = {
  get: (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email) ?? null,
  create: (email, salt, hash, verified = 0) =>
    db.prepare('INSERT INTO users (email, salt, hash, created_at, verified) VALUES (?, ?, ?, ?, ?)').run(email, salt, hash, new Date().toISOString(), verified),
  setVerifyCode: (email, codeHash, exp) =>
    db.prepare('UPDATE users SET verify_code = ?, verify_exp = ? WHERE email = ?').run(codeHash, exp, email),
  setEveningMail: (email, on) => db.prepare('UPDATE users SET evening_mail = ? WHERE email = ?').run(on, email),
  // Bought time with Mila. Added on purchase, drawn down as answers are
  // billed, and never allowed below zero.
  addAiCredit: (email, usd) =>
    db.prepare('UPDATE users SET ai_credit_usd = COALESCE(ai_credit_usd, 0) + ? WHERE email = ?').run(usd, email).changes,
  spendAiCredit: (email, usd) =>
    db.prepare('UPDATE users SET ai_credit_usd = MAX(0, COALESCE(ai_credit_usd, 0) - ?) WHERE email = ?').run(usd, email).changes,
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
  // The wording is stored with the answer because consent is to a particular
  // sentence, and that sentence will be reworded eventually. Withdrawal is
  // recorded the same way -- an unsubscribe is a fact to be able to prove too.
  setMarketing: (email, on, wording) =>
    db.prepare('UPDATE users SET marketing_ok = ?, marketing_at = ?, marketing_wording = ? WHERE email = ?')
      .run(on ? 1 : 0, new Date().toISOString(), wording || null, email).changes,
  // Everyone who may lawfully be sent a commercial message right now.
  marketingList: () =>
    db.prepare('SELECT email, name FROM users WHERE marketing_ok = 1 AND verified = 1 AND delete_at IS NULL').all(),
  acceptTerms: (email, version) =>
    db.prepare('UPDATE users SET terms_at = ?, terms_version = ? WHERE email = ? AND terms_at IS NULL')
      .run(new Date().toISOString(), version, email).changes,
  setName: (email, name) => db.prepare('UPDATE users SET name = ? WHERE email = ?').run(name, email),
  setPassword: (email, salt, hash) =>
    db.prepare('UPDATE users SET salt = ?, hash = ? WHERE email = ?').run(salt, hash, email),
};

const identities = {
  get: (provider, subject) => db.prepare('SELECT * FROM identities WHERE provider = ? AND subject = ?').get(provider, subject) ?? null,
  forEmail: (email) => db.prepare('SELECT provider, created_at FROM identities WHERE email = ?').all(email),
  link: (provider, subject, email) =>
    db.prepare('INSERT INTO identities (provider, subject, email, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider, subject) DO UPDATE SET email = excluded.email')
      .run(provider, subject, email, new Date().toISOString()),
  unlink: (provider, email) => db.prepare('DELETE FROM identities WHERE provider = ? AND email = ?').run(provider, email).changes,
  removeAll: (email) => db.prepare('DELETE FROM identities WHERE email = ?').run(email).changes,
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
  // usd is what the till actually took, after any promotion code. Null for a
  // comp, a redeemed code, or a sale from before this was recorded -- those
  // the caller prices from the catalogue.
  add: (plan, stripeSession, email, usd) =>
    db.prepare('INSERT INTO passes (plan, stripe_session, email, at, usd) VALUES (?, ?, ?, ?, ?)').run(plan, stripeSession ?? null, email ?? null, new Date().toISOString(), Number.isFinite(usd) ? usd : null),
  // Sold passes in a window, by plan. The caller prices them: the catalogue
  // lives in server.js and only it knows which ids are real money. Anything
  // priceless -- a dev pass, a legacy id retired before the current catalogue
  // -- has to be counted somewhere rather than quietly dropped, so this hands
  // back every plan and lets the caller split them.
  // n is every row; priced is how many carry what the till took, and paid
  // is that sum. The caller prices the rest from the catalogue.
  soldSince: (iso) => db.prepare('SELECT plan, COUNT(*) AS n, COUNT(usd) AS priced, COALESCE(SUM(usd), 0) AS paid FROM passes WHERE at >= ? GROUP BY plan').all(iso),
  soldByDay: (iso) => db.prepare('SELECT substr(at, 1, 10) AS day, plan, COUNT(*) AS n, COUNT(usd) AS priced, COALESCE(SUM(usd), 0) AS paid FROM passes WHERE at >= ? GROUP BY day, plan ORDER BY day').all(iso),
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

// "How likely are you to recommend ParkPulse to a friend?", 0 to 10, asked
// once a park day has actually delivered something. One answer per person per
// quarter: a second tap inside the window updates the row rather than adding
// one, so the follow-up comment lands on the score it belongs to and nobody is
// counted twice. Anonymous visitors answer under their device id -- NPS from
// account holders only would be NPS from the people who already liked it
// enough to sign up.
const NPS_WINDOW_DAYS = 90;
const nps = {
  set: ({ who, kind, score, comment, park, lang }) => {
    const since = new Date(Date.now() - NPS_WINDOW_DAYS * 86400000).toISOString();
    const open = db.prepare('SELECT id FROM nps WHERE who = ? AND at >= ? ORDER BY id DESC LIMIT 1').get(who, since);
    if (open) {
      db.prepare('UPDATE nps SET score = ?, comment = COALESCE(?, comment), park = COALESCE(?, park) WHERE id = ?')
        .run(score, comment ?? null, park ?? null, open.id);
      return { id: open.id, updated: true };
    }
    const r = db.prepare('INSERT INTO nps (who, kind, score, comment, park, lang, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(who, kind, score, comment ?? null, park ?? null, lang ?? null, new Date().toISOString());
    return { id: Number(r.lastInsertRowid), updated: false };
  },
  // The score as the method defines it: promoters (9-10) minus detractors
  // (0-6) as percentages of everyone who answered; passives (7-8) count in
  // the denominator and nowhere else. Null until somebody has answered --
  // zero would read as "neutral", and no data is not neutral.
  summary: (days) => {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = db.prepare('SELECT score, COUNT(*) AS n FROM nps WHERE at >= ? GROUP BY score').all(since);
    const n = rows.reduce((a, r) => a + r.n, 0);
    const promoters = rows.filter((r) => r.score >= 9).reduce((a, r) => a + r.n, 0);
    const detractors = rows.filter((r) => r.score <= 6).reduce((a, r) => a + r.n, 0);
    const passives = n - promoters - detractors;
    return {
      n, promoters, passives, detractors,
      score: n ? Math.round((promoters - detractors) / n * 100) : null,
      byScore: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i, rows.find((r) => r.score === i)?.n || 0])),
      recent: db.prepare("SELECT score, comment, park, lang, at FROM nps WHERE at >= ? AND comment IS NOT NULL AND comment != '' ORDER BY id DESC LIMIT 12").all(since),
    };
  },
  clearUser: (email) => db.prepare("DELETE FROM nps WHERE who = ? AND kind = 'email'").run(email),
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

// The plan email's three authored flavour lines -- Mila's opening word, her
// local secret and the park fact -- translated once per park per language and
// kept. The English originals live in data/ and stay the source of truth.
const parkflavor = {
  get: (park, lang) => db.prepare('SELECT json FROM park_flavor WHERE park = ? AND lang = ?').get(park, lang)?.json ?? null,
  set: (park, lang, json) =>
    db.prepare('INSERT OR REPLACE INTO park_flavor (park, lang, json, at) VALUES (?, ?, ?, ?)').run(park, lang, json, new Date().toISOString()),
};

// AI-classified ride tags (vibe + age band) per park, cached.
const waitreports = {
  // Upsert: a repeat report for the same ride on the same day replaces the
  // earlier one rather than being rejected, so a visitor can correct a typo.
  add: (r) => db.prepare(`INSERT INTO wait_reports (park, ride, ride_key, actual_min, posted_min, hour_local, day, reporter, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(reporter, park, ride_key, day) DO UPDATE SET
        actual_min = excluded.actual_min, posted_min = excluded.posted_min,
        hour_local = excluded.hour_local, at = excluded.at`)
    .run(r.park, r.ride, r.rideKey, r.actual, r.posted, r.hour, r.day, r.reporter, new Date().toISOString()),
  // Every report for a park, oldest first — the aggregator does the bucketing.
  forPark: (park) => db.prepare('SELECT ride, ride_key, actual_min, posted_min, hour_local, day FROM wait_reports WHERE park = ? ORDER BY day').all(park),
  parks: () => db.prepare('SELECT park, COUNT(*) AS n FROM wait_reports GROUP BY park').all(),
  countBy: (reporter, since) => db.prepare('SELECT COUNT(*) AS n FROM wait_reports WHERE reporter = ? AND at >= ?').get(reporter, since)?.n ?? 0,
  total: () => db.prepare('SELECT COUNT(*) AS n FROM wait_reports').get()?.n ?? 0,
};

const ridetags = {
  get: (park) => db.prepare('SELECT json FROM ride_tags WHERE park = ?').get(park)?.json ?? null,
  set: (park, json) => db.prepare('INSERT OR REPLACE INTO ride_tags (park, json, at) VALUES (?, ?, ?)').run(park, json, new Date().toISOString()),
};

// Cached plan reviews. `get` enforces the freshness the caller asks for
// rather than storing a TTL per row, because the same advice is worth a
// quarter of an hour when the plan is for today and half a day when it is for
// a date whose live waits do not exist yet.
const planadvice = {
  get: (sig, maxAgeMs) => {
    const row = db.prepare('SELECT text, actions, at FROM plan_advice WHERE sig = ?').get(sig);
    if (!row) return null;
    if (Date.now() - new Date(row.at).getTime() > maxAgeMs) return null;
    try { return { text: row.text, actions: JSON.parse(row.actions) }; } catch { return { text: row.text, actions: [] }; }
  },
  set: (sig, park, day, text, actions) =>
    db.prepare('INSERT INTO plan_advice (sig, park, day, text, actions, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sig) DO UPDATE SET text = excluded.text, actions = excluded.actions, at = excluded.at')
      .run(sig, park, day, text, JSON.stringify(actions || []), new Date().toISOString()),
  // Nothing here is worth keeping once it is far past any TTL a caller uses.
  prune: (olderThanMs) =>
    db.prepare('DELETE FROM plan_advice WHERE at < ?').run(new Date(Date.now() - olderThanMs).toISOString()).changes,
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

// Raw material for two features shipping later, not now: per-age-band ride
// ratings and the "people who liked X also liked Y" block. Both need months
// of volume, so today's job is only to collect honestly: one row per
// (account, park, ride, kind), latest verdict wins, with a snapshot of the
// party's age bands at the moment of rating. kind is 'rate' (thumbs after
// riding) or 'fav' (the star). vote is +1/-1.
const ratings = {
  set: (email, park, ride, kind, vote, ages) =>
    db.prepare('INSERT INTO ride_ratings (email, park, ride, kind, vote, ages, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(email, park, ride, kind) DO UPDATE SET vote = excluded.vote, ages = excluded.ages, at = excluded.at')
      .run(email, park, ride, kind, vote, ages, new Date().toISOString()),
  countFor: (email) => db.prepare('SELECT COUNT(*) AS n FROM ride_ratings WHERE email = ?').get(email).n,
  totals: () => db.prepare("SELECT kind, COUNT(*) AS n, SUM(CASE WHEN vote > 0 THEN 1 ELSE 0 END) AS up FROM ride_ratings GROUP BY kind").all(),
  clearUser: (email) => db.prepare('DELETE FROM ride_ratings WHERE email = ?').run(email),
};

// One saved plan per account+park+date. `stops` is the sanitized JSON the
// plan email already trusts; mailed_at makes the night-before send one-shot.
const plans = {
  get: (email, park, date) => db.prepare('SELECT stops, saved_min FROM saved_plans WHERE email = ? AND park = ? AND date = ?').get(email, park, date) ?? null,
  list: (email) => db.prepare('SELECT park, date, stops, saved_min, updated_at FROM saved_plans WHERE email = ? ORDER BY date, park').all(email),
  set: (email, park, date, stops, savedMin) =>
    db.prepare('INSERT INTO saved_plans (email, park, date, stops, saved_min, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email, park, date) DO UPDATE SET stops = excluded.stops, saved_min = excluded.saved_min, updated_at = excluded.updated_at')
      .run(email, park, date, stops, savedMin, new Date().toISOString()),
  remove: (email, park, date) => db.prepare('DELETE FROM saved_plans WHERE email = ? AND park = ? AND date = ?').run(email, park, date),
  // Plans for a given date that have not had their night-before email yet.
  unmailedFor: (date) => db.prepare('SELECT email, park, date, stops, saved_min FROM saved_plans WHERE date = ? AND mailed_at IS NULL').all(date),
  markMailed: (email, park, date) => db.prepare("UPDATE saved_plans SET mailed_at = ? WHERE email = ? AND park = ? AND date = ?").run(new Date().toISOString(), email, park, date),
  purgeOld: (before) => db.prepare('DELETE FROM saved_plans WHERE date < ?').run(before),
  clearUser: (email) => db.prepare('DELETE FROM saved_plans WHERE email = ?').run(email),
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
      run('identities', 'DELETE FROM identities WHERE email = ?');
      run('aiSpend', 'DELETE FROM ai_spend WHERE email = ?');
      run('trips', 'DELETE FROM trips WHERE email = ?');
      run('daystate', 'DELETE FROM daystate WHERE email = ?');
      run('savedPlans', 'DELETE FROM saved_plans WHERE email = ?');
      run('rideRatings', 'DELETE FROM ride_ratings WHERE email = ?');
      run('nps', "DELETE FROM nps WHERE who = ? AND kind = 'email'");
      run('whatsappLinks', 'DELETE FROM wa_links WHERE email = ?');
      run('advisorMemory', 'DELETE FROM advisor_memory WHERE email = ?');
      run('advisorChats', 'DELETE FROM advisor_chats WHERE email = ?');
      // Reported waits are deleted outright rather than de-identified. One
      // person's reports barely move a median, and matching the promise in
      // the privacy policy is worth more than the rows.
      counts.waitReports = db.prepare("DELETE FROM wait_reports WHERE reporter = 'u:' || ?").run(email).changes;
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
  // Same count against an explicit instant, so a caller working in calendar
  // days (the AI spend report, which runs on Eastern midnights) can line the
  // window up with its own rather than with a rolling 24 hours. `exclude`
  // drops named accounts from the count -- reading the operator dashboard
  // touches the operator's own session, so without this the person checking
  // the numbers would always appear in them.
  activeAccountsSince: (iso, exclude = []) => {
    const holes = exclude.map(() => '?').join(',');
    return db.prepare(`SELECT COUNT(DISTINCT email) AS n FROM sessions WHERE last_seen >= ?${exclude.length ? ` AND email NOT IN (${holes})` : ''}`)
      .get(iso, ...exclude).n;
  },
  liveSessions: () => db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
  counts: () => Object.fromEntries(['alerts', 'leads', 'passes', 'trips', 'advisor_chats', 'advisor_feedback'].map(
    (t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n],
  )),
  recentLeads: (limit) => db.prepare('SELECT email, plan, at FROM leads ORDER BY id DESC LIMIT ?').all(limit),

  // --- funnel ---------------------------------------------------------------
  // Each stage counted over the same window, so the drop-offs between them
  // mean something. Verified and planned are cumulative states on the account
  // rather than events, so they are counted among accounts created in the
  // window -- otherwise a long-standing account verifying today would show up
  // as a conversion from a signup that never happened here.
  funnel: (days) => {
    const from = daysAgoIso(days);
    const row = db.prepare(`SELECT
        COUNT(*) AS signups,
        COALESCE(SUM(verified), 0) AS verified,
        COALESCE(SUM(first_plan_at IS NOT NULL), 0) AS planned,
        COALESCE(SUM(plan IS NOT NULL AND plan != ''), 0) AS paid
      FROM users WHERE created_at >= ?`).get(from);
    return row;
  },
  // Stamped once, at signup, from the first-touch the browser has been
  // carrying since that visitor's first page view.
  attribute: (email, source, medium, campaign) =>
    db.prepare("UPDATE users SET signup_source = ?, signup_medium = ?, signup_campaign = ? WHERE email = ? AND signup_source IS NULL")
      .run(source, medium, campaign, email).changes,
  signupsBySource: (days) => db.prepare(`SELECT
      COALESCE(NULLIF(signup_source, ''), 'unknown') AS source,
      COALESCE(NULLIF(signup_medium, ''), 'unknown') AS medium,
      COUNT(*) AS signups,
      COALESCE(SUM(plan IS NOT NULL AND plan != ''), 0) AS paid
    FROM users WHERE created_at >= ? GROUP BY source, medium ORDER BY signups DESC`).all(daysAgoIso(days)),

  markFirstPlan: (email) =>
    db.prepare("UPDATE users SET first_plan_at = ? WHERE email = ? AND (first_plan_at IS NULL OR first_plan_at = '')")
      .run(new Date().toISOString(), email).changes,

  // --- retention ------------------------------------------------------------
  seen: (email, day) =>
    db.prepare('INSERT INTO account_days (email, day) VALUES (?, ?) ON CONFLICT(email, day) DO NOTHING').run(email, day),
  // Weekly cohorts: for each signup week, how many of that week's accounts
  // were seen again in each of the following weeks. Done in JS rather than one
  // clever query because the shape is a grid, and a grid is easier to read
  // than the SQL that would build it.
  cohorts: (weeks = 6) => {
    const since = daysAgoIso(weeks * 7);
    const users = db.prepare('SELECT email, created_at FROM users WHERE created_at >= ?').all(since);
    const days = db.prepare('SELECT email, day FROM account_days WHERE day >= ?').all(since.slice(0, 10));
    // Monday-anchored week key, so a cohort is a calendar week not an offset.
    const weekOf = (iso) => {
      const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    };
    const cohortOf = new Map(users.map((u) => [u.email, weekOf(u.created_at)]));
    const size = {};
    for (const w of cohortOf.values()) size[w] = (size[w] || 0) + 1;
    const back = {};                       // cohort -> week offset -> Set(email)
    for (const { email, day } of days) {
      const c = cohortOf.get(email);
      if (!c) continue;
      const off = Math.round((Date.parse(weekOf(day)) - Date.parse(c)) / (7 * 86400000));
      if (off < 0) continue;
      ((back[c] ||= {})[off] ||= new Set()).add(email);
    }
    return Object.keys(size).sort().map((cohort) => ({
      cohort, size: size[cohort],
      weeks: Array.from({ length: weeks }, (_, i) => (back[cohort]?.[i]?.size) || 0),
    }));
  },

  // --- deletion queue -------------------------------------------------------
  // Scheduled account deletions. They run themselves on a timer and nothing
  // showed what was queued, so there was no way to see one coming or to prove
  // afterwards that it happened.
  pendingDeletions: () => db.prepare('SELECT email, delete_at FROM users WHERE delete_at IS NOT NULL ORDER BY delete_at').all(),
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

// AI spend, aggregated per day+feature+model so the table stays tiny.
const aiusage = {
  add: (day, feature, model, u) =>
    db.prepare(`INSERT INTO ai_usage (day, feature, model, calls, input_tokens, output_tokens, cache_write, cache_read, cost_usd)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(day, feature, model) DO UPDATE SET
        calls = calls + 1,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_write = cache_write + excluded.cache_write,
        cache_read = cache_read + excluded.cache_read,
        cost_usd = cost_usd + excluded.cost_usd`)
      .run(day, feature, model, u.input, u.output, u.cacheWrite, u.cacheRead, u.cost),
  // Inclusive day range (YYYY-MM-DD strings sort lexicographically).
  totals: (from, to) => db.prepare(`SELECT COALESCE(SUM(calls),0) calls, COALESCE(SUM(input_tokens),0) input_tokens,
      COALESCE(SUM(output_tokens),0) output_tokens, COALESCE(SUM(cache_write),0) cache_write,
      COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cost_usd),0) cost_usd
    FROM ai_usage WHERE day >= ? AND day <= ?`).get(from, to),
  byFeature: (from, to) => db.prepare(`SELECT feature, SUM(calls) calls, SUM(cost_usd) cost_usd
    FROM ai_usage WHERE day >= ? AND day <= ? GROUP BY feature ORDER BY cost_usd DESC`).all(from, to),
  byDay: (from, to) => db.prepare(`SELECT day, SUM(calls) calls, SUM(cost_usd) cost_usd
    FROM ai_usage WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`).all(from, to),
  // Everything spent today, across every account and every feature. The
  // global backstop reads this.
  totalOn: (day) => db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM ai_usage WHERE day = ?').get(day).usd,
};

const visits = {
  bump: (day, source, medium, campaign, landing) =>
    db.prepare(`INSERT INTO visits (day, source, medium, campaign, landing, n) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(day, source, medium, campaign, landing) DO UPDATE SET n = n + 1`)
      .run(day, source, medium, campaign, landing),
  // People, by where they came from. Crawlers are their own medium and are
  // asked for separately, because mixing them into a funnel makes the top of
  // it meaningless.
  bySource: (from, { bots = false } = {}) => db.prepare(`SELECT source, medium, SUM(n) AS n FROM visits
      WHERE day >= ? AND medium ${bots ? '=' : '!='} 'bot' GROUP BY source, medium ORDER BY n DESC`).all(from),
  byCampaign: (from) => db.prepare(`SELECT campaign, source, SUM(n) AS n FROM visits
      WHERE day >= ? AND campaign != '' GROUP BY campaign, source ORDER BY n DESC`).all(from),
  totals: (from) => db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN medium != 'bot' THEN n END), 0) AS people,
      COALESCE(SUM(CASE WHEN medium = 'bot' THEN n END), 0) AS bots
    FROM visits WHERE day >= ?`).get(from),
  topLanding: (from, limit = 8) => db.prepare(`SELECT landing, SUM(n) AS n FROM visits
      WHERE day >= ? AND medium != 'bot' AND landing != '' GROUP BY landing ORDER BY n DESC LIMIT ?`).all(from, limit),
};

// The per-account side of the same ledger. Kept separate from ai_usage on
// purpose: that table is product analytics and is grouped by feature, this one
// is a budget and has to be readable for one address in one lookup.
const aispend = {
  add: (email, day, usd) =>
    db.prepare(`INSERT INTO ai_spend (email, day, usd, calls) VALUES (?, ?, ?, 1)
      ON CONFLICT(email, day) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1`)
      .run(email, day, usd),
  on: (email, day) => db.prepare('SELECT usd, calls FROM ai_spend WHERE email = ? AND day = ?').get(email, day)
    ?? { usd: 0, calls: 0 },
  since: (email, from) => db.prepare('SELECT COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(calls), 0) AS calls FROM ai_spend WHERE email = ? AND day >= ?').get(email, from),
  // Who is spending the most today -- the dashboard's "is anyone running away
  // with it" list.
  topOn: (day, limit = 10) => db.prepare('SELECT email, usd, calls FROM ai_spend WHERE day = ? ORDER BY usd DESC LIMIT ?').all(day, limit),
  removeAll: (email) => db.prepare('DELETE FROM ai_spend WHERE email = ?').run(email).changes,
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

// A consistent copy of the live file, made by SQLite itself. VACUUM INTO
// writes a compacted, transaction-consistent database to a new path while
// readers and writers carry on -- the right way to copy a database that is in
// use, where a plain file copy can catch the WAL mid-write.
const backup = {
  to: (dest) => {
    // The path goes into SQL as a string literal; the only character that
    // needs care in one is the quote itself.
    db.exec(`VACUUM INTO '${String(dest).replace(/'/g, "''")}'`);
    return fs.statSync(dest).size;
  },
};

module.exports = { kv, users, identities, aispend, visits, accounts, sessions, alerts, passes, leads, hits, advisor, nps, backup, trips, plans, ratings, rideinfo, dining, parkflavor, ridetags, planadvice, waitreports, admin, daystate, wa, invites, geo, aiusage, DB_FILE };
