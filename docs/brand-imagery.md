# Landing-page photography

Four photo slots exist on `/`. Each renders only when its file is present in
`public/img/`, so a missing photo degrades to the typographic layout rather
than a broken image. Slot definitions live in `PHOTOS` in `server.js`.

| Slot | File | Where it appears |
| --- | --- | --- |
| `hero` | `parkpulse-hero-cinematic.jpg` | Behind the hero, `opacity .62`, no blend mode, under a left-weighted scrim |
| `vip` | `parkpulse-checklist-cover.jpg` | Left column of the VIP-guide panel, under the honesty note |
| `band` | `parkpulse-family-visual.jpg` | Full-width editorial band immediately before pricing |
| `capture` | `parkpulse-snack-break.jpg` | Ground of the email-capture panel, under a 90–95% purple gradient |

## Art direction — which shot goes where

**`parkpulse-hero-cinematic.jpg` — the sunset promenade.** Three generations
walking away toward a lit castle, gold sun low behind it. The strongest frame
in the set for this slot: the palette is already the brand's, the subjects face
away so the viewer reads themselves into the shot, and the left third is open
sky and paving — exactly where the headline sits. The scrim is weighted left
for that reason and thins out to the right so the photograph still reads behind
the live board.

It is deliberately *not* run through `mix-blend-mode: luminosity`. That was the
first treatment and it drained the warm sunset — the best thing in the frame —
to flat monochrome purple. Plain opacity plus a two-layer scrim keeps the gold
and still clears the AA contrast bar for the headline.

**`parkpulse-checklist-cover.jpg` — the notebook flat-lay.** Open notebook with
a ticked checklist on the left page and a hand-drawn route with numbered stops
on the right, on a lilac ground with a lanyard and a ticket. This is the product
metaphor in one frame — scattered list to sequenced route — and it fills what
was dead space in the VIP panel's left column. No people, no merchandise, and
the ground colour is already brand purple.

**`parkpulse-family-visual.jpg` — family at the coaster gate.** Four backs on a
sunlit path, coaster track above the trees, one adult glancing at a phone. The
phone glance is the product moment without faking a UI. Crops well to a wide
band because the interest sits in the middle third.

**`parkpulse-snack-break.jpg` — family at a park counter.** Used as texture, not
as an image: under a 90–95% gradient only warm light and soft shapes survive.
The crop is biased low (`background-position: 50% 82%`) so the band shows the
counter — paper map, drinks, a phone face-down — rather than slicing the faces
off mid-forehead, which is what centring it did. See the caution below.

## Unused

- **`parkpulse-sunrise-arrival.jpg`** — adult and child walking toward a castle
  at sunrise, portrait crop, paper map in hand. Good shot, but close enough to
  the hero in composition that using both reads as repetition. Kept as the
  alternate hero, and as the drop-in replacement for the capture slot if the
  merchandise note below matters to you.
- **A split-screen "queue vs. AI planner" mockup** was supplied and has been
  deleted rather than kept. It carried baked-in interface text ("AI DAY
  PLANNER", "Thunder Coaster 11:15 AM") that is not our UI, and a "305 MINUTES"
  queue sign that is not a plausible posted wait. Putting it near the product
  would have misdescribed the product.

## Two things to decide before publishing

1. **Recognisable merchandise.** `parkpulse-snack-break.jpg` includes purple
   sequinned character ears that read as Disney merchandise. The site's own
   footer says it is unaffiliated with The Walt Disney Company, so putting that
   product in marketing photography cuts against the disclaimer. Under the
   capture panel's gradient they are close to unreadable at desktop width,
   though more visible on a phone where the panel is taller. To swap, change
   one line — the `capture` entry in `PHOTOS` — to
   `parkpulse-sunrise-arrival.jpg`.
2. **Castle silhouettes.** The hero and the sunrise alternate both feature
   stylised castles that evoke a Disney park. Generic fairytale castles are
   common in this category, but it is worth a deliberate decision rather than a
   default.

Both are judgement calls about your own brand risk, not blockers.

## Adding or replacing a photo

Drop the file in `public/img/`, point the matching `PHOTOS` entry at it, and
redeploy. Export at roughly 2000px on the long edge, JPEG quality ~80, and keep
each file under about 450KB; they are `loading="lazy"` except the hero, which
loads on first paint. Do not commit camera-resolution originals — the first
upload of this set was 35MB across five files.
