// The whole suite, in one command.
//
// Fourteen test files existed and nothing ran them together, so they only ever
// protected the code while somebody remembered to invoke each one by hand.
//
// Two kinds of test live here and they need opposite things:
//   - the .cjs ones require server.js into their own process, stub the AI
//     client, and listen on a port of their own; they must NOT have a server
//     already running on that port
//   - the .mjs ones drive a browser against a server this runner starts once
//     and shares, because booting one per file costs ~8s each
//
// Exit code is the number of failed files, capped at 1 for the shell.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PP_TEST_PORT || 9695);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `/tmp/pp-suite-${process.pid}.db`;

// Slow ones last, so a quick mistake surfaces in the first thirty seconds
// rather than four minutes in.
const SHARED_SERVER = [
  ['projected', 'test/projected-waits.mjs'],
  ['datelink', 'test/plan-date-link.mjs'],
  ['grouplabel', 'test/group-label.mjs'],
  ['parksearch', 'test/park-search.mjs'],
  ['picker', 'test/park-picker.mjs'],
  ['langs', 'test/landing-languages.mjs'],
  ['staledict', 'test/stale-dictionary.mjs'],
  ['langpromo', 'test/language-promo.mjs'],
  ['skipsheet', 'test/skip-sheet.mjs'],
  ['partyshape', 'test/party-shape.mjs'],
  ['party', 'test/party-change.mjs'],
  ['ll', 'test/lightning-lane.mjs'],
];
const OWN_SERVER = [
  ['adminai', 'test/admin-ai-spend.cjs'],
  ['adminops', 'test/admin-ops.cjs'],
  ['livestrip', 'test/live-strip.cjs'],
  ['milabudget', 'test/mila-budget.cjs'],
  ['oauth', 'test/oauth-signin.cjs'],
  ['cache', 'test/prompt-cache.cjs'],
  ['card', 'test/plan-card.cjs'],
  ['emaillinks', 'test/email-links.cjs'],
];
// The i18n audit takes a language and is worth running for one by default;
// PP_TEST_LANGS can widen it.
const LANGS = (process.env.PP_TEST_LANGS || 'pt').split(',').filter(Boolean);

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const wanted = ([name]) => !only.length || only.includes(name);

const bar = (s) => `\n${'─'.repeat(64)}\n${s}\n${'─'.repeat(64)}`;
const run = (file, env, args = []) => new Promise((resolve) => {
  const child = spawn(process.execPath, [file, ...args], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env },
  });
  child.on('exit', (code) => resolve(code ?? 1));
  child.on('error', () => resolve(1));
});

async function waitForServer(ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/app`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// The self-hosting tests each bind a fixed port. A stray server left over
// from something else takes one and the failure that follows says only
// EADDRINUSE, three hundred lines up from the summary -- so say it here,
// before anything runs, and name the port.
const OWN_PORTS = { adminai: 9691, adminops: 9689, livestrip: 9687, milabudget: 9685, oauth: 9693, cache: null, card: null, emaillinks: 9698 };
async function portFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(700) });
    return false;                       // something answered
  } catch { return true; }
}
const busy = [];
for (const [name, port] of Object.entries(OWN_PORTS)) {
  if (port && !(await portFree(port))) busy.push(`${name} needs ${port}`);
}
if (busy.length) {
  console.log(`\nSomething is already listening where the suite needs to: ${busy.join(', ')}.`);
  console.log('Stop it first — `ps -eo pid,args | grep "[s]erver.js"` usually finds a stray one.');
  process.exit(1);
}

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), DB_FILE: DB, PASS_SECRET: 'testsecret', ANTHROPIC_API_KEY: 'stub' },
});
let serverLog = '';
for (const s of [server.stdout, server.stderr]) s.on('data', (d) => { serverLog += d; });

const results = [];
let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  try { server.kill('SIGTERM'); } catch {}
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
};
process.on('exit', stop);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(130); });

try {
  console.log(`starting a server on ${PORT}…`);
  if (!await waitForServer()) {
    console.log(serverLog.split('\n').slice(-25).join('\n'));
    throw new Error(`the test server never answered on ${PORT}`);
  }

  for (const entry of SHARED_SERVER.filter(wanted)) {
    const [name, file] = entry;
    console.log(bar(`▶ ${name}`));
    results.push([name, await run(file, { PP_BASE: BASE })]);
  }

  for (const lang of LANGS) {
    if (!wanted(['i18n'])) break;
    console.log(bar(`▶ i18n (${lang})`));
    results.push([`i18n:${lang}`, await run('test/i18n-audit.mjs', { PP_BASE: BASE }, ['--lang', lang])]);
  }

  // These boot their own servers, so the shared one goes down first: two
  // processes reading the same park registry is fine, two binding the same
  // port is not, and their ports have collided before.
  if (OWN_SERVER.some(wanted)) stop();
  for (const entry of OWN_SERVER.filter(wanted)) {
    const [name, file] = entry;
    console.log(bar(`▶ ${name}`));
    results.push([name, await run(file, {})]);
  }
} catch (err) {
  console.log(`\nsuite could not run: ${err.message}`);
  results.push(['runner', 1]);
} finally {
  stop();
}

const failed = results.filter(([, code]) => code !== 0);
// The server's own output is invisible while tests stream past it, and a
// failure is usually the moment you want it -- a park feed that 403'd, a
// dictionary that would not parse.
if (failed.length && serverLog.trim()) {
  console.log(bar('last of the server log'));
  console.log(serverLog.trim().split('\n').slice(-25).join('\n'));
}
console.log(bar('summary'));
for (const [name, code] of results) console.log(`  ${code === 0 ? 'pass' : 'FAIL'}  ${name}`);
console.log(failed.length
  ? `\n${failed.length} of ${results.length} failed: ${failed.map(([n]) => n).join(', ')}`
  : `\nall ${results.length} green`);
process.exit(failed.length ? 1 : 0);
