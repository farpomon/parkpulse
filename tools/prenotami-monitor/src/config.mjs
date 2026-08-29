// Configuration for the prenotami monitor.
//
// Everything comes from environment variables, normally via a .env file that
// stays on your machine. Credentials are never written to disk by this tool and
// never appear in the logs -- see redact() below, which every log path uses.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseWeekdays } from './dates.mjs';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env reader. We deliberately avoid a dependency here: the file only
// ever holds KEY=value lines, and a real parser would be more surface area
// around the one file in this project that holds a password.
export function loadEnvFile(path = join(ROOT, '.env')) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function num(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function bool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function list(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.split('|').map((s) => s.trim()).filter(Boolean);
}

// Phrases prenotami shows when a service has nothing free. The site answers in
// whichever language the account is set to, so we match several. Override with
// PRENOTAMI_UNAVAILABLE_PHRASES (pipe-separated) if your consulate words it
// differently -- `probe` prints the exact text it saw.
const DEFAULT_UNAVAILABLE = [
  'non ci sono date disponibili',
  'non sono disponibili date',
  'no dates available',
  'there are no available',
  'no hay fechas disponibles',
  'sono attualmente esauriti',
  'currently no available slots',
];

// Phrases that mean the account itself is blocked from booking -- a pending
// appointment, or the consulate's per-user cooldown. Worth distinguishing from
// "no slots", because no amount of waiting will change it.
const DEFAULT_BLOCKED = [
  'hai già una prenotazione',
  'you already have a booking',
  'already have an appointment',
  'non è possibile prenotare',
];


// Auto-booking. Off unless PRENOTAMI_AUTOBOOK is explicitly true, and even then
// it refuses to load without a date window -- an unbounded booker would take
// whatever the consulate offered first, including a date you cannot travel to.
function bookingConfig(env) {
  const enabled = bool(env, 'PRENOTAMI_AUTOBOOK', false);
  const earliest = env.PRENOTAMI_BOOK_EARLIEST?.trim() || null;
  const latest = env.PRENOTAMI_BOOK_LATEST?.trim() || null;

  if (!enabled) return { enabled: false, dryRun: true, earliest, latest, weekdays: [] };

  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(earliest || '') || !iso.test(latest || '')) {
    throw new Error(
      'PRENOTAMI_AUTOBOOK is on, so PRENOTAMI_BOOK_EARLIEST and ' +
        'PRENOTAMI_BOOK_LATEST are both required, as YYYY-MM-DD. Booking ' +
        'without a date window would take any date the consulate offered.'
    );
  }
  if (earliest > latest) {
    throw new Error(
      `PRENOTAMI_BOOK_EARLIEST (${earliest}) is after PRENOTAMI_BOOK_LATEST (${latest}).`
    );
  }

  return {
    enabled: true,
    // Stops before the final submit and screenshots what it would have taken.
    dryRun: bool(env, 'PRENOTAMI_BOOK_DRY_RUN', false),
    earliest,
    latest,
    weekdays: parseWeekdays(env.PRENOTAMI_BOOK_WEEKDAYS),
  };
}

export function loadConfig(env = process.env) {
  const email = env.PRENOTAMI_EMAIL?.trim();
  const password = env.PRENOTAMI_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'PRENOTAMI_EMAIL and PRENOTAMI_PASSWORD must be set. ' +
        'Copy .env.example to .env and fill them in.'
    );
  }

  const intervalSeconds = num(env, 'PRENOTAMI_INTERVAL_SECONDS', 300);
  if (intervalSeconds < 60) {
    throw new Error(
      `PRENOTAMI_INTERVAL_SECONDS is ${intervalSeconds}. Polling a consular ` +
        'booking site faster than once a minute gets accounts flagged; 300 is a ' +
        'sane default. Raise the value.'
    );
  }

  return {
    email,
    password,
    baseUrl: (env.PRENOTAMI_BASE_URL || 'https://prenotami.esteri.it').replace(/\/$/, ''),

    // Which service to watch. The Services page lists every service your
    // account's consulate offers; this regex picks the row. Vancouver lists the
    // ID card as "Carta d'identita" / "Carta d'identità".
    servicePattern: new RegExp(
      env.PRENOTAMI_SERVICE_PATTERN || "carta\\s*d[i’'`´]?\\s*identit",
      'i'
    ),
    serviceLabel: env.PRENOTAMI_SERVICE_LABEL || "carta d'identità",

    intervalSeconds,
    jitterSeconds: num(env, 'PRENOTAMI_JITTER_SECONDS', 90),
    maxChecksPerHour: num(env, 'PRENOTAMI_MAX_CHECKS_PER_HOUR', 20),
    timeoutMs: num(env, 'PRENOTAMI_TIMEOUT_MS', 45_000),

    // Don't hammer the site overnight; the consulate releases slots during
    // Italian business hours. Times are in the machine's local zone, 0-23.
    quietHoursStart: num(env, 'PRENOTAMI_QUIET_START', -1),
    quietHoursEnd: num(env, 'PRENOTAMI_QUIET_END', -1),

    // Hours between all-quiet messages. 0 disables them.
    heartbeatHours: num(env, 'PRENOTAMI_HEARTBEAT_HOURS', 24),

    headless: bool(env, 'PRENOTAMI_HEADLESS', true),
    screenshots: bool(env, 'PRENOTAMI_SCREENSHOTS', true),

    unavailablePhrases: list(env, 'PRENOTAMI_UNAVAILABLE_PHRASES', DEFAULT_UNAVAILABLE),
    blockedPhrases: list(env, 'PRENOTAMI_BLOCKED_PHRASES', DEFAULT_BLOCKED),

    booking: bookingConfig(env),

    dataDir: env.PRENOTAMI_DATA_DIR || join(ROOT, 'data'),

    notify: {
      telegramToken: env.TELEGRAM_BOT_TOKEN?.trim() || null,
      telegramChatId: env.TELEGRAM_CHAT_ID?.trim() || null,
      ntfyTopic: env.NTFY_TOPIC?.trim() || null,
      ntfyServer: (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, ''),
      webhookUrl: env.WEBHOOK_URL?.trim() || null,
      desktop: bool(env, 'PRENOTAMI_DESKTOP_NOTIFY', false),
    },
  };
}

// Scrub anything that could leak the account out of a log line or a crash dump.
export function redact(text, config) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const secret of [config?.password, config?.notify?.telegramToken]) {
    if (secret && secret.length > 3) out = out.split(secret).join('***');
  }
  if (config?.email) {
    const [user, domain] = config.email.split('@');
    if (user && domain) {
      out = out.split(config.email).join(`${user.slice(0, 2)}***@${domain}`);
    }
  }
  return out;
}
