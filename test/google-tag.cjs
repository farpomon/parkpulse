// The Google Ads tag: on every page when configured, on none when not, and a
// conversion carried to the two moments that matter.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-googletag.db';
process.env.PORT = '9655';
process.env.PASS_SECRET = 'testsecret';
process.env.HISTORY = 'off';
process.env.GOOGLE_ADS_ID = 'AW-123456789';
process.env.GOOGLE_ADS_PURCHASE_LABEL = 'AbCdEfGhIj';
const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: { create: async () => ({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '.' }], usage: {} }) } } });
const B = 'http://127.0.0.1:9655';
(async () => {
  const server = require('../server.js');
  for (let i = 0; i < 80 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 200));

  console.log('\n[on every page, exactly once]');
  for (const [label, path] of [['the landing page', '/'], ['the app', '/app'], ['the welcome page', '/welcome'], ['the guide', '/guide'], ['the terms', '/terms'], ['a park page', '/parks/magic-kingdom'], ['a translated landing', '/pt']]) {
    const r = await fetch(B + path); const html = await r.text();
    const n = (html.match(/googletagmanager\.com\/gtag\/js\?id=AW-123456789/g) || []).length;
    check(`${label} carries the tag once`, r.ok && n === 1, `${r.status}, ${n} tags`);
    check(`  and it is configured with the id`, /gtag\('config','AW-123456789'\)/.test(html));
    const pos = html.indexOf('googletagmanager'); const head = html.search(/<head[^>]*>/i);
    if (head >= 0) check(`  inside <head>, near the top`, pos > head && pos < head + 400, `tag at ${pos}, head at ${head}`);
  }
  const js = await fetch(`${B}/i18n.js`).then((r) => r.text());
  check('a script file is left alone', !/googletagmanager/.test(js));

  console.log('\n[and nowhere when not configured]');
  check('no id, no tag', server._withAds('<html><head></head></html>', '') === '<html><head></head></html>');
  check('a malformed id, no tag', server._withAds('<html><head></head></html>', 'G-ABC') === '<html><head></head></html>');
  check('a page with no <head> still gets it, after the doctype', /^<!doctype html><!-- Google tag/i.test(server._withAds('<!doctype html><meta charset="utf-8"><title>x</title>', 'AW-1234567')));
  check('a page that already has it is not given it twice', (server._withAds(server._withAds('<html><head></head></html>', 'AW-1234567'), 'AW-1234567').match(/gtag\/js/g) || []).length === 1);

  console.log('\n[the conversions ride along]');
  const cfg = await fetch(`${B}/api/config`).then((r) => r.json());
  check('the app can see the purchase conversion id', cfg.ads && cfg.ads.purchase === 'AW-123456789/AbCdEfGhIj', JSON.stringify(cfg.ads));
  check('and knows there is no signup label yet', cfg.ads && cfg.ads.signup === null, JSON.stringify(cfg.ads));
  const welcome = await fetch(`${B}/welcome`).then((r) => r.text());
  check('the welcome page reports the sale with its value and the session as transaction id', /gtag\('event', 'conversion', \{ send_to: data\.conversion, value: Number\(data\.usd\)/.test(welcome) && /transaction_id: sessionId/.test(welcome));
  const app = await fetch(`${B}/app`).then((r) => r.text());
  check('the app reports a verified signup', /c\.ads\.signup\) gtag\('event', 'conversion'/.test(app));

  console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the tag is everywhere it should be and nowhere else ===');
  process.exit(fail ? 1 : 0);
})();
