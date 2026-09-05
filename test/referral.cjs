// Give a friend ParkPulse.
//
// The bargain: when a friend who signed up from your link buys their first
// pass, you get the same number of days -- a Day Pass earns a day, a Trip
// Pass ten -- capped at ten, so a Season or Annual Pass earns ten too. Paid
// once per friend, on the first purchase only, never on a replayed claim,
// never to yourself. Added to the end of a live pass, or a Guest Pass from
// now if you have none.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-referral.db';
process.env.PORT = '9672';
process.env.PASS_SECRET = 'testsecret';
process.env.HISTORY = 'off';
process.env.STRIPE_SECRET_KEY = 'sk_test_stub';

const crypto = require('node:crypto');
const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: { create: async () => ({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '.' }], usage: {} }) } } });

// Stripe, stood in for: three paid checkouts, one per plan we care about.
const PAID = { cs_day: 'day-pass', cs_year: 'year-pass', cs_trip: 'trip-pass', cs_stranger: 'day-pass' };
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const m = String(url).match(/api\.stripe\.com\/v1\/checkout\/sessions\/(cs_\w+)/);
  if (m && PAID[m[1]]) return { ok: true, status: 200, json: async () => ({ payment_status: 'paid', amount_total: 699, metadata: { plan: PAID[m[1]] } }) };
  return realFetch(url, opts);
};

const db = require('../db.js');
const B = 'http://127.0.0.1:9672';
const DAY = 86400000;

function session(email) {
  try { db.users.create(email, 'salt', 'x', 1); } catch {}
  db.users.markVerified(email);
  const sid = crypto.randomBytes(16).toString('hex');
  db.sessions.create(sid, email, 'test-phone', 'test');
  const body = Buffer.from(JSON.stringify({ sid, email, exp: Date.now() + DAY })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', process.env.PASS_SECRET).update(body).digest('base64url')}`;
}
const call = (path, body, sess, extra = {}) => fetch(`${B}${path}`, {
  method: body ? 'POST' : 'GET', redirect: 'manual',
  headers: { 'content-type': 'application/json', ...(sess ? { 'x-session': sess } : {}) },
  body: body ? JSON.stringify(body) : undefined, ...extra,
}).then(async (r) => ({ status: r.status, headers: r.headers, data: await r.json().catch(() => ({})) }));
const signup = (email, ref) => call('/api/auth/signup', { email, password: 'password123', name: 'Amy', terms: true, device: 'd', ref });
const claim = (sess, id) => call('/api/pass/claim', { session_id: id }, sess);

(async () => {
  require('../server.js');
  for (let i = 0; i < 80 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const REF = 'ref@example.com';
  const me = session(REF);

  console.log('\n  the link');
  const who = await call('/api/auth/me', null, me);
  const code = who.data.refCode;
  check('every account has a share code', who.status === 200 && /^[A-Z2-9]{7}$/.test(code || ''), code);
  check('and it is the same code next time', (await call('/api/auth/me', null, me)).data.refCode === code);
  check('with nothing earned yet', who.data.refDays === 0 && who.data.referrals === 0);
  const r1 = await call(`/r/${code.toLowerCase()}`);
  check('the short link lands in the app with the code and the source', r1.status === 302 && r1.headers.get('location') === `/app?ref=${code}&utm_source=referral&utm_medium=friend`, r1.headers.get('location'));
  const r2 = await call('/r/NOPE999');
  check('an unknown code is just the front door', r2.status === 302 && r2.headers.get('location') === '/');

  console.log('\n  the friend');
  const s1 = await signup('f1@example.com', code);
  check('a friend signs up from the link', s1.status === 200, JSON.stringify(s1.data).slice(0, 80));
  check('and is remembered as yours', db.users.get('f1@example.com')?.referred_by === REF);
  check('which shows on your timeline', db.activity.forEmail(REF).some((e) => e.action === 'a friend signed up from your link'));
  check('you cannot refer yourself', db.users.setReferredBy(REF, REF) === 0);
  await signup('f0@example.com', 'ZZZZZZZ');
  check('a made-up code is ignored, not refused', db.users.get('f0@example.com') && !db.users.get('f0@example.com').referred_by);
  check('a friend is yours once — a second code does not move them', (await signup('f1@example.com', code)).status === 200 && db.users.get('f1@example.com').referred_by === REF);

  console.log('\n  the payout');
  const f1 = session('f1@example.com');
  const before = Date.now();
  const c1 = await claim(f1, 'cs_day');
  check('the friend gets their Day Pass', c1.status === 200 && c1.data.plan === 'day-pass');
  let u = db.users.get(REF);
  check('you get a day -- the same as they bought', u.plan === 'comp' && u.plan_exp > before + DAY - 5000 && u.plan_exp < before + DAY + 60000, `${u.plan} until ${u.plan_exp}`);
  check('written down as one day earned', u.ref_days === 1);
  const exp1 = u.plan_exp;
  await claim(f1, 'cs_day');
  u = db.users.get(REF);
  check('activating a second device pays nothing more', u.plan_exp === exp1 && u.ref_days === 1);

  const s2 = await signup('f2@example.com', code);
  const f2 = session('f2@example.com');
  await claim(f2, 'cs_year');
  u = db.users.get(REF);
  check('an Annual Pass earns ten days, not 365', u.ref_days === 11, String(u.ref_days));
  check('added to the end of your live pass, not from today', Math.abs(u.plan_exp - (exp1 + 10 * DAY)) < 1000, `${u.plan_exp} vs ${exp1 + 10 * DAY}`);
  const exp2 = u.plan_exp;

  await signup('f3@example.com', code);
  await claim(session('f3@example.com'), 'cs_trip');
  u = db.users.get(REF);
  check('a Trip Pass earns its full ten', u.ref_days === 21 && Math.abs(u.plan_exp - (exp2 + 10 * DAY)) < 1000);

  await claim(session('stranger@example.com'), 'cs_stranger');
  check('a buyer nobody referred pays nobody', db.users.get(REF).ref_days === 21);

  const after = await call('/api/auth/me', null, me);
  check('the account sheet has the totals', after.data.refDays === 21 && after.data.referrals === 3, JSON.stringify({ d: after.data.refDays, r: after.data.referrals }));
  check('and the timeline has each payout', db.activity.forEmail(REF).filter((e) => e.action === 'earned referral days').length === 3);
  check('the friend sees it too', db.activity.forEmail('f1@example.com').some((e) => e.action === 'referral paid out'));

  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
