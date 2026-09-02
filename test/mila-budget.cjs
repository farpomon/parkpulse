// What one account may cost, in dollars.
//
// Counting questions never capped the bill: a question that makes Mila reach
// for a tool bills several times over. Before this, one account could run to
// roughly $8 a day under the existing ceilings -- three Month Passes of margin
// from one chatty family. These checks are about money, so they are specific
// about money.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-milabudget.db';
process.env.PORT = '9685';
process.env.PASS_SECRET = 'testsecret';
process.env.AI_BUDGET_FREE = '0.20';
process.env.AI_GLOBAL_DAILY_USD = '3';
process.env.AI_BUDGETS = JSON.stringify({ 'week-pass': 1.00 });
process.env.ADMIN_EMAILS = 'boss@test.dev';

const crypto = require('node:crypto');
const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');
let calls = 0;
consultant._setClient({
  beta: { messages: {
    create: async () => { calls++; return { model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'A line.' }], usage: { input_tokens: 800, output_tokens: 40 } }; },
    stream: () => { throw new Error('the advisor stream is not exercised here'); },
  } },
});
const db = require('../db.js');

const B = 'http://127.0.0.1:9685';
const ME = 'budget@test.dev';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
function tokenFor(email) {
  const sid = crypto.randomBytes(16).toString('hex');
  db.sessions.create(sid, email, 'dev-1', 'test');
  const body = Buffer.from(JSON.stringify({ sid, email, exp: Date.now() + 86400000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', process.env.PASS_SECRET).update(body).digest('base64url')}`;
}

(async () => {
  require('../server.js');
  for (let i = 0; i < 60 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  db.users.create(ME, 's', 'x', 1);
  db.users.markVerified(ME);
  const tok = tokenFor(ME);
  const budget = () => fetch(`${B}/api/mila/budget`, { headers: { 'x-session': tok } }).then((r) => r.json());
  const ask = (body = {}) => fetch(`${B}/api/consultant`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-session': tok },
    body: JSON.stringify({ park: 'magic-kingdom', messages: [{ role: 'user', content: 'hi' }], ...body }),
  });

  console.log('\n[the budget is in dollars, and it follows the pass]');
  {
    const free = await budget();
    check('a free account gets the free allowance', free.budget === 0.20, JSON.stringify(free));
    const raw = new (require('node:sqlite').DatabaseSync)(process.env.DB_FILE);
    raw.prepare('UPDATE users SET plan = ?, plan_exp = ? WHERE email = ?').run('week-pass', Date.now() + 7 * 86400000, ME);
    const paid = await budget();
    check('a Week Pass raises it, from the env override', paid.budget === 1.00, JSON.stringify(paid));
    check('and nothing has been spent yet', paid.spent === 0 && paid.ok, JSON.stringify(paid));
  }

  console.log('\n[spending is recorded against the account, not just the product]');
  {
    db.aispend.add(ME, today(), 0.30);
    const b = await budget();
    check('the ledger shows it', b.spent === 0.3, JSON.stringify(b));
    check('and she is still available under the cap', b.ok === true, JSON.stringify(b));
    // ai_usage is product analytics; ai_spend is the budget. Both must exist.
    check('the product ledger is separate from the account one',
      db.aiusage.totalOn(today()) === 0 && db.aispend.on(ME, today()).usd === 0.3,
      `product ${db.aiusage.totalOn(today())} / account ${db.aispend.on(ME, today()).usd}`);
  }

  console.log('\n[running out is an offer, not a wall]');
  {
    db.aispend.add(ME, today(), 0.80);           // now $1.10 against $1.00
    const b = await budget();
    check('the account is over its budget', b.ok === false && b.reason === 'account', JSON.stringify(b));
    const res = await ask();
    const d = await res.json();
    check('Mila declines rather than spending', res.status === 402, String(res.status));
    check('and says it is her, not an error', /Mila/.test(d.error || ''), d.error);
    check('the reply carries what was spent and what the cap was', d.spent === 1.1 && d.budget === 1, JSON.stringify(d));
    check('no model call was made', calls === 0, String(calls));
  }

  console.log('\n[bought time is spent first, and it lifts the cap]');
  {
    db.users.addAiCredit(ME, 1.50);
    const b = await budget();
    check('credit is added to the allowance', b.budget === 2.5, JSON.stringify(b));
    check('and she is available again', b.ok === true, JSON.stringify(b));
    check('the credit is visible to the app', b.credit === 1.5, JSON.stringify(b));
    // Drawing down: a billed call takes from credit before the allowance.
    const before = db.users.get(ME).ai_credit_usd;
    db.aispend.add(ME, today(), 0.10);
    db.users.spendAiCredit(ME, 0.10);
    check('a billed answer draws the credit down', db.users.get(ME).ai_credit_usd === Math.round((before - 0.1) * 100) / 100,
      `${before} -> ${db.users.get(ME).ai_credit_usd}`);
    check('and credit never goes negative', (db.users.spendAiCredit(ME, 999), db.users.get(ME).ai_credit_usd === 0), String(db.users.get(ME).ai_credit_usd));
  }

  console.log('\n[who gets what, in one table]');
  {
    // These are money, and they are easy to change by accident: they live in
    // one object beside the retired plans and nothing else reads them aloud.
    // Reading the whole table back in one place is what makes a wrong number
    // obvious rather than discoverable months later from a bill.
    const seen = {};
    for (const [who, plan, want] of [
      ['an invited guest', 'comp', 0.90],
      ['a Trip Pass', 'trip-pass', 0.90],
      ['a Day Pass', 'day-pass', 2.50],
      // The long passes carry the most days, so their daily ceiling is the one
      // that decides whether a pass can cost more in AI than it sold for. At
      // $0.20 a day a year of allowance is $73 -- still more than the $49.99
      // pass, which is why the real guard is the per-pass cap, not this.
      ['a Season Pass', 'season-pass', 0.30],
      ['a Year Pass', 'year-pass', 0.20],
    ]) {
      const e = `tbl-${plan}@test.dev`;
      db.users.create(e, 's', 'x', 1); db.users.markVerified(e);
      db.users.grant(e, plan, Date.now() + 30 * 86400000);
      const b = await fetch(`${B}/api/mila/budget`, { headers: { 'x-session': tokenFor(e) } }).then((r) => r.json());
      seen[plan] = b.budget;
      check(`${who}: $${want.toFixed(2)}/day`, b.budget === want, JSON.stringify(b));
    }
    // The one that matters most: an invitation must not run out before the
    // thing it is inviting somebody to try.
    check('a guest is never worse off than a paying visitor', seen.comp >= seen['trip-pass'],
      `comp ${seen.comp} vs trip-pass ${seen['trip-pass']}`);
  }

  console.log('\n[the warning arrives before the wall]');
  {
    // The alert email is the warning and the global cap is the wall. Raising
    // the cap without raising the alert leaves a warning that fires every day
    // until nobody reads it; raising the alert without the cap leaves one that
    // arrives too late to do anything with. They move together or not at all.
    // The DEFAULTS, not this run's env overrides -- the relationship has to
    // hold for the numbers that actually ship.
    const { _defaults } = require('../server.js');
    check('the alert fires below the hard cap', _defaults.alertUsd < _defaults.globalDailyUsd,
      JSON.stringify(_defaults));
    check('and not so far below it that it cries wolf', _defaults.alertUsd >= _defaults.globalDailyUsd / 3,
      JSON.stringify(_defaults));
    check('the operator alone cannot spend the product\'s whole day',
      _defaults.devUsd < _defaults.globalDailyUsd, JSON.stringify(_defaults));
  }

  console.log('\n[the operator is not a stranger]');
  {
    // Reported from production: the owner of the site, signed in as himself,
    // was told "Mila has given you everything she has for today" after a
    // couple of questions -- in English, in the middle of a Portuguese app.
    // Nothing was broken. hasAccess() waved him through the gate and then the
    // budget put him back on the free tier's twenty cents, which is about two
    // of Mila's reads. An admin who cannot use the product cannot check it.
    const ADMIN = 'boss@test.dev';
    db.users.create(ADMIN, 's', 'x', 1);
    db.users.markVerified(ADMIN);
    const atok = tokenFor(ADMIN);
    const b = await fetch(`${B}/api/mila/budget`, { headers: { 'x-session': atok } }).then((r) => r.json());
    check('an admin is not on the free tier allowance', b.budget > 0.20, JSON.stringify(b));
    check('but on the dev allowance', b.budget === 25, JSON.stringify(b));
    check('and Mila will answer them', b.ok === true, JSON.stringify(b));

    // Still a ceiling, not a blank cheque -- an admin loop is still a bill.
    db.aispend.add(ADMIN, today(), 30);
    const after = await fetch(`${B}/api/mila/budget`, { headers: { 'x-session': atok } }).then((r) => r.json());
    check('the operator is still capped, just far higher', after.ok === false && after.reason === 'account', JSON.stringify(after));
  }

  console.log('\n[the global backstop does not care whose spending it was]');
  {
    // AI_GLOBAL_DAILY_USD is $3 for this run. Product-wide spend crosses it.
    db.users.addAiCredit(ME, 50);               // this account has plenty left
    db.aiusage.add(today(), 'advisor', 'claude-opus-5', { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, cost: 4 });
    const b = await budget();
    check('she rests even for an account in credit', b.ok === false && b.reason === 'global', JSON.stringify(b));
    const res = await ask();
    check('and the route refuses to spend', res.status === 402, String(res.status));
    check('still no model call', calls === 0, String(calls));
    // The point of choosing graceful degradation: the app keeps working.
    const waits = await fetch(`${B}/api/waits/magic-kingdom`);
    const cfg = await fetch(`${B}/api/config`);
    check('waits still answer', waits.ok, String(waits.status));
    check('and so does the app config', cfg.ok, String(cfg.status));
  }

  console.log('\n[deleting an account takes its ledger with it]');
  {
    check('the ledger has rows', db.aispend.on(ME, today()).usd > 0);
    db.accounts.purge(ME);
    check('and none survive the purge', db.aispend.on(ME, today()).usd === 0, JSON.stringify(db.aispend.on(ME, today())));
  }

  console.log(`\n=== ${fail ? fail + ' failed' : 'one account cannot run away with the bill'} ===`);
  process.exit(fail ? 1 : 0);
})();
