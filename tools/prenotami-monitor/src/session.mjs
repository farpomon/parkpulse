// Browser session: launch, log in, and keep the cookie jar between checks so we
// are not re-authenticating every few minutes.
//
// A note on selectors: prenotami is a server-rendered ASP.NET app whose markup
// changes without warning, and it renders in whichever language the account is
// set to. So nothing here depends on a single selector -- each field is looked
// up through a cascade of increasingly generic strategies, and `probe` prints
// what was actually found so a broken cascade is a two-minute fix, not a
// rewrite. See README, "When the site changes".

import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const EMAIL_SELECTORS = [
  '#login-email',
  'input[name="Modeltest.Email"]',
  'input[name*="Email" i]',
  'input[type="email"]',
];

const PASSWORD_SELECTORS = [
  '#login-password',
  'input[name="Modeltest.Password"]',
  'input[name*="Password" i]',
  'input[type="password"]',
];

const SUBMIT_SELECTORS = [
  'button[name="UserAccount"]',
  '#login-form button[type="submit"]',
  'form button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Login")',
  'button:has-text("Accedi")',
];

// Signs that we got a bot check rather than the page we asked for.
const CHALLENGE_MARKERS = [
  'cf-challenge',
  'challenge-platform',
  'checking your browser',
  'verifica che sei umano',
  'g-recaptcha',
  'hcaptcha',
];

export async function firstMatch(page, selectors, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();
        if (await locator.count()) {
          await locator.waitFor({ state: 'visible', timeout: 1000 });
          return { locator, selector };
        }
      } catch (error) {
        lastError = error;
      }
    }
    await page.waitForTimeout(250);
  }
  const error = new Error(`None of these selectors matched: ${selectors.join(', ')}`);
  error.cause = lastError;
  throw error;
}

export async function looksLikeChallenge(page) {
  const html = (await page.content()).toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => html.includes(marker));
}

export class Session {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.browser = null;
    this.context = null;
    this.storagePath = join(config.dataDir, 'session.json');
  }

  async start() {
    if (this.browser) return;
    mkdirSync(this.config.dataDir, { recursive: true });

    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    // Reusing storage state means a run that restarts does not hand the site a
    // fresh login every time -- fewer auth events on the account, less friction.
    const storageState = existsSync(this.storagePath) ? this.storagePath : undefined;
    this.context = await this.browser.newContext({
      storageState,
      locale: 'en-US',
      timezoneId: process.env.TZ || 'America/Vancouver',
      viewport: { width: 1280, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    });
    this.context.setDefaultTimeout(this.config.timeoutMs);
  }

  async newPage() {
    await this.start();
    return this.context.newPage();
  }

  async saveSession() {
    if (this.context) await this.context.storageState({ path: this.storagePath });
  }

  // True once the Services page renders for a logged-in user.
  async isLoggedIn(page) {
    await page.goto(`${this.config.baseUrl}/Services`, { waitUntil: 'domcontentloaded' });
    if (page.url().toLowerCase().includes('/home')) return false;
    return page.url().toLowerCase().includes('/services');
  }

  async login(page) {
    this.logger.info('Logging in...');
    await page.goto(`${this.config.baseUrl}/Home`, { waitUntil: 'domcontentloaded' });

    if (await looksLikeChallenge(page)) {
      const error = new Error('Login page served a bot challenge');
      error.outcome = 'challenge';
      throw error;
    }

    const email = await firstMatch(page, EMAIL_SELECTORS);
    const password = await firstMatch(page, PASSWORD_SELECTORS);

    await email.locator.fill(this.config.email);
    await password.locator.fill(this.config.password);

    const submit = await firstMatch(page, SUBMIT_SELECTORS);
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      submit.locator.click(),
    ]);
    await page.waitForTimeout(1500);

    const url = page.url().toLowerCase();
    if (!url.includes('/services') && !url.includes('/uservalidation')) {
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
      const error = new Error(
        `Login did not land on the Services page (now at ${page.url()}). ` +
          `Page said: ${body.replace(/\s+/g, ' ').trim()}`
      );
      // Wrong password is worth saying out loud rather than retrying forever.
      error.outcome = /password|credenzial|credential|errat|incorrect/i.test(body)
        ? 'auth'
        : 'error';
      throw error;
    }

    await this.saveSession();
    this.logger.ok('Logged in');
  }

  // Gets a page that is definitely authenticated, reusing the stored session
  // when it is still good.
  async authenticatedPage() {
    const page = await this.newPage();
    if (await this.isLoggedIn(page)) {
      this.logger.info('Reused existing session');
      return page;
    }
    await this.login(page);
    await page.goto(`${this.config.baseUrl}/Services`, { waitUntil: 'domcontentloaded' });
    return page;
  }

  async close() {
    try {
      await this.saveSession();
    } catch {
      // Best effort; a stale session file just means the next run logs in again.
    }
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.context = null;
  }
}
