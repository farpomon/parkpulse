// "How likely are you to recommend ParkPulse to a friend?" -- the collection
// half. What has to hold:
//   * anyone can answer: an account under its email, a stranger under their
//     device id, and nobody with neither
//   * a score is 0 to 10 and nothing else
//   * one answer per person per quarter -- a second tap updates, the comment
//     that arrives a moment later lands on the same row
//   * the dashboard computes the score the way the method defines it
//   * and deleting an account deletes its answers
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-nps.db';
process.env.PORT = '9657';
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
const B = 'http://127.0.0.1:9657';

function session(email) {
  try { db.users.create(email, 'salt', 'x', 1); db.users.markVerified(email); } catch {}
  const sid = crypto.randomBytes(16).toString('hex');
  db.sessions.create(sid, email, 'test-device', 'test');
  const body = Buffer.from(JSON.stringify({ sid, email, exp: Date.now() + 86400000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', process.env.PASS_SECRET).update(body).digest('base64url')}`;
}
const post = (body, sess) => fetch(`${B}/api/nps`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(sess ? { 'x-session': sess } : {}) }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const rows = () => db.kv && require('../db.js') && dbAll();
function dbAll() { return db.nps.summary(365); }

(async () => {
  require('../server.js');
  for (let i = 0; i < 80 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('\n[who can answer]');
  const DEV = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  let r = await post({ score: 9, device: DEV });
  check('a stranger answers under their device', r.status === 200 && r.body.ok, JSON.stringify(r.body));
  r = await post({ score: 9 });
  check('nobody answers as nobody', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await post({ score: 9, device: 'short' });
  check('a made-up device id does not count either', r.status === 400, String(r.status));
  const alice = session('alice@example.com');
  r = await post({ score: 10, park: 'magic-kingdom', lang: 'pt' }, alice);
  check('an account answers under its email, no device needed', r.status === 200 && r.body.ok, JSON.stringify(r.body));

  console.log('\n[what counts as a score]');
  for (const bad of [-1, 11, 7.5, 'nine', null]) {
    r = await post({ score: bad, device: DEV });
    check(`${JSON.stringify(bad)} is refused`, r.status === 400, String(r.status));
  }
  r = await post({ score: 0, device: DEV });
  check('zero is a real answer', r.status === 200, String(r.status));

  console.log('\n[one answer per person per quarter]');
  let s = db.nps.summary(365);
  check('two people, two rows -- not five', s.n === 2, `${s.n} rows`);
  r = await post({ score: 3, device: DEV });
  check('a second tap updates rather than adds', r.body.updated === true && db.nps.summary(365).n === 2, JSON.stringify(r.body));
  r = await post({ score: 3, comment: 'The map lost my position twice.', device: DEV });
  const s2 = db.nps.summary(365);
  check('the comment lands on that same row', s2.n === 2 && s2.recent.some((x) => /lost my position/.test(x.comment)), JSON.stringify(s2.recent));
  r = await post({ score: 4, device: DEV });
  check('and a later score change keeps the comment', db.nps.summary(365).recent.some((x) => x.score === 4 && /lost my position/.test(x.comment)));
  r = await post({ score: 10, comment: 'x'.repeat(2000), device: DEV });
  check('a comment is capped, not refused', r.status === 200 && db.nps.summary(365).recent.every((x) => x.comment.length <= 600));

  console.log('\n[the arithmetic the dashboard shows]');
  db.prepare?.('DELETE FROM nps');
  // Straight from the definition. Ten answers: six promoters, two passives,
  // two detractors -> 60% - 20% = +40. Passives are in the denominator and
  // nowhere else, which is the part people get wrong.
  const stamp = new Date().toISOString();
  const seed = [10, 9, 9, 10, 9, 10, 8, 7, 6, 2];
  for (let i = 0; i < seed.length; i++) db.nps.set({ who: `seed-${i}-${'x'.repeat(8)}`, kind: 'device', score: seed[i] });
  // The two earlier answers are still there; take them out of the sum.
  db.nps.clearUser('alice@example.com');
  const before = db.nps.summary(365);
  const only = { n: before.n, promoters: before.promoters, passives: before.passives, detractors: before.detractors };
  // DEV's last score was 10 -> one more promoter. Account for it explicitly.
  check('the count is everyone who answered', only.n === 11, JSON.stringify(only));
  check('promoters are 9 and 10', only.promoters === 7, String(only.promoters));
  check('passives are 7 and 8', only.passives === 2, String(only.passives));
  check('detractors are 0 to 6', only.detractors === 2, String(only.detractors));
  check('and the score is promoters minus detractors, in percent', before.score === Math.round((7 - 2) / 11 * 100), String(before.score));
  // A window that starts tomorrow: unambiguously empty. A zero-day window's
  // "since" is this very millisecond, and a row written in it passes ">=".
  check('nothing answered is null, not zero', db.nps.summary(-1).score === null && db.nps.summary(-1).n === 0);

  console.log('\n[the dashboard carries it]');
  const boss = session('boss@example.com');
  const stats = await fetch(`${B}/api/admin/stats`, { headers: { 'x-session': boss } }).then((x) => x.json());
  check('the score is on the admin stats', stats.nps90d && stats.nps90d.n === 11 && stats.nps90d.score === before.score, JSON.stringify(stats.nps90d && { n: stats.nps90d.n, score: stats.nps90d.score }));
  check('with the distribution by score', stats.nps90d && stats.nps90d.byScore && stats.nps90d.byScore[10] === 4, JSON.stringify(stats.nps90d && stats.nps90d.byScore));

  console.log('\n[deleting an account deletes its answers]');
  const bob = session('bob@example.com');
  await post({ score: 1, comment: 'never again', park: 'epcot' }, bob);
  check('the answer is there', db.nps.summary(365).recent.some((x) => /never again/.test(x.comment)));
  const purged = db.accounts.purge('bob@example.com');
  check('and gone with the account', !db.nps.summary(365).recent.some((x) => /never again/.test(x.comment)) && purged && purged.nps === 1, JSON.stringify(purged && purged.nps));

  console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the question is asked fairly and counted right ===');
  process.exit(fail ? 1 : 0);
})();
