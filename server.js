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
const premade = require('./premade');
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
// Replies to any transactional mail land in the support inbox, which
// forwards to a human — otherwise they vanish into the sender domain.
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO || 'support@parkpulse.fun';

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
  const fc = (() => { try { return forecastFor(slug, 120); } catch { return null; } })();
  if (fc) waits.forecast = { ...fc, days: fc.days.slice(0, 7) };
  try { waits.weather = await getWeather(PARKS[slug]); } catch {}
  // The assistant on WhatsApp answers about whatever day the app is set to,
  // for the same reason the in-app one does: a plan for Wednesday and advice
  // about today is the most confusing pairing this product can produce.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: PARKS[slug].tz });
  const wd = typeof ds.planDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ds.planDate) && fc
    ? fc.days.find((d) => d.date === ds.planDate) : null;
  if (wd) {
    waits.planDay = { ...wd, isToday: wd.date === today, weather: (waits.weather?.days || []).find((w) => w.date === wd.date) || null };
  }
  waits.today = today;
  waits.events = eventsFor(slug, wd ? wd.date : today);
  try { waits.tags = JSON.parse(db.ridetags.get(slug) || 'null') || undefined; } catch {}
  const history = db.wa.history(link.phone);
  const messages = [...history, { role: 'user', content: String(text).trim().slice(0, 2000) }];
  while (messages.length && messages[0].role !== 'user') messages.shift();
  let reply = '';
  await consultant.consult({
    park: PARKS[slug], waits, messages, name: db.users.get(link.email)?.name || null,
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
    body: JSON.stringify({ from: MAIL_FROM, to: [to], reply_to: MAIL_REPLY_TO, subject, html }),
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
// First names are for greeting people, so they get greeted properly: trimmed,
// letters only, and never a curse word wearing a name tag. The check is a
// short list of unambiguous hard words across the languages we serve, matched
// on whole normalized tokens -- so nobody from Scunthorpe gets flagged, and
// nobody gets addressed as something Mila would blush at.
const PROFANE_NAMES = new Set([
  'fuck', 'fucker', 'shit', 'bitch', 'cunt', 'asshole', 'dick', 'bastard', 'whore', 'slut', 'twat', 'wanker',
  'puta', 'puto', 'mierda', 'cono', 'cabron', 'pendejo', 'gilipollas', 'joder', 'polla', 'verga',
  'putain', 'merde', 'salope', 'connard', 'connasse', 'encule', 'pute',
  'scheisse', 'fotze', 'arschloch', 'hurensohn', 'wichser', 'schlampe',
  'caralho', 'porra', 'buceta', 'foda', 'merda', 'viado',
  'cazzo', 'stronzo', 'puttana', 'vaffanculo', 'troia', 'minchia',
]);
function cleanFirstName(raw) {
  if (typeof raw !== 'string') return { name: null, profane: false };
  const name = raw.replace(/[\u{10000}-\u{10FFFF}]/gu, '').replace(/[^\p{L}\p{M}' \-]/gu, '')
    .replace(/\s+/g, ' ').trim().slice(0, 30);
  if (!name) return { name: null, profane: false };
  const tokens = name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (tokens.some((t) => PROFANE_NAMES.has(t))) return { name: null, profane: true };
  // Title-case for display so "luis" greets as "Luis".
  return { name: name.replace(/\p{L}[\p{L}\p{M}']*/gu, (w) => w[0].toUpperCase() + w.slice(1)), profane: false };
}
// What we say instead of the word: kind, in character, and it names the
// stand-in so the app's later greetings make sense.
const NAME_NOTE = "That one made Mila hide behind her wings! We'll go with 'Dear Friend' for now — you can tell us your real name any time in your account.";

// One free consultant call per day per client, tracked in memory. A restart
// resets it; the free plan is a taste, not a metered entitlement.
const FREE_CONSULT = new Map();
function hasAccess(req) {
  if (!PRO_GATE) return true;
  if (passFromReq(req)) return true;
  const s = sessionUser(req);
  return Boolean(s && accountPassActive(s.user));
}

// Behind a platform proxy every connection arrives from the proxy, so
// req.socket.remoteAddress is one address shared by every visitor. Keying a
// rate limiter on it throttles the whole site as a single bucket. Trust the
// first hop of x-forwarded-for, which the proxy sets, and fall back to the
// socket for direct connections in development.
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim().slice(0, 64);
  return req.socket.remoteAddress || 'anon';
}

// A rate limiter may only key on identity that has been *verified*. Reading the
// raw x-pass header let a caller mint a fresh quota bucket per request simply
// by sending a different value each time. That stays true with PRO_GATE on: a
// signed-in account clears hasAccess through the session branch, so it can send
// any x-pass it likes and still get an unlimited number of buckets.
function throttleIdentity(req) {
  const pass = passFromReq(req);
  if (pass) {
    const digest = crypto.createHash('sha256').update(String(req.headers['x-pass'])).digest('base64url');
    return `p:${digest.slice(0, 32)}`;
  }
  const s = sessionUser(req);
  if (s) return `u:${s.email}`;
  return `i:${clientIp(req)}`;
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
// Per-ride wait bands by crowd level. Empty until enough days accrue; every
// consumer treats absence as "not enough data yet" rather than as zero.
let CROWD_BANDS = {};
let HOURLY_CURVES = {};
let ACCURACY = null;
let CLOSURES = {};
// Twin of the HOURLY curve in public/app.html -- the hour-of-day crowd shape
// the planner multiplies into every future-day wait. The backtest must use
// the same curve or it would be scoring a model nobody is shown. Change one,
// change both.
const HOURLY_SHAPE = { 7: .45, 8: .4, 9: .55, 10: .8, 11: 1.0, 12: 1.1, 13: 1.15, 14: 1.15, 15: 1.1, 16: 1.0, 17: .9, 18: .85, 19: .75, 20: .6, 21: .45, 22: .35, 23: .3 };
premade.init({ hourlyShape: HOURLY_SHAPE });
// Observed-wait aggregates, keyed park -> hour. Empty until reports accrue;
// the chart draws its second line only when this fills.
let ACTUAL_WAITS = {};

// Minimums before an observed figure is published. Self-reported data earns its
// place on a chart by weight of numbers, not by existing.
const ACTUAL_MIN_REPORTS = 5;   // per hour
const ACTUAL_MIN_HOURS = 4;     // hours covered before a park's line is drawn

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};

// Median, not mean: one person reporting 240 for a walk-on should not move the
// published figure, and with self-reported data that person always turns up.
function refreshActualWaits() {
  const out = {};
  try {
    for (const { park } of db.waitreports.parks()) {
      const byHour = {};
      for (const r of db.waitreports.forPark(park)) {
        (byHour[r.hour_local] ??= { actual: [], posted: [] }).actual.push(r.actual_min);
        if (Number.isFinite(r.posted_min)) byHour[r.hour_local].posted.push(r.posted_min);
      }
      const hours = [];
      for (const [h, v] of Object.entries(byHour)) {
        if (v.actual.length < ACTUAL_MIN_REPORTS) continue;
        const a = median(v.actual);
        const pst = v.posted.length ? median(v.posted) : null;
        hours.push({ hour: Number(h), actual: a, posted: pst, delta: pst != null ? a - pst : null, n: v.actual.length });
      }
      hours.sort((x, y) => x.hour - y.hour);
      if (hours.length >= ACTUAL_MIN_HOURS) out[park] = hours;
    }
  } catch (err) {
    console.log(`actual-wait refresh failed: ${err.message}`);
  }
  ACTUAL_WAITS = out;
}
function refreshBaselines() {
  try {
    MEASURED = history.computeBaselines(normName);
    DOW_INDEX = history.computeDowIndex();
    CROWD_BANDS = history.computeCrowdBands(normName);
    HOURLY_CURVES = history.computeHourlyCurves(normName, (slug) => PARKS[slug]?.tz);
    CLOSURES = history.computeClosures();
    refreshActualWaits();
    const parks = Object.keys(MEASURED).length;
    if (parks) console.log(`Baselines refreshed from history: ${parks} parks (${Object.keys(DOW_INDEX).length} with dow index, ${Object.keys(CROWD_BANDS).length} with crowd bands)`);
  } catch (err) {
    console.log(`Baseline refresh failed: ${err.message}`);
  }
}
// The first refresh is deliberately NOT called here: computeHourlyCurves needs
// a park timezone, and PARKS is defined further down. Called after the registry
// instead. The interval is armed here so the schedule is visible beside the
// function it drives.
setInterval(refreshBaselines, 6 * 60 * 60 * 1000);

// The published accuracy scoreboard. Separate from refreshBaselines on
// purpose: dayFactorFor reads PARK_SEASONS and HOLIDAYS, which are defined
// much further down -- calling this from the first refreshBaselines() would
// hit the temporal dead zone and the try/catch would silently eat it, the
// exact failure mode that zeroed the baselines once already. First call is
// beside server.listen, where everything exists.
function refreshAccuracy() {
  try {
    ACCURACY = history.computeAccuracy({
      normName,
      tzOf: (slug) => PARKS[slug]?.tz,
      dayFactor: dayFactorFor,
      hourly: HOURLY_SHAPE,
    });
    if (ACCURACY) console.log(`Accuracy scoreboard: ${ACCURACY.overall.n} predictions scored over ${ACCURACY.scoredDays} days (median |err| ${ACCURACY.overall.medAbs} min)`);
  } catch (err) {
    console.log(`Accuracy refresh failed: ${err.message}`);
  }
}
setInterval(refreshAccuracy, 6 * 60 * 60 * 1000);

const typicalFor = (slug, rideName) => {
  const key = normName(rideName);
  return MEASURED[slug]?.get(key) ?? TYPICAL[slug]?.get(key) ?? null;
};

// --- Premade touring plans ---------------------------------------------------
// The ride universe for a park's premade plans: display names + lands from the
// tag store (the app populates it the first time anyone opens the park), each
// with its typical wait for the popularity ranking. Live waits are deliberately
// NOT used — these pages are evergreen and regenerate weekly.
async function premadeEntries(slug) {
  let tags = {};
  try { tags = JSON.parse(db.ridetags.get(slug) || '{}'); } catch {}
  const names = Object.keys(tags).filter((n) => tags[n] && typeof tags[n] === 'object');
  if (names.length) {
    return names.map((n) => ({
      name: n,
      land: tags[n].land || '',
      base: typicalFor(slug, n) ?? ({ thrill: 40, water: 30, family: 25, gentle: 15, show: 12 }[tags[n].vibe] || 20),
      tags: tags[n],
    }));
  }
  // No tags yet (nobody has opened this park in the app): take the ride
  // universe from the feed — names and lands, closed rides included, since a
  // premade plan describes the park, not this afternoon. Static sample last.
  try {
    const w = await getWaits(slug);
    if (w.rides.length) {
      return w.rides.map((r) => ({ name: r.name, land: r.land || '', base: typicalFor(slug, r.name) ?? r.wait ?? 20, tags: null }));
    }
  } catch {}
  const sample = SAMPLE[slug];
  if (!sample) return [];
  return sample.rides.map((r) => ({ name: r.name, land: '', base: typicalFor(slug, r.name) ?? r.wait, tags: null }));
}

const PREMADE_TTL = 7 * 24 * 3600 * 1000;
const PREMADE_MEM = new Map();
async function premadePlan(slug, personaSlug) {
  const persona = premade.PERSONAS.find((p) => p.slug === personaSlug);
  const park = PARKS[slug];
  if (!persona || !park) return null;
  const key = `premade:v2:${slug}:${personaSlug}`;   // bump on scheduler changes
  const hit = PREMADE_MEM.get(key);
  if (hit && Date.now() - hit.at < PREMADE_TTL) return hit.plan;
  let stored = null;
  try { stored = JSON.parse(db.kv.get(key) || 'null'); } catch {}
  if (stored && Date.now() - stored.at < PREMADE_TTL) {
    PREMADE_MEM.set(key, stored);
    return stored.plan;
  }
  const plan = premade.buildPremade(park, await premadeEntries(slug), persona);
  const wrap = { at: Date.now(), plan };
  PREMADE_MEM.set(key, wrap);
  try { db.kv.set(key, JSON.stringify(wrap)); } catch {}
  return plan;
}
async function premadeIndexFor(slug) {
  const out = [];
  for (const p of premade.PERSONAS) {
    const plan = await premadePlan(slug, p.slug);
    if (plan) out.push({ persona: p, plan });
  }
  return out;
}

// Park registry: display data, typical hours/shows, and queue-times matching
// hints. Static ids are fallbacks — resolveParkIds() corrects them against
// queue-times' live parks directory by name, so we never hardcode a wrong id.
const REGISTRY = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'parks.json'), 'utf8'));
const PARKS = Object.fromEntries(REGISTRY.map((p) => [p.slug, p]));
// Safe now that PARKS exists -- see the note beside refreshBaselines.
refreshBaselines();

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

// --- Park weather ------------------------------------------------------------
// Open-Meteo: free, no API key, no attribution string required. Cached per
// park for 30 minutes — forecasts don't move faster than that, and a park's
// visitors all share one lookup.
const WEATHER_API = process.env.WEATHER_API || 'https://api.open-meteo.com/v1/forecast';
const weatherCache = new Map();
const WEATHER_TTL_MS = 30 * 60 * 1000;

// WMO weather codes → a short label and an emoji the whole app can show.
const WMO = [
  [[0], 'Clear', '☀️'], [[1], 'Mostly sunny', '🌤️'], [[2], 'Partly cloudy', '⛅'], [[3], 'Overcast', '☁️'],
  [[45, 48], 'Fog', '🌫️'], [[51, 53, 55, 56, 57], 'Drizzle', '🌦️'],
  [[61, 63, 65, 66, 67], 'Rain', '🌧️'], [[71, 73, 75, 77], 'Snow', '🌨️'],
  [[80, 81, 82], 'Showers', '🌦️'], [[85, 86], 'Snow showers', '🌨️'],
  [[95, 96, 99], 'Thunderstorms', '⛈️'],
];
const wmo = (code) => {
  const hit = WMO.find(([codes]) => codes.includes(code));
  return { label: hit ? hit[1] : 'Mixed', icon: hit ? hit[2] : '🌡️' };
};

async function getWeather(park) {
  const hit = weatherCache.get(park.slug);
  if (hit && Date.now() - hit.at < WEATHER_TTL_MS) return hit.data;
  const url = `${WEATHER_API}?latitude=${park.lat}&longitude=${park.lng}` +
    '&current=temperature_2m,apparent_temperature,weather_code,precipitation' +
    // Feels-like, UV, wind and humidity are what actually decide a park day:
    // the queue is outdoors, the sun is overhead, and high rides pause in wind.
    '&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code,uv_index,wind_speed_10m,relative_humidity_2m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,wind_speed_10m_max,sunrise,sunset' +
    `&timezone=${encodeURIComponent(park.tz || 'auto')}&forecast_days=7`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const j = await res.json();
  const cur = j.current || {};
  const daily = j.daily || {};
  const hourly = j.hourly || {};
  // The rainiest hour while the park is open — that's the one worth planning
  // an indoor ride around.
  let wettest = null;
  const times = hourly.time || [];
  for (let i = 0; i < times.length; i++) {
    const hr = Number(String(times[i]).slice(11, 13));
    if (!String(times[i]).startsWith((daily.time || [])[0] || '')) continue;
    if (park.open != null && (hr < park.open || hr >= park.close)) continue;
    const p = hourly.precipitation_probability?.[i] ?? 0;
    if (!wettest || p > wettest.chance) wettest = { hour: hr, chance: p };
  }
  // Every figure below is coerced to a number before it leaves here. These
  // values are interpolated straight into markup client-side, and a
  // third-party feed is the one input this process does not control.
  const data = {
    now: {
      temp: Math.round(cur.temperature_2m),
      feels: Math.round(cur.apparent_temperature ?? cur.temperature_2m),
      ...wmo(cur.weather_code),
    },
    today: {
      high: Math.round((daily.temperature_2m_max || [])[0]),
      low: Math.round((daily.temperature_2m_min || [])[0]),
      rainChance: Math.round(Number((daily.precipitation_probability_max || [])[0]) || 0),
      sunset: ((daily.sunset || [])[0] || '').slice(11, 16),
      ...wmo((daily.weather_code || [])[0]),
    },
    wettestHour: wettest && wettest.chance >= 30 ? wettest : null,
    // Each day carries its own hours. The app was reading index 0 whatever day
    // the user picked, so a Thursday plan showed Tuesday's weather; giving every
    // day its own block is what makes selecting a day mean anything.
    days: (daily.time || []).map((d, i) => ({
      date: d,
      high: Math.round(daily.temperature_2m_max[i]),
      low: Math.round(daily.temperature_2m_min[i]),
      rainChance: Math.round(Number(daily.precipitation_probability_max?.[i]) || 0),
      uvMax: Math.round((daily.uv_index_max?.[i] ?? 0) * 10) / 10,
      windMax: Math.round(daily.wind_speed_10m_max?.[i] ?? 0),
      sunrise: ((daily.sunrise || [])[i] || '').slice(11, 16),
      sunset: ((daily.sunset || [])[i] || '').slice(11, 16),
      ...wmo(daily.weather_code[i]),
      hours: times.reduce((acc, t, j) => {
        if (!String(t).startsWith(d)) return acc;
        acc.push({
          hour: Number(String(t).slice(11, 13)),
          temp: Math.round(hourly.temperature_2m?.[j] ?? 0),
          feels: Math.round(hourly.apparent_temperature?.[j] ?? hourly.temperature_2m?.[j] ?? 0),
          rain: Math.round(Number(hourly.precipitation_probability?.[j]) || 0),
          uv: Math.round((hourly.uv_index?.[j] ?? 0) * 10) / 10,
          wind: Math.round(hourly.wind_speed_10m?.[j] ?? 0),
          humidity: Math.round(Number(hourly.relative_humidity_2m?.[j]) || 0),
          ...wmo(hourly.weather_code?.[j]),
        });
        return acc;
      }, []),
    })),
    units: 'celsius',
  };
  weatherCache.set(park.slug, { at: Date.now(), data });
  return data;
}

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

// One sanitizer for every place a client hands us a plan: the email endpoint,
// the saved-plans store, and (indirectly) the night-before mailer that replays
// stored rows. Anything that renders into an email goes through here first.
function sanitizeStops(raw) {
  return (Array.isArray(raw) ? raw.slice(0, 34) : [])
    .filter((st) => st && (typeof st.name === 'string' || typeof st.break === 'string'))
    .map((st) => (typeof st.name === 'string'
      ? {
        name: st.name.slice(0, 120),
        time: typeof st.time === 'string' ? st.time.slice(0, 12) : '',
        wait: Number.isFinite(st.wait) ? Math.max(0, Math.round(st.wait)) : null,
      }
      : {
        break: st.break.slice(0, 80),
        time: typeof st.time === 'string' ? st.time.slice(0, 12) : '',
        why: typeof st.why === 'string' ? st.why.slice(0, 140) : '',
      }));
}

async function planKpis(park, stops, profile) {
  const rideNames = stops.filter((st) => st.name).map((st) => st.name);
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
  const landOf = {};
  let dodged = null;
  let live = new Map();
  try {
    const waits = await getWaits(park.slug);
    live = new Map(waits.rides.map((r) => [r.name, r]));
  } catch {}
  try {
    for (const st of stops) {
      if (!st.name) continue;
      const r = live.get(st.name);
      // Feed lands are authoritative; the classifier covers feeds that omit them.
      const land = (r && r.land) || (tags[st.name] && tags[st.name].land) || '';
      if (land) { lands.add(land); landOf[st.name] = land; }
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
    landOf,
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

function planEmailHtml({ park, day, stops, kpis, savedMin, briefing, profile, firstName, future }) {
  const B = '#5b3df5';
  const INK = '#251d3d', MUTED = '#8b83a8', SOFT = '#f4f1ff';
  // The last one of these printed from Outlook came back with every astral
  // emoji as tofu or CJK mojibake -- the icons were the design. Nothing in
  // this email may depend on an emoji font again: icons are colored badges
  // built from tables and text, and astral characters are stripped from any
  // client-supplied string before it is interpolated.
  const noAstral = (v) => String(v ?? '').replace(/[\u{10000}-\u{10FFFF}]/gu, '').replace(/️/g, '').trim();
  const E = (v) => esc(noAstral(v));
  const badge = (txt, bg, fg, w) => `<span style="display:inline-block;min-width:${w || 26}px;height:26px;border-radius:99px;background:${bg};color:${fg};font-weight:800;font-size:${String(txt).length > 2 ? 10 : 12}px;text-align:center;line-height:26px;padding:0 ${String(txt).length > 2 ? 8 : 0}px">${txt}</span>`;

  const tile = (v, label, sub, pct) => `<td style="padding:0 6px" width="${pct || 25}%" valign="top">
    <div style="background:${SOFT};border-radius:14px;padding:14px 8px;text-align:center">
      <div style="font-size:26px;font-weight:800;color:${B};line-height:1.1">${v}</div>
      <div style="font-size:11px;font-weight:700;color:#443b6b;text-transform:uppercase;letter-spacing:.04em;margin-top:3px">${label}</div>
      ${sub ? `<div style="font-size:10px;color:${MUTED};margin-top:2px">${sub}</div>` : ''}
    </div></td>`;

  // Running order, banded by the shape of a park day. The hour comes from the
  // stop's own printed time, so it works whatever timezone built the plan.
  const hourOf = (t) => {
    const m = /^(\d{1,2})(?::\d{2})?\s*(AM|PM)?$/i.exec(String(t || '').trim());
    if (!m) return null;
    let h = Number(m[1]) % 12;
    if (m[2] && m[2].toUpperCase() === 'PM') h += 12;
    if (!m[2]) h = Number(m[1]);
    return h;
  };
  const bandOf = (h) => (h == null ? null : h < 12 ? 'MORNING' : h < 17 ? 'AFTERNOON' : 'EVENING');
  const BAND_SUB = { MORNING: 'rope drop pace — the short-line hours', AFTERNOON: 'peak crowds — shows, meals, indoor rides', EVENING: 'lines fade as the crowd drifts to dinner' };
  let rideNo = 0;
  let lastBand = null;
  const rowPieces = [];
  for (const st of stops) {
    const band = bandOf(hourOf(st.time));
    if (band && band !== lastBand) {
      lastBand = band;
      rowPieces.push(`<tr><td colspan="3" style="padding:14px 0 6px">
        <div style="border-left:3px solid ${B};padding:2px 0 2px 10px">
          <span style="font-size:11px;font-weight:800;letter-spacing:.1em;color:${B}">${band}</span>
          <span style="font-size:11px;color:${MUTED}"> · ${BAND_SUB[band]}</span>
        </div></td></tr>`);
    }
    if (st.break) {
      rowPieces.push(`<tr><td colspan="3" style="padding:5px 0">
        <div style="background:#fff7e6;border-radius:10px;padding:9px 12px">
          <b style="color:#92580a;font-size:13.5px">${E(st.break)}</b>
          <span style="color:#b8791a;font-size:12.5px"> · ${E(st.time)}${st.why ? ` — ${E(st.why)}` : ''}</span>
        </div></td></tr>`);
      continue;
    }
    rideNo += 1;
    const land = kpis.landOf && kpis.landOf[st.name];
    rowPieces.push(`<tr>
      <td width="34" valign="top" style="padding:7px 0">${badge(rideNo, B, '#fff')}</td>
      <td valign="top" style="padding:7px 8px 7px 0">
        <b style="color:${INK};font-size:14.5px">${E(st.name)}</b>
        ${land ? `<br><span style="display:inline-block;background:${SOFT};color:${B};font-size:10.5px;font-weight:700;padding:1px 8px;border-radius:99px;margin-top:3px">${E(land)}</span>` : ''}
      </td>
      <td width="86" valign="top" align="right" style="padding:7px 0;white-space:nowrap">
        <b style="color:${INK};font-size:13px">${E(st.time)}</b>
        ${st.wait != null ? `<br><span style="color:${MUTED};font-size:12px">~${st.wait} min</span>` : ''}
      </td></tr>`);
  }
  const rows = rowPieces.join('');

  // Fact rows: the number IS the icon. Category colors, no glyphs.
  const fact = (b, label) => `<tr><td width="40" valign="top" style="padding:5px 0">${b}</td>
    <td valign="top" style="padding:7px 0;font-size:14px;color:#3f3762">${label}</td></tr>`;
  const CAT = {
    thrill: ['#fdeaea', '#b23a48'], water: ['#e7efff', '#1e40af'], show: ['#f4f1ff', B],
    map: ['#eafaf1', '#14532d'], money: ['#fff7e6', '#92580a'], neutral: ['#eee9ff', '#443b6b'],
  };
  const namedStopsPeek = () => stops.filter((st) => st.name)
    .reduce((a, b) => (Number.isFinite(b.wait) && (!a || b.wait > a.wait) ? b : a), null);

  // Editorial signal cards -- a title that names the takeaway, then one
  // sentence of what to do about it. Same real numbers as before.
  const signalCard = (title, color, body) => `<td width="50%" valign="top" style="padding:5px">
    <div style="background:${SOFT};border-radius:12px;padding:11px 13px;min-height:52px">
      <div style="font-size:10.5px;font-weight:800;letter-spacing:.08em;color:${color}">${title}</div>
      <div style="font-size:13px;color:#3f3762;margin-top:2px;line-height:1.45">${body}</div>
    </div></td>`;
  const longestQ = namedStopsPeek();
  const signalList = [
    longestQ && longestQ.wait >= 35 ? signalCard('ONE BIG QUEUE', CAT.thrill[1], `${E(longestQ.name)} reaches about <b>${longestQ.wait} min</b> — the one wait to plan around. Snack first, then commit.`) : '',
    kpis.shows ? signalCard(`${kpis.shows === 1 ? 'A' : kpis.shows} COOL-DOWN STOP${kpis.shows === 1 ? '' : 'S'}`, B, `${kpis.shows} show${kpis.shows === 1 ? '' : 's'} give${kpis.shows === 1 ? 's' : ''} you built-in places to sit and reset in the AC.`) : '',
    kpis.water ? signalCard(`PACK FOR ${kpis.water === 1 ? 'ONE SPLASH' : kpis.water + ' SPLASHES'}`, CAT.water[1], `${kpis.water === 1 ? 'One ride' : kpis.water + ' rides'} can send you out wetter than you arrived. A compact poncho keeps the afternoon comfortable.`) : '',
    kpis.skip ? signalCard('NO PASS PRESSURE', CAT.money[1], `Built to work without ${esc(kpis.skip.name)} — <b>${kpis.skip.cur}${kpis.skip.low}–${kpis.skip.cur}${kpis.skip.high}</b> kept in your pocket${kpis.party > 1 ? ` for ${kpis.party}` : ''}. Buy only if live waits change the math.`) : '',
    kpis.lands ? signalCard(`${kpis.lands} LAND${kpis.lands === 1 ? '' : 'S'}, ONE DIRECTION`, CAT.map[1], `The route stays compact${kpis.landNames.length ? ` through ${esc(kpis.landNames.slice(0, 4).join(', '))}` : ''} instead of zig-zagging.`) : '',
    kpis.singleRider ? signalCard('SPLIT-UP OPTION', '#443b6b', `${kpis.singleRider} ride${kpis.singleRider === 1 ? '' : 's'} run${kpis.singleRider === 1 ? 's' : ''} a single-rider line if the party is willing.`) : '',
  ].filter(Boolean);
  const signalRows = [];
  for (let i = 0; i < signalList.length; i += 2) {
    signalRows.push(`<tr>${signalList[i]}${signalList[i + 1] || '<td width="50%"></td>'}</tr>`);
  }
  const facts = signalRows.join('');

  // Playful, but every number is real: each of these is derived from the plan
  // itself. A fabricated "churros within reach" would be funnier and would
  // make the rest of the email less believable -- a bad trade for an email
  // whose whole job is to be trusted about wait times.
  const namedStops = stops.filter((st) => st.name);
  const first = namedStops[0], last = namedStops[namedStops.length - 1];
  const longest = namedStops.reduce((a, b) => (Number.isFinite(b.wait) && (!a || b.wait > a.wait) ? b : a), null);
  const dayLen = first && last && first.time && last.time ? `${first.time} → ${last.time}` : null;
  const hourOfFirst = hourOf(first && first.time), hourOfLast = hourOf(last && last.time);
  const dayHours = hourOfFirst != null && hourOfLast != null && hourOfLast > hourOfFirst ? `${hourOfLast - hourOfFirst}h` : '~';
  const queueHours = savedMin >= 60 ? (savedMin / 60).toFixed(1) : null;
  const totalQueue = namedStops.reduce((sum, st) => sum + (Number.isFinite(st.wait) ? st.wait : 0), 0);
  const paceRides = hourOfFirst != null && hourOfLast != null && hourOfLast > hourOfFirst
    ? (namedStops.length / (hourOfLast - hourOfFirst)).toFixed(1).replace(/\.0$/, '') : null;
  const funFacts = [
    dayLen ? fact(badge(dayHours, ...CAT.neutral, 34), `Your day, gate to gate: <b>${esc(dayLen)}</b> — longer than most flights you have complained about`) : '',
    longest && longest.wait >= 40 ? fact(badge(`${longest.wait}m`, ...CAT.thrill, 34), `Longest single queue on the plan: <b>${longest.wait} min</b> at ${E(longest.name)}. Bring a snack and a grudge`) : '',
    queueHours ? fact(badge(`${queueHours}h`, ...CAT.map, 34), `Line time dodged: <b>${queueHours} hours</b> — roughly ${Math.max(1, Math.round(savedMin / 22))} sitcom episode${Math.round(savedMin / 22) === 1 ? '' : 's'} you get to not watch in a queue`) : '',
    kpis.water ? fact(badge(kpis.water, ...CAT.water), `Forecast dampness: <b>${kpis.water}</b> ride${kpis.water === 1 ? '' : 's'} that can return you visibly wetter than you arrived`) : '',
    kpis.thrills ? fact(badge(kpis.thrills, ...CAT.thrill), `Stomach relocation${kpis.thrills === 1 ? '' : 's'} booked: <b>${kpis.thrills}</b>`) : '',
    kpis.mapped && kpis.steps ? fact(badge('~', ...CAT.neutral), `About <b>${kpis.steps.toLocaleString()}</b> steps — your shoes knew what they signed up for`) : '',
    totalQueue >= 30 ? fact(badge(totalQueue >= 60 ? `${Math.round(totalQueue / 60)}h` : `${totalQueue}m`, ...CAT.money, 34), `Projected time in lines all day: <b>${totalQueue >= 60 ? `${Math.floor(totalQueue / 60)}h ${totalQueue % 60}m` : `${totalQueue} min`}</b> — already the fat-trimmed version`) : '',
    hourOfFirst != null && hourOfFirst <= 9 && first ? fact(badge('AM', ...CAT.show, 34), `Rope-drop warrior: first ride at <b>${esc(first.time)}</b>, when queues are half their afternoon selves`) : '',
    hourOfLast != null && hourOfLast >= 20 && last ? fact(badge('PM', ...CAT.show, 34), `Closing-time finisher: last stop at <b>${esc(last.time)}</b> — the park empties out, you don't`) : '',
    paceRides && Number(paceRides) >= 1 ? fact(badge(paceRides, ...CAT.map, 34), `Pace: about <b>${paceRides} attraction${paceRides === '1' ? '' : 's'} per hour</b>, gate to gate — Olympic, by vacation standards`) : '',
  ].filter(Boolean).join('');

  const tileRow = [
    (w) => tile(kpis.attractions, 'Attractions', 'on the plan', w),
    kpis.mapped ? (w) => tile(kpis.km + ' km', 'Walking', kpis.miles + ' mi', w) : null,
    kpis.mapped ? (w) => tile(kpis.kcal, 'Calories', 'per adult', w) : null,
    savedMin > 0 ? (w) => tile(savedMin >= 60 ? Math.round(savedMin / 60) + ' hr' : savedMin + ' min', 'Line time saved', 'vs. winging it', w) : null,
    !kpis.mapped && kpis.lands ? (w) => tile(kpis.lands, 'Lands', 'on the route', w) : null,
    !kpis.mapped && kpis.thrills ? (w) => tile(kpis.thrills, 'Thrill rides', 'on the list', w) : null,
  ].filter(Boolean).slice(0, 4);
  const tiles = tileRow.map((fn) => fn(Math.round(100 / tileRow.length))).join('');

  const dodgedBanner = kpis.dodged
    ? `<div style="padding:4px 26px 0"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
        <td style="background:#eafaf1;border-radius:12px;padding:12px 16px;font-size:14px;color:#14532d">
        <span style="font-size:10.5px;font-weight:800;letter-spacing:.1em;color:#0f7a45">TODAY'S ADVANTAGE</span><br>
        ${E(kpis.dodged.name)} is ${kpis.dodged.standby} min right now — your slot lands about <b>${kpis.dodged.minutes} min shorter</b>.
      </td></tr></table></div>`
    : '';
  const preheader = `${kpis.attractions} stops mapped for ${esc(park.name)}${kpis.dodged ? `, dodging the ${kpis.dodged.standby}-minute line at ${E(kpis.dodged.name)}` : ''}.`;
  return `<!doctype html><html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <!-- Tell clients the design is light-only; without it, Outlook.com and Apple
       Mail auto-invert the card and the purple header turns muddy. -->
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>Your ${esc(park.name)} day plan</title>
  </head><body style="margin:0;padding:0;background:#f7f5ff">
  <div style="display:none;font-size:1px;color:#f7f5ff;max-height:0;overflow:hidden;mso-hide:all">${preheader}</div>
  <div style="background:#f7f5ff;padding:24px 12px;font:15px/1.6 -apple-system,'Segoe UI',sans-serif;color:${INK}">
   <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 6px 28px rgba(20,12,48,.09)">
    <!-- bgcolor as well as the gradient: Outlook renders through Word, which
         ignores linear-gradient entirely. Without the attribute the header lost
         its background and printed white text on white. -->
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" bgcolor="${B}" style="background:${B};background:linear-gradient(135deg,${B},#8b5cf6)"><tr><td style="padding:26px 26px 22px;color:#fff">
      <div style="font-size:12px;font-weight:800;letter-spacing:.12em;opacity:.85;text-transform:uppercase">ParkPulse · ${future ? 'advance plan' : 'live route'} · ${esc(park.name)}</div>
      <div style="font-size:25px;font-weight:800;letter-spacing:-.02em;margin-top:6px;line-height:1.2">A full park day, with fewer second&nbsp;guesses.</div>
      <div style="opacity:.85;font-size:14px;margin-top:4px">${day} · sequenced around ${future ? "that day's predicted crowds" : 'live waits'}, park geography, and the rides you care about.</div>
    </td></tr></table>
    <div style="padding:22px 20px 6px">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>${tiles}</tr></table>
    </div>
    ${dodgedBanner}
    ${briefing ? `<div style="padding:16px 26px 4px">
      <div style="background:#fffaf0;border-left:4px solid #f0b429;border-radius:10px;padding:14px 16px;font-size:14.5px">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td width="40" valign="top"><img src="https://www.parkpulse.fun/img/mila/mila-thinking-160.webp" width="32" height="32" alt="" style="border-radius:99px;display:block"></td>
          <td valign="top"><b>Mila's read${firstName ? ` for ${E(firstName)}` : ''} on the day</b><br>${E(briefing).replace(/\n/g, '<br>')}</td>
        </tr></table>
      </div></div>` : ''}
    <div style="padding:18px 26px 6px">
      <div style="font-weight:800;font-size:16px;margin-bottom:2px">${future ? `${esc(String(day).split(',')[0])}'s running order` : "Today's running order"}</div>
      <div style="color:${MUTED};font-size:13px">Follow the numbers — they match the pins on your map.</div>
      <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
    </div>
    ${facts ? `<div style="padding:14px 21px 2px">
      <div style="font-weight:800;font-size:16px;margin-bottom:4px;padding:0 5px">Plan signals worth knowing</div>
      <table width="100%" cellpadding="0" cellspacing="0">${facts}</table></div>` : ''}
    ${funFacts ? `<div style="padding:14px 26px 2px">
      <div style="font-weight:800;font-size:16px;margin-bottom:2px">The stats nobody asked for</div>
      <div style="color:${MUTED};font-size:12.5px;margin-bottom:6px">All real, all from this plan.</div>
      <table width="100%" cellpadding="0" cellspacing="0">${funFacts}</table></div>` : ''}
    <div style="padding:18px 26px 8px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:linear-gradient(135deg,#2c2154,#443b6b);background-color:#2c2154" bgcolor="#2c2154">
        <div style="padding:18px 20px;color:#fff">
          <div style="font-size:10.5px;font-weight:800;letter-spacing:.1em;opacity:.8">KEEP THE DAY MOVING</div>
          <div style="font-size:17px;font-weight:800;margin-top:4px;line-height:1.35">The plan is your starting point. Live waits make it smarter as you go.</div>
          <div style="font-size:13px;opacity:.85;margin-top:4px">A delay, a hungry kid, or a wait swing doesn't undo the day — reopen your plan and take the next better move.</div>
        </div>
      </td></tr></table>
    </div>
    <div style="padding:4px 26px 26px">
      <a href="https://www.parkpulse.fun/app" style="display:inline-block;background:${B};color:#fff;text-decoration:none;font-weight:800;padding:13px 26px;border-radius:12px">Open live waits →</a>
      <div style="color:#a49cc0;font-size:12px;margin-top:6px">Your route, ready to adapt.</div>
      ${kpis.mapped ? `<div style="color:#a49cc0;font-size:11.5px;margin-top:16px;line-height:1.5">
        Walking distance is measured along your planned route plus the walk in and out, with a 35% allowance for real-world wandering. Calories assume a 70 kg adult at a casual pace — a rough guide, not a fitness tracker.
      </div>` : ''}
    </div>
   </div>
   <div style="max-width:600px;margin:12px auto 0;text-align:center;color:#a49cc0;font-size:11.5px">
     ParkPulse · unofficial fan tool, not affiliated with any park operator.
   </div>
  </div></body></html>`;
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
setInterval(() => { checkAlerts().catch(() => {}); checkBookingReminders().catch(() => {}); sweepDeletedAccounts(); maybeSendAiCostEmail(); sweepEveningPlanMail().catch((e) => console.log(`evening mail sweep: ${e.message}`)); }, ALERT_CHECK_MS);

// --- Night-before plan emails ------------------------------------------------
// Zero taps during the trip: the evening before a saved plan's date (18:00 to
// 20:59 at THAT PARK), the advance-plan email goes out on its own. mailed_at
// makes each send one-shot; the account-level toggle turns the whole thing
// off. Sends only ever go to the account's own address.
async function sweepEveningPlanMail() {
  if (!RESEND_KEY) return; // no mailer configured — nothing to sweep
  let sent = 0;
  // "Tomorrow" differs by park timezone, so collect the candidate dates from
  // both edges of the map and let the per-park local-time check decide.
  const dates = new Set();
  for (const tz of ['Pacific/Honolulu', 'UTC', 'Asia/Tokyo']) {
    try { dates.add(addDays(new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()), 1)); } catch {}
  }
  for (const date of dates) {
    for (const row of db.plans.unmailedFor(date)) {
      if (sent >= 10) return; // spread bursts across sweeps
      const park = PARKS[row.park];
      if (!park) continue;
      let local;
      try {
        local = new Intl.DateTimeFormat('en-CA', { timeZone: park.tz, hour: 'numeric', hourCycle: 'h23' })
          .formatToParts(new Date());
      } catch { continue; }
      const hour = Number(local.find((x) => x.type === 'hour')?.value);
      const todayAtPark = new Intl.DateTimeFormat('en-CA', { timeZone: park.tz }).format(new Date());
      // Only in the evening window, and only when the plan is for tomorrow
      // at that park — a plan for further out waits for its own eve.
      if (!(hour >= 18 && hour <= 20) || addDays(todayAtPark, 1) !== row.date) continue;
      const user = db.users.get(row.email);
      if (!user || user.evening_mail === 0 || user.delete_at) { db.plans.markMailed(row.email, row.park, row.date); continue; }
      let stops = [];
      try { stops = sanitizeStops(JSON.parse(row.stops)); } catch {}
      if (!stops.some((st) => st.name)) { db.plans.markMailed(row.email, row.park, row.date); continue; }
      // Mark BEFORE sending: a crash after send must not re-mail tomorrow.
      db.plans.markMailed(row.email, row.park, row.date);
      try {
        const profile = (db.daystate.get(row.email) || {}).profile || null;
        const kpis = await planKpis(park, stops, profile);
        kpis.dodged = null; // future day: no live-now comparison
        const day = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
          .format(new Date(`${row.date}T12:00:00Z`));
        let briefing = '';
        if (consultant.enabled()) {
          try {
            briefing = await consultant.dayBriefing({ parkName: park.name, group: park.group, day, future: true, stops, kpis, profile, savedMin: row.saved_min || 0, lang: 'English' });
          } catch (err) { console.log(`evening briefing failed: ${err.message}`); }
        }
        const html = planEmailHtml({ park, day, stops, kpis, savedMin: row.saved_min || 0, briefing, profile, firstName: user.name || null, future: true });
        const firstRide = stops.find((st) => st.name && st.time);
        await sendEmail(row.email, `Tomorrow at ${park.name} — your plan is ready${firstRide ? ` (first ride ${firstRide.time})` : ''}`, html);
        sent += 1;
        console.log(`evening plan email: ${park.slug} ${row.date} -> ${row.email}`);
      } catch (err) {
        console.log(`evening plan email failed (${park.slug} ${row.date}): ${err.message}`);
      }
    }
  }
  // Old plans expire quietly; the library shows upcoming days, not history.
  try { db.plans.purgeOld(addDays(new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date()), -30)); } catch {}
}
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

// For each date, which park in the same resort is the lightest. This is the
// call a visitor actually wants — not "how busy is EPCOT" but "which of the
// four should I do on the 30th" — and it only means anything where a resort
// has siblings, so a standalone park gets nothing rather than a comparison
// with itself.
function bestParkByDate(slug, horizon) {
  const group = PARKS[slug]?.group;
  const siblings = REGISTRY.filter((p) => p.group && p.group === group);
  if (siblings.length < 2) return null;
  const byPark = siblings.map((p) => ({ slug: p.slug, name: p.name, days: forecastFor(p.slug, horizon).days }));
  const out = {};
  for (let i = 0; i < byPark[0].days.length; i += 1) {
    const date = byPark[0].days[i].date;
    let best = null;
    for (const p of byPark) {
      const d = p.days[i];
      if (!d) continue;
      if (!best || d.factor < best.factor) best = { slug: p.slug, name: p.name, factor: d.factor, score: d.score };
    }
    // A tie across every park in the resort is not a recommendation.
    const spread = Math.max(...byPark.map((p) => p.days[i]?.factor ?? 0)) - (best?.factor ?? 0);
    if (best && spread >= 0.03) {
      // Lighter is only half the story if the recommended park closes early to
      // day tickets that night -- say so in the same breath.
      const bestEv = eventsFor(best.slug, date).find((e) => e.kind === 'hard-ticket' && e.certainty === 'confirmed');
      out[date] = { ...best, reason: 'crowds', ...(bestEv && { closesEarly: bestEv.name }) };
    }
    // Independent of crowds: a CONFIRMED hard-ticket night closes the viewed
    // park to day tickets in the early evening. A sibling with no such event
    // that night keeps full hours -- a better day even at equal crowd level.
    // Confirmed dates only; with dates unfilled this stays silent rather than
    // guessing which nights are party nights.
    if (!out[date]) {
      const hardHere = eventsFor(slug, date).find((e) => e.kind === 'hard-ticket' && e.certainty === 'confirmed');
      if (hardHere) {
        const clear = byPark.find((p) => p.slug !== slug
          && !eventsFor(p.slug, date).some((e) => e.kind === 'hard-ticket' && e.certainty === 'confirmed'));
        if (clear) out[date] = { slug: clear.slug, name: clear.name, factor: clear.days[i]?.factor, score: clear.days[i]?.score, reason: 'hours', event: hardHere.name };
      }
    }
  }
  return { group, count: siblings.length, byDate: out };
}

// --- Special events ----------------------------------------------------------
// Hard-ticket nights are the ones that break a plan: the park closes to day
// tickets in the early evening and reopens for people holding a separate event
// ticket. A day planned to 10pm on one of those is wrong from about 6pm.
//
// Dates come from the operator and are not shipped. With confirmed dates in
// park-events.json an event is CERTAIN for that date -- the planner caps the
// day and the advisor is told outright. Without them we know only the season,
// so the visitor is told to check the official calendar and nothing is capped.
// Guessing which nights are party nights would produce exactly the confident,
// wrong advice this product exists to replace.
let PARK_EVENTS = {};
try {
  PARK_EVENTS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'park-events.json'), 'utf8'));
} catch (err) { console.log(`park events unavailable: ${err.message}`); }

// Authored peak/quiet months per park, shared with the SEO pages. Until the
// history archive is deep enough to measure per-park differences, this is the
// only signal that separates resort siblings: Epcot's festival autumn versus
// Magic Kingdom's quiet September is real, editorial knowledge -- and without
// it every sibling shared one weekday prior, so the calendar's "best park to
// visit" call could never fire and each park's own grid could show Light in a
// month its page copy calls the busiest of the year.
let PARK_SEASONS = {};
try {
  const seo = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'park-seo.json'), 'utf8'));
  for (const [slug, v] of Object.entries(seo)) {
    PARK_SEASONS[slug] = { peak: new Set(v.peak?.months || []), quiet: new Set(v.quiet?.months || []) };
  }
} catch (err) { console.log(`park seasons unavailable: ${err.message}`); }

function eventsFor(slug, iso) {
  const list = (PARK_EVENTS[slug] || []).filter((e) => e && e.name);
  if (!list.length || !/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return [];
  const month = Number(iso.slice(5, 7));
  return list.flatMap((e) => {
    if (Array.isArray(e.dates) && e.dates.includes(iso)) {
      return [{ ...e, certainty: 'confirmed' }];
    }
    if (Array.isArray(e.months) && e.months.includes(month)) {
      return [{ ...e, certainty: 'possible' }];
    }
    return [];
  });
}

// A 1-10 score for the calendar. The underlying factor is continuous — the five
// named levels are a display choice, not the resolution of the model — so this
// exposes what is already there rather than inventing precision. Buckets of
// 0.075 across the range the factor actually occupies.
const crowdScore = (factor) => Math.max(1, Math.min(10, Math.floor((factor - 0.70) / 0.075) + 1));

// One factor function for every consumer: the forecast, the calendar, and the
// published accuracy backtest. The backtest passes its own walk-forward
// measured index; live callers pass DOW_INDEX. If the model here changes, the
// scoreboard scores the changed model automatically -- they cannot drift apart.
function dayFactorFor(slug, iso, measured) {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  const weight = measured ? Math.min(1, measured.days / 21) : 0;
  const m = measured?.factors[dow];
  let factor = weight * (m ?? PRIOR_DOW[dow]) + (1 - weight) * PRIOR_DOW[dow];
  // Small on purpose: one score bucket either way. The seasonal months are
  // authored judgement, not measurement, and they must never drown out the
  // measured weekday pattern once it exists.
  const season = PARK_SEASONS[slug];
  if (season?.peak.has(Number(iso.slice(5, 7)))) factor *= 1.06;
  else if (season?.quiet.has(Number(iso.slice(5, 7)))) factor *= 0.94;
  if (HOLIDAYS[iso] || isChristmasWeek(iso)) factor *= 1.28;
  return factor;
}

function forecastFor(slug, horizon = 7) {
  const park = PARKS[slug];
  const measured = DOW_INDEX[slug];
  const days = [];
  // People book trips months ahead, so the calendar needs a horizon a trip
  // planner can actually use. The model is day-of-week plus a holiday table,
  // which projects arbitrarily far -- what degrades with distance is the
  // holiday coverage, not the arithmetic, and the page says so.
  const span = Math.min(Math.max(Number(horizon) || 7, 7), 370);
  for (let i = 0; i < span; i++) {
    const d = new Date(Date.now() + i * 86400000);
    // Date and weekday in the PARK's timezone, not the server's.
    const iso = d.toLocaleDateString('en-CA', { timeZone: park.tz });
    const dowName = d.toLocaleDateString('en-US', { timeZone: park.tz, weekday: 'short' });
    const factor = dayFactorFor(slug, iso, measured);
    const holiday = HOLIDAYS[iso] || (isChristmasWeek(iso) ? 'Holiday season' : null);
    const level = factor < 0.88 ? 1 : factor < 0.97 ? 2 : factor < 1.07 ? 3 : factor < 1.22 ? 4 : 5;
    const events = eventsFor(slug, iso);
    days.push({ date: iso, dow: dowName, level, label: FORECAST_LEVELS[level], score: crowdScore(factor), factor: Math.round(factor * 100) / 100, ...(holiday && { holiday }), ...(events.length && { events }) });
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
  // Photography is served from public/img; without these, JPEGs and WebP go
  // out as application/octet-stream and browsers download rather than render.
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// --- Landing-page photography -----------------------------------------------
// Art direction lives here, files live in public/img. Every slot renders only
// when its file is present, so a missing photo degrades to the typographic
// layout rather than a broken image.
const PHOTOS = {
  hero: { file: 'parkpulse-hero-cinematic.jpg', alt: '' },
  vip: { file: 'parkpulse-checklist-cover.jpg', alt: 'A trip checklist and a hand-drawn park route in a notebook.' },
  band: { file: 'parkpulse-family-visual.jpg', alt: 'A family pausing on a park path below a coaster, checking their plan on a phone.' },
  capture: { file: 'parkpulse-snack-break.jpg', alt: '' },
};
const photoPath = (slot) => {
  const p = PHOTOS[slot];
  if (!p) return null;
  return fs.existsSync(path.join(PUBLIC_DIR, 'img', p.file)) ? `/img/${p.file}` : null;
};
// The hero photo sits under the gradient, not over it — it adds depth without
// competing with the headline.
const heroPhoto = () => {
  const src = photoPath('hero');
  return src ? `<div class="hero-photo" style="background-image:url('${src}')"></div>` : '';
};
const vipPhoto = () => {
  const src = photoPath('vip');
  return src ? `<img class="vip-photo" src="${src}" alt="${esc(PHOTOS.vip.alt)}" loading="lazy">` : '';
};
const photoBand = () => {
  const src = photoPath('band');
  return src ? `<section class="sec"><figure class="band"><img src="${src}" alt="${esc(PHOTOS.band.alt)}" loading="lazy"></figure></section>` : '';
};
const captureStyle = () => {
  const src = photoPath('capture');
  // The band is very wide and short, so `cover` crops a square photo hard. Bias
  // the crop low: the counter -- paper map, drinks, a phone face-down -- is both
  // the most on-brand part of the frame and the part that survives being cut to
  // a 200px strip. Centring it instead slices the faces off mid-forehead.
  return src ? ` style="background-image:linear-gradient(180deg,rgba(36,27,70,.9),rgba(51,39,89,.95)),url('${src}');background-size:cover;background-position:50% 82%"` : '';
};

// --- Landing-page hero board ------------------------------------------------
// The design puts live product proof above the fold. Rendered server-side for
// three featured parks so the board is filled on first paint and works with
// JavaScript off; the tabs only toggle which panel is visible.
const HERO_PARKS = ['magic-kingdom', 'universal-studios-florida', 'cedar-point'];

const waitChip = (w) => (w >= 60 ? 'hot' : w >= 30 ? 'warm' : 'cool');

// A verdict has to come from the board itself, not a copywriter — otherwise it
// is just decoration that can contradict the numbers directly above it.
function boardVerdict(park, rides) {
  const scored = rides.filter((r) => r.delta != null);
  if (!scored.length) return `Open the app for today's read on ${park.name}.`;
  const avg = scored.reduce((a, r) => a + r.delta, 0) / scored.length;
  const pass = (park.skip && park.skip.name) || 'the paid pass';
  if (avg <= -8) return `Skip ${pass} today — waits are running below typical across the board.`;
  if (avg >= 12) return `${pass} is earning its keep — headliners are well above typical.`;
  return `Middling day — rope drop covers the headliners, so ${pass} is optional.`;
}

async function heroBoardPanels() {
  const panels = [];
  for (const slug of HERO_PARKS) {
    const park = PARKS[slug];
    if (!park) continue;
    let waits;
    try { waits = await getWaits(slug); } catch { waits = null; }
    const rides = ((waits && waits.rides) || [])
      .filter((r) => r.open !== false && typeof r.wait === 'number')
      .sort((a, b) => b.wait - a.wait)
      .slice(0, 6)
      .map((r) => ({
        name: r.name,
        land: r.land || '',
        wait: r.wait,
        delta: typeof r.typical === 'number' ? r.wait - r.typical : null,
      }));
    // Without a live feed the "typical" baseline equals the posted wait, so
    // every delta is zero. Showing "typical" on every row is noise, not data.
    const hasBaseline = rides.some((r) => r.delta);
    if (!hasBaseline) rides.forEach((r) => { r.delta = null; });
    panels.push({ park, rides, live: Boolean(waits && waits.source === 'live'), verdict: boardVerdict(park, rides) });
  }
  return panels;
}

function heroBoardHtml(panels) {
  if (!panels.length) return '';
  const rail = (active) => `<div class="board-tabs">${panels.map((p, i) =>
    `<button class="board-tab${i === active ? ' on' : ''}" data-board-tab="${i}" type="button">${esc(p.park.name)}</button>`).join('')}</div>`;
  const bodies = panels.map((p, i) => {
    const rows = p.rides.map((r) => {
      const d = r.delta == null ? ''
        : r.delta <= -5 ? `<span class="delta down">&#9660; ${Math.abs(r.delta)} below typical</span>`
        : r.delta >= 5 ? `<span class="delta up">&#9650; ${r.delta} above typical</span>`
        : '<span class="delta flat">typical</span>';
      const meta = [d, r.land ? `<span class="land">${esc(r.land)}</span>` : ''].filter(Boolean).join('');
      return `<div class="board-row"><div class="board-ride"><div class="rn">${esc(r.name)}</div>
${meta ? `<div class="rm">${meta}</div>` : ''}</div>
<div class="chip ${waitChip(r.wait)}"><b>${r.wait}</b><span>min</span></div></div>`;
    }).join('');
    const empty = '<div class="board-empty">Live waits for this park are momentarily unavailable — the app retries every minute.</div>';
    return `<div class="board-panel${i ? '' : ' on'}" data-board-panel="${i}">
<div class="board-head"><span class="board-name">${esc(p.park.name)}</span>
<span class="board-live ${p.live ? '' : 'off'}"><i></i>${p.live ? 'LIVE' : 'TYPICAL WAITS'}</span></div>
${rail(i)}
<div class="board-rows">${rows || empty}</div>
<div class="board-foot"><div><div class="vk">TODAY&rsquo;S VERDICT</div><div class="vv">${esc(p.verdict)}</div></div>
<a class="whybtn" href="/app">Why?</a></div></div>`;
  }).join('');
  return `<div class="board">${bodies}</div>`;
}

// Four regional columns of real parks, each linking to its own guide page.
function parkGuides(registry) {
  const by = (fn) => registry.filter(fn);
  const groups = [
    ['Walt Disney World', by((p) => p.group === 'Walt Disney World')],
    ['Universal &amp; Orlando', by((p) => p.group === 'Universal Orlando' || (p.region === 'Florida' && p.group !== 'Walt Disney World' && p.group !== 'Universal Orlando'))],
    ['California &amp; West', by((p) => p.region === 'California')],
    ['Worldwide', by((p) => p.region === 'Asia' || p.region === 'Europe')],
  ];
  return groups.map(([region, parks]) => `<div class="pg-col"><div class="pg-head">${region}</div>${
    parks.slice(0, 6).map((p) => `<a href="/parks/${p.slug}">${esc(p.name)}</a>`).join('')
  }</div>`).join('');
}

const SHOTS = [
  { file: 'plan.png', alt: 'The ParkPulse day plan: eight rides sequenced by time, each with its predicted wait and the reason for its slot.',
    cap: '<strong>Your day, sequenced.</strong> Pick the rides you care about; ParkPulse orders them against the hourly crowd curve and tells you why each one sits where it does.' },
  { file: 'advisor.png', alt: 'The ParkPulse AI consultant answering whether Lightning Lane is worth buying today.',
    cap: '<strong>Straight answers, including no.</strong> Ask whether the paid pass is worth it today and the consultant works it out from live waits &mdash; and tells you to keep your money when that is the truth.' },
];
function productShots() {
  const have = SHOTS.filter((s) => fs.existsSync(path.join(PUBLIC_DIR, 'shots', s.file)));
  if (!have.length) return '';
  const lead = have.length > 1
    ? 'Two screens do most of the work &mdash; the plan that sequences your day, and the consultant that tells you when not to spend.'
    : 'The screen that does most of the work: the plan that sequences your day around the crowd curve.';
  const figures = have.map((s) => `<figure><img src="/shots/${s.file}" alt="${s.alt}" loading="lazy" width="430" height="932"><figcaption>${s.cap}</figcaption></figure>`).join('');
  return `<p class="sectionlead">${lead}</p><div class="shots">${figures}</div>`;
}

function serveStatic(res, urlPath) {
  // Browsers and crawlers probe /favicon.ico regardless of what the pages
  // declare; without this alias every page view logs a 404. A PNG under the
  // .ico name is fine -- everything that asks for it renders PNG.
  if (urlPath === '/favicon.ico') urlPath = '/icon-192.png';
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  const candidates = [filePath, `${filePath}.html`];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(candidate)] || 'application/octet-stream' });
      // The landing page carries the full park index so every one of the
      // parks we cover is one click from the front door, for readers and
      // crawlers alike. Injected here so the list has a single source.
      return fs.createReadStream(candidate).pipe(res);
    }
  }
  // A person's typo gets a page that recovers the visit; a program's wrong
  // path keeps the JSON it can parse.
  if (!urlPath.startsWith('/api/') && !path.extname(urlPath)) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(pages.renderNotFoundPage());
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
  tagsFor: (slug) => { try { return JSON.parse(db.ridetags.get(slug) || 'null'); } catch { return null; } },
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
      // Whether THIS caller may actually use the advisor. `consultant` only
      // says the feature is configured; with PRO_GATE on, an anonymous visitor
      // still gets a 402. The widget needs both so it can show a paywall up
      // front instead of inviting a question and rejecting the answer.
      consultantAccess: consultant.enabled() && hasAccess(req),
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
      eveningMail: s.user.evening_mail !== 0,
      plan: active ? s.user.plan : null,
      exp: active ? s.user.plan_exp : null,
      passToken: active ? signPass(s.user.plan, s.user.plan_exp) : null,
    });
  }

  // The account's saved multi-day trip plan.
  // Saved plans: the library under the You tab, and the itinerary's per-day
  // status. Summaries only — the full stops come back when one is opened.
  if (url.pathname === '/api/plans' && req.method === 'GET') {
    const s2 = sessionUser(req);
    if (!s2) return sendJson(res, 401, { error: 'not logged in' });
    const rows = db.plans.list(s2.email).map((r) => {
      let stops = []; try { stops = JSON.parse(r.stops); } catch {}
      const named = stops.filter((st) => st.name);
      return { park: r.park, date: r.date, attractions: named.length, first: named[0]?.time || null, savedMin: r.saved_min || 0 };
    });
    return sendJson(res, 200, { plans: rows });
  }
  if (url.pathname === '/api/plans/one' && req.method === 'GET') {
    const s2 = sessionUser(req);
    if (!s2) return sendJson(res, 401, { error: 'not logged in' });
    const park = url.searchParams.get('park'), date = url.searchParams.get('date');
    if (!PARKS[park] || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return sendJson(res, 400, { error: 'invalid' });
    const row = db.plans.get(s2.email, park, date);
    if (!row) return sendJson(res, 404, { error: 'no plan saved' });
    let stops = []; try { stops = JSON.parse(row.stops); } catch {}
    return sendJson(res, 200, { park, date, stops, savedMin: row.saved_min || 0 });
  }
  // The whole trip as an .ics file — each planned day is an event with the
  // running order in the notes. Own account only; nothing here is public.
  if (url.pathname === '/api/plans.ics' && req.method === 'GET') {
    const s2 = sessionUser(req);
    if (!s2) return sendJson(res, 401, { error: 'not logged in' });
    const icsEsc = (t) => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const events = [];
    const seen = new Set();
    for (const r of db.plans.list(s2.email)) {
      const park = PARKS[r.park]; if (!park) continue;
      let stops = []; try { stops = JSON.parse(r.stops); } catch {}
      const named = stops.filter((st) => st.name);
      if (!named.length) continue;
      seen.add(`${r.date}|${r.park}`);
      const order = stops.map((st) => st.name ? `${st.time ? st.time + ' — ' : ''}${st.name}` : `${st.time ? st.time + ' — ' : ''}${st.break}`).join('\n');
      events.push({ date: r.date, title: `${park.name} — ${named.length} attractions (ParkPulse)`, desc: `First ride ${named[0].time || 'at opening'}.\n\n${order}` });
    }
    let trip = null; try { trip = db.trips.get(s2.email); } catch {}
    if (trip) {
      let plan = []; try { plan = JSON.parse(trip.plan); } catch {}
      for (const d of plan) {
        if (seen.has(`${d.date}|${d.park}`) || !PARKS[d.park]) continue;
        events.push({ date: d.date, title: `${PARKS[d.park].name} (ParkPulse trip)`, desc: 'Park day from your saved trip — build a plan in ParkPulse for a running order.' });
      }
    }
    if (!events.length) return sendJson(res, 404, { error: 'no plans or trip saved yet' });
    events.sort((a, b) => a.date < b.date ? -1 : 1);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ParkPulse//trip//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    for (const ev of events) {
      const d = ev.date.replace(/-/g, '');
      lines.push('BEGIN:VEVENT',
        `UID:pp-${ev.date}-${icsEsc(ev.title).slice(0, 24).replace(/[^A-Za-z0-9]/g, '')}@parkpulse.fun`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${d}`,
        `SUMMARY:${icsEsc(ev.title)}`,
        `DESCRIPTION:${icsEsc(ev.desc)}`,
        'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="parkpulse-trip.ics"' });
    return res.end(lines.join('\r\n'));
  }

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
      email: { configured: Boolean(RESEND_KEY), from: MAIL_FROM, replyTo: MAIL_REPLY_TO, customSender: !MAIL_FROM.includes('resend.dev') },
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

  // The landing page is templated (hero board, park guides, screenshots), so
  // it is rendered here rather than streamed by the static handler.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    let board = '';
    try { board = heroBoardHtml(await heroBoardPanels()); } catch (err) { console.log(`hero board: ${err.message}`); }
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
      .replace('<!--HERO_BOARD-->', () => board)
      .replace('<!--HERO_PHOTO-->', () => heroPhoto())
      .replace('<!--VIP_PHOTO-->', () => vipPhoto())
      .replace('<!--PHOTO_BAND-->', () => photoBand())
      .replace('<!--CAPTURE_BG-->', () => captureStyle())
      .replace('<!--PARK_GUIDES-->', () => parkGuides(REGISTRY))
      .replace('<!--FOOTER_PARKS-->', () => `<div class="allparks">${pages.allParksIndex(REGISTRY)}</div>`)
      .replace('<!--SHOTS-->', () => productShots());
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // The curve as data. CSV rather than JSON because the people who want this
  // want it in a spreadsheet, and because a downloadable file is the thing that
  // gets cited. Every crowd level is included, not just the one charted.
  const curveMatch = url.pathname.match(/^\/api\/curve\/([a-z0-9-]+)\.csv$/);
  if (curveMatch) {
    const slug = curveMatch[1];
    if (!PARKS[slug]) return sendJson(res, 404, { error: 'unknown park' });
    const levels = HOURLY_CURVES[slug] || {};
    // Observed columns ride alongside the posted ones so the gap is computable
    // from the file itself, not just visible on the chart. Blank where nobody
    // has reported at that hour yet.
    const obs = Object.fromEntries((ACTUAL_WAITS[slug] || []).map((a) => [a.hour, a]));
    const rows = [['park', 'crowd_level', 'crowd_label', 'hour_local', 'median_posted_min', 'p25_min', 'p75_min', 'readings', 'reported_actual_min', 'reports']];
    for (const [lvl, pts] of Object.entries(levels)) {
      for (const pt of pts) {
        const a = obs[pt.hour];
        rows.push([PARKS[slug].name, lvl, FORECAST_LEVELS[lvl], pt.hour, pt.median, pt.low, pt.high, pt.n,
          a ? a.actual : '', a ? a.n : '']);
      }
    }
    // Quote every field: park names contain commas and apostrophes.
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${slug}-wait-curve.csv"`,
      'cache-control': 'public, max-age=3600',
    });
    return res.end(csv);
  }

  // Wait-by-crowd-level bands. Public: this is the asset people link to.
  // What's closed at a park right now — detected from the feed, free, no gate.
  const closedMatch = url.pathname.match(/^\/api\/closures\/([a-z0-9-]+)$/);
  if (closedMatch) {
    const slug = closedMatch[1];
    if (!PARKS[slug]) return sendJson(res, 404, { error: 'unknown park' });
    const c = CLOSURES[slug] || null;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=1800' });
    return res.end(JSON.stringify({
      park: PARKS[slug].name,
      observedTo: c?.observedTo || null,
      minDays: 3,
      closed: (c?.rides || []).filter((r) => r.current),
      recentlyReopened: (c?.rides || []).filter((r) => !r.current).slice(0, 8),
    }));
  }

  const bandsMatch = url.pathname.match(/^\/api\/bands\/([a-z0-9-]+)$/);
  if (bandsMatch) {
    const slug = bandsMatch[1];
    if (!PARKS[slug]) return sendJson(res, 404, { error: 'unknown park' });
    const rides = CROWD_BANDS[slug] || [];
    return sendJson(res, 200, {
      park: PARKS[slug].name,
      levels: FORECAST_LEVELS.slice(1),
      rides,
      ...(rides.length ? {} : { note: 'Not enough recorded days yet for this park.' }),
    });
  }

  // SEO surface: server-rendered park pages + sitemap + robots.
  if (url.pathname === '/accuracy') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' });
    return res.end(pages.renderAccuracyPage(ACCURACY, PARKS));
  }

  if (url.pathname === '/parks' || url.pathname === '/parks/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' });
    return res.end(pages.renderParksIndex(REGISTRY));
  }
  // Free crowd calendar, one indexable page per park. Matched before the park
  // page so the longer path wins.
  const calPage = url.pathname.match(/^\/parks\/([a-z0-9-]+)\/calendar\/?$/);
  if (calPage) {
    const park = PARKS[calPage[1]];
    if (!park) return sendJson(res, 404, { error: 'unknown park' });
    const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    // A full year: trip planning happens months out, and the model -- weekday
    // pattern, seasonal months, holiday table -- projects that far honestly,
    // with the page saying what degrades with distance.
    const days = forecastFor(park.slug, 365).days;
    let best = null;
    try { best = bestParkByDate(park.slug, 365); } catch (err) { console.log(`best-park (${park.slug}): ${err.message}`); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' });
    return res.end(pages.renderCalendarPage(park, days, best, REGISTRY, origin));
  }

  const parkPage = url.pathname.match(/^\/parks\/([a-z-]+)$/);
  if (parkPage) {
    const park = PARKS[parkPage[1]];
    if (!park) return sendJson(res, 404, { error: 'unknown park' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' });
    return res.end(pages.renderParkPage(park, SAMPLE[park.slug] || null, REGISTRY, CROWD_BANDS[park.slug] || null, HOURLY_CURVES[park.slug] || null, ACTUAL_WAITS[park.slug] || null, CLOSURES[park.slug] || null));
  }
  // Premade touring plans: the free library. /plans hub, per-park index,
  // one page per persona, and the JSON the app's deep link consumes.
  if (url.pathname === '/plans') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' });
    return res.end(pages.renderPlansHub(REGISTRY, premade.PERSONAS));
  }
  const plansParkMatch = url.pathname.match(/^\/plans\/([a-z-]+)$/);
  if (plansParkMatch) {
    const park = PARKS[plansParkMatch[1]];
    if (!park) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); return res.end(pages.renderNotFoundPage()); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' });
    return res.end(pages.renderParkPlansPage(park, await premadeIndexFor(park.slug), REGISTRY));
  }
  const plansOneMatch = url.pathname.match(/^\/plans\/([a-z-]+)\/([a-z-]+)$/);
  if (plansOneMatch) {
    const park = PARKS[plansOneMatch[1]];
    const plan = park && await premadePlan(park.slug, plansOneMatch[2]);
    if (!plan) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); return res.end(pages.renderNotFoundPage()); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' });
    return res.end(pages.renderPremadePlanPage(park, plan, await premadeIndexFor(park.slug), REGISTRY));
  }
  const premadeApiMatch = url.pathname.match(/^\/api\/premade\/([a-z-]+)\/([a-z-]+)$/);
  if (premadeApiMatch) {
    const plan = PARKS[premadeApiMatch[1]] && await premadePlan(premadeApiMatch[1], premadeApiMatch[2]);
    if (!plan) return sendJson(res, 404, { error: 'no such plan' });
    return sendJson(res, 200, plan);
  }

  if (url.pathname === '/sitemap.xml' || url.pathname === '/robots.txt') {
    const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    const isMap = url.pathname === '/sitemap.xml';
    res.writeHead(200, { 'content-type': isMap ? 'application/xml' : 'text/plain', 'cache-control': 'public, max-age=86400' });
    if (APP_ENV !== 'production') {
      return res.end(isMap ? '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>' : 'User-agent: *\nDisallow: /\n');
    }
    return res.end(isMap ? pages.renderSitemap(origin, REGISTRY.map((p) => p.slug), REGISTRY.map((p) => ({ slug: p.slug, personas: premade.PERSONAS.filter((x) => !x.needsTags).map((x) => x.slug) }))) : pages.renderRobots(origin));
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
    if (rideInfoBlocked(clientIp(req))) return sendJson(res, 429, { error: 'slow down' });
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
    // Per-park dining pages: the resort-wide link dumps every restaurant in
    // the whole resort, which is useless when you're standing in one park.
    const RESERVE_PARK = {
      'magic-kingdom': 'https://disneyworld.disney.go.com/dining/magic-kingdom/',
      'epcot': 'https://disneyworld.disney.go.com/dining/epcot/',
      'hollywood-studios': 'https://disneyworld.disney.go.com/dining/hollywood-studios/',
      'animal-kingdom': 'https://disneyworld.disney.go.com/dining/animal-kingdom/',
      'disneyland': 'https://disneyland.disney.go.com/dining/disneyland/',
      'california-adventure': 'https://disneyland.disney.go.com/dining/disney-california-adventure/',
      'disneyland-paris': 'https://www.disneylandparis.com/en-usd/restaurants/disneyland-park/',
      'walt-disney-studios-paris': 'https://www.disneylandparis.com/en-usd/restaurants/walt-disney-studios-park/',
      'tokyo-disneyland': 'https://www.tokyodisneyresort.jp/en/tdl/restaurant.html',
      'tokyo-disneysea': 'https://www.tokyodisneyresort.jp/en/tds/restaurant.html',
    };
    const groupReserve = RESERVE[park.group] || null;
    const reserve = groupReserve
      ? { ...groupReserve, url: RESERVE_PARK[slug] || groupReserve.url, scoped: Boolean(RESERVE_PARK[slug]) }
      : null;
    const cached = db.dining.get(slug, langCode);
    if (cached) return sendJson(res, 200, { park: park.name, reserve, list: JSON.parse(cached) });
    if (!consultant.enabled()) return sendJson(res, 503, { error: 'not available' });
    // First visit for this park+language: generate in the background and tell
    // the client to poll. Nobody stares at a spinner tied to a model call, and
    // concurrent visitors share one generation instead of stampeding it.
    const jobKey = `${slug}|${langCode}`;
    if (!diningJobs.has(jobKey)) {
      if (rideInfoBlocked(clientIp(req))) return sendJson(res, 429, { error: 'slow down' });
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
  // Park weather — public, same access rules as live waits.
  const weatherMatch = url.pathname.match(/^\/api\/weather\/([a-z-]+)$/);
  if (weatherMatch) {
    const park = PARKS[weatherMatch[1]];
    if (!park) return sendJson(res, 404, { error: 'unknown park' });
    if (!park.lat || !park.lng) return sendJson(res, 200, { unavailable: true });
    try {
      return sendJson(res, 200, await getWeather(park));
    } catch (err) {
      console.log(`weather (${park.slug}): ${err.message}`);
      return sendJson(res, 200, { unavailable: true });
    }
  }

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
      // Tags cached before the single-rider, land or shelter fields existed
      // regenerate once.
      const fresh = Object.values(parsed).some((t) => t && typeof t === 'object' && 'sr' in t && 'land' in t && 'in' in t && 'hmin' in t);
      if (fresh) return sendJson(res, 200, { tags: parsed });
    }
    if (!consultant.enabled()) return sendJson(res, 503, { error: 'not available' });
    if (rideInfoBlocked(clientIp(req))) return sendJson(res, 429, { error: 'slow down' });
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
    // Planning ahead is a pass feature: without one the horizon clamps to the
    // 7-day strip. Server-side — the year calendar must not be scrapeable by
    // pointing the free API at day 365.
    const askedDays = url.searchParams.get('days');
    const horizon = hasAccess(req) ? askedDays : Math.min(Number(askedDays) || 7, 7);
    return sendJson(res, 200, forecastFor(slug, horizon));
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
        const stops = sanitizeStops(parsed.stops);
        if (!stops.some((st) => st.name)) return sendJson(res, 400, { error: 'no plan to send' });
        if (planMailBlocked(sess.email)) return sendJson(res, 429, { error: 'you have sent a few plans already today — try again tomorrow' });

        const profileForKpi = sanitizeProfile(parsed.profile) || (db.daystate.get(sess.email) || {}).profile || null;
        const kpis = await planKpis(park, stops, profileForKpi);
        const savedMin = Number.isFinite(parsed.savedMin) ? Math.max(0, Math.round(parsed.savedMin)) : 0;
        const profile = profileForKpi;
        const lang = LANG_NAMES[typeof parsed.lang === 'string' ? parsed.lang : 'en'] || 'English';
        // Date the email for the day being planned, not the day it is sent.
        // A plan built for Wednesday and headed "Monday" is wrong twice over:
        // in the header the reader sees, and in the note the model writes.
        const planDateRaw = typeof parsed.planDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.planDate) ? parsed.planDate : null;
        const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: planDateRaw ? 'UTC' : park.tz });
        const day = dayFmt.format(planDateRaw ? new Date(`${planDateRaw}T12:00:00Z`) : new Date());
        // A plan for a future day must not speak in the present tense: the
        // "advantage" card compares against queues live at SEND time, which
        // says nothing about the day being planned — drop it, and tell both
        // the template and the model which tense they are writing in.
        const todayAtPark = new Intl.DateTimeFormat('en-CA', { timeZone: park.tz }).format(new Date());
        const future = Boolean(planDateRaw && planDateRaw > todayAtPark);
        if (future) kpis.dodged = null;

        let briefing = '';
        if (consultant.enabled()) {
          try {
            briefing = await consultant.dayBriefing({ parkName: park.name, group: park.group, day, future, stops, kpis, profile, savedMin, lang });
          } catch (err) { console.log(`day briefing failed: ${err.message}`); }
        }
        const firstName = db.users.get(sess.email)?.name || null;
        const html = planEmailHtml({ park, day, stops, kpis, savedMin, briefing, profile, firstName, future });
        try {
          // "18 attractions, 0 km" went out to a real inbox: the km figure is
          // only real when the route was actually measured. Lead with the two
          // numbers that always are.
          const firstRide = stops.find((st) => st.name && st.time);
          const subject = `Your ${park.name} plan${future ? ` for ${day.split(',')[0]}` : ''} — ${kpis.attractions} attractions${kpis.mapped ? `, ${kpis.km} km` : firstRide ? `, first ride ${firstRide.time}` : ''}`;
          const r = await sendEmail(sess.email, subject, html,
            `Plan email for ${sess.email}: ${park.name}, ${kpis.attractions} stops`);
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
          // Whitelisted like everything else: a plain date or nothing.
          planDate: typeof d.planDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.planDate) ? d.planDate : null,
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
          const asked = cleanFirstName(parsed.name);
          if (existing) {
            // Unfinished signup (never verified): treat this as a retry —
            // take the new password and send a fresh code. Whoever controls
            // the inbox wins, so an unverified squat can't lock anyone out.
            db.users.setPassword(email, salt, hashPassword(password, salt));
          } else {
            db.users.create(email, salt, hashPassword(password, salt), 0);
          }
          db.users.setName(email, asked.name);
          startVerification(email);
          return sendJson(res, 200, { pending: true, email, ...(asked.profane && { nameNote: NAME_NOTE }) });
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
          name: fresh.name || null,
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
          name: fresh.name || null,
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

      // Observed waits, reported by visitors. This is the one dataset here that
      // nobody else has, and the only one a stranger can write to -- so the bar for
      // accepting a report is deliberately higher than for reading anything.
      if (url.pathname === '/api/wait-report') {
        // Verified identity only. An open endpoint would collect more numbers and
        // fewer facts: this becomes a published dataset, and one script could bend
        // a ride's whole curve. A session or a valid pass is the bar.
        const sess = sessionUser(req);
        const pass = passFromReq(req);
        if (!sess && !pass) return sendJson(res, 401, { error: 'sign in to report a wait' });
        const reporter = sess ? `u:${sess.email}` : `p:${crypto.createHash('sha256').update(String(req.headers['x-pass'])).digest('base64url').slice(0, 32)}`;

        const park = PARKS[parsed.park] ? parsed.park : null;
        if (!park) return sendJson(res, 400, { error: 'unknown park' });
        const ride = typeof parsed.ride === 'string' ? parsed.ride.slice(0, 120).trim() : '';
        if (!ride) return sendJson(res, 400, { error: 'which ride?' });
        // Number(null) is 0, and so are Number(''), Number(false) and Number([]).
        // Taking the coercion at face value recorded every one of those as a
        // genuine nought-minute wait -- silent false zeros in the one dataset
        // here that gets published as authoritative. Require an actual number
        // or a numeric string, and nothing else.
        const rawActual = parsed.actual;
        const numeric = typeof rawActual === 'number'
          || (typeof rawActual === 'string' && rawActual.trim() !== '' && Number.isFinite(Number(rawActual)));
        const actual = numeric ? Number(rawActual) : NaN;
        // A queue longer than four hours is a data-entry slip far more often than
        // it is a queue; rejecting it here keeps the aggregate clean without
        // needing to guess at intent later.
        if (!Number.isFinite(actual) || actual < 0 || actual > 240) {
          return sendJson(res, 400, { error: 'give a wait between 0 and 240 minutes' });
        }
        // Twenty a day is far above honest use and far below what spam needs.
        if (db.waitreports.countBy(reporter, new Date(Date.now() - 86400000).toISOString()) >= 20) {
          return sendJson(res, 429, { error: "that's a lot of reports for one day — try again tomorrow" });
        }

        // Pair the report with what the sign said at that moment. Without the
        // posted figure there is nothing to measure the gap against, and asking
        // the client for it would let the client decide the answer.
        let posted = null;
        try {
          const waits = await getWaits(park);
          const match = waits.rides.find((r) => normName(r.name) === normName(ride));
          if (match && match.open && Number.isFinite(match.wait)) posted = match.wait;
        } catch {}

        const nowPark = new Date().toLocaleString('en-US', { timeZone: PARKS[park].tz, hour12: false });
        const hour = new Date(nowPark).getHours();
        const day = new Date().toLocaleDateString('en-CA', { timeZone: PARKS[park].tz });
        try {
          db.waitreports.add({ park, ride, rideKey: normName(ride), actual: Math.round(actual), posted, hour, day, reporter });
          // Cheap enough to redo per report, and it means a park crossing the
          // publication threshold lights up within the hour rather than at the
          // next six-hourly baseline pass.
          refreshActualWaits();
        } catch (err) {
          console.log(`wait report failed: ${err.message}`);
          return sendJson(res, 500, { error: 'could not save that' });
        }
        return sendJson(res, 200, {
          ok: true,
          posted,
          ...(posted != null ? { delta: Math.round(actual) - posted } : {}),
        });
      }

      if (url.pathname === '/api/consultant') {
        if (!consultant.enabled()) return sendJson(res, 503, { error: 'consultant not configured' });
        // Free tier: exactly ONE consultant call per day — the review that
        // rides along with the single free "Plan my day" — and only for the
        // free park, only about today. Everything else is 402. Server-side,
        // because a hidden button is not a limit.
        if (!hasAccess(req)) {
          const freePark = typeof parsed.park === 'string' && parsed.park === FREE_PARK;
          const today = !(typeof parsed.planDate === 'string' && parsed.planDate);
          if (!freePark || !today) return sendJson(res, 402, { error: 'pass required' });
          const fkey = throttleIdentity(req).slice(0, 64);
          const fday = etNow().date;
          if (FREE_CONSULT.get(fkey) === fday) {
            return sendJson(res, 402, { error: 'My wand only grants one free wish a day ✨ With a ParkPulse pass, the magic never runs out — unlimited plans, every park, and me by your side all day.' });
          }
          FREE_CONSULT.set(fkey, fday);
          if (FREE_CONSULT.size > 20000) FREE_CONSULT.clear(); // bounded memory
        }
        const { park, messages, favorites, planPicks, subscription } = parsed;
        // Group profile from the setup wizard — whitelisted, never trusted raw.
        const profile = sanitizeProfile(parsed.profile);
        const done = strList(parsed.done, 40);
        // Which day the user is actually planning. Accepted only as a plain
        // date and only if it is a day the forecast covers, so a client cannot
        // steer the advisor to an arbitrary string.
        const planDateRaw = typeof parsed.planDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.planDate) ? parsed.planDate : null;
        const arrive = Number.isFinite(Number(parsed.arrive)) ? Number(parsed.arrive) : null;
        const leave = Number.isFinite(Number(parsed.leave)) ? Number(parsed.leave) : null;
        const lang = Object.values(LANG_NAMES).includes(parsed.lang) ? parsed.lang : 'English';
        if (!PARKS[park]) return sendJson(res, 400, { error: 'unknown park' });
        // Throttle per verified pass, then verified account, then client IP.
        if (consultant.throttled(throttleIdentity(req).slice(0, 64))) {
          return sendJson(res, 429, { error: "You've hit the consultant limit for now — try again in a few hours." });
        }
        try {
          const waits = await getWaits(park);
          const fc = (() => { try { return forecastFor(park, 120); } catch { return null; } })();
          if (fc) waits.forecast = { ...fc, days: fc.days.slice(0, 7) };
          try { waits.weather = await getWeather(PARKS[park]); } catch {}
          // Attach the planned day itself — its crowd level, and its weather
          // where the forecast reaches that far. Everything downstream keys off
          // this rather than re-deriving "today".
          const today = new Date().toLocaleDateString('en-CA', { timeZone: PARKS[park].tz });
          const planDay = planDateRaw && fc ? fc.days.find((d) => d.date === planDateRaw) : null;
          if (planDay) {
            waits.planDay = {
              ...planDay,
              isToday: planDay.date === today,
              weather: (waits.weather?.days || []).find((w) => w.date === planDay.date) || null,
              arrive, leave,
            };
          }
          waits.today = today;
          waits.events = eventsFor(park, planDay ? planDay.date : today);
          // Shelter tags (indoor/covered/outdoor) from the cached classification
          // so weather routing names real air-conditioned rides. Cache only --
          // a consult must never wait on a classification call; without tags the
          // advisor falls back to its own knowledge, as before.
          try { waits.tags = JSON.parse(db.ridetags.get(park) || 'null') || undefined; } catch {}
          waits.closures = (CLOSURES[park]?.rides || []).filter((r) => r.current).slice(0, 12);
          const s = sessionUser(req);
          const firstName = s ? (db.users.get(s.email)?.name || null) : null;
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
              park: PARKS[park], waits, name: firstName, messages, favorites, planPicks, profile, done,
              subscription: subscription && typeof subscription.endpoint === 'string' ? subscription : null,
              email: s?.email || null,
              memory: s ? db.advisor.getMemory(s.email) : null,
              trip: s ? db.trips.get(s.email) : null,
              lang,
              send,
            });
          } catch (err) {
            failed = true;
            // Log the whole shape -- status and type are what distinguish a
            // dead key from an exhausted balance from a rate limit, and
            // "having a moment" told nobody anything.
            const status = err.status || err.statusCode || null;
            console.log(`consultant error: status=${status ?? 'none'} type=${err.type || err.name || 'unknown'} msg=${err.message}`);
            const friendly = err.code === 'bad_request' ? 'invalid messages'
              : status === 401 || status === 403 ? "Mila's key isn't being accepted right now — the operator has been told."
              : status === 429 ? 'Mila is at her limit for the moment — try again shortly.'
              : status === 400 && /credit|balance|quota/i.test(err.message || '') ? "Mila's account needs topping up — the operator has been told."
              : status >= 500 ? 'The advisor service is having trouble — try again shortly.'
              : 'The consultant is having a moment — try again shortly.';
            send('error', { error: friendly });
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

      // Save (or update) the plan for one park+date on the account. Written
      // by the app on every build for logged-in users, so the library and
      // the night-before email always see the latest version.
      if (url.pathname === '/api/plans') {
        const s2 = sessionUser(req);
        if (!s2) return sendJson(res, 401, { error: 'log in to save plans' });
        const park = PARKS[parsed.park] ? parsed.park : null;
        const date = typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null;
        if (!park || !date) return sendJson(res, 400, { error: 'invalid plan' });
        const stops = sanitizeStops(parsed.stops);
        if (!stops.some((st) => st.name)) return sendJson(res, 400, { error: 'empty plan' });
        const savedMin = Number.isFinite(parsed.savedMin) ? Math.max(0, Math.round(parsed.savedMin)) : 0;
        if (db.plans.list(s2.email).length >= 40 && !db.plans.get(s2.email, park, date)) {
          return sendJson(res, 400, { error: 'plan library is full — delete a few old ones' });
        }
        db.plans.set(s2.email, park, date, JSON.stringify(stops), savedMin);
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/api/plans/delete') {
        const s2 = sessionUser(req);
        if (!s2) return sendJson(res, 401, { error: 'not logged in' });
        if (!PARKS[parsed.park] || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date || '')) return sendJson(res, 400, { error: 'invalid' });
        db.plans.remove(s2.email, parsed.park, parsed.date);
        return sendJson(res, 200, { ok: true });
      }
      // Set (or fix) the account's first name after signup — the wizard asks
      // when it doesn't know one. Same profanity kindness as signup.
      if (url.pathname === '/api/account/name') {
        const s2 = sessionUser(req);
        if (!s2) return sendJson(res, 401, { error: 'not logged in' });
        const asked = cleanFirstName(parsed.name);
        db.users.setName(s2.email, asked.name);
        return sendJson(res, 200, { name: asked.name, ...(asked.profane && { nameNote: NAME_NOTE }) });
      }

      // Night-before plan emails on or off, per account.
      if (url.pathname === '/api/plans/evening-mail') {
        const s2 = sessionUser(req);
        if (!s2) return sendJson(res, 401, { error: 'not logged in' });
        db.users.setEveningMail(s2.email, parsed.on ? 1 : 0);
        return sendJson(res, 200, { ok: true, on: Boolean(parsed.on) });
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
        if (feedbackBlocked(clientIp(req))) return sendJson(res, 429, { error: 'slow down' });
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

// A deployment can look completely healthy while silently losing every account
// on each redeploy. Print the two settings that decide that, at boot, where
// the platform's own log viewer will show them.
function bootBanner() {
  const lines = [`ParkPulse running on http://localhost:${PORT}`];
  // The default lives inside the repo, which on a container platform means
  // inside the image: written on every boot, gone on every redeploy.
  const persistent = !db.DB_FILE.startsWith(path.join(__dirname, 'data'));
  lines.push(`  database    ${db.DB_FILE}${persistent ? ' (persistent)' : ''}`);
  if (!persistent) {
    lines.push('  !! EPHEMERAL — this path is inside the container image. Every');
    lines.push('     redeploy destroys all accounts, passes, alerts and trips.');
    lines.push('     Mount a volume and set DB_FILE=/data/parkpulse.db');
  }
  // The archive is what the crowd forecast learns from, and its absence is
  // invisible: the forecast still renders, just from a hardcoded prior.
  const h = history.stats();
  const histPersistent = !history.HISTORY_DIR.startsWith(path.join(__dirname, 'data'));
  lines.push(`  history     ${history.HISTORY_DIR}${histPersistent ? ' (persistent)' : ''} — ${h.files} day${h.files === 1 ? '' : 's'}, ${(h.bytes / 1024).toFixed(0)}KB`);
  if (!histPersistent) {
    lines.push('  !! wait history is EPHEMERAL — day-of-week crowd factors reset');
    lines.push('     to a hardcoded prior on every redeploy.');
  } else if (h.files < 21) {
    lines.push(`     day-of-week factors reach full weight at 21 days (${21 - h.files} to go).`);
  }
  lines.push(process.env.PASS_SECRET
    ? '  PASS_SECRET set'
    : '  !! PASS_SECRET unset — a fresh random key is generated each boot, so\n     every issued pass stops validating on restart. Set a permanent one.');
  console.log(lines.join('\n'));
}

refreshAccuracy();

server.listen(PORT, bootBanner);
