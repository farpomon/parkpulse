# Landing-page photography

Slots are declared in `PHOTOS` in `server.js`. Each renders only when its file
is present, so a missing photo degrades to the typographic layout rather than a
broken image.

| File | Slot | Rendered at |
| --- | --- | --- |
| `parkpulse-hero-cinematic.jpg` | Hero background wash | full-bleed, under the gradient |
| `parkpulse-checklist-cover.jpg` | VIP-guide panel, left column | ~400px wide |
| `parkpulse-family-visual.jpg` | Editorial band before pricing | full-width, 220–380px tall |
| `parkpulse-snack-break.jpg` | Email-capture panel ground | under a 88–94% purple overlay |

`parkpulse-sunrise-arrival.jpg` is unused — kept as an alternate hero.

All files here are re-encoded for the web (long edge 1000–2400px, JPEG ~80).
Re-run the optimizer rather than committing camera-resolution originals: the
first upload was 35MB across five files, which the hero alone would have made
a multi-second blocking download on park wifi.

Art direction and brand-risk notes: `docs/brand-imagery.md`.
