# prenotami-monitor

Watches [prenotami.esteri.it](https://prenotami.esteri.it/Services) for an open
**carta d'identità** appointment at the Italian Consulate in Vancouver and alerts
you the moment one appears.

**It does not book anything.** It tells you; you book. That is deliberate — see
[Why it does not auto-book](#why-it-does-not-auto-book).

---

## Setup

Requires Node 20.6+.

```bash
cd tools/prenotami-monitor
npm install
npx playwright install chromium     # ~150 MB, one time

cp .env.example .env
$EDITOR .env                        # add your login and one alert channel
```

Then confirm it can see your account:

```bash
npm run probe
```

This logs in, lists every service your Vancouver account is offered, and marks
which one the service pattern matched. You want exactly one `<-- MATCHES`. If
you get none or several, adjust `PRENOTAMI_SERVICE_PATTERN` in `.env` and run it
again. It also saves the page HTML and a screenshot to `data/`.

Check that alerts actually reach you:

```bash
npm run test-notify
```

Then a single real check:

```bash
npm run check
```

## Running it

```bash
npm run watch
```

It polls roughly every 5 minutes with jitter, backs off when the site errors,
and alerts you when the booking page stops saying "no dates available". Ctrl-C
to stop. Leave it running on a machine that stays awake — a laptop that sleeps
is not monitoring anything.

### Running it unattended

`deploy/` has a service definition for each platform, so the monitor starts on
boot and restarts if it crashes:

| Platform | File | Install |
|---|---|---|
| Linux | `deploy/prenotami-monitor.service` | `systemctl --user enable --now prenotami-monitor` |
| macOS | `deploy/com.prenotami.monitor.plist` | `launchctl load -w ~/Library/LaunchAgents/...` |

Each file has its exact install steps in a comment at the top, including the one
path you need to edit. On Linux, run `loginctl enable-linger $USER` too, or the
monitor stops when you log out.

Both restart on failure with a 60-second delay and give up for a while if the
monitor is crash-looping, so a broken config cannot turn into a burst of traffic
at the consulate.

**A sleeping laptop is not monitoring anything.** Run this somewhere that stays
awake — a desktop, a Raspberry Pi, a cheap VPS. On macOS, `caffeinate -s`
alongside it.

### Knowing it is still alive

Left alone, "no alerts" and "the process died three weeks ago" look identical.
So every `PRENOTAMI_HEARTBEAT_HOURS` (24 by default) the monitor sends an
all-quiet message through your alert channels. If those stop arriving, the
monitor stopped — check `journalctl --user -u prenotami-monitor` or the launchd
log. Set it to `0` if you find it noisy, but then silence tells you nothing.

## Alert channels

Configure at least one in `.env`, or alerts are console-only:

| Channel | Setup | Good for |
|---|---|---|
| **Telegram** | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Best choice. Reliable push to your phone. |
| **ntfy** | `NTFY_TOPIC` | No account needed. Install the ntfy app, subscribe to your topic. |
| **Webhook** | `WEBHOOK_URL` | Slack, Discord, Zapier, anything that takes a POST. |
| **Desktop** | `PRENOTAMI_DESKTOP_NOTIFY=true` | Only useful if you are at that machine. |

All configured channels fire; one failing does not stop the others.

Alerts are deduplicated — an open slot alerts once, then again after 30 minutes
if it is still open. A slot that closes and reopens alerts again immediately.
"No dates available" never alerts.

## What the outcomes mean

| Outcome | Meaning |
|---|---|
| `available` | The booking page is offering dates. **Go book it.** |
| `unavailable` | The usual state. No alert. |
| `blocked` | The site says your account cannot book — usually a pending appointment or a cooldown. Waiting will not clear this. |
| `challenge` | Cloudflare or a CAPTCHA answered instead of the page. This check learned nothing. |
| `error` | Something else broke. The monitor retries with backoff. |

Every non-`unavailable` outcome saves a full-page screenshot to `data/`, so you
can see the page that triggered the alert rather than taking the tool's word for
it. Every check appends a line to `data/checks.jsonl` — useful for spotting when
Vancouver actually releases slots.

## Why it does not auto-book

Three reasons, in order of how much they would cost you:

1. **A wrong booking is expensive.** Consulate appointments are tied to your
   identity and to one service type. Grabbing the wrong service, or a date you
   cannot travel to, burns a slot that is hard to get back — and some consulates
   penalize no-shows.
2. **Automated booking gets accounts suspended.** prenotami's terms prohibit
   automated access, and booking bots are a known problem the site actively
   defends against. A suspended account cannot book at all, which is strictly
   worse than refreshing by hand.
3. **The last step should be a human decision.** Reading a page every few
   minutes is drudgery worth automating. Committing to a government appointment
   is not.

The monitor is paced accordingly: minimum 60s between checks (enforced — the
config refuses to load below it), jitter on every interval, geometric backoff on
errors, an hourly cap, and optional quiet hours. Do not tune these down. Being
detectable as a bot is the failure mode that ends the whole enterprise.

## When the site changes

prenotami is server-rendered ASP.NET and its markup changes without notice, in
whichever language your account is set to. Two things absorb that:

- **Selectors are cascades, not single strings.** Each field is looked up
  through several increasingly generic strategies (`src/session.mjs`).
- **Phrases are configurable.** `PRENOTAMI_UNAVAILABLE_PHRASES` and
  `PRENOTAMI_BLOCKED_PHRASES` override the built-in list.

When something breaks, run `npm run probe` first. `data/probe-services.html` and
`data/probe-services.png` show what the site actually returned, which is almost
always enough to fix a phrase or a pattern in `.env` without touching code.

If you start getting `challenge` outcomes, run once with
`PRENOTAMI_HEADLESS=false`, clear the CAPTCHA by hand, and the saved session
(`data/session.json`) usually carries for a while.

## Your credentials

- Read from `.env` only. `.env` and `data/` are gitignored.
- Never logged: every log path runs through `redact()` in `src/config.mjs`,
  which strips the password and bot token and masks the email.
- `data/session.json` holds live session cookies. Treat it like a password —
  it is one.
- Nothing is sent anywhere except prenotami and the alert channels you
  configured yourself.

## Tests

```bash
npm test
```

Covers the logic worth being sure about without a browser: how page text is
classified, how alerts are deduplicated, and how checks are paced.

## Layout

```
bin/prenotami-monitor.mjs   CLI: check | watch | probe | test-notify
src/config.mjs              .env loading, validation, credential redaction
src/session.mjs             browser, login, session reuse, selector cascades
src/check.mjs               one check, read-only
src/classify.mjs            what the booking page text means (pure)
src/pacing.mjs              intervals, jitter, backoff, quiet hours (pure)
src/state.mjs               alert deduplication (pure)
src/notify.mjs              Telegram / ntfy / webhook / desktop
src/monitor.mjs             the watch loop
deploy/                     systemd unit and launchd agent
```
