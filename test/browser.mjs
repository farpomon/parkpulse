// One place that knows how to get a Chromium.
//
// Every browser test used to open with the same three lines, including an
// absolute path to one particular build under /opt. That is fine on the
// machine that happens to have it and fatal everywhere else -- which is why
// none of these tests had ever run anywhere but here.
//
// Resolution, in order:
//   PP_CHROMIUM        an explicit binary, wins over everything
//   the sandbox build  used when it is actually on disk
//   nothing            Playwright finds its own download (what CI does)
//
// The module itself comes from PP_PLAYWRIGHT (a path to a checkout that is not
// installed in this project) or from the installed playwright-core.
import fs from 'node:fs';

const SANDBOX_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export function chromiumPath() {
  if (process.env.PP_CHROMIUM) return process.env.PP_CHROMIUM;
  try { if (fs.existsSync(SANDBOX_CHROME)) return SANDBOX_CHROME; } catch {}
  return undefined;                       // let Playwright pick
}

export async function chromium() {
  const pw = await import(process.env.PP_PLAYWRIGHT || 'playwright-core');
  const c = pw.chromium || pw.default?.chromium;
  if (!c) throw new Error('playwright-core has no chromium export');
  return c;
}

export async function launchBrowser(opts = {}) {
  const c = await chromium();
  const executablePath = chromiumPath();
  try {
    return await c.launch({ ...(executablePath ? { executablePath } : {}), ...opts });
  } catch (err) {
    // The commonest failure by far is "no browser installed", and the raw
    // message does not say what to do about it.
    throw new Error(`could not launch Chromium${executablePath ? ` at ${executablePath}` : ''}: ${err.message}\n`
      + 'Set PP_CHROMIUM to a Chromium binary, or run: npx playwright install chromium');
  }
}
