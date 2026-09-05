// What does a real guest do after opening the invite?
//
// Every other table answers a different question: daystate is where they are
// now, hits are how many per day, the funnel is who ever built a plan. None
// of them can say "she opened the link at 14:00, picked six rides at 14:03,
// asked Mila at 14:07 and never came back". That is a sequence with hours on
// it, and this checks the sequence is written down at each step a guest takes
// -- and shown to the operator on the invite that let her in.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-activity.db';
process.env.PORT = '9665';
process.env.PASS_SECRET = 'testsecret';
process.env.ADMIN_EMAILS = 'boss@example.com';
process.env.HISTORY = 'off';

const crypto = require('node:crypto');
const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: { create: async () => ({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '.' }], usage: {} }) } } });
const db = require('../db.js');
const B = 'http://127.0.0.1:9665';

function session(email) {
  try { db.users.create(email, 'salt', 'x', 1); db.users.markVerified(email); } catch {}
  const sid = crypto.randomBytes(16).toString('hex');
  db.sessions.create(sid, email, 'test-phone', 'test');
  const body = Buffer.from(JSON.stringify({ sid, email, exp: Date.now() + 86400000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', process.env.PASS_SECRET).update(body).digest('base64url')}`;
}
const call = (path, body, sess, method) => fetch(`${B}${path}`, {
  method: method || (body ? 'POST' : 'GET'),
  headers: { 'content-type': 'application/json', ...(sess ? { 'x-session': sess } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

(async () => {
  require('../server.js');
  for (let i = 0; i < 80 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }

  const boss = session('boss@example.com');
  const guest = session('amy@example.com');
  const actionsOf = (email) => db.activity.forEmail(email).map((e) => e.action);

  console.log('\n  the invite');
  const inv = await call('/api/admin/invite', { channel: 'link', days: 10 }, boss);
  check('the operator mints a 10-day link', inv.status === 200 && /^[a-f0-9]{32}$/.test(inv.data.token || ''), JSON.stringify(inv.data).slice(0, 100));
  const claim = await call('/api/invite/claim', { token: inv.data.token }, guest);
  check('the guest accepts it', claim.status === 200 && claim.data.ok);
  check('and that is the first line of her timeline', actionsOf('amy@example.com').includes('accepted invite'));
  const first = db.activity.forEmail('amy@example.com').find((e) => e.action === 'accepted invite');
  check('with the pass length on it', first && first.detail === '10-day guest pass', first && first.detail);

  console.log('\n  the day in the park');
  await call('/api/daystate', { state: { park: 'magic-kingdom', picked: ['Space Mountain', 'Haunted Mansion', 'Pirates of the Caribbean'] } }, guest);
  let acts = actionsOf('amy@example.com');
  check('opening a park is recorded, by name', db.activity.forEmail('amy@example.com').some((e) => e.action === 'opened a park' && /Magic Kingdom/.test(e.detail)));
  check('so is building the plan, with its size', db.activity.forEmail('amy@example.com').some((e) => e.action === 'added to plan' && e.detail === '3 rides in plan'));

  await call('/api/daystate', { state: { park: 'magic-kingdom', picked: ['Space Mountain', 'Haunted Mansion', 'Pirates of the Caribbean'] } }, guest);
  check('syncing the same state again records nothing', actionsOf('amy@example.com').length === acts.length, `${actionsOf('amy@example.com').length} vs ${acts.length}`);

  await call('/api/daystate', { state: { park: 'magic-kingdom', picked: ['Space Mountain', 'Haunted Mansion', 'Pirates of the Caribbean'], done: ['Space Mountain'], lanePasses: ['Haunted Mansion'] } }, guest);
  check('ticking off a ride is recorded, by ride', db.activity.forEmail('amy@example.com').some((e) => e.action === 'rode' && e.detail === 'Space Mountain'));
  check('applying a lane pass is recorded', db.activity.forEmail('amy@example.com').some((e) => e.action === 'applied a lane pass' && e.detail === 'Haunted Mansion'));

  const saved = await call('/api/plans', { park: 'magic-kingdom', date: '2030-05-01', stops: [{ name: 'Space Mountain', time: '09:00' }, { name: 'Haunted Mansion', time: '10:00' }] }, guest);
  check('saving a plan is recorded with park, date and size', saved.status === 200 && db.activity.forEmail('amy@example.com').some((e) => e.action === 'saved a plan' && e.detail === 'Magic Kingdom · 2030-05-01 · 2 stops'), JSON.stringify(saved.data));

  const nps = await call('/api/nps', { score: 9, comment: 'loved it' }, guest);
  check('answering NPS is recorded with the score', nps.status === 200 && db.activity.forEmail('amy@example.com').some((e) => e.action === 'answered the NPS question' && e.detail === '9/10 · loved it'));

  const rated = await call('/api/rate', { park: 'magic-kingdom', ride: 'Space Mountain', kind: 'rate', vote: 1 }, guest);
  check('a thumbs up is recorded', rated.status === 200 && db.activity.forEmail('amy@example.com').some((e) => e.action === 'thumbs up' && e.detail === 'Space Mountain'));

  console.log('\n  what the operator sees');
  const list = await call('/api/admin/invites', null, boss);
  const sum = list.data.activity?.['amy@example.com'];
  check('the invite table carries her action count', list.status === 200 && sum && sum.n === actionsOf('amy@example.com').length, JSON.stringify(sum));
  check('and when she was last active', sum && typeof sum.last === 'string' && Date.now() - new Date(sum.last).getTime() < 60000);
  const tl = await call('/api/admin/activity?email=amy@example.com', null, boss);
  check('the timeline lists every action', tl.status === 200 && tl.data.events.length === actionsOf('amy@example.com').length);
  check('newest first', tl.data.events.length > 1 && tl.data.events[0].at >= tl.data.events[tl.data.events.length - 1].at);
  check('with an hour on every line', tl.data.events.every((e) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(e.at)));
  const stranger = await call('/api/admin/activity?email=amy@example.com', null, guest);
  check('and only the operator can read it', stranger.status === 403);

  console.log('\n  the timeline is hers');
  db.accounts.purge('amy@example.com');
  check('deleting the account deletes the timeline', db.activity.forEmail('amy@example.com').length === 0);

  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
