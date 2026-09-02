// Every password box lives in a form of its own.
//
// One did not: the "confirm your password" box in the delete-account panel sat
// outside any <form>, and Chrome, finding a loose password field, invented a
// login form out of every loose text box on the page and offered the owner's
// saved credentials in the ride search. autocomplete="off" does not stop that;
// a form with a username does.
const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const html = await (await fetch(B + '/app')).text();
const forms = [...html.matchAll(/<form\b[\s\S]*?<\/form>/g)].map((m) => [m.index, m.index + m[0].length, m[0]]);
const pws = [...html.matchAll(/<input[^>]*type="password"[^>]*>/g)];
console.log('\n[password fields]');
check('there are password fields to check', pws.length >= 3, String(pws.length));
for (const m of pws) {
  const id = (m[0].match(/id="([^"]+)"/) || [])[1] || '?';
  const form = forms.find(([a, b]) => a <= m.index && m.index < b);
  check(`#${id} sits inside a <form>`, Boolean(form));
  if (form) check(`  and that form carries a username for the browser to pair it with`, /autocomplete="(username|email)"/.test(form[2]), form[2].slice(0, 120).replace(/\s+/g, ' '));
}
console.log('\n[search boxes]');
for (const m of html.matchAll(/<input[^>]*id="(search|parkq)"[^>]*>/g)) {
  check(`#${m[1]} declines autofill`, /autocomplete="off"/.test(m[0]));
}
console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the browser has nothing to mistake for a login ===');
process.exit(fail ? 1 : 0);
