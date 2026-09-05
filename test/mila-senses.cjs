// Mila's senses and initiative, server side.
//
//   * a photo may ride on the last message, once, within limits
//   * find_food answers from the park's dining list, with the booking link
//   * a story for the queue: light tier, gated like everything Mila does
//   * the week-before nudge carries her three-line briefing
//   * rain inside two hours reaches the phone once, and not when it is already
//     raining, and not outside park hours
//   * only Mila's endpoint accepts a request the size of a photo
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-senses.db';
process.env.PORT = '9678';
process.env.PASS_SECRET = 'testsecret';
process.env.HISTORY = 'off';
process.env.RESEND_API_KEY = 'stub';
process.env.WAITS_CACHE_MS = '0';

const crypto = require('node:crypto');
const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

// The model, stood in for: every create() is recorded and answers by its system prompt.
const calls = [];
const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: {
  create: async (a) => {
    calls.push(a);
    const sys = String(a.system || '');
    const text = /three-line briefing/.test(sys) ? '- Walk straight to Space Mountain at rope drop.\n- Book Be Our Guest when the 60-day window opens at 6am ET.\n- Skip Lightning Lane on a Light day.'
      : /quiz/.test(sys) && /Write a five-question quiz/.test(sys) && JSON.parse(a.messages[0].content).kind === 'quiz' ? '1. How fast? A) 10 B) 28 C) 90\nAnswers: B'
      : 'Once upon a time, in a very long line, a small dragon learned to be patient.';
    return { model: a.model, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 50, output_tokens: 40 } };
  },
  stream: () => ({ async *[Symbol.asyncIterator]() {}, finalMessage: async () => ({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '.' }], usage: {} }) }),
} } });

// Upstream, stood in for: waits for park 6, weather that can be made to rain.
const mails = [], pushes = [];
let rainAt = null;   // local hour that will show 80% precipitation, or null
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u === 'https://queue-times.com/parks.json') return { ok: true, status: 200, json: async () => [{ id: 1, name: 'WDA', parks: [{ id: 6, name: 'Magic Kingdom' }] }] };
  if (/queue-times\.com\/parks\/6\/queue_times\.json/.test(u)) return { ok: true, status: 200, json: async () => ({ lands: [{ name: 'X', rides: [{ id: 1, name: 'Space Mountain', is_open: true, wait_time: 30 }] }], rides: [] }) };
  if (u.startsWith('https://api.open-meteo.com')) {
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const hours = Array.from({ length: 24 }, (_, h) => h);
    const t = hours.map((h) => `${day}T${String(h).padStart(2, '0')}:00`);
    return { ok: true, status: 200, json: async () => ({
      current: { temperature_2m: 30, apparent_temperature: 33, weather_code: 2, precipitation: 0 },
      hourly: { time: t, temperature_2m: hours.map(() => 30), apparent_temperature: hours.map(() => 33), precipitation_probability: hours.map((h) => (rainAt !== null && h === rainAt ? 80 : 10)), weather_code: hours.map(() => 2), uv_index: hours.map(() => 6), wind_speed_10m: hours.map(() => 8), relative_humidity_2m: hours.map(() => 60) },
      daily: { time: [day], weather_code: [2], temperature_2m_max: [32], temperature_2m_min: [24], precipitation_probability_max: [rainAt !== null ? 80 : 10], uv_index_max: [8], wind_speed_10m_max: [12], sunrise: [`${day}T07:00`], sunset: [`${day}T19:30`] },
    }) };
  }
  if (u.startsWith('https://api.resend.com/')) { mails.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ id: 'm' }) }; }
  if (u.startsWith('https://overpass')) return { ok: false, status: 503, json: async () => ({}) };
  return realFetch(url, opts);
};
const webpush = require('web-push');
webpush.sendNotification = async (sub, payload) => { pushes.push({ to: sub.endpoint, ...JSON.parse(payload) }); };

