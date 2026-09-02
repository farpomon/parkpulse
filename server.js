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
const oauth = require('./oauth');
const pages = require('./pages');
const premade = require('./premade');
const history = require('./history');
const db = require('./db');

const PORT = process.env.PORT || 3000;
// Environment tag: 'production' (default) or 'dev'. Dev deployments show a
// DEV badge in the app and are hidden from search engines so the dev URL
// never competes with production in Google.
const APP_ENV = process.env.APP_ENV === 'dev' ? 'dev' : 'production';
// The pre-launch strip. On by default in production and off on dev, because
// "coming soon" is a message for visitors, not for us. COMING_SOON=0 takes it
// down on launch day without a deploy; COMING_SOON=1 puts it on dev to look at
// it. Whichever way it resolves is reported by /api/admin/ops, so a launched
// product cannot quietly keep telling people it has not launched.
const COMING_SOON = process.env.COMING_SOON === '1'
  || (process.env.COMING_SOON !== '0' && APP_ENV === 'production');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

// Stripe Payment Link for the Trip Pass — set in the hosting env, no backend needed for v0.
const PAYMENT_LINK = process.env.PAYMENT_LINK || '';
// Launch-preview switch: everything is free until PRO_GATE=on is set in the
// hosting env, which re-locks Pro features (all parks, planner, alerts).
const PRO_GATE = process.env.PRO_GATE === 'on';
// Which Terms a signup is agreeing to. Taken from the effective date printed
// on /terms itself, so the recorded version and the text a reader saw cannot
// drift apart -- a stored "v1" nobody can map back to a particular wording
// proves nothing later.
// The exact sentence a marketing opt-in is consent TO. Stored alongside the
// answer, because consent is to a particular wording and wordings change --
// "they ticked a box once" is not a record, "they ticked THIS on THAT day" is.
const MARKETING_WORDING = 'Send me occasional news about ParkPulse — new parks, features and offers. You can stop any time.';
const TERMS_VERSION = (() => {
  try {
    const m = fs.readFileSync(path.join(PUBLIC_DIR, 'terms.html'), 'utf8').match(/class="date">Effective ([^<]+)</);
    return m ? m[1].trim() : 'unversioned';
  } catch { return 'unversioned'; }
})();
const FREE_PARK = 'magic-kingdom';

// --- Passes & Stripe checkout ------------------------------------------------
// A pass is a self-contained HMAC-signed token {plan, exp} issued after a paid
// Stripe Checkout session (or via the developer code). No accounts needed.
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
// The pass ladder. Prices are display-only — Stripe Prices (created in the
// Stripe dashboard, ids passed via env) are the source of truth for billing.
// Sold by the shape of a holiday, not by the calendar. Nobody plans "a month
// of theme parks" -- they plan nine days -- and the old week/month/six-month
// ladder made every buyer translate a trip into a duration, which landed them
// on Month whether they needed thirty days or twelve.
const PLAN_CATALOG = [
  { id: 'day-pass', days: 1, usd: '6.99', label: 'Day Pass', per: '1 day' },
  { id: 'trip-pass', days: 10, usd: '17.99', label: 'Trip Pass', per: '10 days', badge: 'MOST POPULAR' },
  { id: 'season-pass', days: 90, usd: '29.99', label: 'Season Pass', per: '90 days' },
  { id: 'year-pass', days: 365, usd: '49.99', label: 'Annual Pass', per: '12 months', badge: 'BEST VALUE' },
];
const STRIPE_PRICES = {
  'day-pass': process.env.STRIPE_PRICE_DAY || '',
  'trip-pass': process.env.STRIPE_PRICE_TRIP || '',
  'season-pass': process.env.STRIPE_PRICE_SEASON || '',
  'year-pass': process.env.STRIPE_PRICE_YEAR || '',
  // Retired plans — kept resolvable so an env var set for one still works, and
  // so a buyer re-activating an old purchase on a new device still checks out.
  'week-pass': process.env.STRIPE_PRICE_WEEK || '',
  'month-pass': process.env.STRIPE_PRICE_MONTH || '',
  'half-year-pass': process.env.STRIPE_PRICE_HALFYEAR || '',
  'pro-annual': process.env.STRIPE_PRICE_ANNUAL || '',
};
// The secret key alone is enough to sell: plans without a dashboard Price id
// are sent to Checkout as inline price_data from the catalog above. Setting
// STRIPE_PRICE_* env vars remains supported and takes precedence per plan.
const CHECKOUT_ENABLED = Boolean(STRIPE_KEY);
// More time with Mila, for somebody who has used their day's allowance and
// wants to carry on. Sold as dollars of her attention rather than as a number
// of questions, because that is what it actually is -- and it means a short
// question costs them less than a long one, which is the honest way round.
const MILA_TOPUP_PRICE = process.env.STRIPE_PRICE_MILA_TOPUP || '';
const MILA_TOPUP_USD = Number(process.env.MILA_TOPUP_USD || 2.00);      // credit granted
const MILA_TOPUP_LABEL = process.env.MILA_TOPUP_LABEL || 'More time with Mila';
const MILA_TOPUP_ENABLED = Boolean(STRIPE_KEY && MILA_TOPUP_PRICE);
// MUST be set in production — the ephemeral default invalidates all passes on restart.
const PASS_SECRET = process.env.PASS_SECRET || crypto.randomBytes(32).toString('hex');
// Developer bypass: redeeming this exact code in the app grants a 10-year pass.
const DEV_PASS_CODE = process.env.DEV_PASS_CODE || '';
// Legacy plan ids stay valid so previously issued passes keep working.
// Retired ids stay here so passes already in the wild keep validating. The
// duration only matters when a pass is ISSUED -- an existing one carries its
// own expiry in the token and on the account -- so a plan that is no longer
// sold needs its entry to exist, not to be right about the future.
//
// One deliberate collision: 'trip-pass' was a retired 30-day v0 plan and is now
// the 10-day tier. Tokens already issued keep their baked-in expiry and stay
// valid; the only path that would shorten anyone is re-claiming a v0 Stripe
// session on a new device, on a plan that has not been sold since v0.
const RETIRED_DAYS = { 'week-pass': 7, 'month-pass': 30, 'half-year-pass': 182, 'pro-annual': 365, 'dev': 3650, 'comp': 365 };
const RETIRED_LABELS = { 'week-pass': 'Week Pass', 'month-pass': 'Month Pass', 'half-year-pass': '6-Month Pass', 'pro-annual': 'Pro Annual', 'dev': 'Dev Pass', 'comp': 'Guest Pass' };
const PLAN_DAYS = Object.assign(Object.create(null), RETIRED_DAYS, Object.fromEntries(PLAN_CATALOG.map((p) => [p.id, p.days])))
const PLAN_LABELS = Object.assign(Object.create(null), RETIRED_LABELS, Object.fromEntries(PLAN_CATALOG.map((p) => [p.id, p.label])))

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

// Which accounts this process has already written down as seen today, so an
// active visitor costs one insert a day rather than one per request.
const seenToday = new Set();
function markSeen(email) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${email}|${day}`;
  if (seenToday.has(key)) return;
  seenToday.add(key);
  if (seenToday.size > 20000) seenToday.clear();   // a new day, or a big one
  try { db.admin.seen(email, day); } catch {}
}

function sessionUser(req) {
  const p = verifyToken(req.headers['x-session']);
  if (!p?.email || !p.sid) return null; // legacy stateless tokens are retired
  const row = db.sessions.get(p.sid);
  if (!row || row.email !== p.email) return null; // revoked or evicted
  if (Date.now() - new Date(row.last_seen).getTime() > 10 * 60 * 1000) db.sessions.touch(p.sid);
  const user = db.users.get(p.email);
  if (user) markSeen(p.email);
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
// Where providers send people back. Derived from the request by default,
// which is right for dev and prod alike; set it only when the app sits
// behind something that rewrites the host.
const OAUTH_REDIRECT_BASE = (process.env.OAUTH_REDIRECT_BASE || '').replace(/\/$/, '');

// What each upstream is actually doing, as opposed to what the logs say at
// 3am. Live-wait fetches fail quietly -- the board falls back to typical waits
// and nobody finds out -- so every outcome is written down here and shown on
// the dashboard. In memory: it describes this process, and a restart genuinely
// does reset what we know.
const upstream = {
  parks: Object.create(null),   // slug -> { source, at, okAt, error }
  note(slug, source, error) {
    const prev = upstream.parks[slug] || {};
    upstream.parks[slug] = {
      source, at: Date.now(), error: error || null,
      okAt: source === 'live' ? Date.now() : (prev.okAt || null),
    };
  },
  services: Object.create(null), // name -> { okAt, failAt, fails, error }
  service(name, ok, error) {
    const s = (upstream.services[name] ||= { okAt: null, failAt: null, fails: 0, error: null });
    if (ok) { s.okAt = Date.now(); s.fails = 0; s.error = null; }
    else { s.failAt = Date.now(); s.fails += 1; s.error = String(error || 'failed').slice(0, 160); }
  },
};


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
  // toddler and teen are retired but still arrive from profiles saved before
  // the wizard counted people; the client folds them into kid and adult, and
  // dropping them here would make an old phone's group read as empty.
  const AGES = ['toddler', 'kid', 'teen', 'adult', 'elderly'];
  const BANDS = ['kid', 'adult', 'elderly'];
  const VIBES = ['gentle', 'family', 'thrill', 'water', 'show'];
  const counts = (v) => {
    if (!v || typeof v !== 'object') return null;
    const out = {};
    for (const b of BANDS) out[b] = Math.max(0, Math.min(12, Math.floor(Number(v[b]) || 0)));
    return BANDS.some((b) => out[b] > 0) ? out : null;
  };
  return rawP && typeof rawP === 'object' ? {
    party: Number.isInteger(rawP.party) && rawP.party >= 1 && rawP.party <= 20 ? rawP.party : null,
    counts: counts(rawP.counts),
    ages: Array.isArray(rawP.ages) ? rawP.ages.filter((a) => AGES.includes(a)).slice(0, 5) : [],
    vibes: Array.isArray(rawP.vibes) ? rawP.vibes.filter((v) => VIBES.includes(v)).slice(0, 5) : [],
    onsite: typeof rawP.onsite === 'boolean' ? rawP.onsite : null,
    kids: Array.isArray(rawP.kids)
      ? rawP.kids.filter((k) => k && typeof k === 'object').slice(0, 8)
        .map((k) => ({ age: Math.max(0, Math.min(17, Number(k.age) || 0)), cm: Math.max(0, Math.min(200, Number(k.cm) || 0)) }))
      : [],
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
    excluded: strList(ds.excluded, 40),
    planPicks: strList(ds.picked, 30),
    done: strList(ds.done, 40),
    // Passes bought in the app. Without this the assistant on WhatsApp kept
    // recommending a Lightning Lane the visitor was already holding.
    lanePasses: strList(ds.lanePasses, 30),
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
    `<p>You've been given <b>full ParkPulse access for ${days} days</b> — live wait times for 65 parks worldwide, the AI day planner, and wait-drop alerts.</p>
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
<li>Your <b>magical fairy</b> answers anything — dining, skip-pass math, rainy-day backup plans.</li>
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
// First names are for greeting people, so they get greeted properly: Mila says
// the name out loud, puts it in her prompts and prints it atop the emailed
// plan. The screen itself lives in namecheck.js -- word lists, phrase matching
// and the non-Latin scripts are enough material to want their own file.
const { cleanFirstName, NAME_NOTE } = require('./namecheck');

function hasAccess(req) {
  if (!PRO_GATE) return true;
  if (passFromReq(req)) return true;
  const s = sessionUser(req);
  if (!s) return false;
  // Nobody buys a pass to look at their own product. Without this, the first
  // thing that happens after turning PRO_GATE on is that the owner is locked
  // out of every park but one -- from an account that can read the whole
  // admin dashboard, which makes it look like the gate is broken rather than
  // working. To see the paywall as a visitor does, sign out.
  if (s.user.verified && ADMIN_EMAILS.has(s.email)) return true;
  return accountPassActive(s.user);
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

// --- Rate limiting -----------------------------------------------------------
// Two scopes, deliberately lopsided.
//
// Strict on the account, because that is where abuse actually costs money: an
// advisor turn or a plan email is a paid model call, and an account is a thing
// somebody had to verify an address to get.
//
// Deliberately loose on the IP, because a theme park's public wifi puts every
// guest in the building behind one address. A limit tuned for one person would
// lock out an entire park mid-visit, which is a far worse failure than letting
// a script through -- so the IP ceilings here are set to catch automated
// floods and nothing else.
const buckets = new Map();          // "name|key" -> { n, resetAt }
// What got turned away, for the dashboard. Nothing is stored per person.
const rateBlocks = Object.create(null);   // name -> { n, at }

function overLimit(name, key, max, windowMs) {
  const id = `${name}|${key}`;
  const now = Date.now();
  const b = buckets.get(id);
  if (!b || now > b.resetAt) { buckets.set(id, { n: 1, resetAt: now + windowMs }); return false; }
  b.n += 1;
  if (b.n <= max) return false;
  const seen = (rateBlocks[name] ||= { n: 0, at: null });
  seen.n += 1; seen.at = now;
  return true;
}
// Buckets outlive their window; sweep occasionally so a long-running process
// does not accumulate one entry per address it has ever seen.
setInterval(() => {
  const now = Date.now();
  for (const [id, b] of buckets) if (now > b.resetAt) buckets.delete(id);
}, 10 * 60 * 1000).unref?.();

// Keyed on the account when there is one. An anonymous caller gets the loose
// IP ceiling instead of the strict account one -- never the other way round,
// or one park's wifi would share a single strict bucket.
function accountLimited(req, name, max, windowMs = 3600000) {
  const id = throttleIdentity(req);
  if (id.startsWith('i:')) return ipLimited(req, name, max * 20, windowMs);
  return overLimit(name, id, max, windowMs);
}
function ipLimited(req, name, max, windowMs = 3600000) {
  return overLimit(name, `i:${clientIp(req)}`, max, windowMs);
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

// Lookup tables indexed by request-supplied strings. Null-prototype, because a
// plain object answers to "constructor", "toString" and "__proto__" as though
// they were entries: LANG_NAMES['__proto__'] came back truthy, which sent
// '__proto__' into Intl.DateTimeFormat and took the process down with an
// unhandled RangeError. Object.create(null) has no inherited keys to find.
const LANG_NAMES = Object.assign(Object.create(null), { en: 'English', zh: 'Chinese', hi: 'Hindi', es: 'Spanish', fr: 'French', ar: 'Arabic', bn: 'Bengali', de: 'German', id: 'Indonesian', it: 'Italian', ja: 'Japanese', ko: 'Korean', mr: 'Marathi', pt: 'Portuguese', ru: 'Russian', ta: 'Tamil', te: 'Telugu', tr: 'Turkish', ur: 'Urdu', vi: 'Vietnamese'  })

const SAMPLE = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sample-waits.json'), 'utf8'));

// The same dictionaries the browser fetches from /i18n/<lang>.json, loaded here
// so anything the server composes on the reader's behalf can speak their
// language too. The plan email was the case that forced this: Mila's note
// inside it was already written in the recipient's language by the model, and
// every word around that note was hard-coded English.
//
// English keys, English fallback, exactly like the client's tr() -- a missing
// key degrades to English rather than to a blank.
const I18N = Object.create(null);
for (const code of Object.keys(LANG_NAMES)) {
  if (code === 'en') continue;
  try {
    I18N[code] = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'i18n', `${code}.json`), 'utf8'));
  } catch { /* a missing dictionary just means that language falls back to English */ }
}
const T = (lang) => {
  const dict = I18N[lang] || null;
  return (key) => (dict && dict[key]) || key;
};

// Each language named in its own language, for the landing page's list. A
// visitor scanning for their own is looking for the word they use, not the
// English name for it.
const LANG_NATIVE = {
  en: 'English', zh: '\u4e2d\u6587', hi: '\u0939\u093f\u0928\u094d\u0926\u0940', es: 'Espa\u00f1ol', fr: 'Fran\u00e7ais',
  ar: '\u0627\u0644\u0639\u0631\u0628\u064a\u0629', bn: '\u09ac\u09be\u0982\u09b2\u09be', de: 'Deutsch', id: 'Bahasa Indonesia', it: 'Italiano',
  ja: '\u65e5\u672c\u8a9e', ko: '\ud55c\uad6d\uc5b4', mr: '\u092e\u0930\u093e\u0920\u0940', pt: 'Portugu\u00eas', ru: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439',
  ta: '\u0ba4\u0bae\u0bbf\u0bb4\u0bcd', te: '\u0c24\u0c46\u0c32\u0c41\u0c17\u0c41', tr: 'T\u00fcrk\u00e7e', ur: '\u0627\u0631\u062f\u0648', vi: 'Ti\u1ebfng Vi\u1ec7t',
};
const RTL_LANGS = new Set(['ar', 'ur']);
// Sourced from the dictionaries that actually loaded, so the page cannot
// advertise a language the app no longer ships -- and a new one appears the
// day its file lands. English has no dictionary; it is the keys.
const APP_LANGS = Object.keys(LANG_NATIVE).filter((c) => c === 'en' || I18N[c]);
// Whole sentences with named holes, rather than clauses glued around a value.
// "{ride} is {n} min right now" survives translation into a language that puts
// the number first; `tr('is') + n + tr('min right now')` does not.
const fmt = (s, vals) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vals[k] != null ? vals[k] : m));

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
const PARKS = Object.assign(Object.create(null), Object.fromEntries(REGISTRY.map((p) => [p.slug, p])));
// Safe now that PARKS exists -- see the note beside refreshBaselines.
refreshBaselines();

// This function is the only thing standing between 52 of the 65 parks and a
// permanently empty board: they ship with `id: null` and get their queue-times
// id matched by name here. Two ways that used to fail silently, both of which
// cost a visitor the whole park:
//
//   * one failed fetch at boot meant no ids until the 24-hour interval came
//     round again -- a network blip on deploy cost a full day;
//   * a park whose tokens matched nothing was skipped without a word, and the
//     log said "Park ids resolved" either way.
//
// So: retry with backoff, and say exactly which parks did not resolve. The
// last result is kept for /qt-directory to render.
let qtResolution = { at: null, ok: false, matched: 0, unresolved: [], ambiguous: [], error: null };

