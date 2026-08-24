# Landing-page photography

Four photo slots exist on `/`. Each renders only when its file is present in
`public/img/`, so a missing photo degrades to the typographic layout rather
than a broken image. Slot definitions live in `PHOTOS` in `server.js`.

| Slot | File | Where it appears |
| --- | --- | --- |
| `hero` | `public/img/hero-dusk.jpg` | Behind the hero gradient, `opacity .42`, `mix-blend-mode: luminosity`, with a left-weighted scrim over it |
| `vip` | `public/img/plan-map.jpg` | Left column of the VIP-guide panel, under the honesty note |
| `band` | `public/img/tickets.jpg` | Full-width editorial band immediately before pricing |
| `capture` | `public/img/family-cafe.jpg` | Ground of the email-capture panel, under a 88–94% purple gradient |

## Art direction — which supplied shot goes where

**`hero-dusk.jpg` — the sunset promenade** (adult and child walking away toward
a lit castle, purple and gold sky, park map in hand). The strongest of the set
for this slot: the palette is already the brand's, the subjects face away so the
viewer reads themselves into the shot, and the paper map in hand is literally
what the product replaces. Crop wide; the scrim is weighted left so the
headline stays legible.

**`plan-map.jpg` — phone over a paper park map** (over-the-shoulder, purple
route line with coloured stops on the screen, illustrated map underneath). This
is the product metaphor in one frame — paper map to sequenced route. It fills
what was dead space in the VIP panel's left column.

**`tickets.jpg` — the ParkPulse ticket flat-lay** (stack of passes carrying the
pulse mark, folded map, watch, phone). On-brand, carries the real logo, no
people, and sits naturally above the pricing ladder.

**`family-cafe.jpg` — family laughing at a park café.** Warm and human where the
page asks for an email. See the caution below before using this one.

## Unused, and why

- **Split-screen queue vs. AI planner.** Carries baked-in interface text
  ("AI DAY PLANNER", "Thunder Coaster 11:15 AM") that is not our UI, and a
  "305 MINUTES" queue sign that is not a plausible posted wait. Presenting it
  near the product would misdescribe the product.
- **Purple notebook / lanyard flat-lays, rainy-day jacket, family at the
  coaster gate, hands on the illustrated map.** All usable; held back so the
  page carries four photographs rather than ten. `rainy-day.jpg` is the natural
  choice if a weather or Plan-B section is ever added, and is also the safe
  substitute for the capture slot (see below).

## Two things to check before publishing

1. **Recognisable merchandise.** The café shot includes purple sequinned
   character ears that read as Disney merchandise. The site's own footer says
   it is unaffiliated with The Walt Disney Company, so putting that product in
   marketing photography cuts against the disclaimer. Swap in the rainy-day
   shot if that matters to you.
2. **Castle silhouettes.** The hero and one alternate feature stylised castles
   that evoke a Disney park. Generic fairytale castles are common in this
   category, but it is worth a deliberate decision rather than a default.

Both are judgement calls about your own brand risk, not blockers.

## Adding a photo

Drop the file at the path in the table above and redeploy — no code change.
Export at roughly 2000px on the long edge, JPEG quality ~80, and keep each
file under about 400KB; they are `loading="lazy"` except the hero.
