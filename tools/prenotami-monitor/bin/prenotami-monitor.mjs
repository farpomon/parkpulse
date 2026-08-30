#!/usr/bin/env node
// CLI entry point.
//
//   check         one check, print the result, exit
//   watch         poll until stopped
//   probe         dump what the site is actually showing (for fixing selectors)
//   test-notify   send a fake alert through every configured channel

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile, loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/log.mjs';
import { checkOnce, watch } from '../src/monitor.mjs';
import { Session } from '../src/session.mjs';
import { notifyAll, configuredChannels, validateChannels } from '../src/notify.mjs';

const USAGE = `
prenotami-monitor — watch prenotami.esteri.it for an open appointment slot

  npm run check         Check once and print the result
  npm run watch         Keep checking until you stop it (Ctrl-C)
  npm run probe         Dump the Services page so you can fix selectors
  npm run test-notify   Send a test alert through every configured channel

Configuration lives in .env — see .env.example.
This tool never books an appointment. It tells you; you book.
`;

async function main() {
  const command = process.argv[2] || 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger(config);

  validateChannels(config, logger);

  const channels = configuredChannels(config);
  logger.info(
    channels.length
      ? `Alert channels: ${channels.join(', ')}`
      : 'Alert channels: console only (nothing else configured)'
  );

  switch (command) {
    case 'check': {
      const result = await checkOnce(config, logger);
      process.exitCode = result.outcome === 'available' ? 0 : result.outcome === 'error' ? 2 : 0;
      break;
    }

    case 'watch':
      await watch(config, logger);
      break;

    case 'test-notify':
      await notifyAll(config, logger, {
        priority: 'high',
        title: 'prenotami-monitor test alert',
        body: 'If you can read this, alerts will reach you when a slot opens.',
        url: `${config.baseUrl}/Services`,
      });
      break;

    case 'probe': {
      // When the site changes shape, this is what tells you how.
      const session = new Session(config, logger);
      try {
        const page = await session.authenticatedPage();
        mkdirSync(config.dataDir, { recursive: true });

        const html = join(config.dataDir, 'probe-services.html');
        const shot = join(config.dataDir, 'probe-services.png');
        writeFileSync(html, await page.content());
        await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

        const services = await page
          .locator('a[href*="/Services/Booking/"]')
          .evaluateAll((nodes) =>
            nodes.map((node) => ({
              href: node.getAttribute('href'),
              rowText: (node.closest('tr') || node).innerText.replace(/\s+/g, ' ').trim(),
            }))
          )
          .catch(() => []);

        console.log('\nServices your account can see:\n');
        if (services.length === 0) {
          console.log('  (none — check data/probe-services.png to see what rendered)');
        }
        for (const service of services) {
          const hit = config.servicePattern.test(service.rowText) ? '  <-- MATCHES' : '';
          console.log(`  ${service.href}\n    ${service.rowText}${hit}`);
        }
        console.log(`\nSaved: ${html}\n       ${shot}\n`);
      } finally {
        await session.close();
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}\n`);
  process.exitCode = 1;
});
