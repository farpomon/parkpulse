// Drives attemptBooking against a local page shaped like prenotami's booking
// form. This covers what the unit tests cannot: reading a real datepicker,
// clicking the right cell, aborting on a required field, ticking consents, and
// -- the one that matters -- not submitting anything it was told not to.
//
// The fixture below is this project's best understanding of prenotami's markup,
// not a capture of it. Passing here means the logic is sound; it does not mean
// the selectors match the live site. Only a dry run against your own account
// tells you that.
//
//   npm run test:browser
//
// Needs a real browser: `npx playwright install chromium`, or point
// PLAYWRIGHT_CHROME at one you already have.
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attemptBooking, extractCandidateDates } from '../src/booking.mjs';

const CHROME = process.env.PLAYWRIGHT_CHROME || undefined;

// jQuery UI datepicker markup, as prenotami renders it.
function calendar(days, { year = 2026, month = 8 } = {}) {
  return days
    .map((d) =>
      d.open
        ? `<td data-handler="selectDay" data-event="click" data-month="${month}" data-year="${year}"><a class="ui-state-default" href="#">${d.day}</a></td>`
        : `<td class="ui-datepicker-unselectable ui-state-disabled"><span>${d.day}</span></td>`
    )
    .join('');
}

function page({ days, requiredField = false, consent = true, submit = true }) {
  return `<!doctype html><html><body>
    <h1>Prenotazione</h1>
    <table class="ui-datepicker-calendar"><tbody><tr>${calendar(days)}</tr></tbody></table>
    <form id="f">
      ${requiredField ? '<input required name="CodiceFiscale" placeholder="Codice fiscale">' : ''}
      <input required name="Nome" value="Luis">
      ${consent ? '<label for="p"><input type="checkbox" required id="p"> I accept the privacy policy</label>' : ''}
      ${submit ? '<button type="submit">Conferma</button>' : ''}
    </form>
    <script>
      document.querySelectorAll('td[data-handler] a').forEach(a => {
        a.onclick = (e) => { e.preventDefault(); document.querySelector('h1').textContent = 'picked ' + a.textContent; };
      });
      document.getElementById('f').onsubmit = (e) => {
        e.preventDefault();
        document.body.innerHTML = '<h1>Prenotazione confermata</h1><p>Riepilogo</p>';
      };
    </script>
  </body></html>`;
}

const logger = { info: () => {}, warn: () => {}, ok: () => {}, error: () => {} };
const SHOTS = mkdtempSync(join(tmpdir(), 'prenotami-test-'));
const cfg = (booking) => ({
  dataDir: SHOTS,
  serviceLabel: "carta d'identità",
  booking: { enabled: true, dryRun: false, weekdays: [], ...booking },
});

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const ctx = await browser.newContext();

async function open(html) {
  const p = await ctx.newPage();
  await p.setContent(html);
  return p;
}

// September 2026: 15th is a Tue, 16th a Wed, 19th a Sat.
const days = [
  { day: 14, open: false },
  { day: 15, open: true },
  { day: 16, open: true },
  { day: 19, open: true },
];

// 1. reads only the selectable cells
let p = await open(page({ days }));
const found = await extractCandidateDates(p);
check(
  'reads only selectable days',
  JSON.stringify(found.map((f) => f.iso)) === JSON.stringify(['2026-09-15', '2026-09-16', '2026-09-19']),
  found.map((f) => f.iso).join(',')
);
await p.close();

// 2. books the earliest in window
p = await open(page({ days }));
let r = await attemptBooking(p, cfg({ earliest: '2026-09-01', latest: '2026-12-31' }), logger);
check('books earliest in window', r.booked && r.chosen === '2026-09-15', `${r.outcome} ${r.chosen}`);
check('records the consent text', /privacy policy/i.test((r.consents || []).join(' ')), (r.consents || []).join('|'));
await p.close();

// 3. respects a narrower window
p = await open(page({ days }));
r = await attemptBooking(p, cfg({ earliest: '2026-09-16', latest: '2026-09-16' }), logger);
check('respects a narrower window', r.booked && r.chosen === '2026-09-16', `${r.outcome} ${r.chosen}`);
await p.close();

// 4. skips everything outside the window, books nothing
p = await open(page({ days }));
r = await attemptBooking(p, cfg({ earliest: '2027-01-01', latest: '2027-06-30' }), logger);
check('books nothing outside the window', !r.booked && r.outcome === 'skipped', r.outcome);
check('explains what it passed on', /2026-09-15/.test(r.detail) && /2027-01-01/.test(r.detail), r.detail);
await p.close();

// 5. weekday filter
p = await open(page({ days }));
r = await attemptBooking(p, cfg({ earliest: '2026-09-01', latest: '2026-12-31', weekdays: ['sat'] }), logger);
check('honours weekday filter (Sat = 19th)', r.booked && r.chosen === '2026-09-19', `${r.outcome} ${r.chosen}`);
await p.close();

// 6. aborts on an unfilled required field
p = await open(page({ days, requiredField: true }));
r = await attemptBooking(p, cfg({ earliest: '2026-09-01', latest: '2026-12-31' }), logger);
check('aborts on empty required field', !r.booked && r.outcome === 'needs-human', r.outcome);
check('names the field it refused to invent', /CodiceFiscale/.test(r.detail), r.detail);
await p.close();

// 7. dry run stops before submitting
p = await open(page({ days }));
r = await attemptBooking(p, cfg({ earliest: '2026-09-01', latest: '2026-12-31', dryRun: true }), logger);
const stillOnForm = await p.locator('h1').innerText();
check('dry run does not submit', !r.booked && r.outcome === 'dry-run' && !/confermata/i.test(stillOnForm), `${r.outcome} / page: ${stillOnForm}`);
await p.close();

// 8. no submit button -> hands off
p = await open(page({ days, submit: false }));
r = await attemptBooking(p, cfg({ earliest: '2026-09-01', latest: '2026-12-31' }), logger);
check('hands off when no submit control', !r.booked && r.outcome === 'needs-human', r.outcome);
await p.close();

// 9. empty calendar
p = await open(page({ days: [{ day: 14, open: false }] }));
r = await attemptBooking(p, cfg({ earliest: '2026-09-01', latest: '2026-12-31' }), logger);
check('empty calendar books nothing', !r.booked && r.outcome === 'skipped', r.outcome);
await p.close();

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.error('\nDo NOT arm auto-booking while these fail.');
}
process.exit(failed.length ? 1 : 0);
