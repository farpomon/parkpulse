// Alert channels. Every one of these is a plain HTTPS POST or a local command,
// so the monitor stays dependency-free apart from the browser it drives.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function postJson(url, body, timeoutMs = 15_000) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
}

const CHANNELS = {
  async telegram({ notify }, { title, body, url }) {
    if (!notify.telegramToken || !notify.telegramChatId) return false;
    const text = [`*${title}*`, body, url ? `\n${url}` : ''].filter(Boolean).join('\n');
    await postJson(`https://api.telegram.org/bot${notify.telegramToken}/sendMessage`, {
      chat_id: notify.telegramChatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    });
    return true;
  },

  async ntfy({ notify }, { title, body, url, priority }) {
    if (!notify.ntfyTopic) return false;
    const headers = {
      Title: title,
      Priority: priority === 'high' ? 'urgent' : 'default',
      Tags: priority === 'high' ? 'tada' : 'eyes',
    };
    if (url) headers.Click = url;
    const response = await fetch(`${notify.ntfyServer}/${notify.ntfyTopic}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`ntfy ${response.status} ${response.statusText}`);
    return true;
  },

  async webhook({ notify }, payload) {
    if (!notify.webhookUrl) return false;
    await postJson(notify.webhookUrl, payload);
    return true;
  },

  async desktop({ notify }, { title, body }) {
    if (!notify.desktop) return false;
    if (process.platform === 'darwin') {
      const escape = (s) => s.replace(/["\\]/g, '\\$&');
      await execFileAsync('osascript', [
        '-e',
        `display notification "${escape(body)}" with title "${escape(title)}" sound name "Glass"`,
      ]);
    } else if (process.platform === 'linux') {
      await execFileAsync('notify-send', ['-u', 'critical', title, body]);
    } else {
      return false;
    }
    return true;
  },
};

export function configuredChannels(config) {
  const { notify } = config;
  const names = [];
  if (notify.telegramToken && notify.telegramChatId) names.push('telegram');
  if (notify.ntfyTopic) names.push('ntfy');
  if (notify.webhookUrl) names.push('webhook');
  if (notify.desktop) names.push('desktop');
  return names;
}

// Fan out to every configured channel. One channel failing must not stop the
// others -- the whole point is that the alert gets through.
export async function notifyAll(config, logger, message) {
  const results = [];
  for (const [name, send] of Object.entries(CHANNELS)) {
    try {
      const sent = await send(config, message);
      if (sent) {
        results.push({ channel: name, ok: true });
        logger.info(`Alert sent via ${name}`);
      }
    } catch (error) {
      results.push({ channel: name, ok: false, error: String(error.message || error) });
      logger.warn(`Alert via ${name} failed: ${error.message || error}`);
    }
  }

  if (results.length === 0) {
    logger.warn(
      'No notification channel is configured -- alerts are console-only. ' +
        'Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, or NTFY_TOPIC, in .env.'
    );
  }
  return results;
}

// Turn a check result into something worth reading on a phone screen.
export function buildMessage(config, result) {
  const bookingUrl = result.bookingUrl || `${config.baseUrl}/Services`;

  switch (result.outcome) {
    case 'available':
      return {
        priority: 'high',
        title: `Appointment slots open — ${config.serviceLabel}`,
        body: [
          `The booking page for "${result.serviceName || config.serviceLabel}" is showing availability.`,
          result.detail ? `\n${result.detail}` : '',
          '\nBook it yourself now — this tool does not book for you.',
        ].join(''),
        url: bookingUrl,
      };
    case 'blocked':
      return {
        priority: 'normal',
        title: 'prenotami: your account cannot book right now',
        body:
          `${result.detail || 'The site says booking is not currently possible for this account.'}\n\n` +
          'This usually means an appointment is already pending, or a cooldown is in effect. ' +
          'Watching will continue, but it will not clear on its own.',
        url: bookingUrl,
      };
    case 'challenge':
      return {
        priority: 'normal',
        title: 'prenotami: blocked by a bot check',
        body:
          'The site served a CAPTCHA or Cloudflare challenge instead of the booking page, ' +
          'so this check could not tell whether slots are open. Run with ' +
          'PRENOTAMI_HEADLESS=false to clear it by hand.',
        url: bookingUrl,
      };
    case 'error':
    default:
      return {
        priority: 'normal',
        title: 'prenotami monitor: check failed',
        body:
          `${result.detail || 'Unknown error.'}\n\n` +
          'The monitor is still running and will retry, but it is not currently ' +
          'telling you anything about slot availability.',
        url: bookingUrl,
      };
  }
}
