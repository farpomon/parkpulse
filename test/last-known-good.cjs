// When the feed goes quiet, serve the last board we actually saw.
//
// Queue-Times fails often enough that this is not hypothetical: a 403, a
// timeout, a bad gateway. Until now only four of the sixty-five parks had
// anything behind them -- the four with a hand-written sample -- so for
// everyone else a blip meant an empty board, no picks, and "Mila couldn't fill
// this day". A visitor does not read that as "the feed hiccupped". They read
// it as "this app doesn't work".
//
// Every healthy read is now kept per park and handed back when the feed is
// down. What has to hold, and is checked below:
//   * a park with no sample gets its own last board instead of an empty one
//   * a park that HAS a sample prefers its own real board to the demo list
//   * it is never passed off as live: own source, and the hour it was taken
//   * it never contaminates the history archive the crowd model is built on
//   * a park seen only closed is not kept, or tomorrow morning opens shut
//   * it stops being served once it is too old to mean anything
//   * and the dashboard can say how much of a net is actually there
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-lastgood.db';
process.env.PORT = '9659';
process.env.PASS_SECRET = 'testsecret';
process.env.ADMIN_EMAILS = 'boss@example.com';
process.env.HISTORY = 'off';           // the collector would race every assertion here
process.env.WAITS_CACHE_MS = '0';      // watch the next request, not the one in five minutes
process.env.PRO_GATE = 'off';

const crypto = require('node:crypto');
const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: { create: async () => ({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '.' }], usage: {} }) } } });

// Three parks, each doing a different job. Disneyland is one of the sixty-one
// that had nothing behind it -- the case this exists for. Magic Kingdom is one
// of the four with a hand-written sample, so it proves which of the two wins.
// EPCOT is only ever seen shut.
const ID = { 'magic-kingdom': 6, disneyland: 16, epcot: 5 };
const OPEN = { 'Space Mountain': 45, 'Haunted Mansion': 25, 'Jungle Cruise': 30, 'Peter Pan': 60 };
const SHUT = Object.fromEntries(Object.keys(OPEN).map((n) => [n, null]));
const BOARD = (w) => ({
  lands: [{ name: 'Fantasyland', rides: Object.entries(w).map(([name, wait], i) => ({
    id: i + 1, name, is_open: wait !== null, wait_time: wait === null ? 0 : wait,
  })) }],
  rides: [],
});

// The upstream, scripted per park. A board, or a status to refuse with.
let feedFor = (id) => (id === ID.epcot ? SHUT : OPEN);
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u === 'https://queue-times.com/parks.json') {
    return { ok: true, status: 200, json: async () => [{
      id: 1, name: 'Walt Disney Attractions',
      parks: [{ id: ID['magic-kingdom'], name: 'Magic Kingdom' },
        { id: ID.disneyland, name: 'Disneyland' }, { id: ID.epcot, name: 'EPCOT' }],
    }] };
  }
  const m = u.match(/^https:\/\/queue-times\.com\/parks\/(\d+)\/queue_times\.json$/);
  if (m) {
    const r = feedFor(Number(m[1]));
    if (typeof r === 'number') return { ok: false, status: r, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => BOARD(r) };
  }
  // Everything else this server reaches for on boot, refused quietly.
  if (u.startsWith('https://api.open-meteo.com') || u.startsWith('https://overpass')) {
    return { ok: false, status: 503, json: async () => ({}) };
  }
  return realFetch(url, opts);
};

const B = 'http://127.0.0.1:9659';
const db = require('../db.js');
const history = require('../history.js');
const waits = async (slug) => (await fetch(`${B}/api/waits/${slug}`)).json();
const open = (w) => w.rides.filter((r) => r.open).map((r) => r.name).sort();
const stored = (slug) => { try { return JSON.parse(db.kv.get(`lastgood:${slug}`) || 'null'); } catch { return null; } };

