# ParkPulse — Business Plan

Turning the Disney wait-times guide into a profitable SaaS.

## The wedge

The guide answers "how do I wait less at Disney World?" once. The SaaS answers it
**continuously, for your specific trip**: live wait times, a personalized touring
plan that reorders itself around real conditions, and (roadmap) alerts when
Lightning Lane inventory or prices move.

- **Free tier** (acquisition): the strategy guide + live waits for one park.
  This is the SEO/content flywheel — the guide already ranks-able content.
- **Paid tier** (revenue): all four parks, the smart plan builder, and alerts.

## Who pays

Disney World trips average $3,000–$6,000+ for a family. People paying that
routinely spend $60–$180/day extra on Lightning Lane. A $20 tool that saves
2–3 hours of standing in line per day is an easy yes — the anchor price is the
vacation, not the software. Proof of willingness to pay: TouringPlans has sold
subscriptions (~$45/yr) on exactly this promise for 15+ years.

## Pricing

| Plan | Price | What it's for |
|---|---|---|
| Free | $0 | Guide + one park's live waits. Email capture. |
| **Trip Pass** | **$19.99 / 30 days** | The core offer. Matches how customers think — they have *a trip*, not a subscription habit. |
| Pro Annual | $49 / year | Repeat visitors and annual passholders. |

Travel products convert far better on one-trip pricing than on monthly
subscriptions; Trip Pass is the headline, annual is the upsell for the ~20% who
go more than once a year. Secondary revenue: hotel/ticket affiliate links
(Undercover Tourist et al. pay 3–6%) on the free tier.

## Cost structure & break-even

- Wait-time data: **$0** — queue-times.com free JSON API (attribution required),
  ThemeParks.wiki as backup. No scraping, no data licensing.
- Infra: static frontend + one small Node service with 5-minute caching. A single
  $5–$10/mo instance (or free-tier serverless) handles thousands of users because
  everything is cached.
- Fixed costs ≈ **$40/mo** (hosting, domain, transactional email, Stripe has no
  fixed fee).

**Break-even ≈ 2 Trip Passes per month.** Every sale after that is ~93% margin
(Stripe takes ~3% + 30¢). This is profitable at hobby scale and scales linearly.

## Distribution (the actual hard part)

1. **SEO**: the guide becomes 15–30 programmatic pages — "Slinky Dog Dash wait
   times by hour", "Is Lightning Lane worth it at Animal Kingdom" — each backed
   by the app's data. Long-tail Disney planning queries are high-volume and
   weakly contested outside 3–4 incumbents.
2. **Short-form video**: daily auto-generated "today's waits" clips for
   TikTok/Reels — the data makes content production nearly free.
3. **Communities**: r/WaltDisneyWorld, Facebook planning groups, Disney podcasts
   (affiliate/sponsor swaps).
4. **Email**: free tier requires an email → trip-countdown drip sequence that
   sells the Trip Pass 7 days before the visit (exactly when Lightning Lane
   booking opens and anxiety peaks).

## Competition

| Competitor | Price | Gap we exploit |
|---|---|---|
| Disney's own app | Free | Shows waits but *optimizes for Disney's revenue*, not your time. No planning intelligence. |
| TouringPlans | ~$45/yr | Deep data, dated UX, subscription-only. We win on modern UX + one-trip pricing. |
| Thrill Data | Free/donation | Data-nerd dashboards, not a consumer plan builder. |
| Blogs (Mouse Hacking etc.) | Free | Static advice. We're live and personalized. |

## Legal guardrails (do these before launch)

- **No Disney trademarks** in the product name, logo, or domain. "ParkPulse" +
  nominative references to park names in content is standard practice
  (TouringPlans, Thrill Data operate the same way). Get a trademark screen anyway.
- Visible "Powered by Queue-Times.com" attribution (their API license requires it).
- Standard ToS/privacy policy; no scraping of Disney systems, no automating
  Disney accounts (that's what gets tools C&D'd — read-only third-party wait
  data does not).

## Roadmap

- **v0 (this repo)**: landing + pricing + live waits + plan builder + email
  capture. Payment via Stripe Payment Link (no backend needed).
- **v1**: real auth (Clerk/Supabase), Stripe Checkout + webhooks for entitlement,
  waitlist → launch emails.
- **v2**: the retention feature — **push/SMS alerts** for wait-time drops and
  Lightning Lane availability. This is what makes the Trip Pass feel magical.
- **v3**: historical data → hour-by-hour predictions per ride; expand to
  Disneyland, Universal (same data API — near-zero marginal cost, doubles TAM).

## Risks

- **Data source dies**: mitigated by dual providers + cached fallback (already
  built into the server).
- **Disney adds real planning to their app**: incumbent risk for every player
  here for 15 years; Disney's incentive is selling Lightning Lane, not
  minimizing your spend, so the conflict of interest persists.
- **Seasonality**: revenue tracks school holidays; annual plan and Universal
  expansion smooth it.
