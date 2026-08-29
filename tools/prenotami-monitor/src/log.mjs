// Console + JSONL logging, with credentials scrubbed on the way out.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './config.mjs';

const LEVEL_COLORS = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', ok: '\x1b[32m' };

export function createLogger(config) {
  mkdirSync(config.dataDir, { recursive: true });
  const logPath = join(config.dataDir, 'checks.jsonl');

  function emit(level, message, fields = {}) {
    const safeMessage = redact(String(message), config);
    const stamp = new Date().toISOString();
    const color = LEVEL_COLORS[level] || '';
    const reset = color ? '\x1b[0m' : '';
    console.log(`${color}[${stamp}] ${level.toUpperCase()}${reset} ${safeMessage}`);

    const safeFields = {};
    for (const [key, value] of Object.entries(fields)) {
      safeFields[key] = typeof value === 'string' ? redact(value, config) : value;
    }
    try {
      appendFileSync(
        logPath,
        JSON.stringify({ ts: stamp, level, message: safeMessage, ...safeFields }) + '\n'
      );
    } catch {
      // A failed log write must never take down the monitor.
    }
  }

  return {
    logPath,
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    ok: (m, f) => emit('ok', m, f),
  };
}
