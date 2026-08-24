// Capture the product screenshots used on the landing page.
//
//   node scripts/capture-shots.js [baseUrl]
//
// Writes public/shots/plan.png and public/shots/advisor.png.
// playwright-core is a dev-only dependency and is not in package.json; point
// NODE_PATH at wherever it is installed if require cannot find it.
// The advisor shot needs a real consultant reply, so run this against a
// deployment that has ANTHROPIC_API_KEY set (dev or production) — pass its
// URL as the argument. Playwright's chromium must be available; on this
// project's containers it lives at PW_CHROME below.
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const PW_CHROME = process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = path.join(__dirname, '..', 'public', 'shots');

// The question is chosen to provoke the honest answer, which is the whole
// point of the screenshot: the advisor talking a visitor out of a purchase.
const ADVISOR_PROMPT = 'Is Lightning Lane worth it for my family today?';

async function main() {
  const { chromium } = require('playwright-core');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: PW_CHROME });
  const ctx = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  const dismiss = async () => {
    for (const sel of ['#onboard-go', '#wiz-skip']) {
      try { await page.click(sel, { timeout: 3000 }); await page.waitForTimeout(400); } catch {}
    }
  };
  await dismiss();
  await page.waitForTimeout(1200);

  // 1. The day plan.
  await page.click('#plan-day');
  await page.waitForTimeout(2500);
  // Frame it as a visitor sees it — the sheet over the app, not the sheet
  // cut out of it, so the sticky action bar sits where it belongs.
  await page.screenshot({ path: path.join(OUT, 'plan.png') });
  console.log('wrote plan.png');

  // 2. The advisor talking someone out of a purchase.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
  const opened = await page.click('#ppc-fab', { timeout: 5000 }).then(() => true).catch(() => false);
  if (!opened) {
    console.log('advisor: chat widget not present. It only renders when the');
    console.log('  consultant is enabled, which needs ANTHROPIC_API_KEY on the');
    console.log('  deployment being captured. Skipping advisor.png.');
  } else {
    await page.waitForTimeout(800);
    await page.fill('#ppc-input', ADVISOR_PROMPT);
    await page.keyboard.press('Enter');
    // Streaming reply: wait for it to stop growing rather than a fixed sleep.
    let last = '', stable = 0;
    for (let i = 0; i < 60 && stable < 4; i += 1) {
      await page.waitForTimeout(1000);
      const txt = await page.locator('#ppc-msgs').first().innerText().catch(() => '');
      if (txt === last && txt.length > 200) stable += 1; else stable = 0;
      last = txt;
    }
    if (last.length < 200) {
      console.log('advisor: no reply received (is ANTHROPIC_API_KEY set on this deployment?) — skipping advisor.png');
    } else {
      await page.screenshot({ path: path.join(OUT, 'advisor.png') });
      console.log('wrote advisor.png');
    }
  }

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
