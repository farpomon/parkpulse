// ParkPulse — minimal zero-dependency server.
// Serves the static frontend, proxies live wait times from queue-times.com
// (5-minute cache, attribution required by their API license), and captures
// email leads to data/leads.jsonl. Node 18+ (built-in fetch).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.jsonl');
// Stripe Payment Link for the Trip Pass — set in the hosting env, no backend needed for v0.
const PAYMENT_LINK = process.env.PAYMENT_LINK || '';

const SAMPLE = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sample-waits.json'), 'utf8'));

// queue-times.com park IDs for Walt Disney World.
const PARKS = {
  'magic-kingdom': { id: 6, name: 'Magic Kingdom' },
  'epcot': { id: 5, name: 'EPCOT' },
  'hollywood-studios': { id: 7, name: 'Hollywood Studios' },
  'animal-kingdom': { id: 8, name: 'Animal Kingdom' },
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const waitsCache = new Map();

async function getWaits(slug) {
  const park = PARKS[slug];
  const cached = waitsCache.get(slug);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
  try {
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
      rides: rides.map((r) => ({ name: r.name, wait: r.wait_time, open: r.is_open })),
    };
    waitsCache.set(slug, { at: Date.now(), data });
    return data;
  } catch (err) {
    return {
      park: park.name,
      source: 'sample',
      attribution: 'Typical waits shown — live feed unavailable',
      updatedAt: new Date().toISOString(),
      rides: SAMPLE[slug].rides,
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
    return sendJson(res, 200, { paymentLink: PAYMENT_LINK, parks: Object.fromEntries(Object.entries(PARKS).map(([slug, p]) => [slug, p.name])) });
  }

  const waitsMatch = url.pathname.match(/^\/api\/waits\/([a-z-]+)$/);
  if (waitsMatch) {
    const slug = waitsMatch[1];
    if (!PARKS[slug]) return sendJson(res, 404, { error: 'unknown park' });
    return sendJson(res, 200, await getWaits(slug));
  }

  if (url.pathname === '/api/subscribe' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const { email, plan } = JSON.parse(body || '{}');
        if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return sendJson(res, 400, { error: 'invalid email' });
        }
        saveLead(email.slice(0, 254), typeof plan === 'string' ? plan.slice(0, 40) : 'free');
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 400, { error: 'bad request' });
      }
    });
    return;
  }

  serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`ParkPulse running on http://localhost:${PORT}`);
});
