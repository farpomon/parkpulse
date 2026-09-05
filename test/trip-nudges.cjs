// A week out and the evening before: the two moments someone with a saved
// trip is most ready to build a plan. Once each per trip, in the first park's
// own clock; push if the phone gave us an endpoint, email otherwise; and a
// trip moved to new dates starts its countdown again.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-nudges.db';
process.env.PORT = '9673';
process.env.PASS_SECRET = 'testsecret';
process.env.HISTORY = 'off';
process.env.RESEND_API_KEY = 'stub';

const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: { create: async () => ({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '.' }], usage: {} }) } } });

// Every email and every push, caught.
const mails = [], pushes = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.resend.com/')) { mails.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ id: 'm' }) }; }
  return realFetch(url, opts);
};
const webpush = require('web-push');
webpush.sendNotification = async (sub, payload) => { pushes.push({ to: sub.endpoint, ...JSON.parse(payload) }); };

const db = require('../db.js');
const B = 'http://127.0.0.1:9673';
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const TZ = 'America/New_York';
const nyDate = (d) => d.toLocaleDateString('en-CA', { timeZone: TZ });
// A moment at HH:00 New York time on a given New York date, DST or not.
const at = (date, hh) => {
  const guess = new Date(`${date}T${String(hh).padStart(2, '0')}:00:00Z`);
  const shown = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(guess)) % 24;
  return new Date(guess.getTime() + ((hh - shown + 24) % 24) * 3600000 - (nyDate(guess) < date ? 0 : 0));
};
const trip = (email, start, sub) => db.trips.set(email, 'Walt Disney World', start, 1, JSON.stringify([{ date: start, park: 'magic-kingdom' }]), 0, sub);
const user = (email) => { try { db.users.create(email, 'salt', 'x', 1); } catch {} };

(async () => {
  const server = require('../server.js');
  for (let i = 0; i < 80 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const sweep = (now) => server._sweepTripNudges(now);
  const today = nyDate(new Date());
  const start = addDays(today, 7);

  console.log('\n  a week before');
  user('mail@example.com'); trip('mail@example.com', start, null);
  user('push@example.com'); trip('push@example.com', start, JSON.stringify({ endpoint: 'https://push.example/abc', keys: {} }));
  user('early@example.com'); trip('early@example.com', addDays(today, 8), null);
  await sweep(at(today, 12));
  check('the account without a phone endpoint gets an email', mails.length === 1 && /in one week/.test(mails[0].subject), mails.map((m) => m.subject).join(' | '));
  check('  naming the park and the day', mails[0] && /Magic Kingdom/.test(mails[0].html));
  check('the account with a phone gets a push instead', pushes.length === 1 && pushes[0].title === 'Magic Kingdom in one week' && pushes[0].to === 'https://push.example/abc', JSON.stringify(pushes[0]));
  check('and not an email as well', !mails.some((m) => m.to?.includes?.('push@example.com') || m.to === 'push@example.com'));
  check('a trip eight days out is left alone', !mails.some((m) => String(m.to).includes('early')) && db.trips.get('early@example.com') && !db.trips.forNudges(today).find((t) => t.email === 'early@example.com').nudged);
  check('the trip remembers it has had the week-before nudge', db.trips.forNudges(today).find((t) => t.email === 'mail@example.com').nudged === '7');
  check('and the timeline says how it went', db.activity.forEmail('mail@example.com').some((e) => e.action === 'nudged about the trip' && /a week before · email/.test(e.detail)));

  await sweep(at(today, 15));
  check('the next sweep sends nothing again', mails.length === 1 && pushes.length === 1);

  console.log('\n  the evening before');
  const eve = addDays(start, -1);
  await sweep(at(eve, 10));
  check('mid-morning is too early for the day-before nudge', mails.length === 1);
  await sweep(at(eve, 18));
  check('at six in the evening it goes out', mails.length === 2 && /is tomorrow/.test(mails[1].subject), mails.map((m) => m.subject).join(' | '));
  check('the trip now has both', db.trips.forNudges(today).find((t) => t.email === 'mail@example.com').nudged === '7,1');
  await sweep(at(eve, 19));
  check('and only once', mails.length === 2);

  console.log('\n  a trip that moves');
  trip('mail@example.com', start, null);
  check('re-saving the same dates keeps the nudges it has had', db.trips.forNudges(today).find((t) => t.email === 'mail@example.com').nudged === '7,1');
  trip('mail@example.com', addDays(start, 30), null);
  check('new dates start the countdown afresh', db.trips.forNudges(today).find((t) => t.email === 'mail@example.com').nudged === null);

  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
