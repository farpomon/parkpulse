// ParkPulse — minimal zero-dependency server.
// Serves the static frontend, proxies live wait times from queue-times.com
// (5-minute cache, attribution required by their API license), and captures
// email leads to data/leads.jsonl. Node 18+ (built-in fetch).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
// On Railway, mount a volume (e.g. at /data) and set LEADS_FILE=/data/leads.jsonl
// so captured emails survive redeploys — the default path is ephemeral there.
const LEADS_FILE = process.env.LEADS_FILE || path.join(DATA_DIR, 'leads.jsonl');
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
const STRIPE_PRICES = { 'trip-pass': process.env.STRIPE_PRICE_TRIP || '', 'pro-annual': process.env.STRIPE_PRICE_ANNUAL || '' };
const CHECKOUT_ENABLED = Boolean(STRIPE_KEY && STRIPE_PRICES['trip-pass'] && STRIPE_PRICES['pro-annual']);
// MUST be set in production — the ephemeral default invalidates all passes on restart.
const PASS_SECRET = process.env.PASS_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.PASS_SECRET) console.log('WARNING: PASS_SECRET not set — issued passes will not survive a restart');
// Developer bypass: redeeming this exact code in the app grants a 10-year pass.
const DEV_PASS_CODE = process.env.DEV_PASS_CODE || '';
const PLAN_DAYS = { 'trip-pass': 30, 'pro-annual': 365, 'dev': 3650 };
const PASSES_FILE = process.env.PASSES_FILE || path.join(DATA_DIR, 'passes.jsonl');

function signPass(plan) {
  const body = Buffer.from(JSON.stringify({ plan, exp: Date.now() + PLAN_DAYS[plan] * 86400000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', PASS_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyPass(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', PASS_SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const pass = JSON.parse(Buffer.from(body, 'base64url').toString());
    return PLAN_DAYS[pass.plan] && pass.exp > Date.now() ? pass : null;
  } catch { return null; }
}

const passFromReq = (req) => verifyPass(req.headers['x-pass']);
const hasAccess = (req) => !PRO_GATE || Boolean(passFromReq(req));

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
  try { fs.appendFileSync(PASSES_FILE, JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n'); } catch {}
}

const SAMPLE = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sample-waits.json'), 'utf8'));

// Typical waits indexed by normalized ride name, so live rides can carry a
// "vs typical" comparison even when queue-times names differ in punctuation.
const normName = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const TYPICAL = Object.fromEntries(
  Object.entries(SAMPLE).map(([slug, d]) => [slug, new Map(d.rides.map((r) => [normName(r.name), r.wait]))])
);

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
const VAPID_FILE = process.env.VAPID_FILE || path.join(DATA_DIR, 'vapid.json');
let vapidKeys;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapidKeys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else if (fs.existsSync(VAPID_FILE)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys));
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:alerts@parkpulse.example', vapidKeys.publicKey, vapidKeys.privateKey);

const ALERTS_FILE = process.env.ALERTS_FILE || path.join(DATA_DIR, 'alerts.json');
let alerts = [];
try { alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch { alerts = []; }
const saveAlerts = () => fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts));
let alertSeq = alerts.reduce((m, a) => Math.max(m, a.id), 0);

const ALERT_CHECK_MS = 5 * 60 * 1000;
async function checkAlerts() {
  const parksWithAlerts = [...new Set(alerts.map((a) => a.park))];
  for (const slug of parksWithAlerts) {
    const data = await getWaits(slug);
    if (data.source !== 'live') continue; // never alert off demo data
    for (const alert of alerts.filter((a) => a.park === slug)) {
      const ride = data.rides.find((r) => normName(r.name) === normName(alert.ride));
      if (!ride || !ride.open || ride.wait > alert.threshold) continue;
      const payload = JSON.stringify({
        title: `${ride.name}: ${ride.wait} min`,
        body: `Dropped below your ${alert.threshold} min alert${ride.typical ? ` (typical ${ride.typical} min)` : ''} — go now!`,
      });
      try {
        await webpush.sendNotification(alert.subscription, payload);
        alerts = alerts.filter((a) => a.id !== alert.id); // fire once
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          alerts = alerts.filter((a) => a.subscription.endpoint !== alert.subscription.endpoint);
        } // transient errors: keep and retry next cycle
      }
    }
  }
  saveAlerts();
}
setInterval(() => checkAlerts().catch(() => {}), ALERT_CHECK_MS);

