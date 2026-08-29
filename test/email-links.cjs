// The emailed plan is for one park, and every link in it has to land there.
// Bare /app opens whichever park the device was last on -- so a plan for
// Liseberg would open Magic Kingdom for anyone who had been browsing it.
//
// Sends a real plan email through the real route with the outbound HTTP call
// intercepted, so what is asserted is the HTML that would have gone out.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-email-links.db';
process.env.PORT = '9698';
process.env.PASS_SECRET = 'testsecret';
process.env.RESEND_API_KEY = 'test-key-intercepted-below';
const fs = require('node:fs'), crypto = require('node:crypto');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let sentMail = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url && url.url ? url.url : url);
  if (u.startsWith('https://api.resend.com/')) {
    sentMail = JSON.parse(init.body);
    return new Response('{"id":"x"}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u === 'https://queue-times.com/parks.json') {
    return new Response(JSON.stringify([{ id: 1, name: 'Liseberg group', parks: [{ id: 9, name: 'Liseberg' }] }]), { headers: { 'content-type': 'application/json' } });
  }
  if (/queue_times\.json/.test(u)) {
    return new Response(JSON.stringify({ lands: [{ name: 'A', rides: [{ id: 1, name: 'Balder', is_open: true, wait_time: 30, last_updated: new Date().toISOString() }] }], rides: [] }), { headers: { 'content-type': 'application/json' } });
  }
  if (/open-meteo/.test(u)) return new Response('{}', { headers: { 'content-type': 'application/json' } });
  return realFetch(url, init);
};

const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: {
  create: async () => ({ model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Uma nota curta da Mila.' }], usage: {} }),
} } });
const db = require('../db.js');
require('../server.js');

const { DatabaseSync } = require('node:sqlite');
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const sign = (p) => { const b = Buffer.from(JSON.stringify(p)).toString('base64url'); return `${b}.${crypto.createHmac('sha256', 'testsecret').update(b).digest('base64url')}`; };
const EMAIL = 'planner@test.dev';

(async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const raw = new DatabaseSync(process.env.DB_FILE);
  raw.prepare('INSERT INTO users (email, salt, hash, created_at, verified) VALUES (?,?,?,?,1)').run(EMAIL, 'x', 'x', new Date().toISOString());
  raw.prepare('INSERT INTO sessions (id, email, device, ua, created_at, last_seen) VALUES (?,?,?,?,?,?)').run('sid1', EMAIL, 'd', 'ua', new Date().toISOString(), new Date().toISOString());
  raw.close();
  const token = sign({ email: EMAIL, sid: 'sid1', exp: Date.now() + 3600000 });

  // A park that is emphatically NOT the app's default, which is the whole point.
  const SLUG = 'liseberg';
  const res = await fetch('http://127.0.0.1:9698/api/plan/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session': token },
    body: JSON.stringify({
      park: SLUG, date: new Date().toISOString().slice(0, 10),
      stops: [{ name: 'Balder', time: '10:00', predicted: 25 }, { name: 'Helix', time: '11:00', predicted: 30 }],
      savedMin: 40, profile: { party: 2, ages: ['adult'], vibes: ['thrill'] },
    }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`\n[sending a plan for ${SLUG}]`);
  check('the route accepted it', res.status === 200, `${res.status} ${JSON.stringify(body)}`);
  check('an email went out', Boolean(sentMail), JSON.stringify(body));
  if (!sentMail) { console.log('\n=== nothing to check ==='); process.exit(1); }

  const html = sentMail.html;
  const links = [...html.matchAll(/href="(https:\/\/www\.parkpulse\.fun\/app[^"]*)"/g)].map((m) => m[1]);
  console.log(`      subject: ${sentMail.subject}`);
  links.forEach((l) => console.log(`      link: ${l}`));

  console.log('\n[every link back into the app]');
  check('there are some', links.length >= 2, `${links.length}`);
  check('and every one names the park', links.every((l) => l.includes(`?park=${SLUG}`)), links.filter((l) => !l.includes(`?park=${SLUG}`)).join(', '));
  check('none of them is a bare /app', !links.some((l) => /\/app$/.test(l)), links.join(', '));
  check('the park is the one the plan was for', !/park=magic-kingdom/.test(html));
  check("a plan for today carries no day, because today is where the link lands anyway", !links.some((l) => l.includes('date=')), links.join(', '));

  // A plan built for a day that has not arrived yet is the case that breaks:
  // the reader opens the link, the park is restored, and the planner quietly
  // shows today -- a different running order from the one they are reading.
  const FUTURE = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  sentMail = null;
  const res2 = await fetch('http://127.0.0.1:9698/api/plan/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session': token },
    body: JSON.stringify({
      park: SLUG, date: FUTURE, planDate: FUTURE,
      stops: [{ name: 'Balder', time: '10:00', predicted: 25 }, { name: 'Helix', time: '11:00', predicted: 30 }],
      savedMin: 40, profile: { party: 2, ages: ['adult'], vibes: ['thrill'] },
    }),
  });
  console.log(`\n[sending a plan for ${FUTURE}]`);
  check('the route accepted it', res2.status === 200, `${res2.status}`);
  check('an email went out', Boolean(sentMail));
  const links2 = sentMail ? [...sentMail.html.matchAll(/href="(https:\/\/www\.parkpulse\.fun\/app[^"]*)"/g)].map((m) => m[1]) : [];
  links2.forEach((l) => console.log(`      link: ${l}`));
  check('every link still names the park', links2.length >= 2 && links2.every((l) => l.includes(`?park=${SLUG}`)), links2.join(', '));
  // &amp; in an href, because it is HTML: the parser hands the browser a bare &.
  check('and now also names the day it was planned for', links2.every((l) => l.includes(`&amp;date=${FUTURE}`)), links2.join(', '));

  console.log('\n[the app honours it]');
  // The email is only as good as the deep link it relies on.
  const appHtml = await (await fetch('http://127.0.0.1:9698/app')).text();
  check("the app reads ?park= on boot", /qs\.get\('park'\)/.test(appHtml), 'the deep-link handler is missing');
  check('and stores it as the current park', /localStorage\.setItem\('pp-park', qPark\)/.test(appHtml));
  check('it reads ?date= too', /qs\.get\('date'\)/.test(appHtml), 'the day half of the deep link is missing');
  check('holds it until the forecast says the day is still reachable', /applyPendingPlanDate/.test(appHtml));
  check('and cleans both params off the address bar', /qPark \|\| qPremade \|\| qDate/.test(appHtml));

  console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the email lands on its own park, on its own day ===');
  process.exit(fail ? 1 : 0);
})();
