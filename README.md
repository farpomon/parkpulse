# ParkPulse

Live Disney World wait times and smart touring plans — a freemium SaaS grown out
of a static wait-times guide. See [BUSINESS_PLAN.md](BUSINESS_PLAN.md) for the
business model, pricing, unit economics, and roadmap.

## Run it

```
npm start          # or: node server.js
# → http://localhost:3000
```

Node 18+, zero dependencies.

## What's here

| Path | What it is |
|---|---|
| `public/index.html` | Landing page: positioning, pricing (Free / Trip Pass $19.99 / Pro $49), email capture |
| `public/app.html` | The product: live waits per park + smart plan builder (Pro-gated demo) |
| `public/guide.html` | The original free strategy guide — the SEO/content top of funnel |
| `pages.js` | Server-rendered SEO pages: `/parks/<slug>` per-park wait-time & pass-strategy guides (16 pages), plus `/sitemap.xml` and `/robots.txt` |
| `server.js` | Zero-dep Node server: static hosting, wait-times API proxy, lead capture |
| `data/sample-waits.json` | Typical-day fallback data when the live feed is unreachable |
| `BUSINESS_PLAN.md` | Wedge, pricing, break-even (~2 Trip Passes/mo), distribution, legal, roadmap |

## How the data works

`GET /api/waits/:park` proxies [queue-times.com](https://queue-times.com)'s free
JSON API with a 5-minute in-memory cache (their license requires the visible
"Powered by Queue-Times.com" attribution, which the frontend shows). If the live
feed is unreachable, WDW parks fall back to bundled typical-day sample data
(labeled as such); other parks return a clean "unavailable" state.

**Coverage: 15 parks across 8 destinations** — Walt Disney World (4),
Disneyland California (2), Universal Orlando (3, incl. Epic Universe),
Universal Hollywood, Disneyland Paris (2), Tokyo Disney Resort (2), Hong Kong
Disneyland, Shanghai Disneyland. The registry lives in `data/parks.json`
(slugs, destination groups, typical hours, evening shows, and queue-times
matching tokens). Queue-times park ids are **resolved dynamically by name**
from their `/parks.json` directory at boot and daily thereafter — the static
ids in the registry are only fallbacks, so a wrong or changed upstream id
self-corrects. "vs typical" deltas currently exist for WDW parks only (that's
where we have baseline data).

## Configuration

| Env var | Purpose |
|---|---|
| `PORT` | Listen port (default 3000; Railway sets this automatically) |
| `PAYMENT_LINK` | Stripe Payment Link URL for checkout. Until it's set, pricing buttons capture emails ("lock in this price") instead — a pre-launch waitlist. |
| `LEADS_FILE` | Where captured emails are appended (default `data/leads.jsonl`, gitignored). On Railway, point this at a mounted volume. |
| `PRO_GATE` | `on` re-locks Pro features (all parks beyond Magic Kingdom, plan builder, alerts) behind the paywall — enforced server-side (402s), not just in the UI. Unset/anything else = launch preview, everything free. |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_…`). With both price IDs set, the landing page's buy buttons open real Stripe Checkout. |
| `STRIPE_PRICE_TRIP` / `STRIPE_PRICE_ANNUAL` | Stripe Price IDs (`price_…`) for the $19.99 Trip Pass and $49 Pro Annual one-time payments. Create the two products in the Stripe dashboard. |
| `PASS_SECRET` | HMAC secret for signing pass tokens. **Set it in production** (any long random string) — the ephemeral default invalidates all sold passes on restart. |
| `DEV_PASS_CODE` | Developer bypass code. Redeeming it via "Have a pass code?" in the app grants a 10-year pass through the same token system — full access on any device, regardless of the paywall. Unset = redemption disabled. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push keys for wait-drop alerts. Auto-generated to `data/vapid.json` on first boot if unset — but set them (or mount a volume) in production so existing push subscriptions survive redeploys. Generate once with `npx web-push generate-vapid-keys`. |
| `ALERTS_FILE` | Where active wait-drop alerts are stored (default `data/alerts.json`). Point at a volume in production. |
| `ANTHROPIC_API_KEY` | Enables the AI Park Consultant (💬 in the app). Unset = feature hidden entirely. |
| `HISTORY_DIR` | Where wait-time history accumulates (default `data/history/`). **Point at the mounted volume in production** (e.g. `/data/history`) — this archive is the long-term moat. `HISTORY=off` disables collection. |

### Wait-time history & measured baselines

Every 15 minutes the server snapshots live waits for all parks into daily
JSONL files (~1 MB/day across 16 parks; 60-day retention, oldest pruned).
Per-ride **median baselines** are computed from the last 14 days (minimum 12
samples per ride) and take precedence over the hand-built static samples for
the app's "vs typical" deltas — so within a day or two of running, delta
chips appear for every park, not just WDW, and improve as data accrues. The
archive is also the raw material for future per-hour wait predictions.

### AI Park Consultant

Pro feature: a chat advisor for line-skipping decisions — "is Lightning Lane
worth it today?", "how do I do Universal without Express Pass?" — grounded in
the live wait data for the park the user is viewing. Server-side
(`consultant.js`): Claude Opus 5 via the official SDK, with the stable
strategy knowledge base prompt-cached (only the per-request live-waits block
is re-billed), server-side refusal fallbacks enabled, and a 30-messages-per-
6-hours throttle per user. Rough unit cost ~$0.02-0.04 per message; the
throttle caps worst-case spend near $1/user/day — comfortably inside the
Trip Pass margin.

### Wait-drop alerts

Tap the 🔔 on any ride (Pro) and pick a threshold; the server checks live waits
every 5 minutes and sends one Web Push notification when the ride drops below
it, then clears the alert. Alerts never fire off sample/demo data. On iOS the
app must be added to the Home Screen (iOS 16.4+) for push to work.

### Park hours & shows

`data/park-info.json` holds typical hours and the headline evening show per
park. The plan builder uses them for its time range, schedules the show if you
keep it checked, and otherwise exploits the show window — waits drop 30–50%
while crowds watch — to slot in headliners.

Replace the flat-file leads with a real ESP (ConvertKit/Loops) in v1.

## Deploy to Railway

The repo ships with `railway.json` (Nixpacks build, `node server.js` start,
healthcheck on `/api/config`). To deploy:

1. [railway.com/new](https://railway.com/new) → **Deploy from GitHub repo** →
   pick this repo and the `claude/disney-fastpass-wait-times-9nn7ym` branch
   (or `main` after merging).
2. Railway detects the config and deploys — no settings needed.
3. **Settings → Networking → Generate Domain** to get a public URL.
4. Optional, to persist waitlist emails across deploys: add a **Volume**
   mounted at `/data`, then set `LEADS_FILE=/data/leads.jsonl` in Variables.
5. When ready to charge: create a Stripe Payment Link and set `PAYMENT_LINK`
   in Variables.

Every push to the connected branch auto-deploys from then on.

## Accounts

Optional but recommended: 👤 in the app opens login/signup (email + password,
min 8 chars). Passwords are scrypt-hashed into `data/users.json` (`USERS_FILE`
env to relocate — point at a volume in production); sessions are 30-day HMAC
tokens; failed logins are rate-limited (5 per email per 15 min). A purchase or
pass-code redemption made while logged in attaches the entitlement to the
account, and any later login — on any device — re-issues the pass
automatically. Logging in while holding a device pass adopts it onto the
account. No email verification or password reset yet (next auth iteration).

## How payments work (v1)

1. Buy button → `POST /api/checkout` creates a Stripe Checkout session →
   Stripe-hosted payment page.
2. Success redirects to `/welcome?session_id=…`, which calls
   `POST /api/pass/claim`. The server verifies the session is **paid** directly
   with Stripe's API (no webhook needed) and issues a signed pass token
   (`{plan, exp}`, HMAC'd with `PASS_SECRET`) stored in the browser.
3. The app sends the token as an `x-pass` header; gated endpoints verify the
   signature and expiry. Re-opening the receipt link activates additional
   devices — deliberate and fine for a consumer travel product.
4. Purchases are appended to `data/passes.jsonl` for reconciliation.

Deliberate v1 trade-offs: no accounts or password recovery (the Stripe receipt
link *is* the credential), no refund-revocation (tokens expire on their own),
flat-file lead/pass storage.

## Legal

Unofficial fan tool, not affiliated with or endorsed by The Walt Disney Company.
No Disney trademarks in branding; park/ride names used nominatively. No scraping
or automation of Disney systems — wait data comes from queue-times.com's public API.