const ADMIN = 'boss@example.com';
function adminSession() {
  try { db.users.create(ADMIN, 'salt', 'x', 1); db.users.markVerified(ADMIN); } catch {}
  const sid = crypto.randomBytes(16).toString('hex');
  db.sessions.create(sid, ADMIN, 'test-device', 'test');
  const body = Buffer.from(JSON.stringify({ sid, email: ADMIN, exp: Date.now() + 86400000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', process.env.PASS_SECRET).update(body).digest('base64url')}`;
}

(async () => {
  require('../server.js');
  for (let i = 0; i < 80 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  // Park ids are resolved from the feed on boot; nothing here works until they are.
  for (let i = 0; i < 80 && (await waits('disneyland')).source !== 'live'; i++) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('\n[while the feed is healthy]');
  const live = await waits('disneyland');
  check('the board is live', live.source === 'live', live.source);
  check('and carries the rides the feed sent', open(live).length === 4, open(live).join(', '));
  const mkLive = await waits('magic-kingdom');
  check('so is the park that has a sample', mkLive.source === 'live', mkLive.source);
  const epLive = await waits('epcot');
  check('and so is the one showing every ride shut', epLive.source === 'live', epLive.source);

  console.log('\n[what was worth keeping]');
  check('the open park was kept', stored('disneyland') !== null);
  check('so was the other open one', stored('magic-kingdom') !== null);
  check('the closed one was not', stored('epcot') === null,
    'a closed board was stored — tomorrow morning would open shut');

  console.log('\n[the feed goes down]');
  const before = Date.now();
  feedFor = () => 503;
  const down = await waits('disneyland');
  check('a park with no sample is not left empty', down.rides.length > 0,
    `${down.rides.length} rides, source ${down.source}`);
  check('it serves the last board we recorded', down.source === 'stored', down.source);
  check('with the same rides on it', JSON.stringify(open(down)) === JSON.stringify(open(live)), open(down).join(', '));
  check('it never claims to be live', down.source !== 'live');
  // The whole honesty of the feature is here: the timestamp is the moment the
  // waits were real, not the moment we handed them over. Stamp it "now" and
  // the screen says "Live · just now" over a board from this morning.
  check('stamped when the waits were real, not when they were served',
    new Date(down.updatedAt).getTime() < before, `${down.updatedAt} vs request at ${new Date(before).toISOString()}`);
  check('and the attribution says which it is', /last waits/i.test(down.attribution || ''), down.attribution);

  console.log('\n[the ladder, in order]');
  const mkDown = await waits('magic-kingdom');
  check('a real board of its own beats the hand-written sample', mkDown.source === 'stored', mkDown.source);
  const epDown = await waits('epcot');
  check('and the sample is still there for a park with nothing kept', epDown.source === 'sample', epDown.source);

  console.log('\n[the archive the crowd model is built on stays clean]');
  check('a stored board is not recorded as history', history.record('disneyland', down) === false);
  check('a live one still is', history.record('disneyland', live) === true);

  console.log('\n[what the dashboard sees]');
  const opsRes = await fetch(`${B}/api/admin/ops`, { headers: { 'x-session': adminSession() } });
  const ops = await opsRes.json();
  check('the dashboard answered', opsRes.ok && ops.health, `${opsRes.status} ${JSON.stringify(ops).slice(0, 80)}`);
  const parks = (ops.health && ops.health.parks) || [];
  const summary = (ops.health && ops.health.summary) || {};
  const dl = parks.find((p) => p.slug === 'disneyland');
  const ep = parks.find((p) => p.slug === 'epcot');
  check('a park with a net reports how old it is', dl && typeof dl.backupAgeMin === 'number', JSON.stringify(dl));
  check('a park without one says so', ep && ep.backupAgeMin === null, JSON.stringify(ep));
  check('and the run is counted as served from store', summary.stored >= 1, JSON.stringify(summary));

  console.log('\n[and it expires]');
  // Aged in place rather than deleted: what matters is that an old board stops
  // being served, not that the row disappears.
  const kept = stored('disneyland');
  kept.updatedAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  db.kv.set('lastgood:disneyland', JSON.stringify(kept));
  const old = await waits('disneyland');
  check('a board from thirty hours ago is not served', old.source !== 'stored', old.source);
  check('and the park says plainly that it has nothing', old.source === 'unavailable', old.source);

  console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the last good board is there when the feed is not ===');
  process.exit(fail ? 1 : 0);
})();
