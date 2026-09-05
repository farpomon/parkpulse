// A ride in today's plan goes down.
//
// The alerts watch the rides people asked about; this watches the rides
// people are planning to ride. The phone gets "X just went down" once, "X
// is back" once, and only when: the account's day state says it is in that
// park today, the ride is still ahead of them, and the phone left a push
// endpoint. Nobody else hears a thing, and a dead endpoint is forgotten.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-replan.db';
process.env.PORT = '9677';
process.env.PASS_SECRET = 'testsecret';
process.env.HISTORY = 'off';
process.env.WAITS_CACHE_MS = '0';
process.env.PRO_GATE = 'off';

const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: { create: async () => ({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '.' }], usage: {} }) } } });

// The upstream: Magic Kingdom is park 6; which rides are shut is scripted.
let shut = new Set();
const RIDES = ['Space Mountain', 'Haunted Mansion', 'Jungle Cruise'];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u === 'https://queue-times.com/parks.json') return { ok: true, status: 200, json: async () => [{ id: 1, name: 'Walt Disney Attractions', parks: [{ id: 6, name: 'Magic Kingdom' }] }] };
  if (/queue-times\.com\/parks\/6\/queue_times\.json/.test(u)) return { ok: true, status: 200, json: async () => ({ lands: [{ name: 'X', rides: RIDES.map((name, i) => ({ id: i + 1, name, is_open: !shut.has(name), wait_time: shut.has(name) ? 0 : 35 })) }], rides: [] }) };
  if (u.startsWith('https://api.open-meteo.com') || u.startsWith('https://overpass')) return { ok: false, status: 503, json: async () => ({}) };
  return realFetch(url, opts);
};
// Every push, caught; one endpoint is dead.
const pushes = [];
const webpush = require('web-push');
webpush.sendNotification = async (sub, payload) => {
  if (sub.endpoint.endsWith('/dead')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
  pushes.push({ to: sub.endpoint, ...JSON.parse(payload) });
};

const db = require('../db.js');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const user = (email) => { try { db.users.create(email, 'salt', 'x', 1); } catch {} };
const state = (email, extra) => { user(email); db.daystate.set(email, { park: 'magic-kingdom', day: today, picked: ['Space Mountain', 'Haunted Mansion'], done: [], sub: { endpoint: `https://push.example/${email.split('@')[0]}`, keys: {} }, ...extra }); };

(async () => {
  const server = require('../server.js');
  const B = 'http://127.0.0.1:9677';
  for (let i = 0; i < 80 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  await server._applyStoredIds?.();
  const sweep = () => server._checkPlanBreakdowns();

  state('inpark@example.com');
  state('rode@example.com', { done: ['Space Mountain'] });
  state('nophone@example.com', { sub: null });
  state('yesterday@example.com', { day: '2020-01-01' });
  state('elsewhere@example.com', { picked: ['Jungle Cruise'] });
  state('dead@example.com');

  console.log('\n  the board is watched');
  await sweep();
  check('the first look just learns the board', pushes.length === 0);
  shut = new Set(['Space Mountain']);
  await sweep();
  const down = pushes.filter((p) => /just went down/.test(p.title));
  check('the person with it ahead of them is told', down.some((p) => p.to.endsWith('/inpark')), JSON.stringify(pushes));
  check('  with the app spot to tap into', down.every((p) => p.url === '/app?replan=Space%20Mountain'));
  check('the one who already rode it is not', !down.some((p) => p.to.endsWith('/rode')));
  check('nor the one with no phone endpoint', !down.some((p) => p.to.endsWith('/nophone')));
  check('nor yesterday\'s visitor', !down.some((p) => p.to.endsWith('/yesterday')));
  check('nor the one whose plan does not have it', !down.some((p) => p.to.endsWith('/elsewhere')));
  check('and it is on the timeline', db.activity.forEmail('inpark@example.com').some((e) => e.action === 'told a planned ride went down' && e.detail === 'Space Mountain'));
  check('the dead phone is forgotten', db.daystate.get('dead@example.com').sub === null);
  const n = pushes.length;
  await sweep();
  check('still down, nothing more is said', pushes.length === n);

  console.log('\n  it comes back');
  shut = new Set();
  await sweep();
  const back = pushes.filter((p) => /is back/.test(p.title));
  check('the same person hears it is back', back.length === 1 && back[0].to.endsWith('/inpark') && /35 min/.test(back[0].body), JSON.stringify(back));
  check('  landing on the same spot, flagged as back', back[0] && back[0].url === '/app?replan=Space%20Mountain&back=1');
  check('  under the same tag, so it replaces the first', back[0] && back[0].tag === down[0].tag);
  await sweep();
  check('and only once', pushes.filter((p) => /is back/.test(p.title)).length === 1);

  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
