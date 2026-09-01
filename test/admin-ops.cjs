// Revenue, upstream health, the funnel, retention cohorts, rate limiting and
// the deletion queue -- the operator half of the dashboard.
//
// Each of these answers a question the dashboard could not answer before, and
// most of them are arithmetic over data that already existed, which is exactly
// the kind of thing that goes quietly wrong.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-adminops.db';
process.env.PORT = '9689';
process.env.PASS_SECRET = 'testsecret';
process.env.AI_ALERT_USD = '10';

const crypto = require('node:crypto');
const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: { create: async () => ({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '.' }], usage: {} }) } } });
const db = require('../db.js');

const B = 'http://127.0.0.1:9689';
const ADMIN = 'lfaria@mabenconsulting.ca';
const iso = (back) => new Date(Date.now() - back * 86400000).toISOString();
const day = (back) => iso(back).slice(0, 10);

function adminSession() {
  const sid = crypto.randomBytes(16).toString('hex');
  db.sessions.create(sid, ADMIN, 'test-device', 'test');
  const body = Buffer.from(JSON.stringify({ sid, email: ADMIN, exp: Date.now() + 86400000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', process.env.PASS_SECRET).update(body).digest('base64url')}`;
}

(async () => {
  const server = require('../server.js');
  for (let i = 0; i < 60 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  db.users.create(ADMIN, 'salt', 'x', 1);
  db.users.markVerified(ADMIN);
  const session = adminSession();
  const ops = () => fetch(`${B}/api/admin/ops`, { headers: { 'x-session': session } }).then((r) => r.json());

  console.log('\n[who can see it]');
  {
    const anon = await fetch(`${B}/api/admin/ops`);
    check('closed without an admin session', anon.status === 403, String(anon.status));
  }

  console.log('\n[revenue counts money, and only money]');
  {
    // Two real sales, one dev pass, one retired plan id with no price.
    // The retired one is read off the live catalogue rather than hardcoded:
    // this test used to name 'trip-pass' as the priceless example, and then
    // trip-pass became the $59.99 Trip Pass and the assertion quietly meant
    // something else.
    const cfg = await (await fetch(`${B}/api/config`)).json();
    const sold = cfg.plans.map((p) => p.id);
    const priced = Object.fromEntries(cfg.plans.map((p) => [p.id, Number(p.usd)]));
    const retired = ['week-pass', 'month-pass', 'half-year-pass'].find((id) => !sold.includes(id));
    check('there is a retired id to test with', Boolean(retired), sold.join(','));
    const [a, b] = [sold[0], sold[1]];
    db.passes.add(a, 'cs_1', 'a@example.com');
    db.passes.add(b, 'cs_2', 'b@example.com');
    db.passes.add('dev', null, ADMIN);
    db.passes.add(retired, null, 'legacy@example.com');
    const expect = priced[a] + priced[b];
    const r = (await ops()).revenue;
    check('the catalogue plans are added up', Math.abs(r.month.usd - expect) < 0.005, `${r.month.usd} vs ${expect}`);
    check('and counted', r.month.sold === 2, String(r.month.sold));
    // The point of the split: a dev pass is not revenue, but pretending it does
    // not exist hides how many free passes are in circulation.
    check('the dev pass and the retired id are held out of the money', r.month.comped === 2, String(r.month.comped));
    check('the split adds back up to every pass issued', r.month.sold + r.month.comped === 4, `${r.month.sold}+${r.month.comped}`);
  }

  console.log('\n[cost and revenue over the same population]');
  {
    db.aiusage.add(day(0), 'advisor', 'claude-opus-5', { input: 1000, output: 100, cacheWrite: 0, cacheRead: 0, cost: 3 });
    const d = await ops();
    const m = d.revenue.margin.month;
    check('net is revenue minus the running AI cost', Math.abs(m.net - (m.revenue - m.cost)) < 0.005, JSON.stringify(m));
    // Reading the dashboard touches the operator's own session. If the two
    // per-account figures used different denominators, subtracting one from the
    // other would be meaningless -- and the admin would be in one of them.
    const ai = await fetch(`${B}/api/admin/ai-cost`, { headers: { 'x-session': session } }).then((r) => r.json());
    check('revenue and AI cost divide by the same account count',
      d.revenue.month.accounts === ai.month.accounts, `${d.revenue.month.accounts} vs ${ai.month.accounts}`);
    check('and the operator is not counted among them', d.revenue.month.accounts === 0, String(d.revenue.month.accounts));
  }

  console.log('\n[the funnel]');
  {
    for (let i = 0; i < 10; i++) {
      const email = `f${i}@example.com`;
      db.users.create(email, 's', 'x', 0);
      if (i < 8) db.users.markVerified(email);
      if (i < 5) db.admin.markFirstPlan(email);
    }
    const f = (await ops()).funnel.d30;
    check('signups are counted', f.signups >= 10, String(f.signups));
    check('verified is a subset of signups', f.verified <= f.signups && f.verified >= 8, `${f.verified}/${f.signups}`);
    check('planned is a subset of verified', f.planned <= f.verified && f.planned >= 5, `${f.planned}/${f.verified}`);
    // The milestone must only ever fill once, or "first plan" is a lie.
    const before = db.users.get('f0@example.com').first_plan_at;
    db.admin.markFirstPlan('f0@example.com');
    check('the first-plan mark never moves once set', db.users.get('f0@example.com').first_plan_at === before, before);
  }

  console.log('\n[retention cohorts]');
  {
    // One account, seen on two different days a week apart.
    db.users.create('r1@example.com', 's', 'x', 1);
    db.admin.seen('r1@example.com', day(0));
    db.admin.seen('r1@example.com', day(0));            // same day twice
    db.admin.seen('r1@example.com', day(7));
    const c = (await ops()).cohorts;
    check('there is at least one cohort', c.length > 0, JSON.stringify(c).slice(0, 80));
    check('every cohort starts at its own size in week 0', c.every((x) => x.weeks[0] <= x.size), JSON.stringify(c.map((x) => [x.size, x.weeks[0]])));
    check('and never claims more returns than it had accounts',
      c.every((x) => x.weeks.every((n) => n <= x.size)), JSON.stringify(c));
    // Seeing somebody twice in a day is one day, not two.
    check('a repeat visit on the same day is not a second return',
      c.every((x) => x.weeks.every((n) => Number.isInteger(n))), JSON.stringify(c));
  }

  console.log('\n[upstream health]');
  {
    await fetch(`${B}/api/waits/magic-kingdom`);
    const h = (await ops()).health;
    const mk = h.parks.find((p) => p.slug === 'magic-kingdom');
    check('a park that was asked for has a verdict', mk && mk.source !== 'unknown', JSON.stringify(mk));
    check('a park nobody asked for says so rather than claiming to be fine',
      h.parks.some((p) => p.source === 'unknown'), JSON.stringify(h.summary));
    check('the summary adds up to every park', Object.values(h.summary).reduce((a, b) => a + b, 0) === h.parks.length,
      `${JSON.stringify(h.summary)} vs ${h.parks.length}`);
    check('it says how long this process has been up', typeof h.uptimeMin === 'number', String(h.uptimeMin));

    // The failure that hid a dead dining guide for days. Anthropic access is
    // granted PER MODEL, so the three tiers succeed and fail independently --
    // but they were all filed under one name, and any success zeroed the
    // failure count. Every question a visitor asked Mila wiped the catalogue's
    // refusals off the panel, so a feature that had never once worked showed a
    // green tick.
    server._noteUpstream('anthropic · catalogue', false, 'model: claude-sonnet-5 not found');
    server._noteUpstream('anthropic · advisor', true);
    const svc = (await ops()).health.services || {};
    check('the tiers are listed separately', Object.keys(svc).filter((k) => /anthropic/.test(k)).length >= 2,
      JSON.stringify(Object.keys(svc)));
    check('a working advisor does not erase the catalogue\'s failure',
      svc['anthropic · catalogue'] && svc['anthropic · catalogue'].fails > 0, JSON.stringify(svc));
    check('and the refused tier still carries its reason',
      /not found/.test(svc['anthropic · catalogue']?.error || ''), String(svc['anthropic · catalogue']?.error));
    check('while the advisor reads healthy on its own line',
      svc['anthropic · advisor'] && svc['anthropic · advisor'].fails === 0, JSON.stringify(svc['anthropic · advisor']));
  }

  console.log('\n[rate limiting]');
  {
    // Two scopes, and the difference between them is the whole policy.
    //
    // Strict on the account: guessing one person's password is stopped almost
    // immediately, by the per-address limiter that was already here.
    const login = (email) => fetch(`${B}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrong', device: 'd' }),
    });
    let tries = 0;
    while (tries < 40 && (await login('victim@example.com')).status !== 429) tries++;
    check('guessing one account is stopped almost at once', tries < 15, `${tries} attempts before 429`);

    // Loose on the address: every guest in a park shares one IP, so a limit
    // tuned for one person would lock out the building. Distinct addresses,
    // which is what a park full of people actually looks like.
    let blocked = 0, ok = 0;
    for (let i = 0; i < 640; i++) {
      const res = await login(`guest${i}@example.com`);
      if (res.status === 429) blocked++; else ok++;
    }
    check('a flood from one connection is eventually turned away', blocked > 0, `${blocked} blocked of 640`);
    check('but only after a park-sized number of people', ok >= 550, `${ok} allowed before the ceiling`);
    const d = await ops();
    check('and the dashboard is told what was blocked', d.rateBlocks.auth?.n > 0, JSON.stringify(d.rateBlocks));
    check('without recording who it was', !JSON.stringify(d.rateBlocks).includes('@'), JSON.stringify(d.rateBlocks));
  }

  console.log('\n[the deletion queue]');
  {
    db.users.create('bye@example.com', 's', 'x', 1);
    db.users.scheduleDeletion('bye@example.com', Date.now() + 3 * 86400000, 'tok');
    const dels = (await ops()).deletions;
    const row = dels.find((x) => x.email === 'bye@example.com');
    check('a scheduled deletion is visible', Boolean(row), JSON.stringify(dels));
    check('with how long is left', row && row.inDays >= 2 && row.inDays <= 3, String(row?.inDays));
    db.users.cancelDeletion('bye@example.com');
    check('and it leaves the queue when cancelled',
      !(await ops()).deletions.some((x) => x.email === 'bye@example.com'));
  }

  console.log('\n[spend alert thresholds are reported]');
  {
    const a = (await ops()).alerts;
    check('the ceiling is the configured one', a.ceilingUsd === 10, String(a.ceilingUsd));
    check('and it names where the warning would go', typeof a.to === 'string', String(a.to));
  }

  console.log('\n[the alert actually fires]');
  {
    // AI_ALERT_USD is 10 for this run. Three dollars is already on the books
    // from the margin check above; push today well past the ceiling.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    db.aiusage.add(today, 'advisor', 'claude-opus-5', { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, cost: 20 });
    const marker = `ai-alert:ceiling:${today}`;
    check('nothing has been said yet', db.kv.get(marker) === null, String(db.kv.get(marker)));
    await server._maybeAlertOnSpend();
    check('crossing the ceiling raises one', db.kv.get(marker) === '1', String(db.kv.get(marker)));
    // A runaway loop must not also become a mail flood.
    await server._maybeAlertOnSpend();
    await server._maybeAlertOnSpend();
    check('and it is only said once a day', db.kv.get(marker) === '1', String(db.kv.get(marker)));
  }

  console.log('\n[the database, looked after]');
  {
    const d = await ops();
    const su = d.setup || {};
    check('the dashboard says whether PASS_SECRET is set', su.passSecret === true, JSON.stringify(su));
    check('and where the database lives, and how big it is', su.db && su.db.file === process.env.DB_FILE && su.db.bytes > 0, JSON.stringify(su.db));
    check('and whether that path outlives a redeploy', typeof (su.db || {}).persistent === 'boolean');
    // The daily copy: a real SQLite file beside the live one.
    const copy = server._copyDatabase();
    check('a copy can be made while the database is open', copy && copy.bytes > 0, JSON.stringify(copy));
    const magic = copy && fs.readFileSync(copy.dest).subarray(0, 15).toString();
    check('and it is a SQLite database, not a partial file', magic === 'SQLite format 3', JSON.stringify(magic));
    const after = (await ops()).setup.db;
    check('the dashboard reports the copy', after.copies >= 1 && after.lastCopy && after.lastCopy.bytes === copy.bytes, JSON.stringify(after));
    // The download: admin only, a real database, nothing left behind.
    const anon = await fetch(`${B}/api/admin/backup`);
    check('the download is closed without an admin session', anon.status === 403, String(anon.status));
    const dl = await fetch(`${B}/api/admin/backup`, { headers: { 'x-session': session } });
    const body = Buffer.from(await dl.arrayBuffer());
    check('an admin gets the file', dl.status === 200 && /attachment; filename="parkpulse-\d{4}-\d{2}-\d{2}\.sqlite"/.test(dl.headers.get('content-disposition') || ''), `${dl.status} ${dl.headers.get('content-disposition')}`);
    check('which is a SQLite database', body.subarray(0, 15).toString() === 'SQLite format 3', JSON.stringify(body.subarray(0, 15).toString()));
    check('the size matches what was promised', Number(dl.headers.get('content-length')) === body.length, `${dl.headers.get('content-length')} vs ${body.length}`);
    await new Promise((r) => setTimeout(r, 200));
    const leftovers = fs.readdirSync(require('node:path').dirname(process.env.DB_FILE)).filter((f) => f.startsWith('parkpulse-download-'));
    check('and the temporary file is gone', leftovers.length === 0, leftovers.join(', '));
  }

  console.log(`\n=== ${fail ? fail + ' failed' : 'the dashboard answers the operator questions'} ===`);
  process.exit(fail ? 1 : 0);
})();
