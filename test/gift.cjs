// A pass bought for somebody else.
//
// The same till with a flag: the pass becomes a single-use redeem link
// carrying the real plan, emailed to the recipient when an address is given
// and handed to the buyer to forward otherwise. The buyer's own account gets
// nothing but the sale; the recipient's account says "Trip Pass", not "Guest
// Pass"; replaying the receipt page returns the same gift, never a second.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-gift.db';
process.env.PORT = '9674';
process.env.PASS_SECRET = 'testsecret';
process.env.HISTORY = 'off';
process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
process.env.RESEND_API_KEY = 'stub';

const crypto = require('node:crypto');
const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: { create: async () => ({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '.' }], usage: {} }) } } });

// Stripe and Resend, stood in for.
const checkouts = [], mails = [];
const SESSIONS = {
  cs_gift_to: { payment_status: 'paid', amount_total: 1799, metadata: { plan: 'trip-pass', gift: '1', to: 'nana@example.com', note: 'Happy birthday!' } },
  cs_gift_open: { payment_status: 'paid', amount_total: 699, metadata: { plan: 'day-pass', gift: '1' } },
};
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u === 'https://api.stripe.com/v1/balance') return { ok: true, status: 200, json: async () => ({ livemode: true, available: [] }) };
  if (u === 'https://api.stripe.com/v1/checkout/sessions') { checkouts.push(Object.fromEntries(new URLSearchParams(opts.body))); return { ok: true, status: 200, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/x' }) }; }
  const m = u.match(/api\.stripe\.com\/v1\/checkout\/sessions\/(cs_\w+)/);
  if (m && SESSIONS[m[1]]) return { ok: true, status: 200, json: async () => SESSIONS[m[1]] };
  if (u.startsWith('https://api.resend.com/')) { mails.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ id: 'm' }) }; }
  return realFetch(url, opts);
};

const db = require('../db.js');
const B = 'http://127.0.0.1:9674';
function session(email) {
  try { db.users.create(email, 'salt', 'x', 1); } catch {}
  db.users.markVerified(email);
  const sid = crypto.randomBytes(16).toString('hex');
  db.sessions.create(sid, email, 'test-phone', 'test');
  const body = Buffer.from(JSON.stringify({ sid, email, exp: Date.now() + 86400000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', process.env.PASS_SECRET).update(body).digest('base64url')}`;
}
const call = (path, body, sess) => fetch(`${B}${path}`, {
  method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', ...(sess ? { 'x-session': sess } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

(async () => {
  const server = require('../server.js');
  for (let i = 0; i < 80 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  server._clearStripeStatusCache();
  const buyer = session('buyer@example.com');

  console.log('\n  the till');
  const co = await call('/api/checkout', { plan: 'trip-pass', gift: true, to: 'Nana@Example.com', note: 'Happy birthday!' }, buyer);
  check('a gift checkout opens', co.status === 200 && co.data.url, JSON.stringify(co.data));
  const sent = checkouts[checkouts.length - 1] || {};
  check('  flagged as a gift for Stripe to hand back', sent['metadata[gift]'] === '1' && sent['metadata[to]'] === 'nana@example.com' && sent['metadata[note]'] === 'Happy birthday!', JSON.stringify(sent).slice(0, 200));
  check('  and lands on the welcome page as one', /welcome\?session_id=\{CHECKOUT_SESSION_ID\}&gift=1$/.test(sent.success_url), sent.success_url);
  await call('/api/checkout', { plan: 'day-pass' }, buyer);
  check('an ordinary purchase carries no gift flag', !('metadata[gift]' in checkouts[checkouts.length - 1]));

  console.log('\n  the claim');
  const c1 = await call('/api/pass/claim', { session_id: 'cs_gift_to' }, buyer);
  check('the buyer gets a link, not a pass', c1.status === 200 && c1.data.gift === true && !c1.data.token && /\/invite\?t=[a-f0-9]{32}$/.test(c1.data.link), JSON.stringify(c1.data).slice(0, 160));
  check('  named as the real plan', c1.data.label === 'Trip Pass' && c1.data.days === 10);
  check('  and reported as a sale once', 'conversion' in c1.data && db.passes.soldSince('2000-01-01').find((r) => r.plan === 'trip-pass')?.n === 1);
  const token = c1.data.link.split('t=')[1];
  const inv = db.invites.get(token);
  check('the invite carries the plan, the recipient and the note', inv && inv.channel === 'gift' && inv.plan === 'trip-pass' && inv.days === 10 && inv.target === 'nana@example.com' && inv.note === 'Happy birthday!', JSON.stringify(inv));
  check('the recipient is emailed the link', mails.some((m) => String(m.to).includes('nana@example.com') && m.html.includes(token) && m.html.includes('Happy birthday!')), mails.map((m) => m.subject).join(' | '));
  check("the buyer's own account has no pass", !db.users.get('buyer@example.com').plan);
  const c2 = await call('/api/pass/claim', { session_id: 'cs_gift_to' }, buyer);
  check('reopening the receipt returns the same gift', c2.data.gift && c2.data.link === c1.data.link && c2.data.already === true && !('conversion' in c2.data));
  check('  and no second sale', db.passes.soldSince('2000-01-01').find((r) => r.plan === 'trip-pass')?.n === 1);

  const c3 = await call('/api/pass/claim', { session_id: 'cs_gift_open' }, buyer);
  check('a gift with no address still mints a link to forward', c3.data.gift && c3.data.to === null && /invite\?t=/.test(c3.data.link));
  check('  and emails nobody', !mails.some((m) => m.html.includes(c3.data.link.split('t=')[1])));

  console.log('\n  the recipient');
  const info = await call(`/api/invite/info?t=${token}`);
  check('the invite page knows it is a gift', info.data.valid && info.data.gift === true && info.data.label === 'Trip Pass' && info.data.note === 'Happy birthday!', JSON.stringify(info.data));
  const nana = session('nana@example.com');
  const claim = await call('/api/invite/claim', { token }, nana);
  check('Nana opens it', claim.status === 200 && claim.data.ok);
  check('  onto her account as a Trip Pass, ten days', claim.data.plan === 'trip-pass' && claim.data.exp > Date.now() + 9.9 * 86400000 && claim.data.exp < Date.now() + 10.1 * 86400000, JSON.stringify(claim.data).slice(0, 120));
  check('  and her sheet says so', (await call('/api/auth/me', null, nana)).data.plan === 'trip-pass');
  check('  with a line on her timeline', db.activity.forEmail('nana@example.com').some((e) => e.action === 'opened a gift' && /Trip Pass/.test(e.detail)));
  const again = await call('/api/invite/claim', { token }, session('cousin@example.com'));
  check('a second person cannot open the same gift', again.status === 409);
  check('an ordinary invite still lands as a Guest Pass', (() => {
    const t = crypto.randomBytes(16).toString('hex'); db.invites.create(t, 'link', null, 10, null, 'boss@example.com');
    return call('/api/invite/claim', { token: t }, session('guest@example.com')).then((r) => r.data.plan === 'comp');
  })());

  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