async function resolveParkIds(attempt = 1) {
  try {
    const res = await fetch('https://queue-times.com/parks.json', { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const companies = await res.json();
    const all = companies.flatMap((c) => (c.parks || []).map((p) => ({
      id: p.id, name: p.name, company: c.name, haystack: normName(`${c.name} ${p.name}`),
    })));
    const allowed = (entry, p) => !(entry.exclude || []).some((t) => p.haystack.includes(normName(t)));
    const ambiguous = [], relaxed = [];
    let leftover = [], matched = 0;

    // Pass 1, strict: every token must appear.
    for (const entry of REGISTRY) {
      const candidates = all.filter((p) =>
        entry.tokens.every((t) => p.haystack.includes(normName(t))) && allowed(entry, p));
      if (!candidates.length) { leftover.push(entry); continue; }
      // Shortest haystack wins: the least-qualified name is usually the park
      // itself rather than a sibling water park in the same resort.
      const pick = [...candidates].sort((a, b) => a.haystack.length - b.haystack.length)[0];
      entry.id = pick.id;
      matched += 1;
      // More than one match means the tokens are not specific enough and the
      // winner came down to name length. Worth knowing before it quietly picks
      // the wrong park.
      if (candidates.length > 1) {
        ambiguous.push({ slug: entry.slug, chose: pick.name,
          over: candidates.filter((c) => c.id !== pick.id).map((c) => c.name) });
      }
    }

    // Every id now spoken for, including the static ones that pass 1 confirmed.
    // Two parks must never resolve to the same feed, and pass 2 leans on this.
    const claimed = new Set(REGISTRY.map((e) => e.id).filter((id) => id != null));

    // Pass 2, relaxed: a park listed WITHOUT the qualifier we search on --
    // "SeaWorld" where the registry says seaworld + orlando -- matches nothing
    // strictly and goes dark forever. So drop one token and try again, but only
    // accept when exactly one candidate survives AND no other park has claimed
    // it. Both conditions matter: the siblings ("SeaWorld San Diego") are
    // already claimed by their own entries, so the bare listing is the only one
    // left, and one unclaimed candidate cannot be a coin toss between parks.
    // Single-token entries are skipped -- dropping their only token matches the
    // entire directory.
    for (const entry of leftover) {
      if (entry.id != null || entry.tokens.length < 2) continue;
      const hits = new Map();
      for (let drop = 0; drop < entry.tokens.length; drop++) {
        const subset = entry.tokens.filter((_, i) => i !== drop);
        for (const p of all) {
          if (claimed.has(p.id)) continue;
          if (!allowed(entry, p)) continue;
          if (subset.every((t) => p.haystack.includes(normName(t)))) hits.set(p.id, p);
        }
      }
      if (hits.size !== 1) continue;
      const pick = [...hits.values()][0];
      entry.id = pick.id;
      claimed.add(pick.id);
      matched += 1;
      relaxed.push({ slug: entry.slug, chose: pick.name, company: pick.company, tokens: entry.tokens });
    }
    const unresolved = leftover.filter((e) => e.id == null);

    upstream.service('queue-times directory', true);
    qtResolution = {
      at: Date.now(), ok: true, matched, error: null,
      unresolved: unresolved.map((e) => ({ slug: e.slug, name: e.name, tokens: e.tokens })),
      ambiguous, relaxed,
    };
    console.log(`Park ids: ${matched}/${REGISTRY.length} resolved from the queue-times directory`);
    // Kept, so that the next boot does not depend on the directory being up.
    // It has answered 403 at boot more than once; without this, fifty-two of
    // the sixty-five parks had no id until the retry loop got through, and a
    // park with no id shows an empty board no matter how healthy its feed is.
    try { db.kv.set('qtids', JSON.stringify(Object.fromEntries(REGISTRY.filter((e) => e.id != null).map((e) => [e.slug, e.id])))); }
    catch (err) { console.log(`park ids: could not be kept (${err.message})`); }
    if (unresolved.length) {
      console.log(`  UNRESOLVED (${unresolved.length}) — these parks will show an empty board: ${unresolved.map((e) => e.slug).join(', ')}`);
    }
    for (const r of relaxed) {
      console.log(`  relaxed match: ${r.slug} (${r.tokens.join(' + ')}) -> "${r.chose}" under "${r.company}" — verify this is the right park`);
    }
    for (const a of ambiguous) {
      console.log(`  ambiguous: ${a.slug} matched ${a.over.length + 1} parks, chose "${a.chose}" over ${a.over.map((n) => `"${n}"`).join(', ')}`);
    }
  } catch (err) {
    qtResolution = { ...qtResolution, at: Date.now(), ok: false, error: err.message };
    upstream.service('queue-times directory', false, err.message);
    // 1, 2, 4, 8, then 15-minute ceiling: about 45 minutes of trying before it
    // waits for the daily pass, instead of giving up on the first failure.
    const delay = Math.min(60_000 * 2 ** (attempt - 1), 15 * 60_000);
    const more = attempt < 6;
    console.log(`Park id resolution failed (${err.message}) — attempt ${attempt}${more ? `, retrying in ${Math.round(delay / 1000)}s` : ', giving up until the daily pass'}`);
    if (more) {
      const t = setTimeout(() => resolveParkIds(attempt + 1), delay);
      if (typeof t.unref === 'function') t.unref();
    }
  }
}
// The ids the last successful resolution found, applied before the first
// live attempt. Only fills gaps: a static id in the registry and a fresh live
// answer both outrank a remembered one.
function applyStoredIds() {
  let stored = null;
  try { stored = JSON.parse(db.kv.get('qtids') || 'null'); } catch { return 0; }
  if (!stored || typeof stored !== 'object') return 0;
  let applied = 0;
  for (const entry of REGISTRY) {
    if (entry.id == null && Number.isInteger(stored[entry.slug])) { entry.id = stored[entry.slug]; applied += 1; }
  }
  if (applied) console.log(`Park ids: ${applied} restored from the last successful resolution`);
  return applied;
}
applyStoredIds();
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
  upstream.service('open-meteo weather', res.ok, res.ok ? null : `HTTP ${res.status}`);
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

// Fingerprint of everything that reaches Mila's prompt for one plan review.
// Two requests that hash the same would have produced the same reply, so the
// second can replay the first instead of buying it again.
//
// Live wait times are deliberately absent: they move every few minutes, and
// keying on them would mean the cache never hit. Staleness is bounded by the
// TTL the caller passes instead. List inputs are sorted -- the same set of
// picks in a different order is the same information, and leaving the order in
// would miss hits for nothing.
function planAdviceSig(parts) {
  const list = (v) => (Array.isArray(v) ? [...v].map(String).sort() : []);
  const canonical = JSON.stringify([
    parts.prompt, // retires every cached review when the advisor's instructions change
    parts.park, parts.day, parts.lang, parts.question,
    parts.profile || null, parts.name || null,
    list(parts.favorites), list(parts.excluded), list(parts.planPicks), list(parts.done), list(parts.lanePasses),
    parts.arrive, parts.leave,
    parts.memory || null, parts.trip || null,
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// How long a review stays good for. A plan for today is read against live
// queues, so it goes stale within the quarter hour. A plan for a future date
// has no live queues to be wrong about -- it is built on the forecast, which
// barely moves inside a day.
const ADVICE_TTL_TODAY = 15 * 60 * 1000;
const ADVICE_TTL_FUTURE = 12 * 60 * 60 * 1000;
// How far back the FAILURE path will reach for a read of the same plan. Longer
// than either window above on purpose: the choice there is between fresh
// advice and slightly older advice, and the answer is fresh. Here the choice
// is between older advice and no advice, and the answer is different. Bounded
// by the prune horizon, so nothing is served that the sweep has thrown away.
const ADVICE_TTL_STALE = 24 * 60 * 60 * 1000;

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
        // Only ever true: an absent flag must read as "riding together".
        ...(st.sr === true ? { sr: true } : {}),
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
  // Two different facts that must never be confused. singleRider counts what
  // the park OFFERS; srUsed counts what this plan actually banks on -- the
  // stops whose timings assume the party splits up. Only the second one is
  // grounds for warning anybody.
  // Unique rides, not stops -- an encore of the same headliner is one
  // attraction you ride alone, not two.
  const srRides = [...new Set(stops.filter((st) => st.name && st.sr === true).map((st) => st.name))];
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
    srRides,
    srUsed: srRides.length,
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

// Everything here is decoration the plan can survive without: the park's
// one-liner, the local tip, a bit of lore, and the forecast for the day being
// planned. Each piece degrades to an empty string rather than to an error, so
// a park with no seo entry or a day beyond the forecast still gets its email.
// The three flavour lines are authored in English in data/. The email chrome
// around them is translated from the dictionaries, so on a Portuguese plan
// they were the only English left on the page -- Mila greeting the reader in
// their language and then quoting herself in someone else's.
//
// They are translated once per park per language and kept, the same way the
// dining guide is: a handful of small calls that never repeat, rather than
// 195 hand-written strings times eighteen languages. English is always the
// fallback -- a missing translation must cost a reader the flavour, never the
// email.
async function planEmailFlavor(park, dateISO, langCode = 'en') {
  const flavor = {
    magic: PARK_MAGIC[park.slug] || '',
    tip: PARK_TIPS[park.slug] || '',
    fact: PARK_FACTS[park.slug] || '',
    weather: null,
  };
  if (langCode && langCode !== 'en' && LANG_NAMES[langCode]) {
    const src = {};
    for (const k of ['magic', 'tip', 'fact']) if (flavor[k]) src[k] = flavor[k];
    if (Object.keys(src).length) {
      let hit = null;
      try { hit = JSON.parse(db.parkflavor.get(park.slug, langCode) || 'null'); } catch {}
      // A cache entry written before a data/ edit would quietly serve the old
      // line for ever, so it only counts while it covers the same keys.
      const covers = hit && Object.keys(src).every((k) => typeof hit[k] === 'string' && hit[k]);
      if (covers) Object.assign(flavor, hit);
      else if (consultant.enabled()) {
        try {
          const out = await consultant.translateFlavor(park.name, LANG_NAMES[langCode], src);
          if (out) {
            db.parkflavor.set(park.slug, langCode, JSON.stringify(out));
            Object.assign(flavor, out);
          }
        } catch (err) { console.log(`flavor translate failed (${park.slug}/${langCode}): ${err.message}`); }
      }
    }
  }
  try {
    const w = await getWeather(park);
    flavor.weather = (w.days || []).find((d) => d.date === dateISO) || null;
  } catch {}
  return flavor;
}

function planEmailHtml({ park, day, dateIso = null, stops, kpis, savedMin, briefing, profile, firstName, future, flavor = {}, lang = 'en' }) {
  const t = T(lang);
  const f = (k, v) => fmt(t(k), v);
  const B = '#5b3df5';
  const INK = '#251d3d', MUTED = '#8b83a8', SOFT = '#f4f1ff';
  // The last one of these printed from Outlook came back with every astral
  // emoji as tofu or CJK mojibake -- the icons were the design. Nothing in
  // this email may depend on an emoji font again: icons are colored badges
  // built from tables and text, and astral characters are stripped from any
  // client-supplied string before it is interpolated.
  const noAstral = (v) => String(v ?? '').replace(/[\u{10000}-\u{10FFFF}]/gu, '').replace(/️/g, '').trim();
  // Every link back into the app names the park this plan is for. Bare /app
  // opens whichever park the device happened to be on last, which for anyone
  // planning more than one park is the wrong one -- a plan for Liseberg
  // landing on Magic Kingdom because that is where they were browsing.
  // ...and, for a plan built for a day that has not arrived yet, which day.
  // Without it the link restores the park and then quietly drops the reader
  // on today, so the plan they are reading and the plan on screen disagree.
  const APP = `https://www.parkpulse.fun/app${park.slug ? `?park=${encodeURIComponent(park.slug)}` : ''}`
    + (park.slug && future && /^\d{4}-\d{2}-\d{2}$/.test(String(dateIso || '')) ? `&amp;date=${dateIso}` : '');
  const E = (v) => esc(noAstral(v));
  // PNG, never webp: Outlook desktop renders webp as a broken-image icon, and
  // this email's whole cast is Mila. Absolute URLs — email clients have no
  // origin to resolve against.
  const MILA = (pose) => `https://www.parkpulse.fun/img/mila/${pose}.png`;
  const milaImg = (pose, size, ring) => `<img src="${MILA(pose)}" width="${size}" height="${size}" alt="Mila" style="border-radius:99px;display:block${ring ? `;border:3px solid ${ring}` : ''}">`;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  // Rotating high-spirit copy. Server-side pick: every plan email opens a
  // little differently, same as Mila does in the app.
  const HEADLINES = [
    'Cue the fireworks — your day is planned.',
    'One magical day, sequenced to the minute.',
    'Adventure called. Mila answered.',
    'The best day ever, now boarding.',
  ].map(t);
  const SIGNOFFS = [
    'My wand is charged and so is your plan — see you at the gates!',
    'The queues never saw you coming.',
    'Somewhere in that park, your new favourite memory is already waiting.',
    'Today is going to be one for the storybooks.',
  ].map(t);
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
  const BAND_LABEL = { MORNING: t('MORNING'), AFTERNOON: t('AFTERNOON'), EVENING: t('EVENING') };
  const BAND_SUB = { MORNING: t('rope drop pace — the short-line hours'), AFTERNOON: t('peak crowds — shows, meals, indoor rides'), EVENING: t('lines fade as the crowd drifts to dinner') };
  let rideNo = 0;
  let lastBand = null;
  const rowPieces = [];
  for (const st of stops) {
    const band = bandOf(hourOf(st.time));
    if (band && band !== lastBand) {
      lastBand = band;
      rowPieces.push(`<tr><td colspan="3" style="padding:14px 0 6px">
        <div style="border-left:3px solid ${B};padding:2px 0 2px 10px">
          <span style="font-size:11px;font-weight:800;letter-spacing:.1em;color:${B}">${BAND_LABEL[band]}</span>
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
        ${st.wait != null ? `<br><span style="color:${MUTED};font-size:12px">~${st.wait} ${t('min')}</span>` : ''}
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
  // When the plan actually banks on single-rider lines, that is not a nice-to-
  // know tucked in a signal card -- the timings below only hold if the party
  // genuinely splits up, and a family reading a running order has every reason
  // to assume they are riding together. It goes above the running order it
  // governs, in the warning colour, naming the attractions it applies to.
  // Same exemption as the app: a party of one has nobody to be separated from,
  // and single rider is the sensible default for them.
  const soloVisitor = Number(profile?.party) === 1;
  const srNames = soloVisitor ? [] : (Array.isArray(kpis.srRides) ? kpis.srRides.filter(Boolean) : []);
  const srList = srNames.slice(0, 4).map(E).join(', ')
    + (srNames.length > 4 ? ` ${f('and {n} more', { n: srNames.length - 4 })}` : '');
  const srBand = srNames.length ? `<div style="padding:16px 26px 0">
    <div style="background:#fff4e5;border:2px solid #d97706;border-radius:12px;padding:16px 18px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
        <td width="42" valign="top">${badge('!', '#d97706', '#ffffff', 30)}</td>
        <td valign="top">
          <div style="font-size:12px;font-weight:800;letter-spacing:.07em;color:#92580a;text-transform:uppercase">${t('READ THIS BEFORE YOU GO')}</div>
          <div style="font-size:16px;font-weight:800;color:#7c3d02;margin-top:3px;line-height:1.3">${t('This plan splits your group up')}</div>
          <div style="font-size:14px;color:#5c3a12;margin-top:7px;line-height:1.5">
            ${f('The times below assume you use the single-rider line on <b>{n}</b> of the attractions ({rides}). On those you ride on your own — your party is split across different vehicles, and you will not be seated together.', { n: srNames.length, rides: srList })}
          </div>
          <div style="font-size:13.5px;color:#5c3a12;margin-top:9px;line-height:1.55">
            &bull; ${t('A single-rider line can close at any moment, and it is never guaranteed to be quicker than standby.')}<br>
            &bull; ${t('Height and age rules still apply, and most parks will not let a child ride the single-rider line alone.')}<br>
            &bull; ${t('Would you rather stay together? Turn single rider off on those attractions and plan again — the day runs slower, but you ride side by side.')}
          </div>
        </td>
      </tr></table>
    </div></div>` : '';
  const longestQ = namedStopsPeek();
  const signalList = [
    longestQ && longestQ.wait >= 35 ? signalCard(t('ONE BIG QUEUE'), CAT.thrill[1], f('{ride} reaches about <b>{n} min</b> — the one wait to plan around. Snack first, then commit.', { ride: E(longestQ.name), n: longestQ.wait })) : '',
    kpis.shows ? signalCard(t('COOL-DOWN STOPS'), B, f('Shows on the plan: <b>{n}</b> — built-in places to sit and reset in the air conditioning.', { n: kpis.shows })) : '',
    kpis.water ? signalCard(t('PACK FOR A SPLASH'), CAT.water[1], f('Water rides on the plan: <b>{n}</b>. A compact poncho keeps the afternoon comfortable.', { n: kpis.water })) : '',
    kpis.skip ? signalCard(t('NO PASS PRESSURE'), CAT.money[1], f('Built to work without {pass} — <b>{price}</b> stays in your pocket. Buy one only if live waits change the maths.', { pass: esc(kpis.skip.name), price: `${kpis.skip.cur}${kpis.skip.low}–${kpis.skip.cur}${kpis.skip.high}` })) : '',
    kpis.lands ? signalCard(t('ONE DIRECTION'), CAT.map[1], kpis.landNames.length
      ? f('The route stays compact through {lands} instead of zig-zagging.', { lands: esc(kpis.landNames.slice(0, 4).join(', ')) })
      : t('The route stays compact instead of zig-zagging.')) : '',
    kpis.singleRider && !srNames.length ? signalCard(t('SPLIT-UP OPTION'), '#443b6b', f('Rides with a single-rider line, if the party is willing: <b>{n}</b>.', { n: kpis.singleRider })) : '',
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
  // Who's actually going shapes the jokes: kids, grandparents, and big crews
  // each get a line that only appears when the profile says it applies.
  const ages = Array.isArray(profile?.ages) ? profile.ages : [];
  const kidsArr = Array.isArray(profile?.kids) ? profile.kids : [];
  const breakCount = stops.filter((st) => st.break).length;
  const kidAges = kidsArr.map((k) => Number(k.age)).filter(Number.isFinite);
  const youngest = kidAges.length ? Math.min(...kidAges) : null;
  const totalQueue = namedStops.reduce((sum, st) => sum + (Number.isFinite(st.wait) ? st.wait : 0), 0);
  const paceRides = hourOfFirst != null && hourOfLast != null && hourOfLast > hourOfFirst
    ? (namedStops.length / (hourOfLast - hourOfFirst)).toFixed(1).replace(/\.0$/, '') : null;
  const funFacts = [
    dayLen ? fact(badge(dayHours, ...CAT.neutral, 34), f('Your day, gate to gate: <b>{span}</b> — longer than most flights you have complained about', { span: esc(dayLen) })) : '',
    longest && longest.wait >= 40 ? fact(badge(`${longest.wait}m`, ...CAT.thrill, 34), f('Longest single queue on the plan: <b>{n} min</b> at {ride}. Bring a snack and some patience', { n: longest.wait, ride: E(longest.name) })) : '',
    queueHours ? fact(badge(`${queueHours}h`, ...CAT.map, 34), f('Line time dodged: <b>{h} hours</b> — time you get to spend anywhere but a queue', { h: queueHours })) : '',
    kpis.water ? fact(badge(kpis.water, ...CAT.water), f('Forecast dampness: <b>{n}</b> — rides that can return you visibly wetter than you arrived', { n: kpis.water })) : '',
    kpis.thrills ? fact(badge(kpis.thrills, ...CAT.thrill), f('Stomach relocations booked: <b>{n}</b>', { n: kpis.thrills })) : '',
    kpis.mapped && kpis.steps ? fact(badge('~', ...CAT.neutral), f('About <b>{n}</b> steps — your shoes knew what they signed up for', { n: kpis.steps.toLocaleString() })) : '',
    totalQueue >= 30 ? fact(badge(totalQueue >= 60 ? `${Math.floor(totalQueue / 60)}h` : `${totalQueue}m`, ...CAT.money, 34), f('Projected time in lines all day: <b>{span}</b> — already the trimmed-down version', { span: totalQueue >= 60 ? `${Math.floor(totalQueue / 60)}h ${totalQueue % 60}m` : `${totalQueue} min` })) : '',
    hourOfFirst != null && hourOfFirst <= 9 && first ? fact(badge('AM', ...CAT.show, 34), f('Rope-drop warrior: first ride at <b>{time}</b>, when queues are half their afternoon selves', { time: esc(first.time) })) : '',
    hourOfLast != null && hourOfLast >= 20 && last ? fact(badge('PM', ...CAT.show, 34), f('Closing-time finisher: last stop at <b>{time}</b> — the park empties out, you do not', { time: esc(last.time) })) : '',
    paceRides && Number(paceRides) >= 1 ? fact(badge(paceRides, ...CAT.map, 34), f('Pace: about <b>{n} attractions per hour</b>, gate to gate — Olympic, by holiday standards', { n: paceRides })) : '',
    kidsArr.length ? fact(badge(kidsArr.length, ...CAT.show), kpis.toddlerFriendly
      ? f('Children in the crew: <b>{n}</b> — and <b>{k}</b> of these stops are certified little-legs friendly', { n: kidsArr.length, k: kpis.toddlerFriendly })
      : f('Children in the crew: <b>{n}</b> — pacing tuned for shorter strides and longer wonder', { n: kidsArr.length })) : '',
    ages.includes('elderly') ? fact(badge(breakCount || '~', ...CAT.money), breakCount
      ? f('Grand-tour pacing: <b>{n}</b> built-in sit-down breaks — park benches are the real thrones of a great day', { n: breakCount })
      : t('Grand-tour pacing: a gentler rhythm all day — park benches are the real thrones of a great day')) : '',
    kpis.party >= 5 ? fact(badge(kpis.party, ...CAT.neutral), f('A party of <b>{n}</b>, synchronised through {a} attractions — that is real coordination', { n: kpis.party, a: kpis.attractions })) : '',
  ].filter(Boolean).join('');

  // Forecast for the planned day, told the way Mila would tell it. Every
  // number is open-meteo's; only the commentary is hers.
  const wx = flavor.weather;
  const degF = (c) => Math.round(c * 9 / 5 + 32);
  const wxLines = wx ? [
    Number.isFinite(wx.high) ? fact(badge(`${wx.high}°`, ...CAT.water, 34), f('{label}, <b>{lo}°–{hi}°C</b> ({lof}–{hif}°F) — {note}', {
      label: E(wx.label || t('Forecast')), lo: wx.low, hi: wx.high, lof: degF(wx.low), hif: degF(wx.high),
      note: wx.high >= 30 ? t('officially ice-cream weather; Mila prescribes two scoops, minimum')
        : wx.high <= 8 ? t('hot-chocolate weather — the magic works fine in mittens')
        : t('prime strolling conditions, zero excuses'),
    })) : '',
    wx.rainChance >= 50 ? fact(badge(`${wx.rainChance}%`, ...CAT.water, 34), f('Rain chance <b>{n}%</b> — pack the poncho and grin: queues shrink when the sky opens, and Mila calls that a feature', { n: wx.rainChance }))
      : wx.rainChance >= 20 ? fact(badge(`${wx.rainChance}%`, ...CAT.water, 34), f('A <b>{n}%</b> whisper of rain — a sprinkle has never once cancelled the magic', { n: wx.rainChance })) : '',
    wx.uvMax >= 7 ? fact(badge('UV', ...CAT.thrill), f('UV index peaks at <b>{n}</b> — sunscreen is the one queue you are not allowed to skip', { n: wx.uvMax })) : '',
    wx.sunset ? fact(badge('PM', ...CAT.show, 34), f('Sunset at <b>{time}</b> — golden-hour photos are included free of charge', { time: esc(wx.sunset) })) : '',
  ].filter(Boolean).join('') : '';
  const weatherCard = wxLines ? `<div style="padding:14px 26px 2px">
    <div style="background:#eef5ff;border-radius:14px;padding:13px 16px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
        <td width="56" valign="top" style="padding-top:2px">${milaImg('mila-cool-160', 44, '#fff')}</td>
        <td valign="top">
          <div style="font-weight:800;font-size:15px;color:${INK}">${f('Mila checked the skies over {park}', { park: esc(park.name) })}</div>
          <table width="100%" cellpadding="0" cellspacing="0">${wxLines}</table>
        </td></tr></table>
    </div></div>` : '';

  // The insider corner: the practical local secret and one piece of park lore,
  // each with its own Mila. Real editorial content, not filler — both come
  // from the same per-park data that powers the guide pages.
  const insiderRow = (pose, kicker, color, body) => `<tr>
    <td width="56" valign="top" style="padding:8px 0">${milaImg(pose, 44, SOFT)}</td>
    <td valign="top" style="padding:8px 0">
      <div style="font-size:10.5px;font-weight:800;letter-spacing:.08em;color:${color}">${kicker}</div>
      <div style="font-size:13.5px;color:#3f3762;line-height:1.5;margin-top:2px">${body}</div>
    </td></tr>`;
  const insider = (flavor.tip || flavor.fact) ? `<div style="padding:14px 26px 2px">
    <div style="border:2px dashed #d9d2f5;border-radius:14px;padding:10px 16px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
        ${flavor.tip ? insiderRow('mila-wink-160', t('MILA&#39;S LOCAL SECRET'), B, E(flavor.tip)) : ''}
        ${flavor.fact ? insiderRow('mila-map-160', t('PARK LORE, FREE OF CHARGE'), '#0f7a45', E(flavor.fact)) : ''}
      </table>
    </div></div>` : '';

  const tileRow = [
    (w) => tile(kpis.attractions, t('Attractions'), t('on the plan'), w),
    kpis.mapped ? (w) => tile(kpis.km + ' km', t('Walking'), kpis.miles + ' mi', w) : null,
    kpis.mapped ? (w) => tile(kpis.kcal, t('Calories'), t('per adult'), w) : null,
    savedMin > 0 ? (w) => tile(savedMin >= 60 ? Math.round(savedMin / 60) + ' ' + t('hr') : savedMin + ' ' + t('min'), t('Line time saved'), t('vs. winging it'), w) : null,
    !kpis.mapped && kpis.lands ? (w) => tile(kpis.lands, t('Lands'), t('on the route'), w) : null,
    !kpis.mapped && kpis.thrills ? (w) => tile(kpis.thrills, t('Thrill rides'), t('on the list'), w) : null,
  ].filter(Boolean).slice(0, 4);
  const tiles = tileRow.map((fn) => fn(Math.round(100 / tileRow.length))).join('');

  const dodgedBanner = kpis.dodged
    ? `<div style="padding:4px 26px 0"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
        <td style="background:#eafaf1;border-radius:12px;padding:12px 16px;font-size:14px;color:#14532d">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td width="52" valign="top">${milaImg('mila-thumbs-160', 40, '#fff')}</td>
          <td valign="top">
            <span style="font-size:10.5px;font-weight:800;letter-spacing:.1em;color:#0f7a45">${t("TODAY'S ADVANTAGE")}</span><br>
            ${f('{ride} is {n} min right now — your slot lands about <b>{saved} min shorter</b>. Mila approves.', { ride: E(kpis.dodged.name), n: kpis.dodged.standby, saved: kpis.dodged.minutes })}
          </td></tr></table>
      </td></tr></table></div>`
    : '';
  const preheader = f('{n} stops mapped for {park}.', { n: kpis.attractions, park: esc(park.name) });
  return `<!doctype html><html lang="${esc(lang)}"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <!-- Tell clients the design is light-only; without it, Outlook.com and Apple
       Mail auto-invert the card and the purple header turns muddy. -->
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <!-- Mail apps hunt for dates, addresses and phone numbers and wrap them in
       their own <a>, styled their way. On the purple header that turned
       "Friday, August 28" into dark green underlined text nobody could read.
       Ask them not to, then override the styling for the ones that do it
       anyway -- the injected link is not in our markup, so only a selector can
       reach it. -->
  <meta name="format-detection" content="date=no,telephone=no,address=no,email=no">
  <style>
    /* Contrast note: the header used white at opacity .85, which Outlook's Word
       engine ignores outright and other clients render at 4.86:1. The explicit
       #ece9ff is 5.15:1 on this purple and behaves the same everywhere. */
    /* Apple Mail / iOS tags its detected links with this attribute. */
    a[x-apple-data-detectors] {
      color: inherit !important; text-decoration: none !important;
      font-size: inherit !important; font-family: inherit !important;
      font-weight: inherit !important; line-height: inherit !important;
    }
    /* Outlook mobile and the rest: anything auto-linked inside the header keeps
       the header's own colour. Real links there are set explicitly elsewhere.
       The class rule alone was not enough -- Outlook reported the date as dark
       green on the purple even with this present, so the date is now wrapped in
       an anchor of our own with an INLINE colour. A detector skips text that is
       already a link, and an inline style survives clients that drop <style>,
       which is the failure this rule cannot cover. */
    .pp-head a, .pp-head a span, .pp-head a font { color: #ffffff !important; text-decoration: none !important; }
    /* Gmail wraps its detections in .aBn; Outlook.com in .ExternalClass. */
    .pp-head .aBn, .pp-head .aBn span, .pp-head span[data-auto-link] { color: #ffffff !important; border-bottom: 0 !important; }
    u + #body a, #MessageViewBody a { color: inherit !important; text-decoration: none !important; }
  </style>
  <title>${f('Your {park} day plan', { park: esc(park.name) })}</title>
  </head><body style="margin:0;padding:0;background:#f7f5ff">
  <div style="display:none;font-size:1px;color:#f7f5ff;max-height:0;overflow:hidden;mso-hide:all">${preheader}</div>
  <div style="background:#f7f5ff;padding:24px 12px;font:15px/1.6 -apple-system,'Segoe UI',sans-serif;color:${INK}">
   <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 6px 28px rgba(20,12,48,.09)">
    <!-- bgcolor as well as the gradient: Outlook renders through Word, which
         ignores linear-gradient entirely. Without the attribute the header lost
         its background and printed white text on white. -->
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" bgcolor="${B}" style="background:${B};background:linear-gradient(135deg,${B},#8b5cf6)"><tr>
     <td class="pp-head" style="padding:26px 0 20px 26px;color:#fff" valign="middle">
      <div style="font-size:12px;font-weight:800;letter-spacing:.12em;color:#ece9ff;text-transform:uppercase">ParkPulse · ${future ? t('advance plan') : t('live route')} · ${esc(park.name)}</div>
      <div style="font-size:25px;font-weight:800;letter-spacing:-.02em;margin-top:6px;line-height:1.2">${pick(HEADLINES)}</div>
      <div style="color:#ece9ff;font-size:14px;margin-top:4px"><a href="${APP}" style="color:#ffffff;font-weight:700;text-decoration:none">${day}</a> · ${future ? t("sequenced around that day's predicted crowds, park geography, and the rides you care about.") : t('sequenced around live waits, park geography, and the rides you care about.')}</div>
     </td>
     <td width="128" valign="middle" align="center" style="padding:20px 18px 14px 8px">
      <img src="${MILA('mila-welcome-160')}" width="104" height="104" alt="${t('Mila, your park fairy')}" style="border-radius:99px;display:block;border:3px solid rgba(255,255,255,.6)">
     </td>
    </tr>${flavor.magic ? `<tr><td colspan="2" style="padding:0 26px 20px">
      <div style="background:rgba(255,255,255,.16);border-radius:12px;padding:9px 14px;color:#fff;font-size:13.5px;line-height:1.5"><b>${t('Mila says:')}</b> &ldquo;${E(flavor.magic)}&rdquo;</div>
    </td></tr>` : ''}</table>
    <div style="padding:22px 20px 6px">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>${tiles}</tr></table>
    </div>
    ${dodgedBanner}
    ${briefing ? `<div style="padding:16px 26px 4px">
      <div style="background:#fffaf0;border-left:4px solid #f0b429;border-radius:10px;padding:14px 16px;font-size:14.5px">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td width="48" valign="top">${milaImg('mila-thinking-160', 38)}</td>
          <td valign="top"><b>${firstName ? f("Mila's read for {name} on the day", { name: E(firstName) }) : t("Mila's read on the day")}</b><br>${E(briefing).replace(/\n/g, '<br>')}</td>
        </tr></table>
      </div></div>` : ''}
    ${weatherCard}
    ${srBand}
    <div style="padding:18px 26px 6px">
      <div style="font-weight:800;font-size:16px;margin-bottom:2px">${future ? f('Running order for {day}', { day: esc(String(day).split(',')[0]) }) : t("Today's running order")}</div>
      <div style="color:${MUTED};font-size:13px">${t('Follow the numbers — they match the pins on your map.')}</div>
      <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
    </div>
    ${insider}
    ${facts ? `<div style="padding:14px 21px 2px">
      <div style="font-weight:800;font-size:16px;margin-bottom:4px;padding:0 5px">${t('Plan signals worth knowing')}</div>
      <table width="100%" cellpadding="0" cellspacing="0">${facts}</table></div>` : ''}
    ${funFacts ? `<div style="padding:14px 26px 2px">
      <div style="font-weight:800;font-size:16px;margin-bottom:2px">${t('The stats nobody asked for')}</div>
      <div style="color:${MUTED};font-size:12.5px;margin-bottom:6px">${t('All real, all from this plan.')}</div>
      <table width="100%" cellpadding="0" cellspacing="0">${funFacts}</table></div>` : ''}
    <div style="padding:18px 26px 8px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:linear-gradient(135deg,#2c2154,#443b6b);background-color:#2c2154" bgcolor="#2c2154">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td width="76" valign="middle" style="padding:18px 0 18px 16px">${milaImg('mila-celebrate-160', 56, 'rgba(255,255,255,.45)')}</td>
          <td valign="middle" style="padding:18px 20px 18px 12px;color:#fff">
            <div style="font-size:10.5px;font-weight:800;letter-spacing:.1em;opacity:.8">${t('KEEP THE DAY MOVING')}</div>
            <div style="font-size:17px;font-weight:800;margin-top:4px;line-height:1.35">${t('The plan is your starting point. Live waits make it smarter as you go.')}</div>
            <div style="font-size:13px;opacity:.85;margin-top:4px">${t("A delay, a hungry kid, or a wait swing doesn't undo the day — reopen your plan and take the next better move.")}</div>
          </td>
        </tr></table>
      </td></tr></table>
    </div>
    <div style="padding:4px 26px 26px">
      <div style="font-size:14.5px;font-weight:700;color:${B};margin:2px 0 12px;line-height:1.5">&ldquo;${pick(SIGNOFFS)}&rdquo; <span style="color:${MUTED};font-weight:800">— Mila</span></div>
      <a href="${APP}" style="display:inline-block;background:${B};color:#fff;text-decoration:none;font-weight:800;padding:13px 26px;border-radius:12px">${t('Open live waits →')}</a>
      <div style="color:#a49cc0;font-size:12px;margin-top:6px">${t('Your route, ready to adapt.')}</div>
      ${kpis.mapped ? `<div style="color:#a49cc0;font-size:11.5px;margin-top:16px;line-height:1.5">
        ${t('Walking distance is measured along your planned route plus the walk in and out, with a 35% allowance for real-world wandering. Calories assume a 70 kg adult at a casual pace — a rough guide, not a fitness tracker.')}
      </div>` : ''}
    </div>
   </div>
   <div style="max-width:600px;margin:12px auto 0;text-align:center;color:#a49cc0;font-size:11.5px">
     ParkPulse · ${t('Unofficial fan tool — not affiliated with any park operator.')}
   </div>
  </div></body></html>`;
}

// --- AI spend tracking -------------------------------------------------------
// Anthropic list prices per million tokens (docs: anthropic.com/pricing).
// Cache writes bill at 1.25x the input rate, cache reads at 0.1x.
const AI_PRICES = {
  "claude-opus-5":    { in: 5.00,  out: 25.00 },
  "claude-fable-5":   { in: 10.00, out: 50.00 },
  "claude-sonnet-5":  { in: 2.00,  out: 10.00 },
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

// `billTo` is the account the call was made for, when there is one. The
// catalogue jobs -- ride blurbs, dining guides, map placement -- are written
// once per park and shared by everybody, so they belong to the product rather
// than to whoever happened to trigger them, and they pass nothing.
const CATALOG_MODEL_NAME = consultant.models.catalogue;
const LIGHT_MODEL_NAME = consultant.models.light;
// Which tier a model belongs to. Access is granted per model, so these three
// succeed and fail independently -- and reporting them under one name meant a
// working advisor wiped the catalogue's failures off the panel on every single
// question a visitor asked. The dining guide was refused for days behind a
// green tick.
const AI_TIER = (model) => (model === LIGHT_MODEL_NAME ? 'anthropic · light'
  : model === CATALOG_MODEL_NAME ? 'anthropic · catalogue'
  : 'anthropic · advisor');

function recordUsage(feature, model, usage, billTo) {
  // A billed call is a call that worked, which is the only success signal the
  // AI upstream gives us without asking it something on purpose.
  upstream.service(AI_TIER(model), true);
  const priced = priceUsage(model, usage);
  try { db.aiusage.add(etNow().date, feature, model, priced); }
  catch (err) { console.log(`usage record failed: ${err.message}`); }
  if (!billTo || !priced.cost) return;
  try {
    db.aispend.add(billTo, etNow().date, priced.cost);
    // Bought time is spent before the daily allowance is touched, so somebody
    // who has paid for more is not also told they have run out.
    const credit = db.users.get(billTo)?.ai_credit_usd || 0;
    if (credit > 0) db.users.spendAiCredit(billTo, Math.min(credit, priced.cost));
  } catch (err) { console.log(`account spend record failed: ${err.message}`); }
}

// --- What one account may cost ------------------------------------------------
// Counting questions cannot cap money: a question that makes Mila reach for a
// tool bills several times over and costs six times one that does not. So the
// budget is in dollars, and it scales with the pass, because a day-tripper
// with one day of access is worth being generous to and an annual holder is
// the same person for three hundred days.
// The money numbers, in one literal object so they can be read together and
// checked against each other. They were scattered across two hundred lines --
// a per-plan table here, an alert threshold there, a global backstop in
// between -- and the relationships that matter between them (a guest must not
// be worse off than a customer; the warning must arrive before the wall; one
// operator must not be able to spend the product's whole day) were true only
// by coincidence and untestable either way.
const AI_DEFAULTS = {
  globalDailyUsd: 50,    // the wall: everything, everyone, one day
  alertUsd: 25,          // the warning, at half the wall
  freeUsd: 0.20,
  compUsd: 0.90,         // a guest, matched to Trip Pass on purpose
  devUsd: 25.00,         // the operator
};

const AI_BUDGET_USD = Object.assign(Object.create(null), {
  // These are DAILY ceilings, and the long passes have a lot of days in them.
  // A year at $0.35 a day is $127 of allowance behind a $49.99 pass -- so the
  // long tiers came down when the prices did. Nobody reaches these: one of
  // Mila's reads costs about five cents, so $0.20 is four a day, every day.
  'day-pass': 2.50, 'trip-pass': 0.90, 'season-pass': 0.30, 'year-pass': 0.20,
  // Retired plans, so somebody mid-pass keeps the allowance they bought.
  'week-pass': 1.00, 'month-pass': 0.50, 'half-year-pass': 0.40, 'pro-annual': 0.35,
  // A guest is somebody being shown the product on purpose. Giving them half
  // a paying customer's allowance meant the invitation ran out first, which is
  // the opposite of what an invitation is for -- so it matches Trip Pass.
  'comp': AI_DEFAULTS.compUsd, 'dev': AI_DEFAULTS.devUsd,
}, (() => {
  // One env var, so a budget can be moved without a deploy of the table.
  try { return JSON.parse(process.env.AI_BUDGETS || '{}'); } catch { return {}; }
})());
// No pass: the single free plan review a day, and nothing else.
const AI_BUDGET_FREE = Number(process.env.AI_BUDGET_FREE || AI_DEFAULTS.freeUsd);
// Everything, everyone, one day. The backstop that does not care how the spend
// was distributed.
//
// Held at $50 deliberately while the product is pre-revenue: nothing is being
// sold yet, so a ceiling that bounds a bad day is worth more than one that
// never gets in the way. One consequence is worth knowing rather than
// discovering from a support message: the operator's own allowance is $25, so
// half of this belongs to one person testing the site, and a hard afternoon of
// checking things can crowd out real visitors. Raise this -- or lower devUsd --
// when that starts happening, and move alertUsd with it or the warning stops
// being one.
const AI_GLOBAL_DAILY_USD = Number(process.env.AI_GLOBAL_DAILY_USD || AI_DEFAULTS.globalDailyUsd);

function aiBudgetFor(user) {
  // The admin bypass was only ever half-built. hasAccess() waves an operator
  // through the gate, and then this put them straight back on the free tier's
  // twenty cents -- about two of Mila's reads -- so the person who owns the
  // product was the likeliest person in it to be told she had given them
  // everything she had for today. It reads as "Mila is broken" and it is not:
  // it is a budget written for strangers being applied to the operator.
  //
  // The 'dev' allowance has been sitting in the table for exactly this and
  // nothing ever assigned it.
  if (user && user.verified && user.email && ADMIN_EMAILS.has(user.email)) {
    return AI_BUDGET_USD.dev + (user.ai_credit_usd || 0);
  }
  const base = (user && accountPassActive(user) && AI_BUDGET_USD[user.plan] !== undefined)
    ? AI_BUDGET_USD[user.plan] : AI_BUDGET_FREE;
  return base + (user?.ai_credit_usd || 0);
}

// Why Mila cannot answer right now, or null if she can. Split from the route so
// the same answer can be given before a turn and shown on the account sheet.
// How much of Mila a whole pass may buy. The daily ceilings above bound a
// day; nothing bounded the pass, and a pass is made of days. At $0.35 a day
// the Annual Pass carried $127 of allowance behind a $49.99 price -- a margin
// that could go to minus a hundred and fifty percent on paper, and the only
// thing between that and reality was the global wall, which protects the
// business by switching Mila off for everybody else.
//
// So every pass carries a lifetime cap of a fifth of its price. Twenty percent
// buys a Trip Pass seventy of Mila's reads and an Annual Pass two hundred;
// nobody reaches it, and the floor it puts under the margin is 76% whatever
// anyone does. Bought time counts on top: a top-up is the customer paying for
// more of her, and it would be absurd to sell it and then decline to serve it.
//
// The pass started when it will end minus how long it runs: the grant stores
// only the expiry. Comp and dev passes have no lifetime cap -- they are the
// operator and the operator's guests -- and so does any plan the catalogue
// no longer knows, which is the safe way to be wrong.
const PASS_LIFETIME_SHARE = 0.20;
const PASS_DAYS = Object.assign(Object.create(null),
  Object.fromEntries(PLAN_CATALOG.map((c) => [c.id, c.days])),
  { 'week-pass': 7, 'month-pass': 30, 'half-year-pass': 182, 'pro-annual': 365 });
const PASS_PRICE = Object.assign(Object.create(null),
  Object.fromEntries(PLAN_CATALOG.map((c) => [c.id, Number(c.usd)])),
  // What the retired passes sold for, so a holder keeps the cap they bought.
  { 'week-pass': 49.99, 'month-pass': 69.99, 'half-year-pass': 129.99, 'pro-annual': 199.99 });
function passLifetime(user) {
  if (!user || !accountPassActive(user)) return null;
  const days = PASS_DAYS[user.plan];
  const price = PASS_PRICE[user.plan];
  if (!days || !price) return null;
  const since = new Date(user.plan_exp - days * 86400000).toISOString().slice(0, 10);
  let bought = 0;
  try {
    for (const t of JSON.parse(db.kv.get(`topups:${user.email}`) || '[]')) {
      if (t && t.at >= since) bought += Number(t.usd) || 0;
    }
  } catch {}
  return { since, cap: Math.round((price * PASS_LIFETIME_SHARE + bought) * 100) / 100 };
}

function aiBudgetState(email) {
  const day = etNow().date;
  const globalSpent = db.aiusage.totalOn(day);
  if (AI_GLOBAL_DAILY_USD > 0 && globalSpent >= AI_GLOBAL_DAILY_USD) {
    return { ok: false, reason: 'global', spent: globalSpent, budget: AI_GLOBAL_DAILY_USD };
  }
  const user = email ? db.users.get(email) : null;
  const credit = user?.ai_credit_usd || 0;
  const life = passLifetime(user);
  const passSpent = life ? db.aispend.since(email, life.since).usd : 0;
  const pass = life ? { passSpent, passBudget: life.cap } : {};
  if (life && passSpent >= life.cap) {
    return { ok: false, reason: 'pass', spent: passSpent, budget: life.cap, credit, ...pass };
  }
  const budget = aiBudgetFor(user);
  const spent = email ? db.aispend.on(email, day).usd : 0;
  if (spent >= budget) return { ok: false, reason: 'account', spent, budget, credit, ...pass };
  return { ok: true, spent, budget, credit, ...pass };
}

const usd = (n) => "$" + (Math.round(n * 100) / 100).toFixed(2);
const usd4 = (n) => "$" + n.toFixed(n < 1 ? 4 : 2);

// Features whose output is cached in SQLite and never paid for twice: the
// catalogue jobs, written once per park (per language where it varies) and
// bounded by the number of parks rather than the number of visitors. Dividing
// these by active accounts would be meaningless -- while the catalogue is
// still filling in they would swamp the figure, and once it is full they stop
// costing anything at all. Everything else is charged per visit.
//
// Anything not listed here counts as running cost. That is the deliberate
// direction to be wrong in: a new feature nobody remembered to classify shows
// up in the number that matters instead of hiding in the one that doesn't.
const CACHED_FEATURES = new Set(["ride-info", "dining", "park-flavor", "ride-tags", "geo-match", "geo-estimate"]);

// Midnight Eastern on a YYYY-MM-DD, as an instant. The spend windows are
// Eastern calendar days, so the active-account count has to start at the same
// moment or the two halves of "cost per account" would cover different spans.
// ET runs at UTC-5 or UTC-4, so the offset is probed for that specific date
// rather than assumed -- otherwise the boundary slips by an hour twice a year.
function etMidnight(dateStr) {
  const guess = new Date(dateStr + "T05:00:00Z"); // midnight if ET is on standard time
  const off = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(guess)) % 24;
  return new Date(guess.getTime() - off * 3600000).toISOString();
}

// Day / week / month spend, week and month being trailing 7 and 30 days
// ending on the report day, so the numbers are comparable run to run. Each
// window carries the split between running and catalogue cost, and the number
// of accounts seen in that same window, because the useful question is not
// what the month cost but what one more visitor costs.
function aiCostReport(day) {
  const win = (n) => {
    const from = addDays(day, -(n - 1));
    const t = db.aiusage.totals(from, day);
    const cached = db.aiusage.byFeature(from, day)
      .filter((f) => CACHED_FEATURES.has(f.feature))
      .reduce((sum, f) => sum + f.cost_usd, 0);
    const accounts = db.admin.activeAccountsSince(etMidnight(from), [...ADMIN_EMAILS]);
    const running = t.cost_usd - cached;
    // What share of the prompt came back from cache instead of being paid for
    // again. This is the only ground truth that prompt caching still works:
    // when a change to prompt assembly breaks it nothing errors, requests keep
    // succeeding, and the only symptom is a bigger bill.
    const promptIn = t.input_tokens + t.cache_read + t.cache_write;
    return {
      ...t, cached_usd: cached, running_usd: running, accounts,
      per_account: accounts ? running / accounts : null,
      prompt_tokens: promptIn,
      cache_share: promptIn ? t.cache_read / promptIn : null,
    };
  };
  return {
    day, today: win(1), week: win(7), month: win(30),
    features: db.aiusage.byFeature(addDays(day, -29), day),
    days: db.aiusage.byDay(addDays(day, -13), day),
  };
}

// --- Revenue -----------------------------------------------------------------
// Only the catalogue plans are money. A dev pass is recorded in the same table
// and a couple of retired ids (trip-pass, pro-annual) predate the current
// catalogue and carry no price at all -- counting either as revenue would
// overstate the cash. They are counted separately instead of dropped, because
// "how many free passes are in circulation" is its own question.
const PLAN_PRICE = Object.assign(Object.create(null),
  Object.fromEntries(PLAN_CATALOG.map((p) => [p.id, Number(p.usd)])));

function revenueOf(rows) {
  let usd = 0, sold = 0, comped = 0;
  for (const r of rows) {
    const price = PLAN_PRICE[r.plan];
    if (price === undefined) { comped += r.n; continue; }
    usd += price * r.n;
    sold += r.n;
  }
  return { usd: Math.round(usd * 100) / 100, sold, comped };
}

function revenueReport() {
  const since = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const win = (days) => {
    const rev = revenueOf(db.passes.soldSince(since(days)));
    // The same denominator the AI report divides by, admins excluded. Two
    // per-account figures sitting next to each other on one screen have to be
    // over the same population or subtracting one from the other is nonsense --
    // and reading the dashboard touches the operator's own session, so without
    // the exclusion the person checking the numbers appears in them.
    const accounts = db.admin.activeAccountsSince(since(days), [...ADMIN_EMAILS]);
    return { ...rev, accounts, arpu: accounts ? rev.usd / accounts : null };
  };
  return { today: win(1), week: win(7), month: win(30), byDay: db.passes.soldByDay(since(30)) };
}

function aiCostEmailHtml(r) {
  // The headline number answers "what did I spend"; the one next to it answers
  // "what does one more visitor cost me", which is the one that decides whether
  // a pass price works. Only running cost is divided -- see CACHED_FEATURES.
  const pct = (n) => Math.round(n * 100) + "%";
  // Prompt caching failing is silent -- no error, just a bigger bill -- and it
  // fails by regression, months after it was set up, when something upstream
  // starts rewriting the prefix. A week of real traffic reading almost nothing
  // back is the signature, so the report says so rather than leaving it to be
  // noticed in the total.
  const w = r.week;
  const cacheAlarm = w.calls >= 20 && w.cache_share != null && w.cache_share < 0.4
    ? `<p style="margin:0 0 18px;padding:10px 12px;background:#fdf3d7;border-left:4px solid #a06f00;color:#5c4000;font-size:13px">
        <b>Only ${pct(w.cache_share)} of the prompt came back from cache this week</b>, across ${w.calls} calls.
        A healthy advisor prompt reads most of itself back. Something upstream is likely rewriting the prefix —
        check whether prompt assembly changed since the last deploy.</p>`
    : "";
  const perAcct = (t) => (t.per_account == null
    ? `<span style="color:#999">no accounts active</span>`
    : `<b style="font-size:16px">${usd4(t.per_account)}</b> per active account <span style="color:#888">(${t.accounts})</span>`);
  const row = (label, t) => `<tr><td style="padding:8px 12px 8px 0;vertical-align:top"><b>${label}</b></td>
    <td style="padding:8px 12px 8px 0;font-size:20px;vertical-align:top"><b>${usd(t.cost_usd)}</b></td>
    <td style="padding:8px 0;color:#444;vertical-align:top">${perAcct(t)}<br>
      <span style="color:#888;font-size:12px">${t.calls} calls · ${t.prompt_tokens.toLocaleString()} in / ${t.output_tokens.toLocaleString()} out${t.cache_share == null ? "" : ` · ${pct(t.cache_share)} of the prompt from cache`}${t.cached_usd > 0.00005 ? ` · ${usd4(t.cached_usd)} of it one-off catalogue` : ""}</span></td></tr>`;
  const feats = r.features.length
    ? r.features.map((f) => `<tr><td style="padding:3px 12px 3px 0">${f.feature}${CACHED_FEATURES.has(f.feature) ? ` <span style="color:#888;font-size:12px">· cached, one-off</span>` : ""}</td><td style="padding:3px 0">${usd4(f.cost_usd)} <span style="color:#888">(${f.calls})</span></td></tr>`).join("")
    : `<tr><td colspan="2" style="color:#888">No AI calls in the last 30 days.</td></tr>`;
  const peak = Math.max(...r.days.map((d) => d.cost_usd), 0.0001);
  const spark = r.days.map((d) => `<td style="vertical-align:bottom;padding:0 2px">
      <div style="width:14px;height:${Math.max(2, Math.round((d.cost_usd / peak) * 46))}px;background:#5b3df5;border-radius:2px"></div>
      <div style="font-size:9px;color:#999;text-align:center">${d.day.slice(8)}</div></td>`).join("");
  return `<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;color:#251d3d;max-width:560px">
    <h2 style="margin:0 0 2px">ParkPulse AI spend</h2>
    <p style="margin:0 0 18px;color:#666">for ${r.day} (Eastern)</p>
    ${cacheAlarm}
    <table style="border-collapse:collapse;margin-bottom:22px">
      ${row("Today", r.today)}${row("Last 7 days", r.week)}${row("Last 30 days", r.month)}
    </table>
    <p style="margin:0 0 6px"><b>By feature</b> <span style="color:#888">· last 30 days</span></p>
    <table style="border-collapse:collapse;margin-bottom:22px">${feats}</table>
    ${r.days.length ? `<p style="margin:0 0 6px"><b>Daily spend</b> <span style="color:#888">· last 14 days, peak ${usd4(peak)}</span></p>
    <table style="border-collapse:collapse"><tr>${spark}</tr></table>` : ""}
    <p style="margin:22px 0 0;font-size:12px;color:#888">"From cache" is the share of prompt tokens served from the prompt cache rather than paid for again. It should be high and steady; a drop after a deploy means prompt assembly changed and the cache broke, which reports itself nowhere else.</p>
    <p style="margin:8px 0 0;font-size:12px;color:#888">Per-account cost counts only the work that repeats — the advisor and the plan-email briefing. The catalogue jobs marked <i>cached</i> above are written once per park, stored in SQLite and never charged again, so they are left out of it. An active account is one seen in that same window.</p>
    <p style="margin:8px 0 0;font-size:12px;color:#888">Estimated from token counts at Anthropic list prices — your invoice is the source of truth.</p>
  </div>`;
}

async function sendAiCostEmail(day) {
  if (!AI_REPORT_TO) return { sent: false, reason: "no recipient configured" };
  const r = aiCostReport(day);
  // The subject carries the trailing-week per-account figure rather than
  // today's: a single quiet or busy day swings it too far to glance at.
  const per = r.week.per_account == null ? "" : ` · ${usd4(r.week.per_account)}/account`;
  return sendEmail(AI_REPORT_TO, `ParkPulse AI spend ${day}: ${usd(r.today.cost_usd)} today · ${usd(r.week.cost_usd)} this week${per}`,
    aiCostEmailHtml(r), `AI spend ${day}: today ${usd(r.today.cost_usd)}, week ${usd(r.week.cost_usd)}, month ${usd(r.month.cost_usd)}${per}`);
}

// --- Spend alerting ----------------------------------------------------------
// The daily report is a lagging indicator: a runaway loop bills for a whole day
// before it says anything. This watches two shapes of trouble -- a day that
// crosses a fixed ceiling, and a day running far above the recent norm -- and
// mails the moment either happens. Once per condition per day, so a loop does
// not become a mail flood on top of a bill.
// How many written lines one account can buy in half a day. The client only
// asks when the day actually changed, which is far fewer; this is the backstop.
const LIVE_NUDGE_CAP = Number(process.env.LIVE_NUDGE_CAP || 12);
// Deliberately about HALF of AI_GLOBAL_DAILY_USD: the email is the warning and
// the cap is the wall, and a warning that arrives at the wall is not a warning.
// Move one and move the other -- an alert too close to the ceiling never fires
// in time, and one too far below it fires every day until nobody reads it.
const AI_ALERT_USD = Number(process.env.AI_ALERT_USD || AI_DEFAULTS.alertUsd);
const AI_ALERT_MULTIPLE = Number(process.env.AI_ALERT_MULTIPLE || 4);
// Below this the multiple is meaningless: 4x of eleven cents is not news.
const AI_ALERT_FLOOR_USD = Number(process.env.AI_ALERT_FLOOR_USD || 5);

async function maybeAlertOnSpend() {
  if (!AI_REPORT_TO) return;
  const day = etNow().date;
  const r = aiCostReport(day);
  const today = r.today.cost_usd;
  // The trailing week excluding today, as a daily average.
  const priorDaily = Math.max(0, (r.week.cost_usd - today)) / 6;

  const reasons = [];
  if (AI_ALERT_USD > 0 && today >= AI_ALERT_USD) {
    reasons.push({ k: 'ceiling', why: `today's spend has passed ${usd(AI_ALERT_USD)}` });
  }
  if (today >= AI_ALERT_FLOOR_USD && priorDaily > 0 && today >= priorDaily * AI_ALERT_MULTIPLE) {
    reasons.push({ k: 'spike', why: `today is running ${(today / priorDaily).toFixed(1)}x the daily average of the past week (${usd(priorDaily)})` });
  }
  for (const reason of reasons) {
    const key = `ai-alert:${reason.k}:${day}`;
    if (db.kv.get(key)) continue;          // already said so today
    db.kv.set(key, '1');
    const top = r.features.slice(0, 3).map((f) => `${f.feature} ${usd4(f.cost_usd)} (${f.calls})`).join(', ');
    console.log(`AI spend alert (${reason.k}): ${reason.why}`);
    try {
      await sendEmail(AI_REPORT_TO, `⚠️ ParkPulse AI spend: ${usd(today)} today`,
        `<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;color:#251d3d;max-width:560px">
          <h2 style="margin:0 0 4px">AI spend alert</h2>
          <p style="margin:0 0 14px;color:#666">${day} (Eastern)</p>
          <p style="margin:0 0 14px">Flagged because ${reason.why}.</p>
          <p style="margin:0 0 6px"><b>${usd(today)}</b> today · ${r.today.calls} calls</p>
          <p style="margin:0 0 14px;color:#666">Past week ${usd(r.week.cost_usd)} · past 30 days ${usd(r.month.cost_usd)}</p>
          ${top ? `<p style="margin:0 0 14px;font-size:13px;color:#666">Biggest so far this month: ${top}</p>` : ''}
          <p style="margin:0;font-size:12px;color:#888">The full breakdown is on the admin dashboard. Thresholds: AI_ALERT_USD, AI_ALERT_MULTIPLE.</p>
        </div>`,
        `AI spend alert for ${day}: ${reason.why}. ${usd(today)} today across ${r.today.calls} calls.`);
    } catch (err) { console.log(`AI spend alert email failed: ${err.message}`); }
  }
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
// Cached plan reviews outlive their longest TTL by a day and are then dead
// weight -- a plan for a past date will never be asked for again.
const sweepPlanAdvice = () => { try { db.planadvice.prune(36 * 60 * 60 * 1000); } catch {} };
setInterval(() => { checkAlerts().catch(() => {}); checkBookingReminders().catch(() => {}); sweepDeletedAccounts(); maybeSendAiCostEmail(); maybeAlertOnSpend().catch((e) => console.log(`spend alert: ${e.message}`)); sweepPlanAdvice(); sweepEveningPlanMail().catch((e) => console.log(`evening mail sweep: ${e.message}`)); }, ALERT_CHECK_MS);

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
        const ds = db.daystate.get(row.email) || {};
        const profile = ds.profile || null;
        // This mailer runs from a timer, so there is no request to read the
        // reader's language off. Day state is where the app persists it, and
        // it is what the WhatsApp bridge already trusts for the same purpose.
        const langCode = LANG_NAMES[ds.lang] ? ds.lang : 'en';
        const kpis = await planKpis(park, stops, profile);
        kpis.dodged = null; // future day: no live-now comparison
        const day = new Intl.DateTimeFormat(langCode, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
          .format(new Date(`${row.date}T12:00:00Z`));
        let briefing = '';
        if (consultant.enabled()) {
          try {
            briefing = await consultant.dayBriefing({ parkName: park.name, group: park.group, day, future: true, stops, kpis, profile, savedMin: row.saved_min || 0, lang: LANG_NAMES[langCode] });
          } catch (err) { console.log(`evening briefing failed: ${err.message}`); }
        }
        const flavor = await planEmailFlavor(park, row.date, langCode);
        const html = planEmailHtml({ park, day, dateIso: row.date, stops, kpis, savedMin: row.saved_min || 0, briefing, profile, firstName: user.name || null, future: true, flavor, lang: langCode });
        const firstRide = stops.find((st) => st.name && st.time);
        const ts = T(langCode);
        const subject = fmt(ts('Tomorrow at {park} — your plan is ready'), { park: park.name })
          + (firstRide ? ` (${fmt(ts('first ride {time}'), { time: firstRide.time })})` : '');
        await sendEmail(row.email, subject, html);
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
// --- Landing page localisation -----------------------------------------------
// English is the canonical at "/"; the rest get their own URL so search
// engines index a real translated page instead of a script that rewrites one.
// A missing string falls back to English, so a partial dictionary reads as
// mixed rather than broken -- and never blocks shipping a language.
// Target set, in the order the picker shows them.
const LANDING_WANTED = ['en', 'es', 'pt', 'fr', 'de', 'it', 'zh', 'ja', 'ko', 'ru'];
// Each language named in its own language -- someone looking for their
// language is scanning for the word they actually use.
const LANDING_NATIVE = {
  en: 'English', es: 'Espa\u00f1ol', pt: 'Portugu\u00eas', fr: 'Fran\u00e7ais', de: 'Deutsch',
  it: 'Italiano', zh: '\u4e2d\u6587', ja: '\u65e5\u672c\u8a9e', ko: '\ud55c\uad6d\uc5b4', ru: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439',
};
let LANDING_I18N = {};
try {
  LANDING_I18N = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'landing-i18n.json'), 'utf8'));
} catch (err) { console.log(`landing i18n unavailable: ${err.message}`); }
// Only offer a language whose body copy is actually translated. Listing one
// that only has meta strings would hand visitors a page that is English
// everywhere except the browser tab -- worse than not offering it at all.
const LANDING_MIN_STRINGS = 60;
const LANDING_LANGS = LANDING_WANTED.filter((l) => l === 'en'
  || Object.keys(LANDING_I18N[l] || {}).length >= LANDING_MIN_STRINGS);
console.log(`landing languages: ${LANDING_LANGS.join(', ')}`);

// Translation runs only on the markup between tags, never inside <script> or
// <style> -- a dictionary key that happens to appear in JS would otherwise be
// rewritten and break the page.
const HTML_ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'",
  rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d',
  mdash: '\u2014', ndash: '\u2013', middot: '\u00b7', nbsp: '\u00a0', hellip: '\u2026',
};
const decodeEnt = (t) => t.replace(/&([a-z#0-9]+);/gi, (m, e) => (HTML_ENT[e] !== undefined ? HTML_ENT[e] : m));

// Walks the text between tags and translates a whole node at a time. Looking
// the node up BOTH as authored and entity-decoded is what makes the dictionary
// forgiving: source copy is full of &rsquo; and &mdash;, while strings recovered
// from a rendered page carry the real characters, and both are legitimate keys.
function translateMarkup(html, dict) {
  const parts = html.split(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>)/);
  // Placeholder keys ({} standing in for a park name) still need the old
  // regex treatment -- there is no whole-node equality to test.
  const tmpl = Object.keys(dict).filter((k) => k.includes('{}'));
  const rx = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return parts.map((part, i) => {
    if (i % 2 === 1) return part;                       // the script/style itself
    let out = part.replace(/>([^<>]+)</g, (m, text) => {
      const trimmed = text.trim();
      if (!trimmed) return m;
      const to = dict[trimmed] !== undefined ? dict[trimmed] : dict[decodeEnt(trimmed)];
      if (to === undefined || to === trimmed) return m;
      // Keep the node's own indentation so the markup stays readable.
      const lead = text.slice(0, text.indexOf(trimmed[0]));
      const tail = text.slice(lead.length + trimmed.length);
      return '>' + lead + to + tail + '<';
    });
    for (const en of tmpl) {
      const to = dict[en];
      if (!to) continue;
      const [a0, b0] = en.split('{}');
      out = out.replace(new RegExp('>(\\s*)' + rx(a0) + '(.*?)' + rx(b0) + '(\\s*)<', 'g'),
        (m, a, mid, b) => '>' + a + to.replace('{}', mid) + b + '<');
    }
    return out;
  }).join('');
}

// The language list on the landing page. Native name first, English name
// underneath so a reader who knows only the English name can still find it.
function languageCards() {
  return APP_LANGS.map((c) => `<div class="lang"${RTL_LANGS.has(c) ? ' dir="rtl"' : ''}>`
    + `<b>${esc(LANG_NATIVE[c])}</b><span dir="ltr">${esc(LANG_NAMES[c])}</span></div>`).join('');
}

// The pre-launch strip, injected before the page is translated so the sentence
// inside it goes through the landing dictionary like every other line of copy.
// Mila's portrait carries an empty alt on purpose: the sentence beside it says
// the whole message, and naming her again would only make a screen reader read
// the banner twice.
//
// The dismissal is checked in a synchronous script directly beneath the markup,
// so a visitor who has already closed it never sees it flash. Rendering the
// strip in the HTML rather than after load is what makes it survive a visitor
// with JavaScript off -- they simply get a banner they cannot close, which is
// the right way round for a message that is only a sentence.
function comingSoonStrip() {
  if (!COMING_SOON) return '';
  return `<div class="csoon" id="csoon" role="status">`
    + `<img src="/img/mila/mila-celebrate-160.webp" width="34" height="34" alt="" aria-hidden="true" decoding="async">`
    + `<span class="csoon-t">Get ready for the magic &mdash; coming soon</span>`
    + `<button class="csoon-x" type="button" title="Dismiss" aria-label="Dismiss">&#10005;</button>`
    + `</div>`
    + `<script>(function(){var b=document.getElementById('csoon');if(!b)return;`
    + `try{if(localStorage.getItem('pp-soon-seen')==='1'){b.remove();return}}catch(e){}`
    + `b.querySelector('.csoon-x').addEventListener('click',function(){`
    + `b.remove();try{localStorage.setItem('pp-soon-seen','1')}catch(e){}})})()</scr` + `ipt>`;
}

function landingAlternates() {
  return LANDING_LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="https://www.parkpulse.fun${l === 'en' ? '/' : '/' + l}">`).join('\n')
    + '\n<link rel="alternate" hreflang="x-default" href="https://www.parkpulse.fun/">';
}

// The picker is a plain form: no JavaScript, works before hydration, and each
// option is a real URL a crawler can follow.
function langPicker(active) {
  const opts = LANDING_LANGS
    .map((l) => `<option value="${l === 'en' ? '/' : '/' + l}" data-l="${l}"${l === active ? ' selected' : ''}>${esc(LANDING_NATIVE[l] || l)}</option>`)
    .join('');
  // Carrying the choice into pp-lang means the app opens in the same language
  // the visitor just chose here, instead of asking them twice.
  return `<select class="langpick" aria-label="Language" onchange="var o=this.options[this.selectedIndex];try{localStorage.setItem('pp-lang',o.getAttribute('data-l')||'en')}catch(e){}location.href=o.value">${opts}</select>`;
}

// Copy that lives in attributes rather than between tags: meta and Open Graph
// (or a translated page still shares and indexes in English), and alt/title,
// which is the text a screen-reader user actually receives.
const TRANSLATED_ATTRS = ['content', 'alt', 'title', 'aria-label'];
function translateAttrs(html, dict) {
  let out = html;
  const rx = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const en of Object.keys(dict).sort((a, b) => b.length - a.length)) {
    const to = dict[en];
    if (!to || to === en) continue;
    // $& and $$ mean something to replace() when the replacement is a string,
    // and the dictionaries are full of prices. "$29" is safe by luck -- there
    // are no capture groups, so $2 stays literal -- but a value carrying $&
    // would paste the whole matched attribute back into itself. Doubling the
    // dollars is what makes the value mean itself.
    const safe = to.replace(/"/g, '&quot;').replace(/\$/g, '$$$$');
    for (const attr of TRANSLATED_ATTRS) {
      out = out.replace(new RegExp(attr + '="' + rx(en) + '"', 'g'), `${attr}="${safe}"`);
    }
  }
  return out;
}

// Plenty of the page's copy lives in client-side JS: the rotating hero lines,
// the "more than a planner" band, the pricing blurbs, the advisor demo rows.
// The markup pass never sees any of it, so a translated page kept speaking
// English in those places.
//
// A whole string literal must equal a dictionary key before it is replaced.
// Substring rewriting inside scripts would eventually corrupt real code; a
// full-literal match against a complete marketing sentence will not.
function translateScriptStrings(html, dict) {
  const parts = html.split(/(<script[\s\S]*?<\/script>)/);
  return parts.map((part, i) => {
    if (i % 2 === 0) return part;                        // markup, handled elsewhere
    // One pattern per quote style. A single combined class would exclude the
    // other quote characters from the body, and "ParkPulse's" inside a
    // double-quoted string would end the match halfway through the sentence.
    let out = part;
    for (const q of ['"', "'", '`']) {
      const pat = new RegExp(q + '((?:[^' + q + '\\\\\\n]|\\\\.)*)' + q, 'g');
      out = out.replace(pat, (lit, body) => {
        const plain = body.replace(new RegExp('\\\\' + q, 'g'), q);
        const to = dict[plain];
        if (!to) return lit;
        // Entities are right for markup and wrong here: this string is headed
        // for textContent, where &rsquo; is five characters a reader sees.
        // Pip was muttering "L&rsquo;affluence culmine a 13h00" on the French
        // page because the same dictionary serves both.
        const text = decodeEnt(to);
        return q + text.replace(/\\/g, '\\\\').split(q).join('\\' + q) + q;
      });
    }
    return out;
  }).join('');
}

function localizeLanding(html, lang) {
  const dict = lang === 'en' ? null : LANDING_I18N[lang];
  let out = dict ? translateScriptStrings(translateAttrs(translateMarkup(html, dict), dict), dict) : html;
  if (lang !== 'en') out = out.replace('<html lang="en">', `<html lang="${lang}">`);
  // Canonical + alternates, injected once, right after the charset line.
  // Arriving straight at /pt is itself a choice of language. Recording it lets
  // everything that reads pp-lang -- the chat widget on this page, and the app
  // behind the CTA -- follow along instead of resetting to English. Runs in the
  // head so it lands before anything reads the value.
  const carry = lang === 'en' ? '' : `<script>try{localStorage.setItem('pp-lang','${lang}')}catch(e){}</script>`;
  // This page is written in exactly one language, and the URL is what chose it.
  // Saying so stops the client dictionary from picking a different one off the
  // browser and translating pieces of the page underneath the copy: a Brazilian
  // phone on "/" was getting Mila's speech bubble in Portuguese over English
  // marketing. Declared, never stored -- the visitor's own choice of app
  // language is theirs, and it still opens the app behind the CTA in it.
  const pin = `<script>window.PP_PAGE_LANG='${lang}'</script>`;
  const head = `\n<link rel="canonical" href="https://www.parkpulse.fun${lang === 'en' ? '/' : '/' + lang}">\n${landingAlternates()}\n${pin}${carry}\n`;
  out = out.replace('<title>', head + '<title>');
  // The picker sits with the nav links.
  // Anchored on the sign-in link's exact markup: if that class changes and
  // this does not, replace() silently matches nothing and the picker vanishes
  // from every translated landing page.
  out = out.replace('<a href="/app#account" class="navlogin">', `${langPicker(lang)}<a href="/app#account" class="navlogin">`);
  return out;
}


// In-flight dining-guide generations, one per park+language.
const diningJobs = new Map();
// And the ones that just failed. Without this the browser's poll -- every four
// seconds for a minute and a half -- started a FRESH generation each time,
// because the in-flight entry is deleted when the job settles. A park whose
// guide could not be written burned twenty-two model calls per visitor and
// still showed "cooking up..." the whole time. Remembering the failure stops
// the retry and lets the visitor be told straight away.
const diningFails = new Map();          // park|lang -> { at, error }
const DINING_FAIL_COOLDOWN_MS = 10 * 60 * 1000;

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

// Five minutes is the courtesy interval Queue-Times asks for. Settable so a
// test can watch what happens on the very next request instead of waiting.
const CACHE_TTL_MS = Number.isFinite(Number(process.env.WAITS_CACHE_MS))
  ? Number(process.env.WAITS_CACHE_MS) : 5 * 60 * 1000;
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

// --- Last known good ---------------------------------------------------------
// Queue-Times goes quiet -- a 403, a timeout, a bad gateway -- and when it does
// only four of the sixty-five parks have anything behind them, because only
// four were ever given a hand-written sample. Everyone else got an empty board
// and a day Mila could not build, which is what a visitor actually sees when
// the feed blinks.
//
// So every healthy read is kept, one row per park, and handed back when the
// feed is down: real ride names and real waits with the hour they were taken,
// rather than nothing. It goes in the database rather than in memory because
// the outage a visitor notices is usually the one that follows a restart.
//
// Only a park that was RUNNING is worth keeping. At closing time the feed
// reports every ride shut, and a backup made of that is worse than no backup
// at all -- it would tell tomorrow morning that the park is closed.
const STORED_MAX_MS = 24 * 60 * 60 * 1000;   // beyond a day it stops being useful
const STORED_WRITE_MS = 10 * 60 * 1000;      // one write per park per ten minutes
const STORED_MIN_OPEN = 3;                   // a picture of an open park, not a closed one
const storedWrittenAt = new Map();

function keepLastGood(slug, data) {
  if (data.rides.filter((r) => r.open).length < STORED_MIN_OPEN) return;
  if (Date.now() - (storedWrittenAt.get(slug) || 0) < STORED_WRITE_MS) return;
  storedWrittenAt.set(slug, Date.now());
  try { db.kv.set(`lastgood:${slug}`, JSON.stringify(data)); }
  catch (err) { console.log(`lastgood ${slug}: ${err.message}`); }
}

function lastGood(slug) {
  let data = null;
  try { data = JSON.parse(db.kv.get(`lastgood:${slug}`) || 'null'); } catch { return null; }
  if (!data || !Array.isArray(data.rides) || !data.rides.length) return null;
  const age = Date.now() - new Date(data.updatedAt).getTime();
  if (!Number.isFinite(age) || age < 0 || age > STORED_MAX_MS) return null;
  // updatedAt is left exactly as it was: the screen says how old this is, and
  // it can only say so if the timestamp is the moment the waits were real.
  return { ...data, source: 'stored', attribution: 'Last waits we recorded — the live feed is quiet' };
}

// How much of a safety net is actually there, for the dashboard.
function storedAgeMin(slug) {
  let data = null;
  try { data = JSON.parse(db.kv.get(`lastgood:${slug}`) || 'null'); } catch { return null; }
  const age = data && Date.now() - new Date(data.updatedAt).getTime();
  return Number.isFinite(age) && age >= 0 ? Math.round(age / 60000) : null;
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
    keepLastGood(slug, data);
    upstream.note(slug, 'live');
    return data;
  } catch (err) {
    const stored = lastGood(slug);
    if (stored) {
      upstream.note(slug, 'stored', err.message);
      return stored;
    }
    if (!SAMPLE[slug]) {
      upstream.note(slug, 'unavailable', err.message);
      return { park: park.name, source: 'unavailable', attribution: '', updatedAt: new Date().toISOString(), rides: [] };
    }
    upstream.note(slug, 'sample', err.message);
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
let PARK_TIPS = {};
try {
  const seo = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'park-seo.json'), 'utf8'));
  for (const [slug, v] of Object.entries(seo)) {
    PARK_SEASONS[slug] = { peak: new Set(v.peak?.months || []), quiet: new Set(v.quiet?.months || []) };
    if (v.tip) PARK_TIPS[slug] = v.tip;
  }
} catch (err) { console.log(`park seasons unavailable: ${err.message}`); }
// One true, playful fact per park for the plan email's lore line.
let PARK_FACTS = {};
try {
  PARK_FACTS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'park-facts.json'), 'utf8'));
} catch (err) { console.log(`park facts unavailable: ${err.message}`); }

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
// JavaScript off; the tabs only toggle which panel is visible. The client then
// re-fetches the board for its own timezone (/api/hero-board) so a visitor in
// Tokyo sees Tokyo parks, not Florida.
const HERO_PARKS = ['magic-kingdom', 'universal-studios-florida', 'busch-gardens-tampa'];

// Pick the board's parks from the visitor's IANA timezone. Two or three parks
// sharing the exact timezone ARE the local board (Tokyo shows its two parks,
// London its two). When many share it (US Eastern) one park per resort group
// keeps the tabs varied, and a lone match is padded from its region. A
// timezone with no parks near it falls back to the Florida trio.
// Cached render of the Queue-Times directory page (/qt-directory).
let qtDirCache = { at: 0, html: '' };
// The answer to "why is this park empty?", rendered on the one page that can
// actually reach queue-times. An unresolved park is a park whose tokens match
// nothing in the directory below, so it never gets an id and never gets waits.
function resolutionPanel() {
  const r = qtResolution;
  if (!r.at) return '<div class="warn"><b>Park ids have not been resolved yet.</b> The directory below is live, but the boot-time match has not run.</div>';
  if (!r.ok) {
    return `<div class="bad"><b>Park id resolution is failing.</b> Last attempt ${new Date(r.at).toISOString()} — <code>${esc(r.error || 'unknown')}</code>.
      Every park that ships without a hardcoded id is showing an empty board until this succeeds. It retries with backoff, then daily.</div>`;
  }
  const parts = [`<div class="sum"><b>${r.matched}/${REGISTRY.length}</b> ParkPulse parks matched an id at ${new Date(r.at).toISOString()}.</div>`];
  if (r.unresolved.length) {
    parts.push(`<div class="bad"><b>${r.unresolved.length} park(s) matched nothing and will show an empty board.</b>
      Find each one in the directory below, then widen its <code>tokens</code> in <code>data/parks.json</code> to match the name Queue-Times uses.
      <ul>${r.unresolved.map((u) => `<li><b>${esc(u.name)}</b> <small><code>${esc(u.slug)}</code> · tokens: ${u.tokens.map((t) => `<code>${esc(t)}</code>`).join(' + ')}</small></li>`).join('')}</ul></div>`);
  }
  if ((r.relaxed || []).length) {
    parts.push(`<div class="warn"><b>${r.relaxed.length} park(s) matched only after dropping a token</b> — each was the single unclaimed candidate, but confirm it is the right park.
      To make one permanent, edit its <code>tokens</code> in <code>data/parks.json</code> to match the name below.
      <ul>${r.relaxed.map((m) => `<li><code>${esc(m.slug)}</code> <small>(${m.tokens.map((t) => esc(t)).join(' + ')})</small> → <b>${esc(m.chose)}</b> <small>under ${esc(m.company)}</small></li>`).join('')}</ul></div>`);
  }
  if (r.ambiguous.length) {
    parts.push(`<div class="warn"><b>${r.ambiguous.length} park(s) matched more than one entry</b> — the shortest name won, which may be the wrong park.
      <ul>${r.ambiguous.map((a) => `<li><code>${esc(a.slug)}</code> → chose <b>${esc(a.chose)}</b> over ${a.over.map((n) => esc(n)).join(', ')}</li>`).join('')}</ul></div>`);
  }
  return parts.join('\n');
}

const tzOffsetCache = new Map();
function tzOffsetMin(tz) {
  if (tzOffsetCache.has(tz)) return tzOffsetCache.get(tz);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
  const name = (parts.find((p) => p.type === 'timeZoneName') || {}).value || '';
  const m = name.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  const min = m ? Number(m[1]) * 60 + (m[1][0] === '-' ? -1 : 1) * Number(m[2] || 0) : 0;
  tzOffsetCache.set(tz, min);
  return min;
}

function tzHeroParks(tz) {
  if (!tz || !/^[A-Za-z][A-Za-z0-9_/+-]{0,63}$/.test(String(tz))) return HERO_PARKS;
  const exact = REGISTRY.filter((p) => p.tz === tz);
  if (exact.length >= 2 && exact.length <= 3) return exact.map((p) => p.slug);
  const picks = [];
  const seen = new Set();
  const take = (p) => { if (!seen.has(p.group)) { seen.add(p.group); picks.push(p.slug); } };
  for (const p of exact) { if (picks.length >= 3) break; take(p); }
  if (picks.length < 3) {
    const region = (exact[0] && exact[0].region) || { Europe: 'Europe', Asia: 'Asia' }[tz.split('/')[0]];
    if (region) for (const p of REGISTRY) { if (picks.length >= 3) break; if (p.region === region) take(p); }
  }
  // An Americas timezone no park sits in (Vancouver, Phoenix, Mexico City):
  // right continent, so pick the parks with the closest clock — Vancouver
  // lands on the California parks, not the Florida default.
  if (!picks.length && tz.startsWith('America/')) {
    try {
      const want = tzOffsetMin(tz);
      const ranked = REGISTRY.filter((p) => p.tz.startsWith('America/'))
        .map((p) => ({ p, d: Math.abs(tzOffsetMin(p.tz) - want) }))
        .sort((a, b) => a.d - b.d);
      for (const { p } of ranked) { if (picks.length >= 3) break; take(p); }
    } catch { /* unknown zone name — fall through to the default trio */ }
  }
  return picks.length ? picks : HERO_PARKS;
}

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

async function heroBoardPanels(slugs = HERO_PARKS) {
  const panels = [];
  for (const slug of slugs) {
    const park = PARKS[slug];
    if (!park) continue;
    let waits;
    try { waits = await getWaits(slug); } catch { waits = null; }
    const all = (waits && waits.rides) || [];
    let rides = all
      .filter((r) => r.open !== false && typeof r.wait === 'number')
      .sort((a, b) => b.wait - a.wait)
      .slice(0, 6)
      .map((r) => ({
        name: r.name,
        land: r.land || '',
        wait: r.wait,
        delta: typeof r.typical === 'number' ? r.wait - r.typical : null,
      }));
    let live = Boolean(waits && waits.source === 'live');
    let label = null;
    if (live && rides.length >= 3) {
      // Remember the last healthy live read so a closed park can still show
      // its latest waits instead of an empty board.
      try { db.kv.set(`herolast:${slug}`, JSON.stringify({ at: Date.now(), rides })); } catch {}
    } else if (rides.length < 3) {
      // Park closed (or the feed is thin): latest live snapshot first — kept
      // for 36h so an overnight visitor sees yesterday evening's read, not a
      // week-old one — then typical waits as the last resort.
      let snap = null;
      try { snap = JSON.parse(db.kv.get(`herolast:${slug}`) || 'null'); } catch {}
      if (snap && Array.isArray(snap.rides) && snap.rides.length >= 3 && Date.now() - snap.at < 36 * 36e5) {
        rides = snap.rides;
        live = false;
        label = 'LATEST WAITS';
      } else {
        rides = all
          .filter((r) => typeof r.typical === 'number' && r.typical > 0)
          .sort((a, b) => b.typical - a.typical)
          .slice(0, 6)
          .map((r) => ({ name: r.name, land: r.land || '', wait: r.typical, delta: null }));
        live = false;
        label = null;
      }
    }
    // Without a live feed the "typical" baseline equals the posted wait, so
    // every delta is zero. Showing "typical" on every row is noise, not data.
    const hasBaseline = rides.some((r) => r.delta);
    if (!hasBaseline) rides.forEach((r) => { r.delta = null; });
    const verdict = label === 'LATEST WAITS'
      ? `${park.name} looks closed right now — these are the latest posted waits from before close.`
      : boardVerdict(park, rides);
    panels.push({ park, rides, live, label, verdict });
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
<span class="board-live ${p.live ? '' : 'off'}"><i></i>${p.live ? 'LIVE' : (p.label || 'TYPICAL WAITS')}</span></div>
${rail(i)}
<div class="board-rows">${rows || empty}</div>
<div class="board-foot"><div><div class="vk">TODAY&rsquo;S VERDICT</div><div class="vv">${esc(p.verdict)}</div></div>
<a class="whybtn" href="/app">Why?</a></div></div>`;
  }).join('');
  return `<div class="board">${bodies}</div>`;
}

// The full park directory for the landing page: the most-visited parks up
// front as highlighted cards, then every park by region — each with one line
// of Mila. Lines are editorial data, not AI: written once, zero token cost.
let PARK_MAGIC = {};
try {
  PARK_MAGIC = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'park-magic.json'), 'utf8'));
} catch (err) { console.log(`park magic lines unavailable: ${err.message}`); }

// The landing page's editorial "Most popular" cards, and the parks its regional
// columns therefore leave out. Deliberately eight and deliberately unchanged --
// this row is a layout as much as a list.
const POPULAR_PARKS = [
  'magic-kingdom', 'disneyland', 'epic-universe', 'universal-studios-florida',
  'islands-of-adventure', 'epcot', 'tokyo-disneyland', 'disneyland-paris',
];

// What the app's park picker floats above the regional groups, roughly by
// attendance. Separate from the row above because the two have different jobs:
// that one is eight cards in a grid, this one is the head of a 65-item list
// that has to put something first. Every WDW and Universal Orlando gate earns
// a place here since those are the resorts whose parks were previously only
// reachable by picking the resort and then a chip.
const PICKER_TOP = [
  'magic-kingdom', 'disneyland', 'tokyo-disneyland', 'tokyo-disneysea',
  'universal-studios-japan', 'epcot', 'animal-kingdom', 'hollywood-studios',
  'universal-studios-florida', 'islands-of-adventure', 'epic-universe',
  'disneyland-paris', 'universal-studios-hollywood', 'california-adventure',
];

function parkGuides(registry) {
  const magicLine = (p) => {
    const m = PARK_MAGIC[p.slug];
    return m ? `<span class="pg-magic">${esc(m)}</span>` : '';
  };
  const popular = POPULAR_PARKS
    .map((slug) => registry.find((p) => p.slug === slug))
    .filter(Boolean);
  const cards = popular.map((p) =>
    `<a class="pg-card" href="/parks/${p.slug}"><span class="pg-badge">&#10024; Most popular</span><span class="pg-cn">${esc(p.name)}</span>${magicLine(p)}</a>`).join('');
  const regions = [
    ['Florida', 'Florida'], ['California', 'California &amp; West'],
    ['US & Canada', 'US &amp; Canada'], ['Europe', 'Europe'], ['Asia', 'Asia'],
  ];
  const cols = regions.map(([key, label]) => {
    const parks = registry.filter((p) => p.region === key && !POPULAR_PARKS.includes(p.slug));
    if (!parks.length) return '';
    return `<div class="pg-col"><div class="pg-head">${label}</div>${
      parks.map((p) => `<a href="/parks/${p.slug}"><span class="pg-n">${esc(p.name)}</span>${magicLine(p)}</a>`).join('')
    }</div>`;
  }).join('');
  return `<div class="pg-pop">${cards}</div><div class="pg">${cols}</div>`;
}

const SHOTS = [
  { file: 'plan.png', alt: 'The ParkPulse day plan: eight rides sequenced by time, each with its predicted wait and the reason for its slot.',
    cap: '<strong>Your day, sequenced.</strong> Pick the rides you care about; ParkPulse orders them against the hourly crowd curve and tells you why each one sits where it does.' },
  { file: 'advisor.png', alt: "Mila, ParkPulse's magical fairy, answering whether Lightning Lane is worth buying today.",
    cap: '<strong>Straight answers, including no.</strong> Ask whether the paid pass is worth it today and your magical fairy works it out from live waits &mdash; and tells you to keep your money when that is the truth.' },
];
function productShots() {
  const have = SHOTS.filter((s) => fs.existsSync(path.join(PUBLIC_DIR, 'shots', s.file)));
  if (!have.length) return '';
  const lead = have.length > 1
    ? 'Two screens do most of the work &mdash; the plan that sequences your day, and your magical fairy that tells you when not to spend.'
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
  // Mila dropped a tier to answer. The visitor got a real answer and does not
  // need telling; the operator does, because a fallback that nobody sees is a
  // top tier that has quietly stopped working -- and the bill changes shape
  // underneath, since the spend report will start attributing 'advisor' to a
  // model nobody chose.
  noteFallback: (from, to, status, detail) => {
    lastFallback = { at: Date.now(), from, to, status, detail: String(detail || '').slice(0, 160) };
    console.log(`consultant fallback: ${from} -> ${to} after ${status ?? 'none'}: ${detail}`);
    upstream.service(AI_TIER(null), false, `${from} unavailable (${status ?? 'none'}) — answered on ${to}`);
  },
});
// The most recent tier drop, for the dashboard. Deliberately not persisted: it
// is a "is this happening right now" signal, and the spend report is where the
// durable record of which model answered already lives.
let lastFallback = null;

// Canonical host: when CANONICAL_HOST is set (e.g. www.parkpulse.fun), GET
// traffic arriving on any other host — the Railway domains, the bare apex —
// is 301-redirected there, so links, SEO and sessions converge on one origin.
const CANONICAL_HOST = (process.env.CANONICAL_HOST || '').trim().toLowerCase();

// --- Where a visitor came from -----------------------------------------------
// A referrer and a handful of utm parameters, turned into three short strings.
// No cookie, no fingerprint, nothing that identifies a person -- the row it
// lands in is a day, a source and a count.
//
// Crawlers get their own medium rather than being dropped. "1,645 views" is
// only worth reading once you know how much of it was Googlebot, and the way
// to know is to count it separately, not to throw it away.
const BOT_UA = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|whatsapp|telegram|discord|preview|monitor|uptime|curl|wget|python-requests|headless|lighthouse|pagespeed|gtmetrix|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|applebot|duckduckbot|yandex|baiduspider|archive\.org/i;
const SEARCH_HOSTS = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex|brave|startpage|qwant)\./i;
const SOCIAL_HOSTS = /(^|\.)(reddit|facebook|instagram|x|twitter|t|tiktok|pinterest|youtube|linkedin|threads|bsky|mastodon|tumblr|quora)\.(com|co|app|social|net|me)$/i;

function visitSource(req, url) {
  const ua = String(req.headers['user-agent'] || '');
  if (!ua || BOT_UA.test(ua)) {
    // Name the crawler where it is obvious, so the panel says "googlebot"
    // rather than lumping every robot together.
    const who = /googlebot/i.test(ua) ? 'googlebot' : /bingbot/i.test(ua) ? 'bingbot'
      : /applebot/i.test(ua) ? 'applebot' : /ahrefs|semrush|mj12|dotbot/i.test(ua) ? 'seo-crawler'
      : ua ? 'other-bot' : 'no-user-agent';
    return { source: who, medium: 'bot', campaign: '' };
  }
  const clean = (v, n = 40) => String(v || '').trim().toLowerCase().replace(/[^\w .-]+/g, '').slice(0, n);
  // An explicit campaign always wins: it is the one thing somebody chose to
  // tell us, and it survives a referrer being stripped.
  const utmSource = clean(url.searchParams.get('utm_source'));
  const utmMedium = clean(url.searchParams.get('utm_medium'), 24);
  const campaign = clean(url.searchParams.get('utm_campaign'), 40);
  if (utmSource) return { source: utmSource, medium: utmMedium || 'campaign', campaign };

  const ref = String(req.headers.referer || req.headers.referrer || '');
  if (!ref) return { source: 'direct', medium: 'direct', campaign };
  let host = '';
  try { host = new URL(ref).hostname.replace(/^www\./, ''); } catch { return { source: 'direct', medium: 'direct', campaign }; }
  // Our own pages linking to each other are not a traffic source.
  if (host === String(req.headers.host || '').replace(/^www\./, '').split(':')[0]) {
    return { source: 'internal', medium: 'internal', campaign };
  }
  if (SEARCH_HOSTS.test(host)) return { source: host.split('.')[0], medium: 'search', campaign };
  if (SOCIAL_HOSTS.test(host)) return { source: host.split('.')[0], medium: 'social', campaign };
  return { source: host.slice(0, 60), medium: 'referral', campaign };
}

// --- The database, looked after ----------------------------------------------
// The SQLite file is the business: accounts, passes, answers, the wait
// archive. Two things stand between it and a bad day.
//
//   * A copy on the volume, once a day, seven of them in rotation. Made by
//     SQLite itself (VACUUM INTO), so it is consistent even mid-write. This
//     survives a bad deploy or a corrupting bug; it does not survive losing
//     the volume, which is what the download is for.
//   * A download, from the dashboard, for an off-site copy in a click.
const DB_DIR_LIVE = path.dirname(db.DB_FILE);
const DB_PERSISTENT = !db.DB_FILE.startsWith(path.join(__dirname, 'data'));
const COPY_EVERY_MS = 24 * 60 * 60 * 1000;
function copyDatabase() {
  const dest = path.join(DB_DIR_LIVE, `parkpulse-copy-${new Date().getUTCDay()}.sqlite`);
  try {
    try { fs.unlinkSync(dest); } catch {}
    const bytes = db.backup.to(dest);
    db.kv.set('backup:last', JSON.stringify({ at: new Date().toISOString(), bytes, file: path.basename(dest) }));
    console.log(`database copy: ${path.basename(dest)} (${(bytes / 1024).toFixed(0)}KB)`);
    return { dest, bytes };
  } catch (err) {
    console.log(`database copy failed: ${err.message}`);
    return null;
  }
}
if (process.env.DB_COPIES !== 'off') {
  const t = setTimeout(copyDatabase, 2 * 60 * 1000);
  if (typeof t.unref === 'function') t.unref();
  const i = setInterval(copyDatabase, COPY_EVERY_MS);
  if (typeof i.unref === 'function') i.unref();
}
// What an operator needs to know before launch, without reading a deploy log.
function setupFacts() {
  let bytes = null, copies = 0, last = null;
  try { bytes = fs.statSync(db.DB_FILE).size; } catch {}
  try { copies = fs.readdirSync(DB_DIR_LIVE).filter((f) => /^parkpulse-copy-\d\.sqlite$/.test(f)).length; } catch {}
  try { last = JSON.parse(db.kv.get('backup:last') || 'null'); } catch {}
  return {
    // A permanent secret, or passes stop validating on every restart.
    passSecret: Boolean(process.env.PASS_SECRET),
    db: { file: db.DB_FILE, bytes, persistent: DB_PERSISTENT, copies, lastCopy: last },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const host = String(req.headers.host || '').toLowerCase();
  // On every response, set here so a later writeHead() merges rather than
  // replaces them. No Content-Security-Policy: the app is one file with its
  // scripts inline, and a policy loose enough to allow that protects nothing.
  //   * HSTS: a year, subdomains included. Ignored over plain http, which is
  //     what the platform speaks internally, so it costs nothing to send always.
  //   * nosniff: a JSON answer is never run as a script.
  //   * DENY: nothing here is meant to be framed, and a framed login is a
  //     clickjacked one.
  //   * referrer: the path of a plan or a reset link stays on this site.
  res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), payment=()');
  // The platform health probe arrives on an internal hostname, which is by
  // definition not the canonical one -- so the redirect below answered it with
  // a 301. A health check counts anything outside 2xx as a failure, and enough
  // failures take the whole deployment down. It must never be redirected.
  const isHealthProbe = url.pathname === '/api/config' || url.pathname === '/healthz';
  if (CANONICAL_HOST && host && host !== CANONICAL_HOST && !isHealthProbe
      && !host.startsWith('localhost') && !host.startsWith('127.')
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
    // Which features are the write-once catalogue jobs. The dashboard cannot
    // tell from the name -- they are called "ride-tags" and "dining", with
    // nothing in the string to give it away -- and guessing got it wrong.
    return sendJson(res, 200, { ...report, cachedFeatures: [...CACHED_FEATURES], recipient: AI_REPORT_TO, hourET: AI_REPORT_HOUR });
  }

  // Everything the dashboard grew in one request: money, health, funnel,
  // cohorts, what got rate-limited and what deletions are queued.
// What Stripe will actually charge, against what the site says it will.
//
// The catalogue amount is only the sticker: STRIPE_PRICES[plan] wins when set,
// and its amount lives in the Stripe dashboard. So editing a price here moves
// the label and not the charge, and nothing anywhere would have said so. Read
// once an hour, because it changes about never.
let stripePriceCache = { at: 0, rows: null };
let milaPingCache = { at: 0, val: null };
// Whether Mila can actually answer, asked rather than inferred. Everything
// else we hold is indirect: a key being present is not a key being accepted,
// and an empty error log is not the same as a working advisor -- until this,
// her failures were logged to the console and nowhere a person would look.
// Cached for ten minutes, so the dashboard costs a few tokens an hour.
async function milaStatus() {
  if (!consultant.enabled()) return { ok: false, reason: 'no key', detail: 'ANTHROPIC_API_KEY is not set — Mila cannot answer anyone.' };
  if (milaPingCache.val && Date.now() - milaPingCache.at < 600000) return milaPingCache.val;
  let out;
  try {
    const r = await consultant.ping();
    out = { ok: true, model: r.model, ms: r.ms, tiers: r.tiers || null };
  } catch (err) {
    const status = err.status || err.statusCode || null;
    out = {
      ok: false,
      reason: status === 401 || status === 403 ? 'key rejected'
        : status === 429 ? 'rate limited'
        : status === 400 && /credit|balance|quota/i.test(err.message || '') ? 'out of credit'
        // A key can be perfectly valid and still not be allowed the tier the
        // advisor speaks on. It reads as "not found", which sounds like our
        // bug and is not -- it is a permission, and it is fixed in the
        // Anthropic console, so say so rather than filing it under 'failed'.
        : status === 404 || (/model/i.test(err.message || '') && /not.?found|access|permission/i.test(err.message || '')) ? 'model unavailable'
        : status >= 500 ? 'upstream down' : 'failed',
      detail: String(err.message).slice(0, 160),
      // Even when the advisor itself is down, say what the other tiers did --
      // "everything is broken" and "one entitlement is missing" need very
      // different fixes.
      tiers: err.tiers || null,
    };
  }
  milaPingCache = { at: Date.now(), val: out };
  return out;
}

let stripeStatusCache = { at: 0, val: null };
// Is Stripe actually answering?
//
// A set key is not a connected key. STRIPE_SECRET_KEY being present tells you
// only that somebody pasted something into an env var -- a revoked key, a
// typo, or a test key on a live site all look exactly the same from the
// outside, and the first two mean every buyer gets an error at the till.
// Nothing else here notices: the price check only calls Stripe when a
// STRIPE_PRICE_* id is configured, so with the inline prices we ship by
// default the API is never touched until a real customer tries to pay.
//
// So this asks Stripe directly, and reports the account it reached. Test mode
// is called out separately because a test key sells nothing while looking
// perfectly healthy.
async function stripeStatus() {
  if (!STRIPE_KEY) return { connected: false, reason: 'no key', detail: 'STRIPE_SECRET_KEY is not set — the site cannot take a payment.' };
  if (stripeStatusCache.val && Date.now() - stripeStatusCache.at < 300000) return stripeStatusCache.val;
  let out;
  try {
    const bal = await stripeApi('/v1/balance');
    out = {
      connected: true,
      live: bal.livemode === true,
      // The currencies Stripe holds a balance in, which is a cheap way to see
      // the account is the one you think it is.
      currencies: (bal.available || []).map((a) => String(a.currency || '').toUpperCase()).filter(Boolean),
    };
  } catch (err) {
    // The message is the diagnosis: "Invalid API Key provided", "Expired API
    // Key", a network timeout. Passing it through beats inventing our own.
    out = { connected: false, reason: 'rejected', detail: String(err.message).slice(0, 160) };
  }
  stripeStatusCache = { at: Date.now(), val: out };
  return out;
}

async function stripePriceCheck() {
  if (!STRIPE_KEY) return { mode: 'inline', note: 'No Stripe key: the catalogue amount is charged directly, so it cannot disagree with itself.', rows: [] };
  if (stripePriceCache.rows && Date.now() - stripePriceCache.at < 3600000) return stripePriceCache.rows;
  const rows = [];
  for (const cat of PLAN_CATALOG) {
    const id = STRIPE_PRICES[cat.id];
    if (!id) { rows.push({ plan: cat.id, shown: Number(cat.usd), charged: Number(cat.usd), source: 'inline', ok: true }); continue; }
    try {
      const price = await stripeApi(`/v1/prices/${encodeURIComponent(id)}`);
      const charged = (price.unit_amount ?? 0) / 100;
      rows.push({ plan: cat.id, shown: Number(cat.usd), charged, source: 'stripe', ok: Math.abs(charged - Number(cat.usd)) < 0.005 });
    } catch (err) {
      rows.push({ plan: cat.id, shown: Number(cat.usd), charged: null, source: 'stripe', ok: false, error: String(err.message).slice(0, 100) });
    }
  }
  const out = { mode: 'stripe', rows, mismatches: rows.filter((r) => !r.ok).length };
  stripePriceCache = { at: Date.now(), rows: out };
  return out;
}

  // What is left of this account's day with Mila. Cheap, and the app asks for
  // it when she declines rather than on every page load.
  if (req.method === 'GET' && url.pathname === '/api/mila/budget') {
    const s2 = sessionUser(req);
    if (!s2) return sendJson(res, 401, { error: 'not logged in' });
    const b = aiBudgetState(s2.email);
    return sendJson(res, 200, {
      ok: b.ok, reason: b.ok ? null : b.reason,
      spent: Math.round(b.spent * 100) / 100,
      budget: Math.round(b.budget * 100) / 100,
      credit: Math.round((b.credit || 0) * 100) / 100,
      ...(b.passBudget != null && { passSpent: Math.round(b.passSpent * 100) / 100, passBudget: b.passBudget }),
      topUp: MILA_TOPUP_ENABLED ? { usd: MILA_TOPUP_USD, label: MILA_TOPUP_LABEL } : null,
    });
  }

  // The database, as a file, for an off-site copy. A consistent snapshot made
  // by SQLite into a temporary file beside the live one, streamed, removed.
  if (req.method === 'GET' && url.pathname === '/api/admin/backup') {
    if (!adminUser(req)) return sendJson(res, 403, { error: 'admin account required' });
    const tmp = path.join(DB_DIR_LIVE, `parkpulse-download-${process.pid}-${Date.now()}.sqlite`);
    try {
      const bytes = db.backup.to(tmp);
      res.writeHead(200, {
        'content-type': 'application/vnd.sqlite3',
        'content-length': bytes,
        'content-disposition': `attachment; filename="parkpulse-${new Date().toISOString().slice(0, 10)}.sqlite"`,
        'cache-control': 'no-store',
      });
      const stream = fs.createReadStream(tmp);
      stream.on('close', () => { try { fs.unlinkSync(tmp); } catch {} });
      stream.on('error', () => { try { fs.unlinkSync(tmp); } catch {} res.end(); });
      return stream.pipe(res);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      return sendJson(res, 500, { error: `could not snapshot the database: ${err.message}` });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/ops') {
    if (!adminUser(req)) return sendJson(res, 403, { error: 'admin account required' });
    const aiDay = etNow().date;
    const ai = aiCostReport(aiDay);
    const rev = revenueReport();
    // Cost and revenue over the same window, which is the only way the
    // difference between them means anything.
    const margin = (r, a) => ({
      revenue: r.usd, cost: a.running_usd,
      net: Math.round((r.usd - a.running_usd) * 100) / 100,
      perAccount: r.accounts ? Math.round((r.usd - a.running_usd) / r.accounts * 100) / 100 : null,
    });
    const now = Date.now();
    const parks = REGISTRY.map((p) => {
      const u = upstream.parks[p.slug];
      return {
        slug: p.slug, name: p.name,
        source: u?.source || 'unknown',
        idResolved: p.id != null,
        ageMin: u?.at ? Math.round((now - u.at) / 60000) : null,
        okAgeMin: u?.okAt ? Math.round((now - u.okAt) / 60000) : null,
        // Whether this park has a net under it at all, and how old it is.
        backupAgeMin: storedAgeMin(p.slug),
        error: u?.error || null,
      };
    });
    return sendJson(res, 200, {
      revenue: {
        ...rev,
        margin: { today: margin(rev.today, ai.today), week: margin(rev.week, ai.week), month: margin(rev.month, ai.month) },
      },
      // Can Mila answer at all, and is there budget left for her to do it?
      // The two are separate failures that look identical to a reader.
      mila: {
        ...(await milaStatus()),
        spentToday: Math.round((db.aiusage.totalOn(etNow().date) || 0) * 100) / 100,
        dailyCap: AI_GLOBAL_DAILY_USD,
        // Answering, but not on the tier she is supposed to. The probe above
        // can pass and this still be set: a tier that fails intermittently
        // answers the eight-token ping and drops a real conversation.
        fallback: lastFallback && Date.now() - lastFallback.at < 6 * 60 * 60 * 1000 ? lastFallback : null,
      },
      health: {
        parks,
        // Only parks actually asked for since boot have a verdict; the rest
        // are "unknown", which is honest -- nobody has looked.
        summary: parks.reduce((a, p) => { a[p.source] = (a[p.source] || 0) + 1; return a; }, Object.create(null)),
        services: Object.fromEntries(Object.entries(upstream.services).map(([k, v]) => [k, {
          ...v,
          okAgeMin: v.okAt ? Math.round((now - v.okAt) / 60000) : null,
          failAgeMin: v.failAt ? Math.round((now - v.failAt) / 60000) : null,
        }])),
        uptimeMin: Math.round(process.uptime() / 60),
      },
      setup: setupFacts(),
      traffic: (() => {
        const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const t = db.visits.totals(since);
        return {
          people: t.people, bots: t.bots,
          bySource: db.visits.bySource(since).slice(0, 12),
          bots_by: db.visits.bySource(since, { bots: true }).slice(0, 8),
          campaigns: db.visits.byCampaign(since).slice(0, 8),
          landing: db.visits.topLanding(since, 8),
          signups: db.admin.signupsBySource(30),
        };
      })(),
      // The top of the funnel is page views, not people -- hits counts requests
      // and nothing here de-duplicates a visitor. Labelled as views on the
      // dashboard for that reason; the rate below it is the honest one.
      funnel: {
        d30: db.admin.funnel(30),
        appViews30d: db.hits.totals(30).filter((h) => h.path === '/app').reduce((a, h) => a + h.n, 0),
      },
      cohorts: db.admin.cohorts(6),
      rateBlocks,
      // The accounts costing the most today, so a runaway is visible before
      // it is a line on the invoice.
      topSpenders: db.aispend.topOn(etNow().date, 8).map((r) => ({
        email: r.email, usd: Math.round(r.usd * 100) / 100, calls: r.calls,
        budget: Math.round(aiBudgetFor(db.users.get(r.email)) * 100) / 100,
      })),
      // Whether visitors are still being told the product has not launched.
      // Reported here because the failure mode is silence: the strip says the
      // same thing forever and nobody who works on the site ever sees it,
      // having dismissed it on day one.
      comingSoon: COMING_SOON,
      // Whether anyone is being asked to pay at all. PRO_GATE defaults to off,
      // which is right for a launch preview and silently wrong forever after:
      // nothing in the product says "you are giving this away", and the only
      // symptom is a revenue line that stays at zero for reasons that look
      // like a marketing problem.
      proGate: PRO_GATE,
      freePark: FREE_PARK,
      planCount: PLAN_CATALOG.length,
      stripe: await stripeStatus(),
      pricing: await stripePriceCheck(),
      budgets: { free: AI_BUDGET_FREE, byPlan: { ...AI_BUDGET_USD }, globalDaily: AI_GLOBAL_DAILY_USD, spentToday: db.aiusage.totalOn(etNow().date) },
      deletions: db.admin.pendingDeletions().map((d) => ({ email: d.email, at: d.delete_at, inDays: Math.round((d.delete_at - now) / 86400000) })),
      alerts: { ceilingUsd: AI_ALERT_USD, multiple: AI_ALERT_MULTIPLE, floorUsd: AI_ALERT_FLOOR_USD, to: AI_REPORT_TO },
    });
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
      comingSoon: COMING_SOON,
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
      // Whether THIS caller is through the gate at all, by any route: a pass
      // in the header, a pass on the account, or an admin looking at their own
      // product. The client used to work this out for itself from the pass
      // token alone, which meant the admin bypass added server-side was
      // invisible to the UI -- the API would have answered, but the paywall
      // went up before anything was asked.
      access: hasAccess(req),
      // The Terms the signup box is currently agreeing to, so the page and the
      // recorded consent name the same wording.
      termsVersion: TERMS_VERSION,
      marketingWording: MARKETING_WORDING,
      whatsapp: WA_ENABLED && Boolean(WA_NUMBER),
      // Whether more of Mila's time can be bought at all. Without it a visitor
      // who runs out is told no with nowhere to go, which is worse than not
      // mentioning it.
      milaTopUp: MILA_TOPUP_ENABLED ? { usd: MILA_TOPUP_USD, label: MILA_TOPUP_LABEL } : null,
      // Only the providers that are actually configured, so the buttons never
      // appear for a sign-in that cannot complete.
      oauth: oauth.list(),
      pushKey: vapidKeys.publicKey,
      parks: Object.fromEntries(REGISTRY.map((p) => [p.slug, { name: p.name, group: p.group, region: p.region, open: p.open, close: p.close, show: p.show, skip: p.skip, lat: p.lat, lng: p.lng, tz: p.tz }])),
      popular: PICKER_TOP.filter((slug) => PARKS[slug]),
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
      marketing: s.user.marketing_ok === 1,
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
  if (req.method === 'GET' && /^\/(app|guide|welcome|soon|reset|terms|privacy|parks\/[a-z-]+)?$/.test(url.pathname)) {
    try { db.hits.bump(url.pathname || '/'); } catch {}
    try {
      const v = visitSource(req, url);
      db.visits.bump(etNow().date, v.source, v.medium, v.campaign, (url.pathname || '/').slice(0, 60));
    } catch {}
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
      nps90d: db.nps.summary(90),
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
  // The landing page in each supported language. English stays at "/" as the
  // canonical; every other language is its own indexable URL (/es, /fr, ...)
  // rather than a client-side swap, so search engines see real translated
  // pages and visitors never watch the copy change under them.
  const landingLang = url.pathname === '/' || url.pathname === '/index.html'
    ? 'en'
    : (LANDING_LANGS.includes(url.pathname.slice(1)) ? url.pathname.slice(1) : null);
  if (landingLang) {
    let board = '';
    try { board = heroBoardHtml(await heroBoardPanels()); } catch (err) { console.log(`hero board: ${err.message}`); }
    let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
      .replace('<!--COMING_SOON-->', () => comingSoonStrip())
      .replace('<!--HERO_BOARD-->', () => board)
      .replace('<!--HERO_PHOTO-->', () => heroPhoto())
      .replace('<!--VIP_PHOTO-->', () => vipPhoto())
      .replace('<!--PHOTO_BAND-->', () => photoBand())
      .replace('<!--CAPTURE_BG-->', () => captureStyle())
      .replace('<!--PARK_GUIDES-->', () => parkGuides(REGISTRY))
      .replace('<!--LANGUAGES-->', () => languageCards())
      .replace('<!--SHOTS-->', () => productShots());
    html = localizeLanding(html, landingLang);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // The complete Queue-Times park directory, fetched server-side and annotated
  // with ParkPulse coverage — the shopping list for "which park do we add
  // next". Server-side because this host can reach queue-times.com while the
  // development sandbox (and some visitors' networks) cannot. noindex: it is
  // an internal tool, not content.
  if (url.pathname === '/qt-directory') {
    if (!qtDirCache.html || Date.now() - qtDirCache.at > 60 * 60 * 1000) {
      try {
        const r = await fetch('https://queue-times.com/parks.json', {
          signal: AbortSignal.timeout(10000),
          headers: { 'user-agent': 'ParkPulse/0.1 (directory view with attribution)' },
        });
        if (!r.ok) throw new Error(`upstream ${r.status}`);
        const companies = await r.json();
        const ours = new Map(REGISTRY.filter((p) => p.id != null).map((p) => [p.id, p]));
        let total = 0, covered = 0;
        const sections = companies.map((c) => {
          const rows = (c.parks || []).map((p) => {
            total += 1;
            const mine = ours.get(p.id);
            if (mine) covered += 1;
            return `<li class="${mine ? 'have' : 'miss'}">${esc(p.name)} <small>#${p.id}${mine ? ` &middot; tracked as ${esc(mine.slug)}` : ''}</small></li>`;
          }).join('');
          return `<section><h2>${esc(c.name)} <small>${(c.parks || []).length}</small></h2><ul>${rows}</ul></section>`;
        }).join('');
        qtDirCache = { at: Date.now(), html: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Queue-Times directory — ParkPulse coverage</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:900px;margin:0 auto;padding:2rem 1.2rem;color:#1c1630}
h1{font-size:1.5rem}h2{font-size:1.05rem;margin:1.6rem 0 .4rem}h2 small{color:#888;font-weight:400}
ul{margin:0;padding:0;list-style:none;columns:2 320px;column-gap:2rem}
li{padding:.15rem 0;break-inside:avoid}li small{color:#888}
li.have{color:#1d7a4f}li.have::before{content:"✓ "}li.miss::before{content:"· ";color:#bbb}
.sum{background:#f0edff;border-radius:10px;padding:.8rem 1rem;margin:1rem 0}
.bad{background:#fdeaea;border:1px solid #f3c2c2;border-radius:10px;padding:.8rem 1rem;margin:1rem 0}
.bad ul{columns:1;margin:.5rem 0 0}.bad li{padding:.2rem 0}.bad code{background:#fff;padding:.05rem .3rem;border-radius:4px}
.warn{background:#fff6e5;border:1px solid #f0d9a8;border-radius:10px;padding:.8rem 1rem;margin:1rem 0}
.warn ul{columns:1;margin:.5rem 0 0}</style></head><body>
<h1>Queue-Times park directory</h1>
<div class="sum"><b>${total} parks</b> in the Queue-Times feed &middot; <b>${covered} tracked by ParkPulse</b> (green) &middot; ${total - covered} not yet covered.</div>
${resolutionPanel()}
${sections}
<p>Data powered by <a href="https://queue-times.com" rel="nofollow">Queue-Times.com</a>. Snapshot cached for 1 hour.</p>
</body></html>` };
      } catch (err) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(`Could not reach the Queue-Times directory right now (${err.message}). Try again in a minute.`);
      }
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, max-age=300' });
    return res.end(qtDirCache.html);
  }

  // The landing hero board re-picked for the visitor's timezone. Public on
  // purpose and deliberately tiny — top waits for up to three parks chosen
  // server-side from the tz, the same teaser the landing page already renders.
  if (url.pathname === '/api/hero-board') {
    let board = '';
    try { board = heroBoardHtml(await heroBoardPanels(tzHeroParks(url.searchParams.get('tz')))); }
    catch (err) { console.log(`hero board api: ${err.message}`); }
    // The landing swaps this board in over the server-rendered one, so on a
    // translated page an untranslated reply put English back on screen.
    const bl = url.searchParams.get('lang');
    if (bl && bl !== 'en' && LANDING_I18N[bl]) board = translateMarkup(board, LANDING_I18N[bl]);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, max-age=120' });
    return res.end(board);
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
    return res.end(isMap
      ? pages.renderSitemap(origin, REGISTRY.map((p) => p.slug),
          REGISTRY.map((p) => ({ slug: p.slug, personas: premade.PERSONAS.filter((x) => !x.needsTags).map((x) => x.slug) })),
          // The same list the hreflang alternates are built from, so the two
          // can never disagree about which languages exist.
          LANDING_LANGS.filter((l) => l !== 'en'))
      : pages.renderRobots(origin));
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
    // Recently failed: say so now rather than making them wait out the poll
    // for an answer that is not coming.
    const failed = diningFails.get(jobKey);
    if (failed && Date.now() - failed.at < DINING_FAIL_COOLDOWN_MS && !diningJobs.has(jobKey)) {
      return sendJson(res, 503, { error: 'dining guide unavailable', reason: failed.error });
    }
    if (!diningJobs.has(jobKey)) {
      if (rideInfoBlocked(clientIp(req))) return sendJson(res, 429, { error: 'slow down' });
      const job = consultant.diningGuide(park.name, park.group, LANG_NAMES[langCode])
        .then((list) => {
          if (list && list.length) {
            db.dining.set(slug, langCode, JSON.stringify(list));
            diningFails.delete(jobKey);
          } else {
            // A guide with nothing in it is a failure with better manners.
            console.log(`dining: empty guide for ${jobKey}`);
            diningFails.set(jobKey, { at: Date.now(), error: 'the guide came back empty' });
          }
        })
        .catch((err) => {
          console.log(`dining error (${jobKey}): ${err.message}`);
          diningFails.set(jobKey, { at: Date.now(), error: String(err.message).slice(0, 120) });
          // The health panel exists to make exactly this visible: nothing
          // errors loudly when a catalogue job stops working, the feature
          // just quietly never fills in.
          upstream.service(AI_TIER(CATALOG_MODEL_NAME), false, err.message);
        })
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
      upstream.service(AI_TIER(CATALOG_MODEL_NAME), false, err.message);
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

  // --- Sign in with Google / Apple -------------------------------------------
  // Authorization-code flow, finished on this side. Two rules do most of the
  // security work here:
  //
  //   * accounts are matched on the provider's SUBJECT, never on the address.
  //     Emails change hands; a subject does not.
  //   * an address is only ever attached to an existing ParkPulse account when
  //     the provider says it verified it. Otherwise anyone able to set an
  //     unverified email at a provider could walk into somebody's account.
  const oauthMatch = url.pathname.match(/^\/api\/auth\/oauth\/([a-z]+)\/(start|callback)$/);
  if (oauthMatch && (req.method === 'GET' || req.method === 'POST')) {
    const [, provider, leg] = oauthMatch;
    if (!oauth.enabled(provider)) return sendJson(res, 404, { error: 'provider not configured' });
    if (ipLimited(req, 'oauth', 600)) return sendJson(res, 429, { error: 'too many sign-in attempts from this connection' });
    // The redirect must match what is registered at the provider to the
    // character, so it is derived once and used for both legs.
    const base = OAUTH_REDIRECT_BASE || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    const redirectUri = `${base}/api/auth/oauth/${provider}/callback`;

    if (leg === 'start') {
      // No device, no login: the claim is bound to it, and a blank one would
      // bind to nothing.
      const device = String(url.searchParams.get('device') || '').trim().slice(0, 64);
      if (!device || device === 'unknown') {
        res.writeHead(302, { location: '/app#autherr=' + encodeURIComponent('sign-in could not start on this device'), 'cache-control': 'no-store' });
        return res.end();
      }
      const nonce = crypto.randomBytes(16).toString('hex');
      // The state is signed and carries everything the callback needs, so
      // nothing has to be remembered between the two legs.
      const state = signToken({ k: 'oauth', provider, device, nonce, exp: Date.now() + 10 * 60 * 1000 });
      res.writeHead(302, { location: oauth.authorizeUrl(provider, { redirectUri, state, nonce }), 'cache-control': 'no-store' });
      return res.end();
    }

    // Apple posts the callback as a form when name or email is requested;
    // Google redirects with a query string. Accept both.
    const fields = await (async () => {
      if (req.method === 'GET') return url.searchParams;
      let body = '';
      await new Promise((done) => {
        req.on('data', (c) => { body += c; if (body.length > 16384) req.destroy(); });
        req.on('end', done);
        req.on('error', done);
      });
      return new URLSearchParams(body);
    })();

    const back = (params) => {
      res.writeHead(302, { location: `/app#${new URLSearchParams(params)}`, 'cache-control': 'no-store' });
      res.end();
    };
    try {
      const st = verifyToken(fields.get('state'));
      if (!st || st.k !== 'oauth' || st.provider !== provider) throw new Error('login expired — please try again');
      // Say that it failed, not what the caller wrote. Everything on this
      // request is attacker-supplied, and a valid state is free to obtain --
      // hit the start leg and read it out of the redirect. Reflecting
      // error_description would let a crafted link put any sentence of its
      // choosing in front of the reader, inside our own toast: no script (the
      // toast sets textContent), but a fine place to ask them to ring a
      // "support" number. The real text goes to the log instead.
      if (fields.get('error')) {
        console.log(`${provider} returned an error: ${String(fields.get('error_description') || fields.get('error')).slice(0, 200)}`);
        throw new Error('that sign-in did not complete — please try again');
      }
      const code = fields.get('code');
      if (!code) throw new Error('no authorisation code came back');

      const tokens = await oauth.exchange(provider, { code, redirectUri });
      const claims = await oauth.verifyIdToken(provider, tokens.id_token, { nonce: st.nonce });
      // Apple sends the name exactly once, on first authorisation, in its own
      // form field. There is no second chance to ask.
      let hint = '';
      try { hint = JSON.parse(fields.get('user') || '{}')?.name?.firstName || ''; } catch {}
      const id = oauth.identityFrom(claims, hint);

      let email = db.identities.get(provider, id.subject)?.email || '';
      // Whether this login brought a brand-new ParkPulse account into being.
      // The app needs to know: a first-ever sign-up is asked about its party,
      // and a provider sign-up was skipping that, leaving Mila planning for a
      // group she had never been told about.
      let created = false;
      if (!email) {
        if (!id.email) throw new Error('that account did not share an email address');
        if (!id.emailVerified) throw new Error('that email is not verified with the provider — sign in with a code instead');
        email = id.email.slice(0, 254);
        const existing = db.users.get(email);
        if (!existing) {
          // No password: this account is reached through the provider. A
          // random one keeps the column honest and unguessable, and "forgot
          // password" still works if they ever want one.
          const salt = crypto.randomBytes(16).toString('hex');
          db.users.create(email, salt, hashPassword(crypto.randomBytes(32).toString('hex'), salt), 1);
          created = true;
          if (id.name) db.users.setName(email, cleanFirstName(id.name).name);
          sendWelcomeEmail(email).catch((err) => console.log(`welcome email failed: ${err.message}`));
        } else {
          // Joining a provider to an account that already existed. Safe only
          // because the provider verified the address above.
          if (!existing.verified) db.users.markVerified(email);
          if (!existing.name && id.name) db.users.setName(email, cleanFirstName(id.name).name);
        }
        db.identities.link(provider, id.subject, email);
      }
      if (db.users.get(email)?.delete_at) {
        db.users.cancelDeletion(email);
        console.log(`account deletion cancelled by ${provider} sign-in: ${email}`);
      }
      // The session is not handed over in the URL. A one-time code is, and
      // the app trades it in over POST -- so a token never lands in history,
      // a referrer, or somebody's screenshot.
      const claim = crypto.randomBytes(24).toString('base64url');
      db.kv.set(`oauthclaim:${claim}`, JSON.stringify({ email, device: st.device, created, exp: Date.now() + 2 * 60 * 1000 }));
      console.log(`${provider} sign-in: ${email}`);
      return back({ auth: claim });
    } catch (err) {
      console.log(`${provider} sign-in failed: ${err.message}`);
      return back({ autherr: String(err.message).slice(0, 160) });
    }
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
        const langCode = LANG_NAMES[parsed.lang] ? parsed.lang : 'en';
        const lang = LANG_NAMES[langCode];
        // Date the email for the day being planned, not the day it is sent.
        // A plan built for Wednesday and headed "Monday" is wrong twice over:
        // in the header the reader sees, and in the note the model writes.
        const planDateRaw = typeof parsed.planDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.planDate) ? parsed.planDate : null;
        const dayFmt = new Intl.DateTimeFormat(langCode, { weekday: 'long', month: 'long', day: 'numeric', timeZone: planDateRaw ? 'UTC' : park.tz });
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
        const flavor = await planEmailFlavor(park, planDateRaw || todayAtPark, langCode);
        const html = planEmailHtml({ park, day, dateIso: planDateRaw, stops, kpis, savedMin, briefing, profile, firstName, future, flavor, lang: langCode });
        try {
          // "18 attractions, 0 km" went out to a real inbox: the km figure is
          // only real when the route was actually measured. Lead with the two
          // numbers that always are.
          const firstRide = stops.find((st) => st.name && st.time);
          const ts = T(langCode);
          const subject = future
            ? fmt(ts('Your {park} plan for {day} — {n} attractions'), { park: park.name, day: String(day).split(',')[0], n: kpis.attractions })
            : fmt(ts('Your {park} plan — {n} attractions'), { park: park.name, n: kpis.attractions });
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
      // Mila's standing line. The client decides WHETHER anything changed --
      // it already has the live waits and the plan on screen -- and sends the
      // change plus a few facts. This turns that into one sentence in her
      // voice. Everything else the strip says is written locally and costs
      // nothing.
      if (url.pathname === '/api/live-nudge') {
        const s = sessionUser(req);
        if (!s) return sendJson(res, 401, { error: 'log in first' });
        if (!consultant.enabled()) return sendJson(res, 503, { error: 'not available' });
        // A hard ceiling that does not depend on the client behaving. A stuck
        // page asking every twenty seconds instead of every twenty minutes
        // would otherwise bill for it, and the visitor would never know.
        if (accountLimited(req, 'live-nudge', LIVE_NUDGE_CAP, 12 * 3600000)) {
          return sendJson(res, 429, { error: 'enough for now' });
        }
        // The strip is the least valuable thing Mila spends on, so it is the
        // first to go quiet: it already has a local line to fall back on, and
        // a visitor out of budget should keep their questions, not their
        // decorations.
        if (!aiBudgetState(s.email).ok) return sendJson(res, 200, { text: null });
        const park = PARKS[parsed.park];
        if (!park) return sendJson(res, 400, { error: 'unknown park' });
        const headline = typeof parsed.headline === 'string' ? parsed.headline.trim().slice(0, 200) : '';
        if (!headline) return sendJson(res, 400, { error: 'nothing to say' });
        const facts = strList(parsed.facts, 6).map((f) => String(f).slice(0, 160));
        const lang = LANG_NAMES[typeof parsed.lang === 'string' ? parsed.lang : 'en'] || 'English';
        try {
          const text = await consultant.liveNudge({
            parkName: park.name, lang, headline, facts,
            name: db.users.get(s.email)?.name || null,
            billTo: s.email,
          });
          return sendJson(res, 200, { text: text || null });
        } catch (err) {
          console.log(`live nudge failed: ${err.message}`);
          return sendJson(res, 200, { text: null });   // the strip falls back to its local line
        }
      }

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
          // Rides ruled out. The agent needs these as much as the favourites:
          // suggesting something the family has already said no to is worse
          // than suggesting nothing.
          excluded: strList(d.excluded, 40),
          lanePasses: strList(d.lanePasses, 30),
          // Whitelisted like everything else: a plain date or nothing.
          planDate: typeof d.planDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.planDate) ? d.planDate : null,
        });
        // Picking rides is the moment an account stops being a signup and
        // starts being a user. It is the middle of the funnel and nothing
        // recorded it; the column only ever fills once.
        if (strList(d.picked, 30).length) { try { db.admin.markFirstPlan(s.email); } catch {} }
        return sendJson(res, 200, { ok: true });
      }

      // The browser has been carrying this since that visitor's very first page
      // view. Whitelisted like everything else that arrives from a client.
      const firstTouchOf = (v) => {
        const c = (x, n) => String(x || '').trim().toLowerCase().replace(/[^\w .-]+/g, '').slice(0, n);
        if (!v || typeof v !== 'object') return null;
        const source = c(v.source, 60);
        return source ? { source, medium: c(v.medium, 24) || 'direct', campaign: c(v.campaign, 40) } : null;
      };

      if (url.pathname === '/api/auth/signup' || url.pathname === '/api/auth/login') {
        // Loose on purpose: a park's wifi is one address for everybody in the
        // building, so this is set to stop a script and nothing else. The
        // strict per-address limits live in verifyBlocked/forgotBlocked.
        if (ipLimited(req, 'auth', 600)) return sendJson(res, 429, { error: 'too many attempts from this connection — try again shortly' });
        const email = typeof parsed.email === 'string' ? parsed.email.trim().toLowerCase().slice(0, 254) : '';
        const password = typeof parsed.password === 'string' ? parsed.password : '';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: 'invalid email' });

        if (url.pathname === '/api/auth/signup') {
          if (password.length < 8) return sendJson(res, 400, { error: 'password must be at least 8 characters' });
          // Checked here as well as in the browser. A tick only the page
          // enforces is a rendering choice, not consent -- and this endpoint is
          // reachable without the page.
          if (parsed.terms !== true) return sendJson(res, 400, { error: 'please accept the terms to create an account' });
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
          const ft = firstTouchOf(parsed.src);
          if (ft) { try { db.admin.attribute(email, ft.source, ft.medium, ft.campaign); } catch {} }
          db.users.setName(email, asked.name);
          // Written once, on first acceptance, and never overwritten: what
          // matters later is the version they agreed to at the time, not the
          // one current when they happened to retry.
          try { db.users.acceptTerms(email, TERMS_VERSION); } catch {}
          // Separate from the terms, and a decline is recorded as firmly as an
          // acceptance -- "never asked" and "asked and said no" are different
          // facts, and only the first can be re-asked in good conscience.
          try { db.users.setMarketing(email, parsed.marketing === true, MARKETING_WORDING); } catch {}
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

      // The other half of the provider flow: the app trades the one-time code
      // from the redirect for a real session. Single use, two-minute life, and
      // bound to the device that started the login.
      if (url.pathname === '/api/auth/oauth/claim') {
        if (ipLimited(req, 'oauth', 600)) return sendJson(res, 429, { error: 'too many sign-in attempts from this connection' });
        const code = typeof parsed.code === 'string' ? parsed.code.slice(0, 64) : '';
        const key = `oauthclaim:${code}`;
        // Delete rather than blank, and only when the row was really there.
        // Writing an empty value did two bad things: it kept a tombstone for
        // every sign-in that ever happened, and because the write was an
        // upsert it CREATED a row for a code that had never been issued --
        // so anyone could grow the table by posting junk at this endpoint,
        // with no account and no rate limit in the way.
        const raw = code ? db.kv.get(key) : null;
        if (raw !== null) db.kv.del(key);         // spent, whatever happens next
        let held = null;
        try { held = JSON.parse(raw || 'null'); } catch {}
        if (!held || !held.email || held.exp < Date.now()) return sendJson(res, 403, { error: 'that sign-in link has expired — try again' });
        // The device must match, with no exception. The escape hatch for
        // 'unknown' was one: the start leg takes ?device= from the caller, so
        // anyone could begin a login as 'unknown', finish it with their own
        // provider account, and hand the resulting code to a victim -- whose
        // app would claim it and sign them into the attacker's account.
        const device = typeof parsed.device === 'string' ? parsed.device.trim().slice(0, 64) : '';
        if (!device || device !== held.device) {
          return sendJson(res, 403, { error: 'that sign-in was started on another device' });
        }
        if (held.created) {
          const c = (x, n) => String(x || '').trim().toLowerCase().replace(/[^\w .-]+/g, '').slice(0, n);
          const src = parsed.src && typeof parsed.src === 'object' ? parsed.src : null;
          if (src && c(src.source, 60)) {
            try { db.admin.attribute(held.email, c(src.source, 60), c(src.medium, 24) || 'direct', c(src.campaign, 40)); } catch {}
          }
        }
        const bound = passFromReq(req);
        if (bound) grantToUser(held.email, bound.plan, bound.exp);
        const u = db.users.get(held.email);
        if (!u) return sendJson(res, 403, { error: 'account not found' });
        const active = accountPassActive(u);
        return sendJson(res, 200, {
          session: issueSession(held.email, parsed.device, req),
          email: held.email,
          // So the app can treat a first sign-in like a sign-up.
          created: Boolean(held.created),
          name: u.name || null,
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
        // A till that cannot take money should not open. Without a key, with a
        // key Stripe rejects, or with a TEST key on the live site, every card
        // is declined -- so the buyer gets the coming-soon page and a chance to
        // leave an address instead of an error they can do nothing about.
        //
        // Gated on what Stripe actually answers rather than on a flag, so it
        // stops diverting by itself the moment a live key lands. There is no
        // second switch to remember.
        const till = await stripeStatus();
        if (!till.connected || !till.live) {
          const plan = typeof parsed.plan === 'string' ? parsed.plan.replace(/[^a-z0-9-]/gi, '').slice(0, 40) : '';
          console.log(`checkout diverted to /soon: ${till.connected ? 'test-mode key' : till.detail || 'no key'}`);
          return sendJson(res, 200, { soon: `/soon${plan ? `?plan=${encodeURIComponent(plan)}` : ''}` });
        }
        const plan = parsed.plan;
        const cat = PLAN_CATALOG.find((p) => p.id === plan);
        if (!cat && !STRIPE_PRICES[plan]) return sendJson(res, 400, { error: 'unknown plan' });
        const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
        // A dashboard-created Price wins when configured; otherwise the
        // catalog amount ships inline, so a bare STRIPE_SECRET_KEY sells.
        const priceParams = STRIPE_PRICES[plan]
          ? { 'line_items[0][price]': STRIPE_PRICES[plan] }
          : {
            'line_items[0][price_data][currency]': 'usd',
            'line_items[0][price_data][unit_amount]': String(Math.round(Number(cat.usd) * 100)),
            'line_items[0][price_data][product_data][name]': `ParkPulse ${cat.label}`,
            'line_items[0][price_data][product_data][description]': `All 65 parks, the AI planner and Mila for ${cat.per} — one-time, no subscription.`,
          };
        // Logged-in buyers get their email prefilled, and the claim on
        // /welcome attaches the pass to the same account.
        const buyer = sessionUser(req);
        try {
          const session = await stripeApi('/v1/checkout/sessions', {
            mode: 'payment',
            ...priceParams,
            'line_items[0][quantity]': '1',
            'metadata[plan]': plan,
            allow_promotion_codes: 'true',
            ...(buyer && { customer_email: buyer.email }),
            success_url: `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${origin}/#pricing`,
          });
          return sendJson(res, 200, { url: session.url });
        } catch (err) {
          console.log(`checkout: ${err.message}`);
          return sendJson(res, 502, { error: 'checkout failed' });
        }
      }

      // Buying more of Mila's time. Deliberately its own product rather than a
      // pass: it grants model credit, not access, and it must not extend a
      // pass's expiry by accident.
      if (url.pathname === '/api/mila/topup') {
        if (!MILA_TOPUP_ENABLED) return sendJson(res, 503, { error: 'top-ups not configured' });
        const buyer = sessionUser(req);
        if (!buyer) return sendJson(res, 401, { error: 'log in first' });
        const origin = OAUTH_REDIRECT_BASE || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
        try {
          const session = await stripeApi('/v1/checkout/sessions', {
            mode: 'payment',
            'line_items[0][price]': MILA_TOPUP_PRICE,
            'line_items[0][quantity]': '1',
            'metadata[kind]': 'mila-topup',
            'metadata[email]': buyer.email,
            customer_email: buyer.email,
            success_url: `${origin}/app?mila_topup={CHECKOUT_SESSION_ID}`,
            cancel_url: `${origin}/app`,
          });
          return sendJson(res, 200, { url: session.url });
        } catch (err) {
          console.log(`mila top-up checkout: ${err.message}`);
          return sendJson(res, 502, { error: 'checkout failed' });
        }
      }

      if (url.pathname === '/api/mila/topup/claim') {
        if (!MILA_TOPUP_ENABLED) return sendJson(res, 503, { error: 'top-ups not configured' });
        const buyer = sessionUser(req);
        if (!buyer) return sendJson(res, 401, { error: 'log in first' });
        const sessionId = parsed.session_id;
        if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return sendJson(res, 400, { error: 'invalid session' });
        // Credit is money, so unlike a pass this is NOT idempotent by replay:
        // claiming the same checkout twice must not grant it twice.
        const spentKey = `topup:${sessionId}`;
        try {
          const session = await stripeApi(`/v1/checkout/sessions/${sessionId}`);
          if (session.payment_status !== 'paid' || session.metadata?.kind !== 'mila-topup') {
            return sendJson(res, 402, { error: 'payment not completed' });
          }
          if (session.metadata?.email && session.metadata.email !== buyer.email) {
            return sendJson(res, 403, { error: 'that purchase belongs to another account' });
          }
          if (db.kv.get(spentKey)) {
            const already = db.users.get(buyer.email)?.ai_credit_usd || 0;
            return sendJson(res, 200, { credit: Math.round(already * 100) / 100, already: true });
          }
          db.kv.set(spentKey, buyer.email);
          db.users.addAiCredit(buyer.email, MILA_TOPUP_USD);
          // Written down with its date, because the pass cap counts what was
          // bought during the pass on top of what came with it.
          try {
            const k = `topups:${buyer.email}`;
            const list = JSON.parse(db.kv.get(k) || '[]');
            list.push({ at: etNow().date, usd: MILA_TOPUP_USD });
            db.kv.set(k, JSON.stringify(list.slice(-50)));
          } catch {}
          const credit = db.users.get(buyer.email)?.ai_credit_usd || 0;
          console.log(`mila top-up: ${buyer.email} +${usd(MILA_TOPUP_USD)}`);
          return sendJson(res, 200, { credit: Math.round(credit * 100) / 100 });
        } catch (err) {
          console.log(`mila top-up claim: ${err.message}`);
          return sendJson(res, 502, { error: 'could not verify payment' });
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
        // Unauthenticated, and it writes a row per call. That was survivable
        // while it sat behind a prompt() nobody reached; it is now the one
        // thing the coming-soon page asks visitors to do, so it gets a ceiling.
        if (ipLimited(req, 'subscribe', 30)) return sendJson(res, 429, { error: 'too many, slow down' });
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
        // Reaches the reader now that the client shows what the server said,
        // so it has to read like something a person wrote.
        if (!consultant.enabled()) return sendJson(res, 503, { error: 'Mila is not switched on here yet — the plan below still stands.' });
        // Every turn here is a paid model call and nothing capped them. Forty
        // an hour is far more than a day in a park produces and far less than
        // a loop costs.
        if (accountLimited(req, 'advisor', 40)) return sendJson(res, 429, { error: 'that is a lot of questions at once — give me a minute' });
        // The money gate, before any of the free-tier bookkeeping. Counting
        // questions never capped the bill: under the old ceiling alone one
        // account could run to about $8 a day, which is three Month Passes'
        // worth of margin from one chatty family.
        {
          const who = sessionUser(req);
          const budget = aiBudgetState(who?.email || null);
          if (!budget.ok) {
            return sendJson(res, 402, {
              error: budget.reason === 'global'
                ? 'Mila is having a little rest — everything else still works. Try her again shortly.'
                : budget.reason === 'pass'
                  ? 'Mila has given you everything that came with this pass ✨ A top-up keeps her going.'
                  : 'Mila has given you everything she has for today.',
              milaRest: budget.reason,
              spent: Math.round(budget.spent * 100) / 100,
              budget: Math.round(budget.budget * 100) / 100,
              topUp: (budget.reason === 'account' || budget.reason === 'pass') && MILA_TOPUP_ENABLED,
            });
          }
        }
        let freeWish = null;
        // Free tier: exactly ONE consultant call per day — the review that
        // rides along with the single free "Plan my day" — and only for the
        // free park, only about today. The wish belongs to a VERIFIED
        // ACCOUNT, not an IP: sessions only exist after the email code, so a
        // session here proves a real address, and the ledger is per email in
        // the database — durable across restarts and devices.
        if (!hasAccess(req)) {
          const freePark = typeof parsed.park === 'string' && parsed.park === FREE_PARK;
          const today = !(typeof parsed.planDate === 'string' && parsed.planDate);
          // Shown to the reader verbatim by the plan panel, so it has to be a
          // sentence and not a status. With the paywall on and the free tier
          // limited to one park, this is what every visitor planning anywhere
          // else meets -- the upsell moment, which was reading "pass required".
          // Already in all nineteen dictionaries, so it arrives translated.
          if (!freePark || !today) return sendJson(res, 402, { error: "Mila's read of your plan comes with any pass." });
          const s2 = sessionUser(req);
          if (!s2) return sendJson(res, 401, { error: 'Your free daily plan is waiting — log in (free) so Mila knows who she is planning for.' });
          // Neither checked nor spent yet. Both wait until we know this is a
          // genuinely new ask: a visitor refreshing the page, or coming back
          // to a plan they have already been given, must get it back rather
          // than be told their one wish is gone -- they already paid it for
          // this very answer.
          const fkey = `freewish:${s2.email}`;
          freeWish = { key: fkey, day: etNow().date, spent: db.kv.get(fkey) === etNow().date };
        }
        const { park, messages, favorites, excluded, planPicks, subscription } = parsed;
        const lanePasses = strList(parsed.lanePasses, 30);
        // Set by the plan panel, never by the chat widget. Two things hang off
        // it: these are the only turns worth caching (one self-contained
        // question, no conversation behind it), and they must stay out of the
        // saved chat history -- a plan review is not something the visitor
        // said, and saving it overwrote the account's real conversation.
        const planReview = parsed.kind === 'plan-review' && Array.isArray(messages) && messages.length === 1;
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

        const s = sessionUser(req);
        const firstName = s ? (db.users.get(s.email)?.name || null) : null;
        const memory = s ? db.advisor.getMemory(s.email) : null;
        const trip = s ? db.trips.get(s.email) : null;
        const parkToday = new Date().toLocaleDateString('en-CA', { timeZone: PARKS[park].tz });
        const planDay = planDateRaw || parkToday;

        // A plan review the visitor has already been given -- after a refresh,
        // on a second device, or coming back to a park they wandered away from
        // -- replays from SQLite. This happens before the throttle and before
        // the free wish is spent: nothing is being bought, so nothing should
        // be charged for it.
        const adviceSig = planReview ? planAdviceSig({
          prompt: consultant.promptFingerprint(),
          park, day: planDay, lang, question: messages[0] && messages[0].content,
          profile, name: firstName, favorites, excluded, planPicks, done, arrive, leave, memory, trip, lanePasses,
        }) : null;
        if (adviceSig) {
          const hit = db.planadvice.get(adviceSig, planDay === parkToday ? ADVICE_TTL_TODAY : ADVICE_TTL_FUTURE);
          if (hit) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            const replay = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            replay('delta', { text: hit.text });
            for (const a of hit.actions) replay('action', a);
            replay('done', {});
            return res.end();
          }
        }

        // Throttle per verified pass, then verified account, then client IP.
        if (consultant.throttled(throttleIdentity(req).slice(0, 64))) {
          return sendJson(res, 429, { error: "You've hit your magical fairy's limit for now — try again in a few hours." });
        }
        if (freeWish && freeWish.spent) {
          return sendJson(res, 402, { error: 'My wand only grants one free wish a day ✨ With a ParkPulse pass, the magic never runs out — unlimited plans, every park, and me by your side all day.' });
        }
        if (freeWish) db.kv.set(freeWish.key, freeWish.day);
        try {
          const waits = await getWaits(park);
          const fc = (() => { try { return forecastFor(park, 120); } catch { return null; } })();
          if (fc) waits.forecast = { ...fc, days: fc.days.slice(0, 7) };
          try { waits.weather = await getWeather(PARKS[park]); } catch {}
          // Attach the planned day itself — its crowd level, and its weather
          // where the forecast reaches that far. Everything downstream keys off
          // this rather than re-deriving "today".
          const forecastDay = planDateRaw && fc ? fc.days.find((d) => d.date === planDateRaw) : null;
          if (forecastDay) {
            waits.planDay = {
              ...forecastDay,
              isToday: forecastDay.date === parkToday,
              weather: (waits.weather?.days || []).find((w) => w.date === forecastDay.date) || null,
              arrive, leave,
            };
          }
          waits.today = parkToday;
          waits.events = eventsFor(park, forecastDay ? forecastDay.date : parkToday);
          // Shelter tags (indoor/covered/outdoor) from the cached classification
          // so weather routing names real air-conditioned rides. Cache only --
          // a consult must never wait on a classification call; without tags the
          // advisor falls back to its own knowledge, as before.
          try { waits.tags = JSON.parse(db.ridetags.get(park) || 'null') || undefined; } catch {}
          waits.closures = (CLOSURES[park]?.rides || []).filter((r) => r.current).slice(0, 12);
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
              park: PARKS[park], waits, name: firstName, messages, favorites, excluded, planPicks, profile, done, lanePasses,
              // Reported with a screenshot: on the plan panel she wrote out a
              // full reorder -- swap the coasters out of the 39-degree hour,
              // start at Morocco, save the water ride for the heat peak -- and
              // there was no way to take any of it. The panel was excluded from
              // the repair turn on the theory that a review only ever critiques
              // an order that already exists. It does not: a review IS a
              // proposal whenever she disagrees with Pip, and that is precisely
              // when the reader most needs a button.
              //
              // The saving was a turn on reviews that agreed with him. That
              // turn reads cached input and answers with one word, and losing
              // an actionable reorder costs far more than it ever saved.
              cardExpected: true,
              subscription: subscription && typeof subscription.endpoint === 'string' ? subscription : null,
              email: s?.email || null,
              memory, trip,
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
            // The catalogue jobs reported their failures here and the advisor
            // never did, so Mila could be failing every question while the
            // health panel showed nothing at all.
            upstream.service(AI_TIER(null), false, `${status ?? 'none'}: ${err.message}`);
            const friendly = err.code === 'bad_request' ? 'invalid messages'
              : status === 401 || status === 403 ? "Mila's key isn't being accepted right now — the operator has been told."
              : status === 429 ? 'Mila is at her limit for the moment — try again shortly.'
              : status === 400 && /credit|balance|quota/i.test(err.message || '') ? "Mila's account needs topping up — the operator has been told."
              // Not a wobble that will pass: the key is fine and simply is not
              // allowed her tier, so "try again shortly" would be a lie.
              : status === 404 ? "Mila can't reach her magic right now — the operator has been told."
              : status >= 500 ? 'Your magical fairy is having trouble — try again shortly.'
              : 'Your magical fairy is having a moment — try again shortly.';
            // Before apologising: do we already have her read of THIS EXACT
            // plan? The signature covers the park, the day, the party and the
            // running order, so a hit is not "something she once said" -- it
            // is her verdict on the very list on screen. Serving it beats an
            // apology on every count: it is her own voice, in the reader's own
            // language, and it costs nothing. Only the live wait numbers she
            // quoted have moved on, which is why it is labelled rather than
            // passed off as fresh, and why the window is hours and not days.
            //
            // Nothing may have been streamed yet -- half an answer followed by
            // a different whole one is worse than either.
            const stale = !replyText.trim() && adviceSig
              ? (() => { try { return db.planadvice.get(adviceSig, ADVICE_TTL_STALE); } catch { return null; } })()
              : null;
            if (stale) {
              // `stale` first, so the client can label it before a word of her
              // prose arrives.
              send('stale', { at: Date.now() });
              send('delta', { text: stale.text });
              for (const a of stale.actions) send('action', a);
              send('done', {});
            } else {
              send('error', { error: friendly });
              // A free wish buys ONE answer a day. Spending it on an apology
              // takes the day's magic and gives nothing back, so an ask that
              // produced no answer at all is not charged for.
              if (freeWish) { try { db.kv.del(freeWish.key); } catch {} }
            }
          }
          // Bank the review so the next identical ask is free. Only when every
          // action was side-effect-free: a turn that created a wait alert must
          // not be replayed later, or a visitor would be told an alert was set
          // that nobody set.
          if (adviceSig && !failed && replyText.trim()) {
            const planOnly = turnActions.filter((a) => a.type === 'plan');
            if (planOnly.length === turnActions.length) {
              try { db.planadvice.set(adviceSig, park, planDay, replyText, planOnly); } catch {}
            }
          }
          // Persist the conversation for logged-in users so it follows the
          // account across devices (mirrors the client's own history rules).
          // Plan reviews are excluded: the question is one the app asked, not
          // the visitor, and because saveChat replaces the whole row, storing
          // one wiped out the account's actual conversation.
          if (s && !failed && replyText && !planReview) {
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
          return sendJson(res, 502, { error: 'Your magical fairy is having a moment — try again shortly.' });
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
      // "How likely are you to recommend ParkPulse to a friend?" Asked by the
      // app once a park day has delivered something; answered by anyone, under
      // their account if they have one and their device if not. The score
      // arrives first and the optional comment a moment later, as a second
      // call that lands on the same row.
      if (url.pathname === '/api/nps') {
        if (ipLimited(req, 'nps', 30)) return sendJson(res, 429, { error: 'too many from this connection' });
        // A number, not something that coerces to one: Number(null) is 0,
        // and 0 is a detractor. A missing score must be refused, not counted.
        const score = parsed.score;
        if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 10) return sendJson(res, 400, { error: 'score must be 0-10' });
        const s2 = sessionUser(req);
        const device = typeof parsed.device === 'string' ? parsed.device.trim().slice(0, 64) : '';
        if (!s2 && !/^[A-Za-z0-9-]{8,64}$/.test(device)) return sendJson(res, 400, { error: 'no way to tell who is answering' });
        const comment = typeof parsed.comment === 'string' ? parsed.comment.trim().slice(0, 600) : '';
        const out = db.nps.set({
          who: s2 ? s2.email : device,
          kind: s2 ? 'email' : 'device',
          score,
          comment: comment || undefined,
          park: PARKS[parsed.park] ? parsed.park : undefined,
          lang: typeof parsed.lang === 'string' ? parsed.lang.slice(0, 8) : undefined,
        });
        return sendJson(res, 200, { ok: true, ...out });
      }

      // One-tap ride verdicts and durable favorites — the collection half of
      // age-band ratings and "also liked", which surface once volume exists.
      // Logged-in only: person-level rows are the whole point.
      if (url.pathname === '/api/rate') {
        const s2 = sessionUser(req);
        if (!s2) return sendJson(res, 401, { error: 'log in first' });
        const park = PARKS[parsed.park] ? parsed.park : null;
        const ride = typeof parsed.ride === 'string' ? parsed.ride.trim().slice(0, 120) : '';
        const kind = parsed.kind === 'fav' ? 'fav' : 'rate';
        const vote = parsed.vote === -1 ? -1 : 1;
        if (!park || !ride) return sendJson(res, 400, { error: 'invalid' });
        const BANDS = new Set(['toddler', 'kid', 'teen', 'adult', 'elderly']);
        const ages = Array.isArray(parsed.ages) ? parsed.ages.filter((a) => BANDS.has(a)).slice(0, 4) : [];
        db.ratings.set(s2.email, park, ride, kind, vote, JSON.stringify(ages));
        return sendJson(res, 200, { ok: true });
      }

      // Screen a name before the app stores it locally. Signed-out visitors
      // never reach /api/account/name, so without this the wizard wrote
      // whatever was typed straight into localStorage and Mila said it back.
      // No session required: it reads nothing and writes nothing.
      if (url.pathname === '/api/name-check') {
        const asked = cleanFirstName(parsed.name);
        return sendJson(res, 200, { name: asked.name, ...(asked.profane && { nameNote: NAME_NOTE }) });
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
      if (url.pathname === '/api/account/marketing') {
        const s2 = sessionUser(req);
        if (!s2) return sendJson(res, 401, { error: 'not logged in' });
        // Withdrawing is recorded exactly like giving: CASL cares that you can
        // show when someone stopped consenting, not only when they started.
        db.users.setMarketing(s2.email, parsed.on === true, MARKETING_WORDING);
        return sendJson(res, 200, { ok: true, on: parsed.on === true });
      }

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

// A seam for the tests, in the spirit of oauth._setProvider. The spend alert
// otherwise only runs on a five-minute timer, and an alert that quietly never
// fires is worse than no alert at all -- it is the same silence, with the
// belief that somebody is watching.
module.exports = { _defaults: AI_DEFAULTS, _maybeAlertOnSpend: maybeAlertOnSpend, _revenueReport: revenueReport,
  _clearMilaPingCache: () => { milaPingCache = { at: 0, val: null }; },
  _noteUpstream: (name, ok, error) => upstream.service(name, ok, error),
  _applyStoredIds: applyStoredIds,
  _copyDatabase: copyDatabase,
  _noteFallbackForTest: (from, to, status, detail) => { lastFallback = { at: Date.now(), from, to, status, detail }; },
  // The status is cached for five minutes, which a test walking through every
  // Stripe answer in turn has to be able to step past.
  _clearStripeStatusCache: () => { stripeStatusCache = { at: 0, val: null }; } };
