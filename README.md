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
| `server.js` | Zero-dep Node server: static hosting, wait-times API proxy, lead capture |
| `data/sample-waits.json` | Typical-day fallback data when the live feed is unreachable |
| `BUSINESS_PLAN.md` | Wedge, pricing, break-even (~2 Trip Passes/mo), distribution, legal, roadmap |

## How the data works

`GET /api/waits/:park` proxies [queue-times.com](https://queue-times.com)'s free
JSON API with a 5-minute in-memory cache (their license requires the visible
"Powered by Queue-Times.com" attribution, which the frontend shows). If the live
feed is unreachable, it falls back to bundled typical-day sample data and labels
it as such. Parks: `magic-kingdom`, `epcot`, `hollywood-studios`, `animal-kingdom`.

## Configuration

| Env var | Purpose |
|---|---|
| `PORT` | Listen port (default 3000) |
| `PAYMENT_LINK` | Stripe Payment Link URL for checkout. Until it's set, pricing buttons capture emails ("lock in this price") instead — a pre-launch waitlist. |

Leads land in `data/leads.jsonl` (gitignored). Replace with a real ESP
(ConvertKit/Loops) in v1.

## v0 limitations (deliberate)

- **No auth** — "Pro" gating is a client-side demo flag (`localStorage pp-pro=1`).
  v1 wires real entitlements via Stripe webhooks + Clerk/Supabase.
- **No alerts yet** — the roadmap's retention feature (v2 in the business plan).
- Leads in a flat file — fine for a waitlist, replace before scale.

## Legal

Unofficial fan tool, not affiliated with or endorsed by The Walt Disney Company.
No Disney trademarks in branding; park/ride names used nominatively. No scraping
or automation of Disney systems — wait data comes from queue-times.com's public API.