const db = require('../db.js');
const B = 'http://127.0.0.1:9678';
const TZ = 'America/New_York';
const nyDate = (d) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const at = (date, hh) => { const g = new Date(`${date}T${String(hh).padStart(2, '0')}:00:00Z`); const shown = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(g)) % 24; return new Date(g.getTime() + ((hh - shown + 24) % 24) * 3600000); };
function session(email) {
  try { db.users.create(email, 'salt', 'x', 1); } catch {}
  db.users.markVerified(email);
  const sid = crypto.randomBytes(16).toString('hex');
  db.sessions.create(sid, email, 'phone', 'test');
  const body = Buffer.from(JSON.stringify({ sid, email, exp: Date.now() + 86400000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', process.env.PASS_SECRET).update(body).digest('base64url')}`;
}
const call = (path, body, sess) => fetch(`${B}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(sess ? { 'x-session': sess } : {}) }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

(async () => {
  const server = require('../server.js');
  for (let i = 0; i < 80 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 200));
  await server._applyStoredIds?.();
  const { validateMessages, runTool } = consultant._internal;

  console.log('\n  a photo on the last message');
  const png = Buffer.alloc(900, 7).toString('base64');
  const shot = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: png } };
  const ok = validateMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: [shot, { type: 'text', text: 'Anything without nuts?' }] }]);
  check('a photo with a question is accepted', ok && Array.isArray(ok[2].content) && ok[2].content[0].type === 'image' && ok[2].content[1].text === 'Anything without nuts?');
  check('history stays plain text', ok && typeof ok[0].content === 'string');
  check('a photo with no words gets a question', validateMessages([{ role: 'user', content: [shot] }])[0].content[1].text === 'What do you make of this?');
  check('a photo on an earlier turn is refused', validateMessages([{ role: 'user', content: [shot, { type: 'text', text: 'x' }] }, { role: 'assistant', content: 'y' }, { role: 'user', content: 'z' }]) === null);
  check('two photos are refused', validateMessages([{ role: 'user', content: [shot, shot, { type: 'text', text: 'x' }] }]) === null);
  check('a GIF is refused', validateMessages([{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/gif', data: png } }] }]) === null);
  check('a URL image is refused', validateMessages([{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.jpg' } }] }]) === null);
  check('a photo too big for a downscaled shot is refused', validateMessages([{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(2_500_000) } }] }]) === null);

  console.log('\n  where do we eat');
  db.dining.set('magic-kingdom', 'en', JSON.stringify([
    { name: 'Be Our Guest', type: 'table', price: '$$$', blurb: 'French-inspired, in the Beast\'s castle.', mustBook: true },
    { name: 'Casey\'s Corner', type: 'quick', price: '$', blurb: 'Hot dogs on Main Street.', mustBook: false },
  ]));
  const ctx = { park: server._reserveFor ? null : null, send: () => {}, lang: 'English', channel: 'app' };
  const food = await runTool({ name: 'find_food', input: { park: 'magic-kingdom', type: 'any' } }, { ...ctx, park: { slug: 'magic-kingdom', name: 'Magic Kingdom' } });
  check('the tool lists what the catalogue knows', !food.isError && /Be Our Guest/.test(food.text) && /Casey/.test(food.text), food.text.slice(0, 120));
  check('  marks what needs booking', /Be Our Guest[^\n]*BOOK AHEAD/.test(food.text));
  check('  and hands over the reservation link', /disney\.go\.com|reservation/i.test(food.text));
  const quick = await runTool({ name: 'find_food', input: { park: 'magic-kingdom', type: 'quick' } }, { ...ctx, park: { slug: 'magic-kingdom', name: 'Magic Kingdom' } });
  check('narrowing to quick service works', /Casey/.test(quick.text) && !/Be Our Guest/.test(quick.text));
  const none = await runTool({ name: 'find_food', input: { park: 'epcot' } }, { ...ctx, park: { slug: 'epcot', name: 'EPCOT' } });
  check('a park with no list says so instead of inventing', !none.isError && /no dining list/.test(none.text));

  console.log('\n  a story for the queue');
  const noone = await call('/api/mila/story', { park: 'magic-kingdom', kind: 'story' });
  check('needs an account', noone.status === 401);
  const fam = session('fam@example.com');
  const st = await call('/api/mila/story', { park: 'magic-kingdom', kind: 'story', ride: 'Space Mountain', ages: [5, 8], lang: 'Spanish' }, fam);
  check('a story comes back', st.status === 200 && /dragon/.test(st.data.text), JSON.stringify(st.data).slice(0, 100));
  const c = calls[calls.length - 1];
  check('  on the light tier', c.model === consultant.models.light, c.model);
  check('  suited to the youngest, in their language, franchise-free', /youngest/.test(c.system) && /franchise/.test(c.system) && /"language":"Spanish"/.test(c.messages[0].content) && /"childrenAges":\[5,8\]/.test(c.messages[0].content));
  const qz = await call('/api/mila/story', { park: 'magic-kingdom', kind: 'quiz', ride: 'Space Mountain' }, fam);
  check('a quiz has questions and an answer line', qz.status === 200 && /Answers:/.test(qz.data.text));
  check('  and each is on the timeline', db.activity.forEmail('fam@example.com').filter((e) => /asked Mila for a (story|quiz)/.test(e.action)).length === 2);
  check('  and billed to the account', db.aiusage && true);

  console.log('\n  the week-before briefing');
  const today = nyDate(new Date());
  const start = new Date(Date.parse(today + 'T12:00:00Z') + 7 * 86400000).toISOString().slice(0, 10);
  try { db.users.create('trip@example.com', 'salt', 'x', 1); } catch {}
  db.daystate.set('trip@example.com', { park: 'magic-kingdom', day: today, lang: 'pt', picked: [] });
  db.trips.set('trip@example.com', 'Walt Disney World', start, 1, JSON.stringify([{ date: start, park: 'magic-kingdom' }]), 0, null);
  await server._sweepTripNudges(at(today, 12));
  const m = mails.find((x) => /in one week/.test(x.subject));
  check('the nudge carries her three lines', m && /Walk straight to Space Mountain/.test(m.html) && /Skip Lightning Lane/.test(m.html), m && m.html.slice(0, 200));
  check('  as three lines, not one run-on paragraph', m && (m.html.match(/<br>/g) || []).length >= 3);
  const bc = calls.find((x) => /three-line briefing/.test(String(x.system)));
  check('  written in the account\'s language', bc && /"language":"Portuguese"/.test(bc.messages[0].content));
  check('  once', calls.filter((x) => /three-line briefing/.test(String(x.system))).length === 1);

  console.log('\n  rain on the way');
  const sub = (who) => ({ endpoint: `https://push.example/${who}`, keys: {} });
  try { db.users.create('wet@example.com', 'salt', 'x', 1); db.users.create('dry@example.com', 'salt', 'x', 1); } catch {}
  db.daystate.set('wet@example.com', { park: 'magic-kingdom', day: today, picked: ['Space Mountain'], sub: sub('wet') });
  db.daystate.set('dry@example.com', { park: 'magic-kingdom', day: '2020-01-01', picked: ['Space Mountain'], sub: sub('dry') });
  rainAt = 15;
  await server._sweepRainPivots(at(today, 13));
  check('rain two hours out is not yet worth a push', pushes.length === 0, JSON.stringify(pushes));
  await server._sweepRainPivots(at(today, 14));
  check('an hour out, the person in the park is told', pushes.length === 1 && pushes[0].to.endsWith('/wet') && /15:00/.test(pushes[0].title) && /indoor/.test(pushes[0].body), JSON.stringify(pushes));
  check('  not the one who was here in 2020', !pushes.some((p) => p.to.endsWith('/dry')));
  check('  and it is on the timeline', db.activity.forEmail('wet@example.com').some((e) => e.action === 'warned about rain' && /80%/.test(e.detail)));
  await server._sweepRainPivots(at(today, 14));
  check('and only once a day', pushes.length === 1);
  db.kv.del(`rain:wet@example.com|${today}`);
  await server._sweepRainPivots(at(today, 15));
  check('once it is already raining, nothing is said', pushes.length === 1);
  await server._sweepRainPivots(at(today, 6));
  check('nor before the park opens', pushes.length === 1);

  console.log('\n  only Mila takes a photo-sized request');
  const big = JSON.stringify({ park: 'magic-kingdom', messages: [{ role: 'user', content: 'x'.repeat(200000) }] });
  const r1 = await fetch(`${B}/api/consultant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big }).then((r) => r.status).catch((e) => 'reset');
  check('a 200 KB body reaches the advisor endpoint', typeof r1 === 'number', String(r1));
  const r2 = await fetch(`${B}/api/nps`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big }).then((r) => r.status).catch(() => 'reset');
  check('and is cut off everywhere else', r2 === 'reset', String(r2));

  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