const CACHE_TTL_MS = 5 * 60 * 1000;
const waitsCache = new Map();

async function getWaits(slug) {
  const park = PARKS[slug];
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
    const rides = [...(json.lands || []).flatMap((l) => l.rides || []), ...(json.rides || [])];
    const data = {
      park: park.name,
      source: 'live',
      attribution: 'Powered by Queue-Times.com',
      updatedAt: new Date().toISOString(),
      rides: rides.map((r) => ({ name: r.name, wait: r.wait_time, open: r.is_open, typical: TYPICAL[slug]?.get(normName(r.name)) ?? null })),
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
      rides: SAMPLE[slug].rides.map((r) => ({ ...r, typical: r.wait })),
    };
  }
}

function saveLead(email, plan) {
  const record = { email, plan, at: new Date().toISOString() };
  fs.appendFileSync(LEADS_FILE, JSON.stringify(record) + '\n');
}

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/config') {
    return sendJson(res, 200, {
      paymentLink: PAYMENT_LINK,
      proGate: PRO_GATE,
      checkout: CHECKOUT_ENABLED,
      pushKey: vapidKeys.publicKey,
      parks: Object.fromEntries(REGISTRY.map((p) => [p.slug, { name: p.name, group: p.group, open: p.open, close: p.close, show: p.show }])),
    });
  }

  if (url.pathname === '/api/pass/verify') {
    const pass = passFromReq(req);
    return sendJson(res, 200, pass ? { valid: true, plan: pass.plan, exp: pass.exp } : { valid: false });
  }

  const waitsMatch = url.pathname.match(/^\/api\/waits\/([a-z-]+)$/);
  if (waitsMatch) {
    const slug = waitsMatch[1];
    if (!PARKS[slug]) return sendJson(res, 404, { error: 'unknown park' });
    if (slug !== FREE_PARK && !hasAccess(req)) return sendJson(res, 402, { error: 'pass required' });
    return sendJson(res, 200, await getWaits(slug));
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 8192) req.destroy(); });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad request' }); }

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
          recordPass({ plan, session: sessionId, email: session.customer_details?.email || null });
          return sendJson(res, 200, { token, plan, exp: verifyPass(token).exp });
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
        recordPass({ plan: 'dev' });
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

      if (url.pathname === '/api/push/alerts') {
        if (!hasAccess(req)) return sendJson(res, 402, { error: 'pass required' });
        const { subscription, park, ride, threshold } = parsed;
        if (!subscription || typeof subscription.endpoint !== 'string' || !PARKS[park] ||
            typeof ride !== 'string' || !Number.isFinite(threshold) || threshold < 5 || threshold > 240) {
          return sendJson(res, 400, { error: 'invalid alert' });
        }
        // One alert per ride per device — replace an existing one.
        alerts = alerts.filter((a) => !(a.subscription.endpoint === subscription.endpoint && normName(a.ride) === normName(ride)));
        const alert = { id: ++alertSeq, subscription, park, ride: ride.slice(0, 120), threshold: Math.round(threshold), createdAt: new Date().toISOString() };
        alerts.push(alert);
        saveAlerts();
        return sendJson(res, 200, { ok: true, id: alert.id });
      }

      if (url.pathname === '/api/push/alerts/cancel') {
        const { endpoint, ride } = parsed;
        if (typeof endpoint !== 'string') return sendJson(res, 400, { error: 'invalid' });
        const before = alerts.length;
        alerts = alerts.filter((a) => !(a.subscription.endpoint === endpoint && (!ride || normName(a.ride) === normName(ride))));
        saveAlerts();
        return sendJson(res, 200, { ok: true, removed: before - alerts.length });
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
