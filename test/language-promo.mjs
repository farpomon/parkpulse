// Twenty languages are worth nothing to someone who never finds the switch,
// and worth less than nothing if the page promoting them is itself in the
// wrong one. Two things are checked here:
//
//   1. Mila's pointer at the globe -- shown to visitors still on whatever the
//      browser guessed, gone the moment they choose or wave her off, and
//      aimed at the picker rather than at a fixed offset that lands on the
//      pin button when the header is a different width.
//   2. The landing page in each language it ships: the pass ladder, the demo
//      read and both characters' dialogue, all of which live inside <script>
//      and so miss the markup translator unless their strings are dictionary
//      keys.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const browser = await launchBrowser();

async function app(seedLang, width = 390) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript((l) => {
    localStorage.setItem('pp-onboarded', '1');
    localStorage.setItem('pp-park', 'magic-kingdom');
    if (l) localStorage.setItem('pp-lang', l);
  }, seedLang);
  await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => { for (const i of ['onboard', 'onboard-bg', 'acct-sheet', 'acct-bg', 'gate', 'sheet-bg']) document.getElementById(i)?.classList.remove('open'); });
  return { ctx, page, errs };
}

console.log('\n[Mila points at the globe]');
{
  const { ctx, page, errs } = await app(null);
  const st = await page.evaluate(() => {
    const box = document.getElementById('lang-hint');
    return { shown: box && !box.hidden, text: document.getElementById('lang-hint-txt')?.textContent || '' };
  });
  check('a visitor who has never chosen is told there are others', st.shown, 'the hint stayed hidden');
  check('and told how many', /\b20\b/.test(st.text), st.text);
  check('and where to tap', st.text.length > 20, st.text);
  // The caret is measured, not guessed: the header row is a different width in
  // every language and on every phone.
  for (const w of [360, 390, 820]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(250);
    const off = await page.evaluate(() => {
      const box = document.getElementById('lang-hint'), pick = document.getElementById('langpick');
      const a = pick.getBoundingClientRect(), b = box.getBoundingClientRect();
      const caret = parseFloat(getComputedStyle(box).getPropertyValue('--lh-caret'));
      return Math.round(b.left + caret + 4.5 - (a.left + a.width / 2));
    });
    check(`  at ${w}px the arrow points at the picker`, Math.abs(off) <= 3, `${off}px off centre`);
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.click('#lang-hint-x');
  const after = await page.evaluate(() => ({ hidden: document.getElementById('lang-hint').hidden, seen: localStorage.getItem('pp-langhint-seen') }));
  check('waving her off hides it', after.hidden);
  check('and it stays gone', after.seen === '1', String(after.seen));
  check('no page errors', errs.length === 0, errs[0]);
  await ctx.close();
}
{
  const { ctx, page } = await app('fr');
  const shown = await page.evaluate(() => { const b = document.getElementById('lang-hint'); return b && !b.hidden; });
  check('someone who already chose is not nagged', !shown);
  await ctx.close();
}

console.log('\n[the landing page, in each language it ships]');
// English is the control: whatever is checked below must differ from it, or
// the check is passing on untranslated copy.
const snap = async (path) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(B + path, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2200);
  const out = await page.evaluate(() => ({
    plans: [...document.querySelectorAll('.plan')].map((c) => ({
      label: c.querySelector('.pl')?.textContent || '',
      per: c.querySelector('.pper')?.textContent || '',
      note: c.querySelector('.pn')?.textContent || '',
      cta: c.querySelector('.pbtn')?.textContent || '',
      badge: c.querySelector('.pbadge')?.textContent || '',
    })),
    hi: [...document.querySelectorAll('.plan.hi')].length,
    lead: document.querySelector('#languages .lead')?.textContent || '',
    // Both characters speak from inside a <script>; PP_T is what translates them.
    mila: window.PP_T ? window.PP_T("One tap and I'll plan your whole day ✨") : '',
    pip: window.PP_T ? window.PP_T('Rope drop at 9:02…') : '',
    demo: (document.documentElement.innerHTML.match(/const AI_TEXT = "([^"]*)"/) || [])[1] || '',
  }));
  await ctx.close();
  return { out, errs };
};
const en = (await snap('/')).out;
check('the English page still renders its pass ladder', en.plans.length >= 5, `${en.plans.length} cards`);
check('and still highlights the popular one', en.hi === 1, String(en.hi));
check('the section names both characters', /Mila/.test(en.lead) && /Pip/.test(en.lead), en.lead.slice(0, 90));

// Which languages the landing page actually serves. Asking beats a hardcoded
// list: a language is added by filling its dictionary, and the test should
// start covering it the moment it does, not the next time someone edits this.
const LANDING_CODES = ['es', 'pt', 'fr', 'de', 'it', 'zh', 'ja', 'ko', 'ru'];
// What the two of them are called in each script.
const CHARACTER_NAMES = {
  es: ['Mila', 'Pip'], pt: ['Mila', 'Pip'], fr: ['Mila', 'Pip'], de: ['Mila', 'Pip'], it: ['Mila', 'Pip'],
  zh: ['米拉', '皮普'], ja: ['ミラ', 'ピップ'], ko: ['밀라', '핍'], ru: ['Мила', 'Пип'],
};
const shipped = [];
for (const code of LANDING_CODES) {
  try { if ((await fetch(`${B}/${code}`)).ok) shipped.push(code); } catch {}
}
check('at least one language ships besides English', shipped.length > 0);
for (const lang of shipped) {
  const { out, errs } = await snap('/' + lang);
  console.log(`  /${lang}: ${out.plans.map((p) => p.label).join(' · ')}`);
  check(`/${lang} pass names are translated`, out.plans.every((p, i) => p.label !== en.plans[i].label),
    out.plans.filter((p, i) => p.label === en.plans[i].label).map((p) => p.label).join(', '));
  check(`  so are the periods and the notes`, out.plans.every((p, i) => p.per !== en.plans[i].per && p.note !== en.plans[i].note));
  check(`  so is the button`, out.plans.every((p, i) => p.cta !== en.plans[i].cta), out.plans[0].cta);
  check(`  the badge still selects the highlighted card`, out.hi === 1, `${out.hi} highlighted`);
  check(`  and the badge text is translated`, out.plans.some((p) => p.badge && !/MOST POPULAR|BEST VALUE/.test(p.badge)),
    out.plans.map((p) => p.badge).filter(Boolean).join(', '));
  check(`  Mila's walk-on line is translated`, out.mila !== en.mila, out.mila);
  check(`  so is Pip's muttering`, out.pip !== en.pip, out.pip);
  check(`  and it carries no HTML entities`, !/&[a-z]{2,6};/.test(out.pip + out.mila + out.lead), out.pip);
  check(`  the demo read is translated`, out.demo !== en.demo, out.demo.slice(0, 50));
  // Names get transliterated, and should: insisting on Latin "Mila" in a
  // Japanese sentence would force a worse translation, not catch a bug. Check
  // for the form that language actually uses.
  const [mila, pip] = CHARACTER_NAMES[lang] || ['Mila', 'Pip'];
  check(`  the section names both characters, in ${lang}`,
    out.lead.includes(mila) && out.lead.includes(pip) && out.lead !== en.lead,
    `${mila}/${pip} in ${out.lead.slice(0, 60)}`);
  check(`  no page errors`, errs.length === 0, errs[0]);
}

console.log(fail ? `\n=== ${fail} failures ===` : '\n=== she offers the switch, and both of them use it ===');
await browser.close();
process.exit(fail ? 1 : 0);
