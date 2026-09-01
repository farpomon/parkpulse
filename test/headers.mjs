// The headers every response wears.
//
// There were none. Not one route sent HSTS, nosniff, a frame policy or a
// referrer policy -- which is the kind of thing nobody notices until a
// security scan runs on launch week. Set once at the top of the handler and
// checked here on the three kinds of response the server gives: a rendered
// page, a static file, and a JSON answer.
const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const WANT = {
  'strict-transport-security': /max-age=\d{7,}/,
  'x-content-type-options': /^nosniff$/,
  'x-frame-options': /^DENY$/,
  'referrer-policy': /strict-origin-when-cross-origin/,
};
for (const [label, path] of [['the landing page', '/'], ['the app', '/app'], ['a static file', '/i18n.js'], ['a JSON answer', '/api/config'], ['a 404', '/no-such-page-ever']]) {
  const r = await fetch(B + path);
  console.log(`\n[${label} · ${r.status}]`);
  for (const [h, rx] of Object.entries(WANT)) {
    const v = r.headers.get(h);
    check(`${h}`, v != null && rx.test(v), v == null ? 'missing' : v);
  }
}
console.log(fail ? `\n=== ${fail} failures ===` : '\n=== every response is dressed ===');
process.exit(fail ? 1 : 0);
