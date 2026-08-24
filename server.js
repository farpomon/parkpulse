// ParkPulse — minimal zero-dependency server.
// Serves the static frontend, proxies live wait times from queue-times.com
// (5-minute cache, attribution required by their API license), and captures
// email leads. SQLite storage via node:sqlite (Node 22.5+).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const webpush = require('web-push');

// Local-run convenience: if ANTHROPIC_API_KEY isn't set, read it from a
// gitignored anthropic-key.txt next to this file (see the .example copy).
// Must happen before consultant.js loads, which creates the client. The
// live deployment should keep using the Railway ANTHROPIC_API_KEY variable.
if (!process.env.ANTHROPIC_API_KEY) {
  try {
    const line = require('node:fs').readFileSync(require('node:path').join(__dirname, 'anthropic-key.txt'), 'utf8')
      .split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (line) {
      process.env.ANTHROPIC_API_KEY = line;
      console.log('Anthropic key loaded from anthropic-key.txt');
    }
  } catch {}
}

const consultant = require('./consultant');
const pages = require('./pages');
const history = require('./history');
const db = require('./db');

const PORT = process.env.PORT || 3000;
// Environment tag: 'production' (default) or 'dev'. Dev deployments show a
// DEV badge in the app and are hidden from search engines so the dev URL
// never competes with production in Google.
const APP_ENV = process.env.APP_ENV === 'dev' ? 'dev' : 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

// Stripe Payment Link for the Trip Pass — set in the hosting env, no backend needed for v0.
const PAYMENT_LINK = process.env.PAYMENT_LINK || '';
// Launch-preview switch: everything is free until PRO_GATE=on is set in the
// hosting env, which re-locks Pro features (all parks, planner, alerts).
const PRO_GATE = process.env.PRO_GATE === 'on';
const FREE_PARK = 'magic-kingdom';

// --- Passes & Stripe checkout ------------------------------------------------
// A pass is a self-contained HMAC-signed token {plan, exp} issued after a paid
// Stripe Checkout session (or via the developer code). No accounts needed.
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
// The pass ladder. Prices are display-only — Stripe Prices (created in the
// Stripe dashboard, ids passed via env) are the source of truth for billing.
const PLAN_CATALOG = [
  { id: 'day-pass', days: 1, usd: '24.99', label: 'Day Pass', per: '1 day' },
  { id: 'week-pass', days: 7, usd: '49.99', label: 'Week Pass', per: '7 days', badge: 'MOST POPULAR' },
  { id: 'month-pass', days: 30, usd: '69.99', label: 'Month Pass', per: '30 days' },
  { id: 'half-year-pass', days: 182, usd: '129.99', label: '6-Month Pass', per: '6 months' },
  { id: 'year-pass', days: 365, usd: '199.99', label: 'Annual Pass', per: '12 months', badge: 'BEST VALUE' },
];
const STRIPE_PRICES = {
  'day-pass': process.env.STRIPE_PRICE_DAY || '',
  'week-pass': process.env.STRIPE_PRICE_WEEK || '',
  'month-pass': process.env.STRIPE_PRICE_MONTH || '',
  'half-year-pass': process.env.STRIPE_PRICE_HALFYEAR || '',
  'year-pass': process.env.STRIPE_PRICE_YEAR || '',
  // Legacy v0 plans — keep resolvable so their env vars still work if set.
  'trip-pass': process.env.STRIPE_PRICE_TRIP || '',
  'pro-annual': process.env.STRIPE_PRICE_ANNUAL || '',
};
const CHECKOUT_ENABLED = Boolean(STRIPE_KEY && PLAN_CATALOG.every((p) => STRIPE_PRICES[p.id]));
// MUST be set in production — the ephemeral default invalidates all passes on restart.
const PASS_SECRET = process.env.PASS_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.PASS_SECRET) console.log('WARNING: PASS_SECRET not set — issued passes will not survive a restart');
// Developer bypass: redeeming this exact code in the app grants a 10-year pass.
const DEV_PASS_CODE = process.env.DEV_PASS_CODE || '';
// Legacy plan ids stay valid so previously issued passes keep working.
const PLAN_DAYS = { ...Object.fromEntries(PLAN_CATALOG.map((p) => [p.id, p.days])), 'trip-pass': 30, 'pro-annual': 365, 'dev': 3650, 'comp': 365 };
const PLAN_LABELS = { ...Object.fromEntries(PLAN_CATALOG.map((p) => [p.id, p.label])), 'trip-pass': 'Trip Pass', 'pro-annual': 'Pro Annual', 'dev': 'Dev Pass', 'comp': 'Guest Pass' };

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', PASS_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', PASS_SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}

const signPass = (plan, exp) => signToken({ plan, exp: exp ?? Date.now() + PLAN_DAYS[plan] * 86400000 });
function verifyPass(token) {
  const p = verifyToken(token);
  return p && PLAN_DAYS[p.plan] ? p : null;
}

// --- Accounts ----------------------------------------------------------------
// scrypt-hashed passwords in SQLite; sessions are HMAC tokens {email, exp}.
// A purchase or dev-code redemption made while logged in attaches the pass to
// the account, so entitlements follow the login rather than the browser.
const SESSION_DAYS = 30;
const MAX_DEVICES = 5;
const hashPassword = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

// Sessions are server-side rows (revocable) referenced by a signed token.
// Each login registers a device; beyond MAX_DEVICES the least-recently-seen
// device is signed out — family-sized, sharing-hostile.
function issueSession(email, device, req) {
  const dev = (typeof device === 'string' && device.trim() ? device.trim() : 'unknown').slice(0, 64);
  const known = db.sessions.devices(email);
  if (!known.some((d) => d.device === dev) && known.length >= MAX_DEVICES) {
    db.sessions.deleteByDevice(email, known[known.length - 1].device);
  }
  const sid = crypto.randomBytes(16).toString('hex');
  db.sessions.create(sid, email, dev, String(req.headers['user-agent'] || '').slice(0, 200));
  return signToken({ sid, email, exp: Date.now() + SESSION_DAYS * 86400000 });
}

function sessionUser(req) {
  const p = verifyToken(req.headers['x-session']);
  if (!p?.email || !p.sid) return null; // legacy stateless tokens are retired
  const row = db.sessions.get(p.sid);
  if (!row || row.email !== p.email) return null; // revoked or evicted
  if (Date.now() - new Date(row.last_seen).getTime() > 10 * 60 * 1000) db.sessions.touch(p.sid);
  const user = db.users.get(p.email);
  return user ? { email: p.email, user, sid: p.sid } : null;
}
const accountPassActive = (user) => Boolean(user.plan && PLAN_DAYS[user.plan] && user.plan_exp > Date.now());

// Operator dashboard access — a normal verified account whose email is on the
// admin list. Extend with a comma-separated ADMIN_EMAILS env var.
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || 'lfaria@mabenconsulting.ca')
  .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
function adminUser(req) {
  const s = sessionUser(req);
  return s && s.user.verified && ADMIN_EMAILS.has(s.email) ? s : null;
}

// Attach an entitlement to an account, keeping whichever expires later.
function grantToUser(email, plan, exp) {
  const u = db.users.get(email);
  if (!u) return;
  if (!accountPassActive(u) || exp > u.plan_exp) db.users.grant(email, plan, exp);
}

// --- Outbound email ----------------------------------------------------------
// All email goes through Resend when RESEND_API_KEY is set; otherwise each
// message's essentials are logged server-side so an operator can help manually.
// Note: Resend's shared onboarding@resend.dev sender only delivers to the
// Resend account owner's own address — a verified domain (MAIL_FROM) is
// required before emailing real users.
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'ParkPulse <onboarding@resend.dev>';

// WhatsApp concierge: the same AI advisor, reachable by texting our WhatsApp
// Business number. Dormant until the Meta Cloud API credentials are set.
const WA_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const WA_VERIFY = process.env.WHATSAPP_VERIFY_TOKEN || '';
const WA_NUMBER = (process.env.WHATSAPP_NUMBER || '').replace(/[^\d]/g, ''); // digits only, for wa.me links
const WA_API_BASE = process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com/v21.0';
const WA_ENABLED = Boolean(WA_TOKEN && WA_PHONE_ID && WA_VERIFY);

