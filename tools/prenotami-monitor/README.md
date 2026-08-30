# prenotami-monitor

Watches [prenotami.esteri.it](https://prenotami.esteri.it/Services) for an open
**carta d'identità** appointment at the Italian Consulate in Vancouver and alerts
you the moment one appears.

By default it only alerts you. It can also book, but that is off until you turn
it on and give it a date window — see [Auto-booking](#auto-booking).

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

### Watching only on certain days

By default it watches continuously. To watch only when your consulate actually
releases slots:

```bash
PRENOTAMI_SCHEDULE_DAYS=mon,tue
PRENOTAMI_SCHEDULE_TIME=15:00
PRENOTAMI_SCHEDULE_WINDOW_MINUTES=30
```

The process still runs all week; it sleeps between windows and wakes at the
appointed time. Nothing else to install — no cron entry, no timer unit.

**A scheduled run is a window, not an instant.** At 15:00 it starts polling at
your normal interval and keeps going for `WINDOW_MINUTES`, then sleeps until the
next scheduled day. A single request fired at exactly 15:00:00 would just as
easily land a minute before the slots appear as after.

The trade-off is the part worth being clear about: with `mon,tue` at 15:00,
**nothing is watched from Tuesday 15:30 until the following Monday at 15:00** —
about six days. A slot that opens Thursday morning comes and goes unseen. That
is the right setting if you know the release schedule, and the wrong one if you
are guessing. Continuous polling at the default 5 minutes is already gentle
enough that reducing load is not a reason to schedule.

Times are the machine's local zone, and stay put across DST — 15:00 is 15:00 in
November too. `PRENOTAMI_QUIET_START` / `_END` are ignored when a schedule is
set; the schedule already decides when to be awake.

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
| `available` | Dates are open (auto-booking off). **Go book it.** |
| `booked` | It took a slot in your window. Verify in your account. Monitor stops. |
| `uncertain` | Submitted, but could not confirm. **Go look.** Monitor stops. |
| `skipped` | Dates were open but all outside your window. Take one by hand if you want it. |
| `needs-human` | A slot is open but the form needs you. Go now. |
| `dry-run` | Would have booked; stopped before submitting. |
| `unavailable` | The usual state. No alert. |
| `blocked` | The site says your account cannot book — usually a pending appointment or a cooldown. Waiting will not clear this. |
| `challenge` | Cloudflare or a CAPTCHA answered instead of the page. This check learned nothing. |
| `error` | Something else broke. The monitor retries with backoff. |

Every non-`unavailable` outcome saves a full-page screenshot to `data/`, so you
can see the page that triggered the alert rather than taking the tool's word for
it. Every check appends a line to `data/checks.jsonl` — useful for spotting when
Vancouver actually releases slots.

## Auto-booking

Off by default. To turn it on, in `.env`:

```bash
PRENOTAMI_AUTOBOOK=true
PRENOTAMI_BOOK_EARLIEST=2026-09-01    # required
PRENOTAMI_BOOK_LATEST=2026-12-31      # required
PRENOTAMI_BOOK_WEEKDAYS=              # optional: mon,tue,...
```

The two dates are not optional. The config refuses to load without them, because
a booker with no window takes whatever the consulate offers first — including a
date you cannot travel to. A slot outside your window gets you a **high-priority
alert instead of a booking**, so you can still take it by hand.

On success it books once, writes a flag to `data/state.json`, and stops. On
restart it sees that flag and refuses to run — otherwise the service files,
which restart on exit, would book you a second appointment.

### What it will not do without you

| Situation | What happens |
|---|---|
| A CAPTCHA or Cloudflare check appears | Stops. Does not attempt to answer or evade it. Alerts you. |
| The form has a required field your profile did not fill | Stops and names the field. It will not invent a value on a government form. |
| A date is offered outside your window | Alerts you, urgently, and books nothing. |
| The submit button cannot be found | Stops and alerts, rather than clicking something hopeful. |

Required consent checkboxes *are* ticked, and the exact text of every one is
recorded in the log and repeated in the booking alert, so you can see what was
agreed to in your name.

### Before you arm it

Run one cycle with `PRENOTAMI_BOOK_DRY_RUN=true`. It does everything up to the
final submit — picks the date, fills the form, ticks the boxes — then stops and
saves a screenshot to `data/`. Look at that screenshot. It is the difference
between finding out the date logic works and finding out it does not by way of
an appointment you cannot attend.

None of the booking selectors have been verified against the live site; this
project could not reach prenotami from where it was written. The dry run is how
you verify them.

### The risks, stated plainly

- **prenotami's terms prohibit automated access.** Accounts doing this get
  suspended, and a suspended account cannot book at all. The pacing defaults
  exist to keep you unremarkable; do not tune them down.
- **A booked appointment is tied to you and to one service.** A wrong one burns
  a slot that is hard to get back, and some consulates penalize no-shows.
- **`uncertain` is a real outcome.** If the tool submits but cannot confirm the
  result, it says so and stops. Open your account and look rather than assuming.

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
npm test            # 57 unit tests, no browser needed
npm run test:browser   # drives the booking flow against a fake page
```

`npm test` covers what can be decided without a browser: how page text is
classified, which offered date is acceptable, how alerts are deduplicated, and
how checks are paced and scheduled.

`npm run test:browser` drives the real booking code against a local page shaped
like prenotami's form, and asserts the things that would be expensive to get
wrong — that it books the earliest date *in* the window, books nothing outside
it, aborts rather than inventing a value for a required field, and does not
submit during a dry run. Run it after any change to `src/booking.mjs` or
`src/dates.mjs`. If it fails, do not arm auto-booking.

The fixture is this project's best understanding of prenotami's markup, not a
capture of it, so passing means the logic is sound — not that the selectors
match the live site. Only a dry run against your own account tells you that.

## Layout

```
bin/prenotami-monitor.mjs   CLI: check | watch | probe | test-notify
src/config.mjs              .env loading, validation, credential redaction
src/session.mjs             browser, login, session reuse, selector cascades
src/check.mjs               one check, read-only
src/classify.mjs            what the booking page text means (pure)
src/booking.mjs             taking a slot — the only module that writes
src/dates.mjs               which offered date is acceptable (pure)
src/pacing.mjs              intervals, jitter, backoff, quiet hours (pure)
src/schedule.mjs            which days and times to be awake (pure)
src/state.mjs               alert deduplication (pure)
src/notify.mjs              Telegram / ntfy / webhook / desktop
src/monitor.mjs             the watch loop
deploy/                     systemd unit and launchd agent
```
