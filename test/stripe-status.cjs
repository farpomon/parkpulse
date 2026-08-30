// Is Stripe actually connected?
//
// A set key and a working key look identical from outside: /api/config says
// checkout:true either way, and the price check only calls Stripe when a
// STRIPE_PRICE_* id is configured -- which, with the inline prices we ship by
// default, it never is. So an expired key stays invisible until a real buyer
// reaches the till and gets an error.
//
// Four states, all of which have to be told apart: no key, a key Stripe
// rejects, a live key, and a test key on a production site (which sells
// nothing while looking perfectly healthy).
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-stripe-status.db';
process.env.PORT = '9667';
process.env.PASS_SECRET = 'testsecret';
process.env.ADMIN_EMAILS = 'boss@example.com';
process.env.STRIPE_SECRET_KEY = 'sk_test_stub';

const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: { create: async () => ({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '.' }], usage: {} }) } } });

// Stand in for Stripe. Every /v1/balance answer the real API can give is
// scripted here; nothing else on the server is intercepted.
const realFetch = global.fetch;
let balance = null;                       // set per case below
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.stripe.com/v1/balance')) {
    if (balance instanceof Error) throw balance;
    return { ok: balance.ok !== false, status: balance.ok === false ? 401 : 200, json: async () => balance.body };
  }
  return realFetch(url, opts);
};

const B = 'http://127.0.0.1:9667';
const db = require('../db.js');

(async () => {
  require('../server.js');
  for (let i = 0; i < 60 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }

  // An admin session, since the readout lives behind /api/admin/ops.
  const crypto = require('node:crypto');
  const ADMIN = 'boss@example.com';
  db.users.create(ADMIN, 'salt', 'x', 1);
  db.users.markVerified(ADMIN);
  const sid = crypto.randomBytes(16).toString('hex');
  db.sessions.create(sid, ADMIN, 'test-device', 'test');
  const body = Buffer.from(JSON.stringify({ sid, email: ADMIN, exp: Date.now() + 86400000 })).toString('base64url');
  const session = `${body}.${crypto.createHmac('sha256', process.env.PASS_SECRET).update(body).digest('base64url')}`;
  const ops = () => fetch(`${B}/api/admin/ops`, { headers: { 'x-session': session } }).then((r) => r.json());

  // The cache is what makes this cheap in production and awkward here, so it
  // is cleared between cases rather than worked around.
  const clearCache = () => { const s = require('../server.js'); if (s._clearStripeStatusCache) s._clearStripeStatusCache(); };

  console.log('\n[a live key that answers]');
  {
    balance = { body: { object: 'balance', livemode: true, available: [{ currency: 'usd', amount: 4200 }] } };
    clearCache();
    const d = await ops();
    check('reported connected', d.stripe.connected === true, JSON.stringify(d.stripe));
    check('and in live mode', d.stripe.live === true);
    check('with the currency it holds', Array.isArray(d.stripe.currencies) && d.stripe.currencies.includes('USD'), JSON.stringify(d.stripe.currencies));
  }

  console.log('\n[a TEST key on a production site]');
  {
    balance = { body: { object: 'balance', livemode: false, available: [] } };
    clearCache();
    const d = await ops();
    check('still reported as connected', d.stripe.connected === true);
    // This is the state that quietly sells nothing: Stripe answers, the
    // dashboard looks healthy, and every real card is declined.
    check('but NOT live', d.stripe.live === false, JSON.stringify(d.stripe));
  }

  console.log('\n[a key Stripe rejects]');
  {
    balance = { ok: false, body: { error: { message: 'Expired API Key provided: sk_live_***' } } };
    clearCache();
    const d = await ops();
    check('reported not connected', d.stripe.connected === false, JSON.stringify(d.stripe));
    check('and says why, in Stripe\'s words', /Expired API Key/.test(d.stripe.detail || ''), d.stripe.detail);
  }

  console.log('\n[Stripe unreachable]');
  {
    balance = new Error('fetch failed');
    clearCache();
    const d = await ops();
    check('reported not connected', d.stripe.connected === false);
    check('and does not claim to know the account', d.stripe.live === undefined);
  }

  console.log('\n[no key at all]');
  {
    // A separate process, because the key is read once at module load.
    const out = require('child_process').spawnSync(process.execPath, ['-e', `
      process.env.ANTHROPIC_API_KEY='stub'; process.env.PASS_SECRET='t';
      process.env.DB_FILE='/tmp/pp-stripe-nokey.db'; process.env.PORT='9666';
      delete process.env.STRIPE_SECRET_KEY;
      require('${__dirname}/../server.js');
      setTimeout(async () => {
        const c = await (await fetch('http://127.0.0.1:9666/api/config')).json();
        console.log(JSON.stringify({ checkout: c.checkout }));
        process.exit(0);
      }, 2500);
    `], { encoding: 'utf8', timeout: 30000 });
    const line = (out.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    const r = line ? JSON.parse(line) : {};
    check('checkout is off without a key', r.checkout === false, JSON.stringify(r));
  }

  console.log(fail ? `\n${fail} failed` : '\nall good');
  process.exit(fail ? 1 : 0);
})();
