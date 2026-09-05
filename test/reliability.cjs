// Which rides go down, how often, and when -- from the archive.
//
// Every snapshot already lists the rides the feed called shut. A ride open in
// one snapshot and shut in the next has just gone down; counted per
// operating day, with the hour in the park's own clock, that is the one line
// nobody else can print. It has to be honest about what it does not know:
// a ride that never breaks gets no line at all, a ride seen for too few days
// gets none either, and the hour only appears once there are enough
// breakdowns to make one typical.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-reliab.db';
process.env.HISTORY_DIR = '/tmp/pp-reliab-history';
process.env.PORT = '9676';
process.env.PASS_SECRET = 'testsecret';
process.env.HISTORY = 'off';
process.env.WAITS_CACHE_MS = '0';
process.env.PRO_GATE = 'off';

const fs = require('node:fs');
const path = require('node:path');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });
fs.rmSync(process.env.HISTORY_DIR, { recursive: true, force: true });
fs.mkdirSync(process.env.HISTORY_DIR, { recursive: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

// Seven operating days at Magic Kingdom, a snapshot every half hour from
// 13:00Z to 23:30Z (9am to 7:30pm in Orlando, EDT).
//   Space Mountain   goes down at 14:00Z (10:00 local) every day, for an hour
//   Jungle Cruise    goes down once, briefly, on two of the days
//   Peter Pan        shut all day on one day, never a transition
//   Haunted Mansion  never down
//   Tomorrowland Speedway  seen only on the last day -- too little to judge
const RIDES = ['Space Mountain', 'Jungle Cruise', 'Peter Pan', 'Haunted Mansion'];
const day0 = Date.parse('2026-08-01T00:00:00Z');
for (let d = 0; d < 7; d++) {
  const date = new Date(day0 + d * 86400000).toISOString().slice(0, 10);
  const lines = [];
  for (let m = 13 * 60; m <= 23 * 60 + 30; m += 30) {
    const t = new Date(day0 + d * 86400000 + m * 60000).toISOString();
    const shut = [];
    if (m >= 14 * 60 && m < 15 * 60) shut.push('Space Mountain');
    if ((d === 2 || d === 5) && m === 17 * 60) shut.push('Jungle Cruise');
    if (d === 3) shut.push('Peter Pan');
    const rides = {};
    for (const n of RIDES) if (!shut.includes(n)) rides[n] = 30;
    if (d === 6) rides['Tomorrowland Speedway'] = 15;
    lines.push(JSON.stringify({ t, park: 'magic-kingdom', rides, ...(shut.length && { shut }) }));
  }
  fs.writeFileSync(path.join(process.env.HISTORY_DIR, `${date}.jsonl`), lines.join('\n') + '\n');
}

const history = require('../history.js');
const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: { create: async () => ({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '.' }], usage: {} }) } } });

console.log('\n  from the archive');
const rel = history.computeReliability(() => 'America/New_York');
const mk = rel['magic-kingdom'] || {};
check('the park is in the report', Boolean(rel['magic-kingdom']), Object.keys(rel).join(','));
check('Space Mountain goes down once a day', mk['Space Mountain'] && mk['Space Mountain'].perDay === 1, JSON.stringify(mk['Space Mountain']));
check('  usually at ten in the morning, Orlando time', mk['Space Mountain'] && mk['Space Mountain'].hour === 10);
check('  and is down about a tenth of the time', mk['Space Mountain'] && mk['Space Mountain'].pct === 9, mk['Space Mountain'] && mk['Space Mountain'].pct);
check('Jungle Cruise: about 0.3 a day, no typical hour from two breakdowns', mk['Jungle Cruise'] && mk['Jungle Cruise'].perDay === 0.3 && mk['Jungle Cruise'].hour === null, JSON.stringify(mk['Jungle Cruise']));
check('Peter Pan: a whole day down counts as time down, not as a breakdown', mk['Peter Pan'] && mk['Peter Pan'].perDay === 0 && mk['Peter Pan'].pct === 14, JSON.stringify(mk['Peter Pan']));
check('Haunted Mansion never breaks and so gets no line', !('Haunted Mansion' in mk));
check('a ride seen for one day is not judged', !('Tomorrowland Speedway' in mk));
check('every line says how many days it rests on', Object.values(mk).every((r) => r.days === 7));

// Fewer than five operating days: nothing, however dramatic.
for (let d = 0; d < 7; d++) {
  const date = new Date(day0 + d * 86400000).toISOString().slice(0, 10);
  if (d >= 3) fs.rmSync(path.join(process.env.HISTORY_DIR, `${date}.jsonl`));
}
check('three days of history is too few to say anything', !('magic-kingdom' in history.computeReliability(() => 'America/New_York')));
// Put them back for the server half.
for (let d = 3; d < 7; d++) {
  const date = new Date(day0 + d * 86400000).toISOString().slice(0, 10);
  const lines = [];
  for (let m = 13 * 60; m <= 23 * 60 + 30; m += 30) {
    const t = new Date(day0 + d * 86400000 + m * 60000).toISOString();
    const shut = m >= 14 * 60 && m < 15 * 60 ? ['Space Mountain'] : [];
    const rides = {}; for (const n of RIDES) if (!shut.includes(n)) rides[n] = 30;
    lines.push(JSON.stringify({ t, park: 'magic-kingdom', rides, ...(shut.length && { shut }) }));
  }
  fs.writeFileSync(path.join(process.env.HISTORY_DIR, `${date}.jsonl`), lines.join('\n') + '\n');
}

// The upstream, stood in for: Magic Kingdom is park 6 and everything is open.
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u === 'https://queue-times.com/parks.json') return { ok: true, status: 200, json: async () => [{ id: 1, name: 'Walt Disney Attractions', parks: [{ id: 6, name: 'Magic Kingdom' }] }] };
  if (/queue-times\.com\/parks\/6\/queue_times\.json/.test(u)) return { ok: true, status: 200, json: async () => ({ lands: [{ name: 'Tomorrowland', rides: RIDES.map((name, i) => ({ id: i + 1, name, is_open: true, wait_time: 30 })) }], rides: [] }) };
  if (u.startsWith('https://api.open-meteo.com') || u.startsWith('https://overpass')) return { ok: false, status: 503, json: async () => ({}) };
  return realFetch(url, opts);
};

(async () => {
  const server = require('../server.js');
  const B = 'http://127.0.0.1:9676';
  for (let i = 0; i < 80 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  await server._applyStoredIds?.();
  server._refreshBaselines();

  console.log('\n  on the board');
  let w = null;
  for (let i = 0; i < 20 && !(w && w.source === 'live'); i++) { w = await fetch(`${B}/api/waits/magic-kingdom`).then((r) => r.json()); if (w.source !== 'live') await new Promise((r) => setTimeout(r, 300)); }
  check('the live board carries the archive’s word beside it', w && w.rel && w.rel['Space Mountain'] && w.rel['Space Mountain'].perDay === 1, JSON.stringify(w && w.rel).slice(0, 120));
  check('  and nothing about the ride that never breaks', w && w.rel && !('Haunted Mansion' in w.rel));
  check('the board itself is untouched', w && w.rides.length === RIDES.length && !('rel' in w.rides[0]));

  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