async function sendWhatsApp(to, text) {
  // WhatsApp caps a text body at 4096 chars; split long replies politely.
  const chunks = [];
  let rest = String(text || '').trim();
  while (rest.length > 3500) {
    let cut = rest.lastIndexOf('\n', 3500);
    if (cut < 500) cut = 3500;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  for (const chunk of chunks) {
    const res = await fetch(`${WA_API_BASE}/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WA_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: chunk } }),
    });
    if (!res.ok) throw new Error(`whatsapp send ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
}

// One-time codes minted in the app to bind a WhatsApp number to an account.
const waCodes = new Map(); // code -> { email, exp }
function mintWaCode(email) {
  for (const [c, v] of waCodes) if (v.exp < Date.now()) waCodes.delete(c);
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  waCodes.set(code, { email, exp: Date.now() + 15 * 60000 });
  return code;
}

function sanitizeProfile(rawP) {
  const AGES = ['toddler', 'kid', 'teen', 'adult'];
  const VIBES = ['gentle', 'family', 'thrill', 'water', 'show'];
  return rawP && typeof rawP === 'object' ? {
    party: Number.isInteger(rawP.party) && rawP.party >= 1 && rawP.party <= 20 ? rawP.party : null,
    ages: Array.isArray(rawP.ages) ? rawP.ages.filter((a) => AGES.includes(a)).slice(0, 4) : [],
    vibes: Array.isArray(rawP.vibes) ? rawP.vibes.filter((v) => VIBES.includes(v)).slice(0, 5) : [],
    onsite: typeof rawP.onsite === 'boolean' ? rawP.onsite : null,
  } : null;
}

const strList = (v, max) => Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 120)).slice(0, max) : [];

// The live agent behind the WhatsApp number: same consultant, same live
// waits, plus everything the visitor set up in the app today.
async function waAgentReply(link, text) {
  const ds = db.daystate.get(link.email) || {};
  const slug = PARKS[ds.park] ? ds.park : 'magic-kingdom';
  const waits = await getWaits(slug);
  try { waits.forecast = forecastFor(slug); } catch {}
  const history = db.wa.history(link.phone);
  const messages = [...history, { role: 'user', content: String(text).trim().slice(0, 2000) }];
  while (messages.length && messages[0].role !== 'user') messages.shift();
  let reply = '';
  await consultant.consult({
    park: PARKS[slug], waits, messages,
    favorites: strList(ds.favorites, 30),
    planPicks: strList(ds.picked, 30),
    done: strList(ds.done, 40),
    profile: sanitizeProfile(ds.profile),
    subscription: null,
    email: link.email,
    memory: db.advisor.getMemory(link.email),
    trip: db.trips.get(link.email),
    lang: LANG_NAMES[ds.lang] || 'English',
    channel: 'whatsapp',
    send: (event, data) => { if (event === 'delta' && data.text) reply += data.text; },
  });
  db.wa.saveHistory(link.phone, [...messages, { role: 'assistant', content: (reply || '').slice(0, 2000) }]);
  // WhatsApp bolds with single asterisks, not markdown's double.
  return (reply || "I couldn't come up with an answer just now — try asking again in a moment.").replace(/\*\*(.+?)\*\*/g, '*$1*');
}

async function sendEmail(to, subject, html, logFallback) {
  if (!RESEND_KEY) {
    console.log(logFallback || `Email not sent to ${to} (no RESEND_API_KEY set): ${subject}`);
    return { sent: false, reason: 'RESEND_API_KEY not set' };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${RESEND_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return { sent: true };
}

const sendResetEmail = (origin, email, token) => {
  const link = `${origin}/reset?email=${encodeURIComponent(email)}&token=${token}`;
  return sendEmail(email, 'Reset your ParkPulse password',
    `<p>Someone (hopefully you) asked to reset the password for this ParkPulse account.</p>
<p><a href="${link}">Reset your password</a> — the link is valid for 1 hour.</p>
<p>If this wasn't you, ignore this email; your password is unchanged.</p>`,
    `Password reset requested for ${email} (no RESEND_API_KEY set) — link: ${link}`);
};

// Email verification: 6-digit codes, hashed at rest, 15-minute validity.
const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');
const sendVerifyEmail = (email, code) => sendEmail(email, `${code} is your ParkPulse code`,
  `<p>Your ParkPulse verification code:</p><p style="font-size:28px;font-weight:800;letter-spacing:4px">${code}</p><p>It expires in 15 minutes. If you didn't request it, ignore this email.</p>`,
  `Verification code for ${email}: ${code}`);

// Deletion is scheduled, not immediate: the account sits in a grace period so
// a regretted tap at 2am is recoverable, by the emailed link or simply by
// logging back in.
const DELETE_GRACE_DAYS = 7;
const sendDeletionEmail = (origin, email, token, deleteAt) => {
  const link = `${origin}/cancel-deletion?email=${encodeURIComponent(email)}&token=${token}`;
  const when = new Date(deleteAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return sendEmail(email, 'Your ParkPulse account is scheduled for deletion',
    `<p>We're sorry to see you go.</p>
<p>Your ParkPulse account and everything in it — trips, plans, advisor conversations and alerts — will be permanently deleted on <strong>${when}</strong>. Until then nothing is lost.</p>
<p>Changed your mind? <a href="${link}">Click here to cancel</a> — or just log in again, which cancels it too.</p>
<p>After that date this cannot be undone.</p>`,
    `Deletion scheduled for ${email} (no RESEND_API_KEY set) — cancel link: ${link}`);
};

// One-time welcome after the account verifies. Fire-and-forget, never blocks.
const sendInviteEmail = (origin, email, token, days, note) => {
  const link = `${origin}/invite?t=${token}`;
  return sendEmail(email, "You're invited to ParkPulse 🎢",
    `<p>You've been given <b>full ParkPulse access for ${days} days</b> — live wait times for 56 parks worldwide, the AI day planner, and wait-drop alerts.</p>
     ${note ? `<p><i>${note.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</i></p>` : ''}
     <p><a href="${link}" style="display:inline-block;background:#5b3df5;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700">Accept your invite →</a></p>
     <p>Or open this link: ${link}</p>`,
    `Invite for ${email} (no RESEND_API_KEY set) — link: ${link}`);
};

const sendWelcomeEmail = (email) => sendEmail(email, 'Welcome to ParkPulse 🎢',
  `<p>Your account is verified — you're in!</p>
<p>Three things worth trying on your next park day:</p>
<ul>
<li><b>Plan my day</b> builds a full-day, walk-smart ride order from live and predicted waits.</li>
<li>The <b>AI advisor</b> answers anything — dining, skip-pass math, rainy-day backup plans.</li>
<li><b>Wait alerts</b> ping your phone when a ride you want drops below your threshold.</li>
</ul>
<p>Happy riding!<br>— ParkPulse</p>`,
  `Welcome email skipped for ${email} (no RESEND_API_KEY set)`);
function startVerification(email) {
  const code = String(crypto.randomInt(100000, 1000000));
  db.users.setVerifyCode(email, hashCode(code), Date.now() + 15 * 60000);
  sendVerifyEmail(email, code).catch((err) => console.log(`verify email failed: ${err.message}`));
}
// 6 wrong codes per email per 15 minutes.
const verifyFails = new Map();
function verifyBlocked(email) {
  const f = verifyFails.get(email);
  if (!f || Date.now() > f.resetAt) { verifyFails.set(email, { n: 1, resetAt: Date.now() + 15 * 60000 }); return false; }
  f.n += 1;
  return f.n > 6;
}

const forgotFails = new Map();
function forgotBlocked(key) {
  const f = forgotFails.get(key);
  if (!f || Date.now() > f.resetAt) { forgotFails.set(key, { n: 1, resetAt: Date.now() + 3600000 }); return false; }
  f.n += 1;
  return f.n > 3;
}

// Feedback flood damper: 30 votes per IP per hour.
const feedbackHits = new Map();
function feedbackBlocked(key) {
  const f = feedbackHits.get(key);
  if (!f || Date.now() > f.resetAt) { feedbackHits.set(key, { n: 1, resetAt: Date.now() + 3600000 }); return false; }
  f.n += 1;
  return f.n > 30;
}

// Description-generation damper: 60 fresh generations per IP per hour
// (cached descriptions are unmetered).
const rideInfoHits = new Map();
function rideInfoBlocked(key) {
  const f = rideInfoHits.get(key);
  if (!f || Date.now() > f.resetAt) { rideInfoHits.set(key, { n: 1, resetAt: Date.now() + 3600000 }); return false; }
  f.n += 1;
  return f.n > 60;
}

// Brute-force damper: 5 failed logins per email per 15 minutes.
const loginFails = new Map();
function loginBlocked(email) {
  const f = loginFails.get(email);
  return f && f.n >= 5 && Date.now() < f.resetAt;
}
function noteLoginFail(email) {
  const f = loginFails.get(email);
  if (!f || Date.now() > f.resetAt) loginFails.set(email, { n: 1, resetAt: Date.now() + 15 * 60000 });
  else f.n += 1;
}

// --- Sharing signals ---------------------------------------------------------
// One account actively pulling waits at two parks >500 km apart within an
// hour is physically impossible for one household — a clean sharing signal
// with none of the false positives of IP matching. Measured, not enforced.
const parkSeen = new Map(); // email -> Map(slug -> ts)
const sharingSignals = [];
const kmBetween = (a, b) => {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
function noteParkUse(email, slug) {
  const now = Date.now();
  const seen = parkSeen.get(email) ?? new Map();
  for (const [other, ts] of seen) {
    if (other === slug || now - ts > 60 * 60000) continue;
    const a = PARKS[slug], b = PARKS[other];
    if (!a?.lat || !b?.lat) continue;
    const km = Math.round(kmBetween(a, b));
    if (km > 500 && !sharingSignals.some((x) => x.email === email && x.parks.includes(other) && now - x.ts < 6 * 3600000)) {
      sharingSignals.push({ email, parks: [slug, other], km, at: new Date().toISOString(), ts: now });
      if (sharingSignals.length > 50) sharingSignals.shift();
    }
  }
  seen.set(slug, now);
  if (seen.size > 10) seen.delete(seen.keys().next().value);
  parkSeen.set(email, seen);
  if (parkSeen.size > 5000) parkSeen.delete(parkSeen.keys().next().value);
}

const passFromReq = (req) => verifyPass(req.headers['x-pass']);
function hasAccess(req) {
  if (!PRO_GATE) return true;
  if (passFromReq(req)) return true;
  const s = sessionUser(req);
  return Boolean(s && accountPassActive(s.user));
}

async function stripeApi(endpoint, params) {
  const res = await fetch(`https://api.stripe.com${endpoint}`, {
    method: params ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${STRIPE_KEY}`,
      ...(params && { 'content-type': 'application/x-www-form-urlencoded' }),
    },
    body: params ? new URLSearchParams(params) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `stripe ${res.status}`);
  return json;
}

function recordPass(entry) {
  try { db.passes.add(entry.plan, entry.session, entry.email); } catch {}
}

const SAMPLE = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sample-waits.json'), 'utf8'));

// Typical waits indexed by normalized ride name, so live rides can carry a
// "vs typical" comparison even when queue-times names differ in punctuation.
const normName = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const TYPICAL = Object.fromEntries(
  Object.entries(SAMPLE).map(([slug, d]) => [slug, new Map(d.rides.map((r) => [normName(r.name), r.wait]))])
);

// Measured baselines from collected history take precedence over the static
// hand-built samples; static values remain the fallback until data accrues.
let MEASURED = {};
let DOW_INDEX = {};
function refreshBaselines() {
  try {
    MEASURED = history.computeBaselines(normName);
    DOW_INDEX = history.computeDowIndex();
    const parks = Object.keys(MEASURED).length;
    if (parks) console.log(`Baselines refreshed from history: ${parks} parks (${Object.keys(DOW_INDEX).length} with dow index)`);
  } catch (err) {
    console.log(`Baseline refresh failed: ${err.message}`);
  }
}
refreshBaselines();
setInterval(refreshBaselines, 6 * 60 * 60 * 1000);

const typicalFor = (slug, rideName) => {
  const key = normName(rideName);
  return MEASURED[slug]?.get(key) ?? TYPICAL[slug]?.get(key) ?? null;
};

// Park registry: display data, typical hours/shows, and queue-times matching
// hints. Static ids are fallbacks — resolveParkIds() corrects them against
// queue-times' live parks directory by name, so we never hardcode a wrong id.
const REGISTRY = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'parks.json'), 'utf8'));
const PARKS = Object.fromEntries(REGISTRY.map((p) => [p.slug, p]));

async function resolveParkIds() {
  try {
    const res = await fetch('https://queue-times.com/parks.json', { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const companies = await res.json();
    const all = companies.flatMap((c) => (c.parks || []).map((p) => ({ id: p.id, haystack: normName(`${c.name} ${p.name}`) })));
    for (const entry of REGISTRY) {
      const candidates = all.filter((p) =>
        entry.tokens.every((t) => p.haystack.includes(normName(t))) &&
        !(entry.exclude || []).some((t) => p.haystack.includes(normName(t)))
      );
      if (candidates.length) {
        entry.id = candidates.sort((a, b) => a.haystack.length - b.haystack.length)[0].id;
      }
    }
    console.log('Park ids resolved from queue-times directory');
  } catch (err) {
    console.log(`Park id resolution skipped (${err.message}) — using static ids`);
  }
}
resolveParkIds();
setInterval(resolveParkIds, 24 * 60 * 60 * 1000);

// --- Web Push (wait-drop alerts) ---------------------------------------------
// VAPID keys from env, or generated once and persisted next to the data files.
// On Railway, set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY (or mount a volume) so
// subscriptions survive redeploys.
let vapidKeys;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapidKeys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else if (db.kv.get('vapid')) {
  vapidKeys = JSON.parse(db.kv.get('vapid'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  db.kv.set('vapid', JSON.stringify(vapidKeys));
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:alerts@parkpulse.example', vapidKeys.publicKey, vapidKeys.privateKey);

const ALERT_CHECK_MS = 5 * 60 * 1000;
// Guardian state: last observed open/closed per watched ride, so alert
// holders get a proactive push when their ride goes down or comes back.
const rideOpenState = new Map();
async function checkAlerts() {
  for (const slug of db.alerts.parks()) {
    // One park's failure must never cost the other parks their alerts.
    try {
    const data = await getWaits(slug);
    if (data.source !== 'live') continue; // never alert off demo data
    // Guardian pass: closure/reopen notices (the alert itself stays armed).
    for (const alert of db.alerts.byPark(slug)) {
      const ride = data.rides.find((r) => normName(r.name) === normName(alert.ride));
      if (!ride) continue;
      const key = `${slug}|${normName(ride.name)}`;
      const prev = rideOpenState.get(key);
      if (prev !== undefined && prev !== ride.open) {
        const payload = JSON.stringify(ride.open
          ? { title: `${ride.name} reopened ✅`, body: `Back up at ${ride.wait} min — go before the line rebuilds!` }
          : { title: `${ride.name} is down ⚠️`, body: 'Temporarily closed — pivot to your next pick and circle back.' });
        try {
          await webpush.sendNotification(JSON.parse(alert.subscription), payload);
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) db.alerts.removeByEndpoint(alert.endpoint);
        }
      }
    }
    for (const r of data.rides) rideOpenState.set(`${slug}|${normName(r.name)}`, r.open);
    for (const alert of db.alerts.byPark(slug)) {
      const ride = data.rides.find((r) => normName(r.name) === normName(alert.ride));
      if (!ride || !ride.open || ride.wait > alert.threshold) continue;
      const payload = JSON.stringify({
        title: `${ride.name}: ${ride.wait} min`,
        body: `Dropped below your ${alert.threshold} min alert${ride.typical ? ` (typical ${ride.typical} min)` : ''} — go now!`,
      });
      try {
        await webpush.sendNotification(JSON.parse(alert.subscription), payload);
        db.alerts.remove(alert.id); // fire once
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.alerts.removeByEndpoint(alert.endpoint);
        } // transient errors: keep and retry next cycle
      }
    }
    } catch (err) { console.log(`alert check failed for ${slug}: ${err.message}`); }
  }
}
// Booking-window reminders: Walt Disney World is the only chain with an
// advance Lightning Lane race (7 days on-site / 3 days off-site, 7:00 AM ET),
// so saved WDW trips with a push subscription get pinged the evening before
// their window opens — with morning-of and already-open fallbacks in case the
// evening pass was missed. One reminder per saved trip; re-saving re-arms it.
const etNow = () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: +get('hour') };
};
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Ride names come from a third-party feed and reach email HTML — escape them.
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- Day-plan KPIs & the advisor email ---------------------------------------
// Walking distance is real: it measures the plan's route through the park
// using the same coordinates that drive the map pins.
const STRIDE_M = 0.76;          // average adult stride
const KCAL_PER_KG_KM = 0.53;    // walking, casual park pace
const DEFAULT_KG = 70;

const planMails = new Map(); // email -> [timestamps]
function planMailBlocked(email) {
  const now = Date.now();
  const hits = (planMails.get(email) || []).filter((t) => now - t < 24 * 3600000);
  hits.push(now);
  planMails.set(email, hits);
  if (planMails.size > 5000) planMails.delete(planMails.keys().next().value);
  return hits.length > 6;
}

async function planKpis(park, stops, profile) {
  const rideNames = stops.map((st) => st.name);
  const geo = db.geo.get(park.slug);
  const coords = new Map((geo?.rides || []).map((r) => [r.name, r]));
  let meters = 0;
  let legs = 0;
  let prev = null;
  for (const name of rideNames) {
    const c = coords.get(name);
    if (!c) continue;
    if (prev) { meters += kmBetween(prev, c) * 1000; legs++; }
    prev = c;
  }
  // Park entrance to the first stop and back at the end: most visitors walk
  // it, and leaving it out understates the day by a kilometre or more.
  const first = rideNames.map((n) => coords.get(n)).find(Boolean);
  const last = [...rideNames].reverse().map((n) => coords.get(n)).find(Boolean);
  if (first) meters += kmBetween({ lat: park.lat, lng: park.lng }, first) * 1000;
  if (last) meters += kmBetween(last, { lat: park.lat, lng: park.lng }) * 1000;
  // Wandering between the direct lines: queues, shops, restrooms, detours.
  meters *= 1.35;

  let tags = {};
  try { tags = JSON.parse(db.ridetags.get(park.slug) || '{}'); } catch {}
  // A park nobody has browsed yet has no tags — generate them now rather
  // than send a half-empty email (cached forever afterwards).
  if (!Object.keys(tags).length && consultant.enabled()) {
    try {
      const all = await getWaits(park.slug);
      const names = all.rides.map((r) => r.name).slice(0, 120);
      if (names.length) {
        const made = await consultant.rideTags(park.name, names);
        if (made && Object.keys(made).length) { tags = made; db.ridetags.set(park.slug, JSON.stringify(made)); }
      }
    } catch (err) { console.log(`plan tags (${park.slug}): ${err.message}`); }
  }
  const vibes = {};
  let youngestOk = 0;
  let singleRider = 0;
  for (const n of rideNames) {
    const t = tags[n];
    if (!t) continue;
    vibes[t.vibe] = (vibes[t.vibe] || 0) + 1;
    if (t.minAge <= 3) youngestOk++;
    if (t.sr) singleRider++;
  }

  // Lands and the biggest line the timing dodges, both from the live feed:
  // standby right now vs. what the plan predicts at the chosen hour.
  let lands = new Set();
  let dodged = null;
  let live = new Map();
  try {
    const waits = await getWaits(park.slug);
    live = new Map(waits.rides.map((r) => [r.name, r]));
  } catch {}
  try {
    for (const st of stops) {
      const r = live.get(st.name);
      // Feed lands are authoritative; the classifier covers feeds that omit them.
      const land = (r && r.land) || (tags[st.name] && tags[st.name].land) || '';
      if (land) lands.add(land);
      if (r && r.open && Number.isFinite(st.wait)) {
        const gap = r.wait - st.wait;
        if (gap > 0 && (!dodged || gap > dodged.minutes)) dodged = { name: st.name, minutes: Math.round(gap), standby: r.wait };
      }
    }
  } catch {}

  const party = profile && profile.party ? profile.party : 1;
  const skip = park.skip && park.skip.type !== 'none' ? park.skip : null;
  const km = meters / 1000;
  return {
    attractions: rideNames.length,
    mapped: legs + (first ? 1 : 0),
    km: Math.round(km * 10) / 10,
    miles: Math.round(km * 0.621371 * 10) / 10,
    steps: Math.round(meters / STRIDE_M / 100) * 100,
    kcal: Math.round(KCAL_PER_KG_KM * DEFAULT_KG * km),
    thrills: vibes.thrill || 0,
    water: vibes.water || 0,
    shows: vibes.show || 0,
    gentle: (vibes.gentle || 0) + (vibes.family || 0),
    toddlerFriendly: youngestOk,
    singleRider,
    lands: lands.size,
    landNames: [...lands].slice(0, 8),
    dodged,
    party,
    skip: skip ? {
      name: skip.name,
      low: skip.low * party,
      high: skip.high * party,
      cur: skip.cur || '$',
    } : null,
  };
}

function planEmailHtml({ park, day, stops, kpis, savedMin, briefing, profile }) {
  const B = '#5b3df5';
  const tile = (v, label, sub) => `<td style="padding:0 6px" width="25%" valign="top">
    <div style="background:#f4f1ff;border-radius:14px;padding:14px 8px;text-align:center">
      <div style="font-size:26px;font-weight:800;color:${B};line-height:1.1">${v}</div>
      <div style="font-size:11px;font-weight:700;color:#443b6b;text-transform:uppercase;letter-spacing:.04em;margin-top:3px">${label}</div>
      ${sub ? `<div style="font-size:10px;color:#8b83a8;margin-top:2px">${sub}</div>` : ''}
    </div></td>`;
  const rows = stops.map((st, i) => `<tr>
    <td width="34" valign="top" style="padding:7px 0">
      <div style="width:26px;height:26px;border-radius:99px;background:${B};color:#fff;font-weight:800;font-size:12px;text-align:center;line-height:26px">${i + 1}</div></td>
    <td valign="top" style="padding:7px 0">
      <b style="color:#251d3d">${esc(st.name)}</b>
      <span style="color:#8b83a8;font-size:13px">${st.time ? ' · ' + esc(st.time) : ''}${st.wait != null ? ' · ~' + st.wait + ' min' : ''}</span>
    </td></tr>`).join('');
  // Everything below is derived from the plan itself — ride tags, the live
  // feed, and the park's own skip-pass pricing.
  const fact = (icon, label) => `<tr><td width="26" valign="top" style="padding:4px 0;font-size:15px">${icon}</td>
    <td valign="top" style="padding:4px 0;font-size:14px;color:#3f3762">${label}</td></tr>`;
  const facts = [
    kpis.thrills ? fact('🎢', `<b>${kpis.thrills}</b> thrill ride${kpis.thrills === 1 ? '' : 's'} on the list`) : '',
    kpis.water ? fact('💦', `<b>${kpis.water}</b> chance${kpis.water === 1 ? '' : 's'} to get soaked — pack a poncho`) : '',
    kpis.shows ? fact('🎭', `<b>${kpis.shows}</b> show${kpis.shows === 1 ? '' : 's'} to sit down and cool off`) : '',
    kpis.lands ? fact('🗺️', `Crossing <b>${kpis.lands}</b> land${kpis.lands === 1 ? '' : 's'}${kpis.landNames.length ? ' · ' + esc(kpis.landNames.join(', ')) : ''}`) : '',
    kpis.singleRider ? fact('🚶', `<b>${kpis.singleRider}</b> single-rider line${kpis.singleRider === 1 ? '' : 's'} available if you split up`) : '',
    kpis.toddlerFriendly && profile && profile.ages && profile.ages.includes('toddler')
      ? fact('👶', `<b>${kpis.toddlerFriendly}</b> of these work for your youngest`) : '',
    kpis.steps ? fact('👟', `About <b>${kpis.steps.toLocaleString()}</b> steps`) : '',
    kpis.skip ? fact('💳', `Built to work without <b>${esc(kpis.skip.name)}</b> — that\'s ${kpis.skip.cur}${kpis.skip.low}–${kpis.skip.cur}${kpis.skip.high} kept in your pocket${kpis.party > 1 ? ` for ${kpis.party}` : ''}`) : '',
  ].filter(Boolean).join('');

  const dodgedBanner = kpis.dodged
    ? `<div style="padding:4px 26px 0"><div style="background:#eafaf1;border-radius:12px;padding:12px 16px;font-size:14px;color:#14532d">
        ⏱️ <b>Biggest line dodged:</b> ${esc(kpis.dodged.name)} is ${kpis.dodged.standby} min right now — your slot lands about <b>${kpis.dodged.minutes} min shorter</b>.
      </div></div>`
    : '';
  return `<div style="background:#f7f5ff;padding:24px 12px;font:15px/1.6 -apple-system,'Segoe UI',sans-serif;color:#251d3d">
   <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 6px 28px rgba(20,12,48,.09)">
    <div style="background:linear-gradient(135deg,${B},#8b5cf6);padding:26px 26px 22px;color:#fff">
      <div style="font-size:12px;font-weight:800;letter-spacing:.12em;opacity:.85;text-transform:uppercase">ParkPulse · your day plan</div>
      <div style="font-size:26px;font-weight:800;letter-spacing:-.02em;margin-top:6px">${esc(park.name)}</div>
      <div style="opacity:.85;font-size:14px">${day}</div>
    </div>
    <div style="padding:22px 20px 6px">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        ${tile(kpis.attractions, 'Attractions', 'on the plan')}
        ${tile(kpis.km + ' km', 'Walking', kpis.miles + ' mi')}
        ${tile(kpis.kcal, 'Calories', 'per adult')}
        ${tile(savedMin >= 60 ? Math.round(savedMin / 60) + ' hr' : savedMin + ' min', 'Line time saved', 'vs. winging it')}
      </tr></table>
    </div>
    ${dodgedBanner}
    ${briefing ? `<div style="padding:16px 26px 4px">
      <div style="background:#fffaf0;border-left:4px solid #f0b429;border-radius:10px;padding:14px 16px;font-size:14.5px">
        <b>🧭 Your advisor's take</b><br>${esc(briefing).replace(/\n/g, '<br>')}
      </div></div>` : ''}
    <div style="padding:18px 26px 6px">
      <div style="font-weight:800;font-size:16px;margin-bottom:2px">Today's running order</div>
      <div style="color:#8b83a8;font-size:13px;margin-bottom:8px">Follow the numbers — they match the pins on your map.</div>
      <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
    </div>
    ${facts ? `<div style="padding:14px 26px 2px">
      <div style="font-weight:800;font-size:16px;margin-bottom:6px">Your day at a glance</div>
      <table width="100%" cellpadding="0" cellspacing="0">${facts}</table></div>` : ''}
    <div style="padding:20px 26px 26px">
      <a href="https://www.parkpulse.fun/app" style="display:inline-block;background:${B};color:#fff;text-decoration:none;font-weight:800;padding:13px 26px;border-radius:12px">Open live waits →</a>
      <div style="color:#a49cc0;font-size:11.5px;margin-top:16px;line-height:1.5">
        Walking distance is measured along your planned route${kpis.mapped ? '' : ' (estimated)'} plus the walk in and out, with a 35% allowance for real-world wandering. Calories assume a 70 kg adult at a casual pace — a rough guide, not a fitness tracker.
      </div>
    </div>
   </div>
   <div style="max-width:600px;margin:12px auto 0;text-align:center;color:#a49cc0;font-size:11.5px">
     ParkPulse · unofficial fan tool, not affiliated with any park operator.
   </div>
  </div>`;
}

// --- AI spend tracking -------------------------------------------------------
// Anthropic list prices per million tokens (docs: anthropic.com/pricing).
// Cache writes bill at 1.25x the input rate, cache reads at 0.1x.
const AI_PRICES = {
  "claude-opus-5":    { in: 5.00,  out: 25.00 },
  "claude-fable-5":   { in: 10.00, out: 50.00 },
  "claude-sonnet-5":  { in: 3.00,  out: 15.00 },
  "claude-haiku-4-5": { in: 1.00,  out: 5.00 },
};
const AI_REPORT_TO = process.env.AI_REPORT_TO || ADMIN_EMAILS.values().next().value || "";
const AI_REPORT_HOUR = Number(process.env.AI_REPORT_HOUR || 8); // ET

function priceUsage(model, usage) {
  const p = AI_PRICES[model] || AI_PRICES["claude-opus-5"];
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cost = (input * p.in + cacheWrite * p.in * 1.25 + cacheRead * p.in * 0.1 + output * p.out) / 1e6;
  return { input, output, cacheWrite, cacheRead, cost };
}

function recordUsage(feature, model, usage) {
  try { db.aiusage.add(etNow().date, feature, model, priceUsage(model, usage)); }
  catch (err) { console.log(`usage record failed: ${err.message}`); }
}

const usd = (n) => "$" + (Math.round(n * 100) / 100).toFixed(2);
const usd4 = (n) => "$" + n.toFixed(n < 1 ? 4 : 2);

// Day / week / month spend, week and month being trailing 7 and 30 days
// ending on the report day, so the numbers are comparable run to run.
function aiCostReport(day) {
  const win = (n) => db.aiusage.totals(addDays(day, -(n - 1)), day);
  return {
    day, today: win(1), week: win(7), month: win(30),
    features: db.aiusage.byFeature(addDays(day, -29), day),
    days: db.aiusage.byDay(addDays(day, -13), day),
  };
}

function aiCostEmailHtml(r) {
  const row = (label, t) => `<tr><td style="padding:6px 12px 6px 0"><b>${label}</b></td>
    <td style="padding:6px 12px 6px 0;font-size:20px"><b>${usd(t.cost_usd)}</b></td>
    <td style="padding:6px 0;color:#666">${t.calls} calls · ${(t.input_tokens + t.cache_read + t.cache_write).toLocaleString()} in / ${t.output_tokens.toLocaleString()} out</td></tr>`;
  const feats = r.features.length
    ? r.features.map((f) => `<tr><td style="padding:3px 12px 3px 0">${f.feature}</td><td style="padding:3px 0">${usd4(f.cost_usd)} <span style="color:#888">(${f.calls})</span></td></tr>`).join("")
    : `<tr><td colspan="2" style="color:#888">No AI calls in the last 30 days.</td></tr>`;
  const peak = Math.max(...r.days.map((d) => d.cost_usd), 0.0001);
  const spark = r.days.map((d) => `<td style="vertical-align:bottom;padding:0 2px">
      <div style="width:14px;height:${Math.max(2, Math.round((d.cost_usd / peak) * 46))}px;background:#5b3df5;border-radius:2px"></div>
      <div style="font-size:9px;color:#999;text-align:center">${d.day.slice(8)}</div></td>`).join("");
  return `<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;color:#251d3d;max-width:560px">
    <h2 style="margin:0 0 2px">ParkPulse AI spend</h2>
    <p style="margin:0 0 18px;color:#666">for ${r.day} (Eastern)</p>
    <table style="border-collapse:collapse;margin-bottom:22px">
      ${row("Today", r.today)}${row("Last 7 days", r.week)}${row("Last 30 days", r.month)}
    </table>
    <p style="margin:0 0 6px"><b>By feature</b> <span style="color:#888">· last 30 days</span></p>
    <table style="border-collapse:collapse;margin-bottom:22px">${feats}</table>
    ${r.days.length ? `<p style="margin:0 0 6px"><b>Daily spend</b> <span style="color:#888">· last 14 days, peak ${usd4(peak)}</span></p>
    <table style="border-collapse:collapse"><tr>${spark}</tr></table>` : ""}
    <p style="margin:22px 0 0;font-size:12px;color:#888">Estimated from token counts at Anthropic list prices — your invoice is the source of truth.</p>
  </div>`;
}

async function sendAiCostEmail(day) {
  if (!AI_REPORT_TO) return { sent: false, reason: "no recipient configured" };
  const r = aiCostReport(day);
  return sendEmail(AI_REPORT_TO, `ParkPulse AI spend ${day}: ${usd(r.today.cost_usd)} today · ${usd(r.week.cost_usd)} this week`,
    aiCostEmailHtml(r), `AI spend ${day}: today ${usd(r.today.cost_usd)}, week ${usd(r.week.cost_usd)}, month ${usd(r.month.cost_usd)}`);
}

// Fires once per day at AI_REPORT_HOUR Eastern, from the shared interval.
async function maybeSendAiCostEmail() {
  const { date, hour } = etNow();
  if (hour < AI_REPORT_HOUR) return;
  if (db.kv.get("ai-report-sent") === date) return;
  db.kv.set("ai-report-sent", date);
  try {
    const r = await sendAiCostEmail(date);
    console.log(`ai cost email ${r.sent ? "sent to " + AI_REPORT_TO : "skipped: " + r.reason}`);
  } catch (err) { console.log(`ai cost email failed: ${err.message}`); }
}

async function checkBookingReminders() {
  for (const t of db.trips.pendingReminders()) {
    if (t.dest !== 'Walt Disney World') continue;
    const { date: today, hour } = etNow();
    if (t.start < today) { db.trips.markNotified(t.email); continue; } // trip already underway
    const windowDate = addDays(t.start, -(t.onsite ? 7 : 3));
    let body = null;
    if (windowDate === addDays(today, 1) && hour >= 17) body = 'opens TOMORROW at 7:00 AM ET — set an alarm and book your must-do ride first!';
    else if (windowDate === today && hour < 7) body = 'opens TODAY at 7:00 AM ET — book your must-do ride the moment it does!';
    else if (windowDate < today || (windowDate === today && hour >= 7)) body = 'is already open — book your must-do rides now before they sell out!';
    if (!body) continue;
    const payload = JSON.stringify({ title: '🎟 Lightning Lane booking window', body: `Your Walt Disney World window ${body}` });
    try {
      await webpush.sendNotification(JSON.parse(t.push_sub), payload);
      console.log(`booking reminder sent for ${t.email} (window ${windowDate})`);
    } catch (err) {
      console.log(`booking reminder failed for ${t.email}: ${err.statusCode || err.message}`);
    }
    db.trips.markNotified(t.email); // once per saved trip, even if the endpoint died
  }
}
// Accounts whose grace period has run out are purged for real.
function sweepDeletedAccounts() {
  for (const email of db.accounts.due(Date.now())) {
    try {
      const counts = db.accounts.purge(email);
      console.log(`account purged after grace period: ${email} — ${JSON.stringify(counts)}`);
    } catch (err) {
      console.log(`purge failed for ${email}: ${err.message}`);
    }
  }
}
setInterval(() => { checkAlerts().catch(() => {}); checkBookingReminders().catch(() => {}); sweepDeletedAccounts(); maybeSendAiCostEmail(); }, ALERT_CHECK_MS);
setTimeout(sweepDeletedAccounts, 8000);
setTimeout(() => checkBookingReminders().catch(() => {}), 5000);

// Language codes the app ships, mapped to names the model understands.
const LANG_NAMES = { en: 'English', zh: 'Chinese', hi: 'Hindi', es: 'Spanish', fr: 'French', ar: 'Arabic', bn: 'Bengali', de: 'German', id: 'Indonesian', it: 'Italian', ja: 'Japanese', ko: 'Korean', mr: 'Marathi', pt: 'Portuguese', ru: 'Russian', ta: 'Tamil', te: 'Telugu', tr: 'Turkish', ur: 'Urdu', vi: 'Vietnamese' };

// In-flight dining-guide generations, one per park+language.
const diningJobs = new Map();

// --- Ride coordinates from OpenStreetMap -------------------------------------
// One Overpass extraction per park, matched to the wait feed's ride names
// (normalized text first, one AI pass for the stragglers), cached forever.
const OVERPASS_APIS = (process.env.OVERPASS_API || 'https://overpass-api.de/api/interpreter https://overpass.kumi.systems/api/interpreter').split(/\s+/);
const geoJobs = new Map();
const geoNorm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(the|and|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();

// ThemeParks.wiki: free, open API with official attraction coordinates for
// most major chains — the precision tier of the pin pipeline.
const THEMEPARKS_API = process.env.THEMEPARKS_API || 'https://api.themeparks.wiki/v1';

async function themeParksCoords(park) {
  const res = await fetch(`${THEMEPARKS_API}/destinations`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`themeparks destinations ${res.status}`);
  const { destinations } = await res.json();
  // Resolve our park to a themeparks.wiki park id: name must match, the
  // destination matching our group breaks ties ("Disneyland Park" exists in
  // both California and Paris).
  let best = null;
  for (const d of destinations || []) {
    const dn = geoNorm(d.name || '');
    const gn = geoNorm(park.group);
    const destHit = dn.includes(gn) || gn.includes(dn);
    for (const p of d.parks || []) {
      const pn = geoNorm(p.name || '');
      const on = geoNorm(park.name);
      if (!(pn === on || pn.includes(on) || on.includes(pn))) continue;
      const score = (destHit ? 2 : 0) + (pn === on ? 2 : 1);
      if (!best || score > best.score) best = { id: p.id, score };
    }
  }
  if (!best) return [];
  const cr = await fetch(`${THEMEPARKS_API}/entity/${best.id}/children`, { signal: AbortSignal.timeout(15000) });
  if (!cr.ok) throw new Error(`themeparks children ${cr.status}`);
  const { children } = await cr.json();
  return (children || [])
    .filter((c) => c.entityType === 'ATTRACTION' && c.location &&
      Number.isFinite(c.location.latitude) && Number.isFinite(c.location.longitude))
    .map((c) => ({ name: c.name, lat: c.location.latitude, lng: c.location.longitude }));
}

async function fetchOsmSpots(park) {
  const query = `[out:json][timeout:25];(
    node["attraction"](around:2500,${park.lat},${park.lng});
    way["attraction"](around:2500,${park.lat},${park.lng});
    node["tourism"="attraction"](around:2500,${park.lat},${park.lng});
    way["tourism"="attraction"](around:2500,${park.lat},${park.lng});
  );out center;`;
  let json = { elements: [] };
  for (const api of OVERPASS_APIS) {
    try {
      const res = await fetch(api, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      json = await res.json();
      break;
    } catch (err) { console.log(`overpass (${api}): ${err.message}`); }
  }
  const spots = new Map(); // name -> {lat, lng}
  for (const el of json.elements || []) {
    const name = el.tags?.name;
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (name && Number.isFinite(lat) && Number.isFinite(lng) && !spots.has(name)) spots.set(name, { lat, lng });
  }
  return spots;
}

// Full coverage is a hard requirement: every ride on the wait list gets a
// pin. Tiers by accuracy — themeparks.wiki official coordinates, then OSM,
// then AI best-guess (two passes, labeled approximate), then a deterministic
// ring near the park centre so nothing is ever missing from the map.
async function buildParkGeo(park) {
  const waits = await getWaits(park.slug);
  const feedNames = waits.rides.map((r) => r.name);
  const placed = new Map(); // feed name -> {name, lat, lng, approx?}

  // Match a named coordinate set against still-unplaced feed names.
  const matchSpots = (spots) => {
    const byNorm = new Map([...spots.keys()].map((n) => [geoNorm(n), n]));
    for (const feedName of feedNames) {
      if (placed.has(feedName)) continue;
      const n = geoNorm(feedName);
      let hit = byNorm.get(n) || null;
      if (!hit) for (const [sn, orig] of byNorm) { if (sn.includes(n) || n.includes(sn)) { hit = orig; break; } }
      if (hit) placed.set(feedName, { name: feedName, ...spots.get(hit) });
    }
  };

  let tpw = 0;
  try {
    const coords = await themeParksCoords(park);
    matchSpots(new Map(coords.map((t) => [t.name, { lat: t.lat, lng: t.lng }])));
    tpw = placed.size;
  } catch (err) { console.log(`themeparks (${park.slug}): ${err.message}`); }

  let osm = 0;
  if (placed.size < feedNames.length) {
    const spots = await fetchOsmSpots(park);
    matchSpots(spots);
    // AI reconciles oddly-named OSM entries with the still-unplaced rides.
    const leftover = feedNames.filter((n) => !placed.has(n));
    if (leftover.length && spots.size && consultant.enabled()) {
      try {
        const pairs = await consultant.matchNames(park.name, leftover, [...spots.keys()]);
        for (const p of pairs) if (spots.has(p.b) && !placed.has(p.a) && leftover.includes(p.a)) placed.set(p.a, { name: p.a, ...spots.get(p.b) });
      } catch (err) { console.log(`geo match (${park.slug}): ${err.message}`); }
    }
    osm = placed.size - tpw;
  }

  if (consultant.enabled()) {
    for (let pass = 0; pass < 2; pass++) {
      const missing = feedNames.filter((n) => !placed.has(n));
      if (!missing.length) break;
      try {
        const est = await consultant.geoEstimate(park.name, park.group, { lat: park.lat, lng: park.lng }, missing);
        for (const e of est) if (!placed.has(e.name)) placed.set(e.name, { ...e, approx: true });
      } catch (err) { console.log(`geo estimate pass ${pass + 1} (${park.slug}): ${err.message}`); }
    }
  }
  const stillMissing = feedNames.filter((n) => !placed.has(n));
  stillMissing.forEach((name, i) => {
    const angle = (i / Math.max(stillMissing.length, 1)) * 2 * Math.PI;
    placed.set(name, { name, lat: park.lat + 0.0012 * Math.sin(angle), lng: park.lng + 0.0012 * Math.cos(angle), approx: true });
  });
  const rides = feedNames.map((n) => placed.get(n));
  const estimated = rides.filter((r) => r.approx).length;
  const status = !rides.length ? 'sparse' : estimated ? 'approx' : 'ok';
  console.log(`geo ${park.slug}: feed=${feedNames.length} tpw=${tpw} osm=${osm} estimated=${estimated} ringed=${stillMissing.length} -> ${status}`);
  return { rides, status };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const waitsCache = new Map();

// --- History collection ------------------------------------------------------
// Snapshot every park's live waits every 15 minutes. Parks are fetched
// sequentially with a courtesy gap (this also keeps the user-facing waits
// cache warm). Disable with HISTORY=off.
const COLLECT_MS = 15 * 60 * 1000;
async function collectHistory() {
  let recorded = 0;
  for (const park of REGISTRY) {
    if (park.id == null) continue;
    try {
      const waits = await getWaits(park.slug);
      if (history.record(park.slug, waits)) recorded += 1;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (recorded) console.log(`History: recorded ${recorded}/${REGISTRY.length} parks`);
  history.prune();
}
if (process.env.HISTORY !== 'off') {
  setTimeout(collectHistory, 20 * 1000); // first pass shortly after boot
  setInterval(collectHistory, COLLECT_MS);
}

async function getWaits(slug) {
  const park = PARKS[slug];
  // A slug that left the registry (or never existed) must not throw — stale
  // alert rows and hand-typed URLs both funnel arbitrary slugs in here.
  if (!park) return { park: slug, source: 'unavailable', attribution: '', updatedAt: new Date().toISOString(), rides: [] };
  const cached = waitsCache.get(slug);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
  try {
    if (park.id == null) throw new Error('park id unresolved');
    const res = await fetch(`https://queue-times.com/parks/${park.id}/queue_times.json`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'ParkPulse/0.1 (wait-time display with attribution)' },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const json = await res.json();
    // Keep each ride's land (park area) — it drives land-clustered plans and
    // geographically sane advisor advice.
    const rides = [
      ...(json.lands || []).flatMap((l) => (l.rides || []).map((r) => ({ ...r, land: l.name || null }))),
      ...(json.rides || []).map((r) => ({ ...r, land: null })),
    ];
    const data = {
      park: park.name,
      source: 'live',
      attribution: 'Powered by Queue-Times.com',
      updatedAt: new Date().toISOString(),
      rides: rides.map((r) => ({ name: r.name, wait: r.wait_time, open: r.is_open, land: r.land, typical: typicalFor(slug, r.name) })),
    };
    waitsCache.set(slug, { at: Date.now(), data });
    return data;
  } catch (err) {
    if (!SAMPLE[slug]) {
      return { park: park.name, source: 'unavailable', attribution: '', updatedAt: new Date().toISOString(), rides: [] };
    }
    return {
      park: park.name,
      source: 'sample',
      attribution: 'Typical waits shown — live feed unavailable',
      updatedAt: new Date().toISOString(),
      rides: SAMPLE[slug].rides.map((r) => ({ ...r, land: null, typical: r.wait })),
    };
  }
}

// --- 7-day crowd forecast ----------------------------------------------------
// Day-of-week factors measured from the park's own history, blended with
// industry priors (Saturday busiest, Tue/Wed lightest) while data accrues,
// plus a major-holiday boost. Levels 1-5.
const PRIOR_DOW = [1.10, 0.90, 0.85, 0.87, 0.93, 1.03, 1.22]; // Sun..Sat
const HOLIDAYS = {
  '2026-09-07': 'Labor Day', '2026-10-12': 'Columbus Day', '2026-11-26': 'Thanksgiving',
  '2026-11-27': 'Thanksgiving weekend', '2026-11-28': 'Thanksgiving weekend',
  '2027-01-01': "New Year's Day", '2027-01-18': 'MLK Day', '2027-02-15': "Presidents' Day",
  '2027-03-26': 'Easter week', '2027-03-27': 'Easter week', '2027-03-28': 'Easter',
  '2027-05-31': 'Memorial Day', '2027-07-03': 'July 4th weekend', '2027-07-04': 'July 4th',
  '2027-09-06': 'Labor Day',
};
const isChristmasWeek = (iso) => {
  const md = iso.slice(5);
  return md >= '12-19' || md <= '01-03';
};
const FORECAST_LEVELS = ['', 'Light', 'Mild', 'Moderate', 'Busy', 'Packed'];

function forecastFor(slug) {
  const park = PARKS[slug];
  const measured = DOW_INDEX[slug];
  const weight = measured ? Math.min(1, measured.days / 21) : 0;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + i * 86400000);
    // Date and weekday in the PARK's timezone, not the server's.
    const iso = d.toLocaleDateString('en-CA', { timeZone: park.tz });
    const dowName = d.toLocaleDateString('en-US', { timeZone: park.tz, weekday: 'short' });
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dowName);
    const m = measured?.factors[dow];
    let factor = weight * (m ?? PRIOR_DOW[dow]) + (1 - weight) * PRIOR_DOW[dow];
    const holiday = HOLIDAYS[iso] || (isChristmasWeek(iso) ? 'Holiday season' : null);
    if (holiday) factor *= 1.28;
    const level = factor < 0.88 ? 1 : factor < 0.97 ? 2 : factor < 1.07 ? 3 : factor < 1.22 ? 4 : 5;
    days.push({ date: iso, dow: dowName, level, label: FORECAST_LEVELS[level], factor: Math.round(factor * 100) / 100, ...(holiday && { holiday }) });
  }
  const best = [...days].sort((a, b) => a.level - b.level)[0];
  return {
    park: park.name,
    days,
    best: best.dow,
    measuredDays: measured ? measured.days : 0,
    basis: measured ? `${measured.days} days of measured data` : 'typical patterns (measured data still accruing)',
  };
}

const saveLead = (email, plan) => db.leads.add(email, plan);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  const candidates = [filePath, `${filePath}.html`];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(candidate)] || 'application/octet-stream' });
      return fs.createReadStream(candidate).pipe(res);
    }
  }
  sendJson(res, 404, { error: 'not found' });
}

// Give the consultant its tools: the park registry, live waits, and the
// ability to create real wait-drop alerts (with the user's own subscription).
consultant.init({
  recordUsage,
  registry: REGISTRY,
  parks: PARKS,
  getWaits,
  createAlert: (subscription, park, ride, threshold) => db.alerts.add(subscription, park, ride, threshold),
  saveMemory: (email, notes) => db.advisor.setMemory(email, notes),
});

// Canonical host: when CANONICAL_HOST is set (e.g. www.parkpulse.fun), GET
// traffic arriving on any other host — the Railway domains, the bare apex —
// is 301-redirected there, so links, SEO and sessions converge on one origin.
const CANONICAL_HOST = (process.env.CANONICAL_HOST || '').trim().toLowerCase();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const host = String(req.headers.host || '').toLowerCase();
  if (CANONICAL_HOST && host && host !== CANONICAL_HOST && !host.startsWith('localhost') && !host.startsWith('127.')
      && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(301, { location: `https://${CANONICAL_HOST}${req.url}`, 'cache-control': 'public, max-age=3600' });
    return res.end();
  }

  // Meta's webhook handshake: echo hub.challenge when the verify token matches.
  if (req.method === 'GET' && url.pathname === '/api/whatsapp/webhook') {
    if (WA_ENABLED && url.searchParams.get('hub.mode') === 'subscribe' &&
        url.searchParams.get('hub.verify_token') === WA_VERIFY) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(url.searchParams.get('hub.challenge') || '');
    }
    return sendJson(res, 403, { error: 'verification failed' });
  }

  if (req.method === 'GET' && url.pathname === '/api/daystate') {
    const s = sessionUser(req);
    if (!s) return sendJson(res, 401, { error: 'not logged in' });
    return sendJson(res, 200, { state: db.daystate.get(s.email) });
  }

  // Public invite lookup for the /invite landing page.
  if (req.method === 'GET' && url.pathname === '/api/invite/info') {
    const token = String(url.searchParams.get('t') || '');
    const inv = /^[a-f0-9]{32}$/.test(token) ? db.invites.get(token) : null;
    if (!inv) return sendJson(res, 404, { error: 'invite not found' });
    return sendJson(res, 200, {
      valid: !inv.redeemed_by,
      days: inv.days,
      boundEmail: inv.channel === 'email' ? inv.target : null,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/invites') {
    if (!adminUser(req)) return sendJson(res, 403, { error: 'admin account required' });
    return sendJson(res, 200, { invites: db.invites.list(50) });
  }

  // Per-park map coverage, so "every ride is pinned" can be verified before
  // a promote: pins vs the live feed, split into exact / approximate.
  // AI spend: same numbers as the daily email, on demand.
  if (req.method === 'GET' && url.pathname === '/api/admin/ai-cost') {
    if (!adminUser(req)) return sendJson(res, 403, { error: 'admin account required' });
    const report = aiCostReport(etNow().date);
    return sendJson(res, 200, { ...report, recipient: AI_REPORT_TO, hourET: AI_REPORT_HOUR });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/geo') {
    if (!adminUser(req)) return sendJson(res, 403, { error: 'admin account required' });
    const out = [];
    for (const p of REGISTRY) {
      const g = db.geo.get(p.slug);
      if (!g) continue;
      out.push({
        park: p.slug, status: g.status, updatedAt: g.updatedAt,
        pins: g.rides.length,
        exact: g.rides.filter((r) => !r.approx).length,
        approx: g.rides.filter((r) => r.approx).length,
      });
    }
    return sendJson(res, 200, { parks: out, note: 'Parks appear here after their map is first opened. rebuild: GET /api/geo/<slug>?rebuild=1' });
  }

  if (url.pathname === '/api/config') {
    return sendJson(res, 200, {
      env: APP_ENV,
      paymentLink: PAYMENT_LINK,
      proGate: PRO_GATE,
      checkout: CHECKOUT_ENABLED,
      plans: PLAN_CATALOG,
      consultant: consultant.enabled(),
      whatsapp: WA_ENABLED && Boolean(WA_NUMBER),
      pushKey: vapidKeys.publicKey,
      parks: Object.fromEntries(REGISTRY.map((p) => [p.slug, { name: p.name, group: p.group, region: p.region, open: p.open, close: p.close, show: p.show, skip: p.skip, lat: p.lat, lng: p.lng, tz: p.tz }])),
    });
  }

  if (url.pathname === '/api/pass/verify') {
    const pass = passFromReq(req);
    return sendJson(res, 200, pass ? { valid: true, plan: pass.plan, exp: pass.exp } : { valid: false });
  }

  if (url.pathname === '/api/auth/me') {
    const s = sessionUser(req);
    if (!s) return sendJson(res, 401, { error: 'not logged in' });
    const active = accountPassActive(s.user);
    return sendJson(res, 200, {
      email: s.email,
      verified: Boolean(s.user.verified),
      admin: ADMIN_EMAILS.has(s.email),
      devices: db.sessions.devices(s.email).length,
      plan: active ? s.user.plan : null,
      exp: active ? s.user.plan_exp : null,
      passToken: active ? signPass(s.user.plan, s.user.plan_exp) : null,
    });
  }

  // The account's saved multi-day trip plan.
  if (url.pathname === '/api/trip' && req.method === 'GET') {
    const s = sessionUser(req);
    if (!s) return sendJson(res, 401, { error: 'not logged in' });
    const trip = db.trips.get(s.email);
    if (!trip) return sendJson(res, 200, {});
    let plan = [];
    try { plan = JSON.parse(trip.plan); } catch {}
    return sendJson(res, 200, { dest: trip.dest, start: trip.start, days: trip.days, onsite: Boolean(trip.onsite), plan });
  }

  // The advisor's saved conversation for the logged-in account, so the chat
  // widget can restore it on any device.
  if (url.pathname === '/api/advisor/history') {
    const s = sessionUser(req);
    if (!s) return sendJson(res, 401, { error: 'not logged in' });
    let messages = [];
    try { messages = JSON.parse(db.advisor.getChat(s.email) || '[]'); } catch {}
    return sendJson(res, 200, { messages: Array.isArray(messages) ? messages : [] });
  }

  // Aggregate page-view counting for HTML pages (a number per page per day —
  // no cookies, no identifiers). API and asset requests are not counted.
  if (req.method === 'GET' && /^\/(app|guide|welcome|reset|terms|privacy|parks\/[a-z-]+)?$/.test(url.pathname)) {
    try { db.hits.bump(url.pathname || '/'); } catch {}
  }

  // Traffic stats for the operator — requires a dev pass token.
  if (url.pathname === '/api/stats') {
    if (passFromReq(req)?.plan !== 'dev') return sendJson(res, 403, { error: 'dev pass required' });
    return sendJson(res, 200, {
      totals30d: db.hits.totals(30),
      daily14d: db.hits.since(14),
      advisorFeedback30d: db.advisor.feedbackSummary(30),
      sharingSignals: { note: 'accounts using two parks >500km apart within an hour (since last restart)', events: sharingSignals.slice(-20).map(({ ts, ...rest }) => rest) },
    });
  }

  // Key analytics for the /admin dashboard — admin account required.
  if (url.pathname === '/api/admin/stats') {
    if (!adminUser(req)) return sendJson(res, 403, { error: 'admin account required' });
    const totals = db.hits.totals(30);
    const daily = db.hits.since(14);
    const parkName = (p) => PARKS[p.path.slice(5)]?.name || p.path.slice(5);
    return sendJson(res, 200, {
      env: APP_ENV,
      email: { configured: Boolean(RESEND_KEY), from: MAIL_FROM, customSender: !MAIL_FROM.includes('resend.dev') },
      users: {
        ...db.admin.userTotals(),
        new7d: db.admin.newUsers(7),
        new30d: db.admin.newUsers(30),
        signupsByDay30d: db.admin.signupsByDay(30),
        recent: db.admin.recentUsers(15),
        active7d: db.admin.activeAccounts(7),
        liveSessions: db.admin.liveSessions(),
      },
      counts: db.admin.counts(),
      traffic: {
        pages30d: totals.filter((r) => !r.path.startsWith('park:')),
        pagesByDay14d: daily.filter((r) => !r.path.startsWith('park:')),
        topParks30d: totals.filter((r) => r.path.startsWith('park:')).slice(0, 15)
          .map((r) => ({ park: parkName(r), n: r.n })),
      },
      advisorFeedback30d: db.advisor.feedbackSummary(30),
      recentLeads: db.admin.recentLeads(10),
      sharingSignals: sharingSignals.slice(-20).map(({ ts, ...rest }) => rest),
    });
  }

  // Android app-link verification for the Play Store TWA wrapper. Bubblewrap
  // prints the signing-key SHA-256 fingerprint; paste it into the Railway
  // ANDROID_FINGERPRINT variable (comma-separated for multiple keys, e.g. the
  // upload key plus Play App Signing) and Chrome will drop the URL bar.
  if (url.pathname === '/.well-known/assetlinks.json') {
    const prints = (process.env.ANDROID_FINGERPRINT || '').split(',').map((f) => f.trim()).filter(Boolean);
    const pkg = process.env.ANDROID_PACKAGE || 'fun.parkpulse.twa';
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
    return res.end(JSON.stringify(prints.length ? [{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: prints },
    }] : []));
  }

  // SEO surface: server-rendered park pages + sitemap + robots.
  const parkPage = url.pathname.match(/^\/parks\/([a-z-]+)$/);
  if (parkPage) {
    const park = PARKS[parkPage[1]];
    if (!park) return sendJson(res, 404, { error: 'unknown park' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' });
    return res.end(pages.renderParkPage(park, SAMPLE[park.slug] || null, REGISTRY));
  }
  if (url.pathname === '/sitemap.xml' || url.pathname === '/robots.txt') {
    const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    const isMap = url.pathname === '/sitemap.xml';
    res.writeHead(200, { 'content-type': isMap ? 'application/xml' : 'text/plain', 'cache-control': 'public, max-age=86400' });
    if (APP_ENV !== 'production') {
      return res.end(isMap ? '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>' : 'User-agent: *\nDisallow: /\n');
    }
    return res.end(isMap ? pages.renderSitemap(origin, REGISTRY.map((p) => p.slug)) : pages.renderRobots(origin));
  }

  // Tap-for-description: AI-generated once per ride per language, cached in
  // SQLite forever, so the marginal cost of the feature trends to zero.
  const rideInfoMatch = url.pathname.match(/^\/api\/ride-info\/([a-z-]+)$/);
  if (rideInfoMatch) {
    const slug = rideInfoMatch[1];
    const ride = (url.searchParams.get('ride') || '').slice(0, 120).trim();
    const langCode = LANG_NAMES[url.searchParams.get('lang')] ? url.searchParams.get('lang') : 'en';
    if (!PARKS[slug] || !ride) return sendJson(res, 400, { error: 'invalid' });
    if (slug !== FREE_PARK && !hasAccess(req)) return sendJson(res, 402, { error: 'pass required' });
    const key = normName(ride);
    const cached = db.rideinfo.get(slug, key, langCode);
    if (cached) return sendJson(res, 200, { text: cached });
    if (!consultant.enabled()) return sendJson(res, 503, { error: 'not available' });
    if (rideInfoBlocked(req.socket.remoteAddress || 'anon')) return sendJson(res, 429, { error: 'slow down' });
    try {
      const text = await consultant.describeRide(PARKS[slug].name, ride, LANG_NAMES[langCode]);
      if (!text) return sendJson(res, 502, { error: 'no description' });
      db.rideinfo.set(slug, key, langCode, ride, text.slice(0, 500));
      return sendJson(res, 200, { text: text.slice(0, 500) });
    } catch (err) {
      console.log(`ride-info error: ${err.message}`);
      return sendJson(res, 502, { error: 'no description' });
    }
  }

  // Dining guide: AI-generated once per park per language, cached forever.
  // Includes the official reservation link and booking-window note per chain.
  const diningMatch = url.pathname.match(/^\/api\/dining\/([a-z-]+)$/);
  if (diningMatch) {
    const slug = diningMatch[1];
    const langCode = LANG_NAMES[url.searchParams.get('lang')] ? url.searchParams.get('lang') : 'en';
    if (!PARKS[slug]) return sendJson(res, 404, { error: 'unknown park' });
    if (slug !== FREE_PARK && !hasAccess(req)) return sendJson(res, 402, { error: 'pass required' });
    const park = PARKS[slug];
    const RESERVE = {
      'Walt Disney World': { url: 'https://disneyworld.disney.go.com/dining/', note: 'Reservations open 60 days ahead at 6:00 AM ET' },
      'Disneyland (California)': { url: 'https://disneyland.disney.go.com/dining/', note: 'Reservations open 60 days ahead' },
      'Universal Orlando': { url: 'https://www.universalorlando.com/web/en/us/things-to-do/dining', note: 'Most spots are walk-up or same-week' },
      'Universal Hollywood': { url: 'https://www.universalstudioshollywood.com/web/en/us/things-to-do/dining', note: 'Mostly walk-up' },
      'Disneyland Paris': { url: 'https://www.disneylandparis.com/en-usd/restaurants/', note: 'Reservations open 2 months ahead' },
      'Tokyo Disney Resort': { url: 'https://www.tokyodisneyresort.jp/en/tdl/restaurant.html', note: 'Priority Seating opens 1 month ahead, 9:00 AM JST' },
    };
    const reserve = RESERVE[park.group] || null;
    const cached = db.dining.get(slug, langCode);
    if (cached) return sendJson(res, 200, { park: park.name, reserve, list: JSON.parse(cached) });
    if (!consultant.enabled()) return sendJson(res, 503, { error: 'not available' });
    // First visit for this park+language: generate in the background and tell
    // the client to poll. Nobody stares at a spinner tied to a model call, and
    // concurrent visitors share one generation instead of stampeding it.
    const jobKey = `${slug}|${langCode}`;
    if (!diningJobs.has(jobKey)) {
      if (rideInfoBlocked(req.socket.remoteAddress || 'anon')) return sendJson(res, 429, { error: 'slow down' });
      const job = consultant.diningGuide(park.name, park.group, LANG_NAMES[langCode])
        .then((list) => {
          if (list && list.length) db.dining.set(slug, langCode, JSON.stringify(list));
          else console.log(`dining: empty guide for ${jobKey}`);
        })
        .catch((err) => console.log(`dining error (${jobKey}): ${err.message}`))
        .finally(() => diningJobs.delete(jobKey));
      diningJobs.set(jobKey, job);
    }
    return sendJson(res, 202, { pending: true });
  }

  // Ride coordinates for the park map. 202 while the one-time OSM
  // extraction runs; parks with thin OSM coverage end up status "sparse".
  const geoMatch = url.pathname.match(/^\/api\/geo\/([a-z-]+)$/);
  if (geoMatch) {
    const park = PARKS[geoMatch[1]];
    if (!park) return sendJson(res, 404, { error: 'unknown park' });
    if (!park.lat || !park.lng) return sendJson(res, 200, { status: 'sparse', rides: [], center: null });
    // Admins can force a rebuild instead of waiting out the retry window.
    const forceRebuild = url.searchParams.get('rebuild') === '1' && adminUser(req);
    const cached = forceRebuild ? null : db.geo.get(park.slug);
    // Fully-OSM maps cache forever; approximate ones refresh daily (OSM may
    // have caught up, upgrading pins to exact); empty results retry in 15 min.
    const age = cached ? Date.now() - Date.parse(cached.updatedAt) : 0;
    const fresh = cached && (cached.status === 'ok' ||
      (cached.status === 'approx' && age < 24 * 3600000) ||
      age < 15 * 60000);
    if (fresh) {
      return sendJson(res, 200, { status: cached.status, rides: cached.rides, center: { lat: park.lat, lng: park.lng } });
    }
    if (!geoJobs.has(park.slug)) {
      const job = buildParkGeo(park)
        .then(({ rides, status }) => db.geo.set(park.slug, status, rides))
        .catch((err) => { console.log(`geo error (${park.slug}): ${err.message}`); db.geo.set(park.slug, 'failed', []); })
        .finally(() => geoJobs.delete(park.slug));
      geoJobs.set(park.slug, job);
    }
    return sendJson(res, 202, { pending: true, center: { lat: park.lat, lng: park.lng } });
  }

  // Ride tags (vibe + age band): AI-classified once per park, cached.
  const rideTagsMatch = url.pathname.match(/^\/api\/ride-tags\/([a-z-]+)$/);
  if (rideTagsMatch) {
    const slug = rideTagsMatch[1];
    if (!PARKS[slug]) return sendJson(res, 404, { error: 'unknown park' });
    if (slug !== FREE_PARK && !hasAccess(req)) return sendJson(res, 402, { error: 'pass required' });
    const cached = db.ridetags.get(slug);
    if (cached) {
      const parsed = JSON.parse(cached);
      // Tags cached before the single-rider or land fields existed regenerate once.
      const fresh = Object.values(parsed).some((t) => t && typeof t === 'object' && 'sr' in t && 'land' in t);
      if (fresh) return sendJson(res, 200, { tags: parsed });
    }
    if (!consultant.enabled()) return sendJson(res, 503, { error: 'not available' });
    if (rideInfoBlocked(req.socket.remoteAddress || 'anon')) return sendJson(res, 429, { error: 'slow down' });
    try {
      const waits = await getWaits(slug);
      const names = waits.rides.map((r) => r.name).slice(0, 120);
      if (!names.length) return sendJson(res, 502, { error: 'no rides' });
      const tags = await consultant.rideTags(PARKS[slug].name, names);
      if (!tags || !Object.keys(tags).length) return sendJson(res, 502, { error: 'no tags' });
      db.ridetags.set(slug, JSON.stringify(tags));
      return sendJson(res, 200, { tags });
    } catch (err) {
      console.log(`ride-tags error: ${err.message}`);
      return sendJson(res, 502, { error: 'no tags' });
    }
  }

  const forecastMatch = url.pathname.match(/^\/api\/forecast\/([a-z-]+)$/);
  if (forecastMatch) {
    const slug = forecastMatch[1];
    if (!PARKS[slug]) return sendJson(res, 404, { error: 'unknown park' });
    if (slug !== FREE_PARK && !hasAccess(req)) return sendJson(res, 402, { error: 'pass required' });
    return sendJson(res, 200, forecastFor(slug));
  }

  const waitsMatch = url.pathname.match(/^\/api\/waits\/([a-z-]+)$/);
  if (waitsMatch) {
    const slug = waitsMatch[1];
    if (!PARKS[slug]) return sendJson(res, 404, { error: 'unknown park' });
    if (slug !== FREE_PARK && !hasAccess(req)) return sendJson(res, 402, { error: 'pass required' });
    const su = sessionUser(req);
    if (su) noteParkUse(su.email, slug);
    try { db.hits.bump(`park:${slug}`); } catch {} // per-park demand counter for /admin
    return sendJson(res, 200, await getWaits(slug));
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(); });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad request' }); }

      // Inbound WhatsApp messages. Meta expects a fast 200; the agent reply
      // happens after we answer, so a slow model turn can't time the hook out.
      if (url.pathname === '/api/whatsapp/webhook') {
        if (!WA_ENABLED) return sendJson(res, 503, { error: 'whatsapp not configured' });
        sendJson(res, 200, { ok: true });
        try {
          const msg = parsed.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
          if (!msg || msg.type !== 'text' || !msg.from) return;
          const phone = String(msg.from).replace(/[^\d]/g, '').slice(0, 20);
          const text = String(msg.text?.body || '').trim();
          if (!phone || !text) return;

          const linkMatch = text.match(/^link[\s:-]*([a-f0-9]{8})$/i);
          if (linkMatch) {
            const code = linkMatch[1].toUpperCase();
            const pending = waCodes.get(code);
            if (pending && pending.exp > Date.now()) {
              waCodes.delete(code);
              db.wa.link(phone, pending.email);
              await sendWhatsApp(phone, `✅ Connected to ${pending.email}. I'm your ParkPulse planner — I can see today's park, your group and what you've already ridden. Ask me anything, like "what should we ride next?" Text STOP to disconnect.`);
            } else {
              await sendWhatsApp(phone, 'That connect code is invalid or expired. Open the ParkPulse app → 👤 Account → WhatsApp concierge to get a fresh one.');
            }
            return;
          }
          const link = db.wa.get(phone);
          if (!link) {
            await sendWhatsApp(phone, 'Hi! I\'m the ParkPulse planner. To connect me to your account, open the app at www.parkpulse.fun → 👤 Account → WhatsApp concierge, and send me the code it gives you.');
            return;
          }
          if (/^(stop|unlink|disconnect)$/i.test(text)) {
            db.wa.unlink(phone);
            await sendWhatsApp(phone, 'Disconnected — I\'ve unlinked this number and cleared our chat. Reconnect anytime from the app. Have a great day at the parks! 👋');
            return;
          }
          if (consultant.throttled('wa:' + phone)) {
            await sendWhatsApp(phone, 'We\'ve chatted a lot in the last few hours — give me a short break and ask again soon.');
            return;
          }
          if (!consultant.enabled()) {
            await sendWhatsApp(phone, 'The planner is offline right now — please try again shortly.');
            return;
          }
          const reply = await waAgentReply(link, text);
          await sendWhatsApp(phone, reply);
        } catch (err) {
          console.log(`whatsapp webhook error: ${err.message}`);
        }
        return;
      }

      // Admin: mint a full-access invite, delivered by email, phone (as a
      // WhatsApp share link from the admin's own phone), or a bare link.
      if (url.pathname === '/api/admin/invite') {
        const adm = adminUser(req);
        if (!adm) return sendJson(res, 403, { error: 'admin account required' });
        const channel = ['email', 'phone', 'link'].includes(parsed.channel) ? parsed.channel : 'link';
        const days = [7, 30, 90, 365].includes(parsed.days) ? parsed.days : 30;
        const note = typeof parsed.note === 'string' ? parsed.note.trim().slice(0, 200) : '';
        let target = null;
        if (channel === 'email') {
          target = typeof parsed.target === 'string' ? parsed.target.trim().toLowerCase().slice(0, 254) : '';
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) return sendJson(res, 400, { error: 'invalid email' });
        }
        if (channel === 'phone') {
          target = typeof parsed.target === 'string' ? parsed.target.replace(/[^\d]/g, '').slice(0, 20) : '';
          if (target.length < 7) return sendJson(res, 400, { error: 'invalid phone number' });
        }
        const token = crypto.randomBytes(16).toString('hex');
        db.invites.create(token, channel, target, days, note, adm.email);
        const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
        const link = `${origin}/invite?t=${token}`;
        let sent = false;
        if (channel === 'email') {
          try { const r = await sendInviteEmail(origin, target, token, days, note); sent = Boolean(r.sent); }
          catch (err) { console.log(`invite email failed: ${err.message}`); }
        }
        const shareText = `You're invited to ParkPulse — full access for ${days} days! ${link}`;
        return sendJson(res, 200, {
          token, link, days, channel, target, sent,
          waShare: channel === 'phone' ? `https://wa.me/${target}?text=${encodeURIComponent(shareText)}` : null,
        });
      }

      if (url.pathname === '/api/admin/ai-cost/send') {
        if (!adminUser(req)) return sendJson(res, 403, { error: 'admin account required' });
        try {
          const r = await sendAiCostEmail(etNow().date);
          return sendJson(res, 200, r.sent ? { sent: true, to: AI_REPORT_TO } : { sent: false, reason: r.reason });
        } catch (err) { return sendJson(res, 502, { sent: false, reason: err.message }); }
      }

      if (url.pathname === '/api/admin/invite/revoke') {
        if (!adminUser(req)) return sendJson(res, 403, { error: 'admin account required' });
        const token = typeof parsed.token === 'string' ? parsed.token : '';
        const removed = db.invites.revoke(token);
        return sendJson(res, removed ? 200 : 409, removed ? { ok: true } : { error: 'not found or already redeemed' });
      }

      // Redeem an invite on the signed-in account.
      if (url.pathname === '/api/invite/claim') {
        const s = sessionUser(req);
        if (!s) return sendJson(res, 401, { error: 'log in first' });
        const token = typeof parsed.token === 'string' && /^[a-f0-9]{32}$/.test(parsed.token) ? parsed.token : '';
        const inv = token ? db.invites.get(token) : null;
        if (!inv) return sendJson(res, 404, { error: 'invite not found' });
        if (inv.redeemed_by && inv.redeemed_by !== s.email) return sendJson(res, 409, { error: 'invite already used' });
        if (inv.channel === 'email' && inv.target !== s.email) {
          return sendJson(res, 403, { error: `this invite is for ${inv.target} — log in with that account` });
        }
        if (!inv.redeemed_by) {
          db.invites.redeem(token, s.email);
          grantToUser(s.email, 'comp', Date.now() + inv.days * 86400000);
        }
        const u = db.users.get(s.email);
        const active = accountPassActive(u);
        return sendJson(res, 200, {
          ok: true,
          plan: active ? u.plan : null,
          exp: active ? u.plan_exp : null,
          passToken: active ? signPass(u.plan, u.plan_exp) : null,
        });
      }

      // Mint a connect code for the signed-in user and hand back the wa.me link.
      // Email the planned day to the signed-in user. Deliberately sends only
      // to the account's own address — an endpoint that mails anywhere is an
      // open relay. Rate-limited to a handful a day per account.
      if (url.pathname === '/api/plan/email') {
        const sess = sessionUser(req);
        if (!sess) return sendJson(res, 401, { error: 'log in first' });
        const park = PARKS[parsed.park];
        if (!park) return sendJson(res, 400, { error: 'unknown park' });
        const rawStops = Array.isArray(parsed.stops) ? parsed.stops.slice(0, 30) : [];
        const stops = rawStops
          .filter((st) => st && typeof st.name === 'string')
          .map((st) => ({
            name: st.name.slice(0, 120),
            time: typeof st.time === 'string' ? st.time.slice(0, 12) : '',
            wait: Number.isFinite(st.wait) ? Math.max(0, Math.round(st.wait)) : null,
          }));
        if (!stops.length) return sendJson(res, 400, { error: 'no plan to send' });
        if (planMailBlocked(sess.email)) return sendJson(res, 429, { error: 'you have sent a few plans already today — try again tomorrow' });

        const profileForKpi = sanitizeProfile(parsed.profile) || (db.daystate.get(sess.email) || {}).profile || null;
        const kpis = await planKpis(park, stops, profileForKpi);
        const savedMin = Number.isFinite(parsed.savedMin) ? Math.max(0, Math.round(parsed.savedMin)) : 0;
        const profile = profileForKpi;
        const lang = LANG_NAMES[typeof parsed.lang === 'string' ? parsed.lang : 'en'] || 'English';
        const day = new Intl.DateTimeFormat('en-US', { timeZone: park.tz, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());

        let briefing = '';
        if (consultant.enabled()) {
          try {
            briefing = await consultant.dayBriefing({ parkName: park.name, group: park.group, day, stops, kpis, profile, savedMin, lang });
          } catch (err) { console.log(`day briefing failed: ${err.message}`); }
        }
        const html = planEmailHtml({ park, day, stops, kpis, savedMin, briefing, profile });
        try {
          const r = await sendEmail(sess.email, `Your ${park.name} plan — ${kpis.attractions} attractions, ${kpis.km} km`, html,
            `Plan email for ${sess.email}: ${park.name}, ${kpis.attractions} stops, ${kpis.km} km, ${kpis.kcal} kcal`);
          return sendJson(res, 200, r.sent ? { sent: true, to: sess.email, kpis } : { sent: false, reason: r.reason, kpis });
        } catch (err) {
          return sendJson(res, 502, { sent: false, reason: err.message });
        }
      }

      if (url.pathname === '/api/whatsapp/link') {
        if (!WA_ENABLED || !WA_NUMBER) return sendJson(res, 503, { error: 'whatsapp not configured' });
        const s = sessionUser(req);
        if (!s) return sendJson(res, 401, { error: 'log in first' });
        const code = mintWaCode(s.email);
        return sendJson(res, 200, {
          code,
          number: WA_NUMBER,
          url: `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent('LINK ' + code)}`,
        });
      }

      // Mirror of the device's in-park choices for the WhatsApp agent (and
      // for restoring a reinstalled app). Client pushes, server sanitizes.
      if (url.pathname === '/api/daystate') {
        const s = sessionUser(req);
        if (!s) return sendJson(res, 401, { error: 'not logged in' });
        const d = parsed.state && typeof parsed.state === 'object' ? parsed.state : {};
        db.daystate.set(s.email, {
          park: typeof d.park === 'string' && PARKS[d.park] ? d.park : null,
          day: typeof d.day === 'string' ? d.day.slice(0, 10) : null,
          lang: typeof d.lang === 'string' ? d.lang.slice(0, 8) : null,
          profile: sanitizeProfile(d.profile),
          picked: strList(d.picked, 30),
          done: strList(d.done, 40),
          favorites: strList(d.favorites, 30),
        });
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/api/auth/signup' || url.pathname === '/api/auth/login') {
        const email = typeof parsed.email === 'string' ? parsed.email.trim().toLowerCase().slice(0, 254) : '';
        const password = typeof parsed.password === 'string' ? parsed.password : '';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: 'invalid email' });

        if (url.pathname === '/api/auth/signup') {
          if (password.length < 8) return sendJson(res, 400, { error: 'password must be at least 8 characters' });
          const existing = db.users.get(email);
          if (existing && existing.verified) return sendJson(res, 409, { error: 'account already exists — log in instead' });
          const salt = crypto.randomBytes(16).toString('hex');
          if (existing) {
            // Unfinished signup (never verified): treat this as a retry —
            // take the new password and send a fresh code. Whoever controls
            // the inbox wins, so an unverified squat can't lock anyone out.
            db.users.setPassword(email, salt, hashPassword(password, salt));
          } else {
            db.users.create(email, salt, hashPassword(password, salt), 0);
          }
          startVerification(email);
          return sendJson(res, 200, { pending: true, email });
        }
        if (loginBlocked(email)) return sendJson(res, 429, { error: 'too many attempts — try again in 15 minutes' });
        const u0 = db.users.get(email);
        const ok = u0 && crypto.timingSafeEqual(Buffer.from(hashPassword(password, u0.salt)), Buffer.from(u0.hash));
        if (!ok) { noteLoginFail(email); return sendJson(res, 403, { error: 'wrong email or password' }); }
        loginFails.delete(email);
        // Coming back during the grace period is itself a change of mind.
        const wasPendingDeletion = Boolean(u0.delete_at);
        if (wasPendingDeletion) {
          db.users.cancelDeletion(email);
          console.log(`account deletion cancelled by login: ${email}`);
        }
        if (!u0.verified) {
          startVerification(email);
          return sendJson(res, 200, { pending: true, email });
        }

        // If this browser already holds a pass token, bind it to the account
        // so the purchase follows the login from now on.
        const held = passFromReq(req);
        if (held) grantToUser(email, held.plan, held.exp);

        const u = db.users.get(email);
        const active = accountPassActive(u);
        return sendJson(res, 200, {
          session: issueSession(email, parsed.device, req),
          email,
          deletionCancelled: wasPendingDeletion,
          plan: active ? u.plan : null,
          exp: active ? u.plan_exp : null,
          passToken: active ? signPass(u.plan, u.plan_exp) : null,
        });
      }

      if (url.pathname === '/api/auth/verify') {
        const email = typeof parsed.email === 'string' ? parsed.email.trim().toLowerCase().slice(0, 254) : '';
        const u = db.users.get(email);
        if (!u) return sendJson(res, 403, { error: 'invalid code' });
        if (parsed.resend) {
          if (forgotBlocked('v:' + email)) return sendJson(res, 429, { error: 'too many codes requested — try again later' });
          startVerification(email);
          return sendJson(res, 200, { pending: true, email });
        }
        const code = typeof parsed.code === 'string' ? parsed.code.trim() : '';
        if (verifyBlocked(email)) return sendJson(res, 429, { error: 'too many attempts — request a new code in 15 minutes' });
        const valid = u.verify_code && u.verify_exp > Date.now() && /^\d{6}$/.test(code) &&
          crypto.timingSafeEqual(Buffer.from(hashCode(code)), Buffer.from(u.verify_code));
        if (!valid) return sendJson(res, 403, { error: 'wrong or expired code' });
        db.users.markVerified(email);
        verifyFails.delete(email);
        sendWelcomeEmail(email).catch((err) => console.log(`welcome email failed: ${err.message}`));
        const held = passFromReq(req);
        if (held) grantToUser(email, held.plan, held.exp);
        const fresh = db.users.get(email);
        const active = accountPassActive(fresh);
        return sendJson(res, 200, {
          session: issueSession(email, parsed.device, req),
          email,
          plan: active ? fresh.plan : null,
          exp: active ? fresh.plan_exp : null,
          passToken: active ? signPass(fresh.plan, fresh.plan_exp) : null,
        });
      }

      // Admin: send a test email to the signed-in admin's own address, so
      // email config can be checked from the dashboard without a real signup.
      if (url.pathname === '/api/admin/test-email') {
        const adm = adminUser(req);
        if (!adm) return sendJson(res, 403, { error: 'admin account required' });
        try {
          const r = await sendEmail(adm.email, 'ParkPulse test email',
            `<p>This is a test email from your ParkPulse ${APP_ENV} deployment. Sending works. ✅</p><p>From: ${MAIL_FROM}</p>`);
          return sendJson(res, 200, r.sent ? { sent: true, to: adm.email } : { sent: false, reason: r.reason });
        } catch (err) {
          return sendJson(res, 502, { sent: false, reason: err.message });
        }
      }

      // Account deletion. Requires the password even when a session is
      // present — this is irreversible, and re-authenticating protects anyone
      // whose unlocked phone is borrowed. Works without a session too, so the
      // public /delete-account page can serve people who removed the app.
      if (url.pathname === '/api/auth/delete') {
        const email = typeof parsed.email === 'string' ? parsed.email.trim().toLowerCase().slice(0, 254) : '';
        const password = typeof parsed.password === 'string' ? parsed.password : '';
        if (!email || !password) return sendJson(res, 400, { error: 'email and password required' });
        if (loginBlocked(email)) return sendJson(res, 429, { error: 'too many attempts — try again in 15 minutes' });
        const u = db.users.get(email);
        const ok = u && crypto.timingSafeEqual(Buffer.from(hashPassword(password, u.salt)), Buffer.from(u.hash));
        if (!ok) { noteLoginFail(email); return sendJson(res, 403, { error: 'wrong email or password' }); }
        loginFails.delete(email);
        const deleteAt = Date.now() + DELETE_GRACE_DAYS * 86400000;
        const cancelToken = crypto.randomBytes(32).toString('hex');
        db.users.scheduleDeletion(email, deleteAt, cancelToken);
        db.sessions.deleteForEmail(email); // signed out everywhere immediately
        const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
        sendDeletionEmail(origin, email, cancelToken, deleteAt).catch((err) => console.log(`deletion email failed: ${err.message}`));
        console.log(`account deletion scheduled: ${email} for ${new Date(deleteAt).toISOString()}`);
        return sendJson(res, 200, { ok: true, scheduled: true, deleteAt, graceDays: DELETE_GRACE_DAYS });
      }

      // Cancel a scheduled deletion, from the emailed link.
      if (url.pathname === '/api/auth/cancel-deletion') {
        const email = typeof parsed.email === 'string' ? parsed.email.trim().toLowerCase().slice(0, 254) : '';
        const token = typeof parsed.token === 'string' ? parsed.token : '';
        const u = email && db.users.get(email);
        if (!u || !u.delete_token || !token || token.length !== u.delete_token.length ||
            !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(u.delete_token))) {
          return sendJson(res, 403, { error: 'this cancellation link is no longer valid' });
        }
        db.users.cancelDeletion(email);
        console.log(`account deletion cancelled: ${email}`);
        return sendJson(res, 200, { ok: true, cancelled: true });
      }

      if (url.pathname === '/api/auth/logout-all') {
        const s2 = sessionUser(req);
        if (!s2) return sendJson(res, 401, { error: 'not logged in' });
        const removed = db.sessions.deleteForEmail(s2.email, s2.sid);
        return sendJson(res, 200, { ok: true, removed });
      }

      if (url.pathname === '/api/auth/forgot') {
        const email = typeof parsed.email === 'string' ? parsed.email.trim().toLowerCase().slice(0, 254) : '';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: 'invalid email' });
        if (forgotBlocked(email)) return sendJson(res, 429, { error: 'too many reset requests — try again later' });
        // Always answer ok — never reveal whether an account exists.
        if (db.users.get(email)) {
          const token = crypto.randomBytes(32).toString('hex');
          db.users.setResetToken(email, token, Date.now() + 3600000);
          const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
          sendResetEmail(origin, email, token).catch((err) => console.log(`reset email failed: ${err.message}`));
        }
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/api/auth/reset') {
        const email = typeof parsed.email === 'string' ? parsed.email.trim().toLowerCase().slice(0, 254) : '';
        const token = typeof parsed.token === 'string' ? parsed.token : '';
        const password = typeof parsed.password === 'string' ? parsed.password : '';
        if (password.length < 8) return sendJson(res, 400, { error: 'password must be at least 8 characters' });
        const u = db.users.get(email);
        const valid = u && u.reset_token && u.reset_exp > Date.now() &&
          token.length === u.reset_token.length &&
          crypto.timingSafeEqual(Buffer.from(token), Buffer.from(u.reset_token));
        if (!valid) return sendJson(res, 403, { error: 'invalid or expired reset link — request a new one' });
        const salt = crypto.randomBytes(16).toString('hex');
        db.users.resetPassword(email, salt, hashPassword(password, salt));
        loginFails.delete(email);
        const fresh = db.users.get(email);
        const active = accountPassActive(fresh);
        return sendJson(res, 200, {
          session: issueSession(email, parsed.device, req),
          email,
          plan: active ? fresh.plan : null,
          exp: active ? fresh.plan_exp : null,
          passToken: active ? signPass(fresh.plan, fresh.plan_exp) : null,
        });
      }

      if (url.pathname === '/api/checkout') {
        if (!CHECKOUT_ENABLED) return sendJson(res, 503, { error: 'checkout not configured' });
        const plan = parsed.plan;
        if (!STRIPE_PRICES[plan]) return sendJson(res, 400, { error: 'unknown plan' });
        const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
        try {
          const session = await stripeApi('/v1/checkout/sessions', {
            mode: 'payment',
            'line_items[0][price]': STRIPE_PRICES[plan],
            'line_items[0][quantity]': '1',
            'metadata[plan]': plan,
            success_url: `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${origin}/#pricing`,
          });
          return sendJson(res, 200, { url: session.url });
        } catch (err) {
          return sendJson(res, 502, { error: 'checkout failed' });
        }
      }

      if (url.pathname === '/api/pass/claim') {
        if (!CHECKOUT_ENABLED) return sendJson(res, 503, { error: 'checkout not configured' });
        const sessionId = parsed.session_id;
        if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return sendJson(res, 400, { error: 'invalid session' });
        try {
          const session = await stripeApi(`/v1/checkout/sessions/${sessionId}`);
          const plan = session.metadata?.plan;
          if (session.payment_status !== 'paid' || !PLAN_DAYS[plan] || plan === 'dev') {
            return sendJson(res, 402, { error: 'payment not completed' });
          }
          // Idempotent by design: re-claiming the same paid session re-issues a
          // pass, which is how a buyer activates a second device.
          const token = signPass(plan);
          const s = sessionUser(req);
          if (s) grantToUser(s.email, plan, verifyPass(token).exp);
          recordPass({ plan, session: sessionId, email: s?.email || session.customer_details?.email || null });
          return sendJson(res, 200, { token, plan, label: PLAN_LABELS[plan] || plan, exp: verifyPass(token).exp });
        } catch (err) {
          return sendJson(res, 502, { error: 'could not verify payment' });
        }
      }

      if (url.pathname === '/api/pass/redeem') {
        const code = typeof parsed.code === 'string' ? parsed.code : '';
        const ok = DEV_PASS_CODE && code.length === DEV_PASS_CODE.length &&
          crypto.timingSafeEqual(Buffer.from(code), Buffer.from(DEV_PASS_CODE));
        if (!ok) return sendJson(res, 403, { error: 'invalid code' });
        const token = signPass('dev');
        const s = sessionUser(req);
        if (s) grantToUser(s.email, 'dev', verifyPass(token).exp);
        recordPass({ plan: 'dev', email: s?.email || null });
        return sendJson(res, 200, { token, plan: 'dev', exp: verifyPass(token).exp });
      }

      if (url.pathname === '/api/subscribe') {
        const { email, plan } = parsed;
        if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return sendJson(res, 400, { error: 'invalid email' });
        }
        saveLead(email.slice(0, 254), typeof plan === 'string' ? plan.slice(0, 40) : 'free');
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/api/consultant') {
        if (!consultant.enabled()) return sendJson(res, 503, { error: 'consultant not configured' });
        if (!hasAccess(req)) return sendJson(res, 402, { error: 'pass required' });
        const { park, messages, favorites, planPicks, subscription } = parsed;
        // Group profile from the setup wizard — whitelisted, never trusted raw.
        const profile = sanitizeProfile(parsed.profile);
        const done = strList(parsed.done, 40);
        const lang = Object.values(LANG_NAMES).includes(parsed.lang) ? parsed.lang : 'English';
        if (!PARKS[park]) return sendJson(res, 400, { error: 'unknown park' });
        // Throttle per pass/session identity, falling back to IP.
        const throttleKey = req.headers['x-pass'] || req.headers['x-session'] || req.socket.remoteAddress || 'anon';
        if (consultant.throttled(String(throttleKey).slice(0, 64))) {
          return sendJson(res, 429, { error: "You've hit the consultant limit for now — try again in a few hours." });
        }
        try {
          const waits = await getWaits(park);
          try { waits.forecast = forecastFor(park); } catch {}
          const s = sessionUser(req);
          // Stream the reply over SSE: `delta` text chunks, `action` effects, `done`.
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          let replyText = '';
          const turnActions = [];
          const send = (event, data) => {
            if (event === 'delta' && data.text) replyText += data.text;
            if (event === 'action') turnActions.push(data);
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };
          let failed = false;
          try {
            await consultant.consult({
              park: PARKS[park], waits, messages, favorites, planPicks, profile, done,
              subscription: subscription && typeof subscription.endpoint === 'string' ? subscription : null,
              email: s?.email || null,
              memory: s ? db.advisor.getMemory(s.email) : null,
              trip: s ? db.trips.get(s.email) : null,
              lang,
              send,
            });
          } catch (err) {
            failed = true;
            console.log(`consultant error: ${err.message}`);
            send('error', { error: err.code === 'bad_request' ? 'invalid messages' : 'The consultant is having a moment — try again shortly.' });
          }
          // Persist the conversation for logged-in users so it follows the
          // account across devices (mirrors the client's own history rules).
          if (s && !failed && replyText) {
            try {
              const window = (Array.isArray(messages) ? messages : [])
                .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
                .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
              window.push({ role: 'assistant', content: replyText.slice(0, 4000) });
              for (const a of turnActions) {
                if (a.type === 'plan') window.push({ role: 'action', action: { type: 'plan', park: a.park, rides: a.rides } });
              }
              db.advisor.saveChat(s.email, JSON.stringify(window.slice(-24)));
            } catch {}
          }
          return res.end();
        } catch (err) {
          console.log(`consultant error: ${err.message}`);
          return sendJson(res, 502, { error: 'The consultant is having a moment — try again shortly.' });
        }
      }

      if (url.pathname === '/api/trip') {
        const s = sessionUser(req);
        if (!s) return sendJson(res, 401, { error: 'log in to save your trip' });
        if (parsed.clear) { db.trips.clear(s.email); return sendJson(res, 200, { ok: true }); }
        const dest = typeof parsed.dest === 'string' ? parsed.dest.slice(0, 60) : '';
        const start = typeof parsed.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.start) ? parsed.start : '';
        const days = Number.isInteger(parsed.days) && parsed.days >= 1 && parsed.days <= 14 ? parsed.days : 0;
        const plan = Array.isArray(parsed.plan)
          ? parsed.plan.filter((p) => p && PARKS[p.park] && typeof p.date === 'string').slice(0, 14).map((p) => ({ date: p.date.slice(0, 10), park: p.park }))
          : [];
        if (!dest || !start || !days || plan.length !== days) return sendJson(res, 400, { error: 'invalid trip' });
        const sub = parsed.sub && typeof parsed.sub.endpoint === 'string' && parsed.sub.endpoint.startsWith('https://')
          ? JSON.stringify(parsed.sub).slice(0, 4000) : null;
        db.trips.set(s.email, dest, start, days, JSON.stringify(plan), parsed.onsite ? 1 : 0, sub);
        return sendJson(res, 200, { ok: true, reminder: Boolean(sub) });
      }

      if (url.pathname === '/api/advisor/feedback') {
        const vote = parsed.vote === 'up' || parsed.vote === 'down' ? parsed.vote : null;
        if (!vote) return sendJson(res, 400, { error: 'invalid vote' });
        if (feedbackBlocked(req.socket.remoteAddress || 'anon')) return sendJson(res, 429, { error: 'slow down' });
        const s = sessionUser(req);
        const park = typeof parsed.park === 'string' && PARKS[parsed.park] ? parsed.park : null;
        const message = typeof parsed.message === 'string' ? parsed.message.slice(0, 500) : null;
        db.advisor.addFeedback(s?.email || null, park, vote, message);
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/api/push/alerts') {
        if (!hasAccess(req)) return sendJson(res, 402, { error: 'pass required' });
        const { subscription, park, ride, threshold } = parsed;
        if (!subscription || typeof subscription.endpoint !== 'string' || !PARKS[park] ||
            typeof ride !== 'string' || !Number.isFinite(threshold) || threshold < 5 || threshold > 240) {
          return sendJson(res, 400, { error: 'invalid alert' });
        }
        // One alert per ride per device — add replaces any existing one.
        const id = db.alerts.add(subscription, park, ride.slice(0, 120), Math.round(threshold));
        return sendJson(res, 200, { ok: true, id: Number(id) });
      }

      if (url.pathname === '/api/push/alerts/cancel') {
        const { endpoint, ride } = parsed;
        if (typeof endpoint !== 'string') return sendJson(res, 400, { error: 'invalid' });
        const removed = db.alerts.removeByEndpoint(endpoint, typeof ride === 'string' ? ride : null);
        return sendJson(res, 200, { ok: true, removed });
      }

      sendJson(res, 404, { error: 'not found' });
    });
    return;
  }

  serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`ParkPulse running on http://localhost:${PORT}`);
});
