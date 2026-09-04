// Three ways in, each of which used to work.
//
//   1. One request takes the whole site down. The handler is async, and its
//      very first line builds a URL from the Host header. A Host that is not a
//      legal hostname makes that throw before any of our code runs, and an
//      unhandled rejection is, by Node's default, process death. No account, no
//      payment, no clever payload -- one curl, and every other visitor's
//      connection closes with it.
//   2. A $6.99 Day Pass becomes a free forever pass. The checkout session id
//      sits in the welcome URL (and in the Stripe receipt) permanently, and
//      claiming it minted a *fresh* full-length pass every time. Reload once a
//      day and it never expires -- and each reload also wrote another sale into
//      the revenue dashboard.
//   3. Anyone can be WhatsApp. The webhook processed whatever it was posted;
//      Meta's X-Hub-Signature-256 was never checked. Enough to unlink somebody
//      else's number, or to spend the AI budget one message at a time.
//
// Multi-device activation must survive fix 2: re-claiming a paid session still
// has to hand back a working pass, just not a longer one.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-hardening.db';
process.env.PORT = '9663';
process.env.PASS_SECRET = 'testsecret';
process.env.HISTORY = 'off';
process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
process.env.WHATSAPP_TOKEN = 'wa-token';
process.env.WHATSAPP_PHONE_ID = '12345';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.WHATSAPP_APP_SECRET = 'app-secret';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: { create: async () => ({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '.' }], usage: {} }) } } });

// Stand in for Stripe: one paid Day Pass checkout, retrievable forever, which
// is exactly the property that made the replay possible.
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.stripe.com/v1/checkout/sessions/cs_test_paid')) {
    return { ok: true, status: 200, json: async () => ({
      payment_status: 'paid', amount_total: 699, metadata: { plan: 'day-pass' },
      customer_details: { email: 'buyer@example.com' },
    }) };
  }
  return realFetch(url, opts);
};

const db = require('../db.js');
const B = 'http://127.0.0.1:9663';

// A raw socket, because fetch() will not send a Host header this broken.
const rawGet = (hostHeader) => new Promise((resolve) => {
  const c = net.connect(9663, '127.0.0.1', () => {
    c.write(`GET /api/config HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
  });
  let out = '';
  c.on('data', (d) => { out += d; });
  c.on('error', () => resolve(''));
  c.on('close', () => resolve(out));
});

const claim = (sessionId) => fetch(`${B}/api/pass/claim`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ session_id: sessionId }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const sign = (raw, secret) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
const hook = (payload, signature) => {
  const raw = JSON.stringify(payload);
  return fetch(`${B}/api/whatsapp/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) },
    body: raw,
  }).then((r) => r.status);
};

(async () => {
  require('../server.js');
  for (let i = 0; i < 80 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('\n  a malformed request costs one request, not the server');
  const bad = await rawGet('not a valid host!!');
  check('a broken Host header gets an answer, not a dropped connection', /^HTTP\/1\.1 \d\d\d/.test(bad), JSON.stringify(bad.slice(0, 40)));
  check('and that answer is a 500, not a crash', / 500 /.test(bad.split('\r\n')[0]), bad.split('\r\n')[0]);
  const empty = await rawGet('');
  check('an empty Host header is survivable too', /^HTTP\/1\.1 \d\d\d/.test(empty), JSON.stringify(empty.slice(0, 40)));
  const after = await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false);
  check('the server is still serving everyone else', after);

  console.log('\n  a paid checkout is one pass and one sale, however often it is claimed');
  const first = await claim('cs_test_paid');
  check('the buyer gets their pass', first.status === 200 && Boolean(first.body.token), JSON.stringify(first.body).slice(0, 120));
  check('it lasts the Day Pass day', first.body.exp > Date.now() && first.body.exp < Date.now() + 2 * 86400000);
  check('and the sale is reported to Google Ads', 'conversion' in first.body);

  await new Promise((r) => setTimeout(r, 30));
  const again = await claim('cs_test_paid');
  check('claiming it again still activates a second device', again.status === 200 && Boolean(again.body.token));
  check('but on the same expiry, not a fresh day', again.body.exp === first.body.exp, `${again.body.exp} vs ${first.body.exp}`);
  check('and it is not reported as a second sale', !('conversion' in again.body) && again.body.already === true);

  for (let i = 0; i < 3; i++) await claim('cs_test_paid');
  const sold = db.passes.soldSince('2000-01-01').find((r) => r.plan === 'day-pass');
  check('the revenue ledger holds exactly one sale', sold && sold.n === 1, `${sold ? sold.n : 0} rows`);
  check('worth what was actually paid, once', sold && Math.abs(sold.paid - 6.99) < 0.001, sold && sold.paid);

  console.log('\n  the WhatsApp webhook only listens to Meta');
  const payload = { entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }] };
  const raw = JSON.stringify(payload);
  check('an unsigned delivery is refused', (await hook(payload)) === 403);
  check('a wrongly-signed delivery is refused', (await hook(payload, sign(raw, 'not-the-app-secret'))) === 403);
  check('a truncated signature is refused', (await hook(payload, 'sha256=abc')) === 403);
  check('a properly signed delivery is accepted', (await hook(payload, sign(raw, 'app-secret'))) === 200);
  // An emoji is the case that breaks when the body is rebuilt by string
  // concatenation instead of from the bytes that were signed.
  const emoji = { entry: [{ changes: [{ value: { statuses: [{ status: 'delivered 🎢🎡' }] } }] }] };
  check('a signature over multi-byte text still verifies', (await hook(emoji, sign(JSON.stringify(emoji), 'app-secret'))) === 200);

  const handshake = await fetch(`${B}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=xyz`);
  check("Meta's setup handshake still works", handshake.status === 200 && (await handshake.text()) === 'xyz');

  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
