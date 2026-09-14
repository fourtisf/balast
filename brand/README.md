# Balast — brand assets

Generated, not hand-edited. Change the geometry in `components/shell/Logo.tsx`
and `scripts/build-brand.py`, then rerun:

```bash
npm run brand          # SVGs, then PNGs
```

The wordmark is outlined from JetBrains Mono at weight 700 — the same variable
font the app ships, instanced at 700 — so **no file here depends on a font
being installed**. The generator reads that font out of `.next/`, so
`npm run build` has to have run at least once.

## Which file

| Use | File |
|---|---|
| X / Telegram avatar, app stores, wallet lists | `icon-black-1024.png` — full bleed, black to every edge |
| The same, one colour | `icon-black-mono-1024.png` |
| Where you want the squircle yourself | `icon-black-rounded-1024.png` — corners transparent |
| On the app's own ground rather than black | `icon-app-ground-1024.png` |
| Inverted, on accent | `icon-accent-1024.png` |
| iOS home screen | `apple-touch-icon-180.png` |
| Browser tab | `favicon.svg`, `favicon-16/32/48.png` |
| The mark alone, dark ground | `balast-mark.svg`, `balast-mark-1024.png` |
| The mark alone, light ground | `balast-mark-light.svg` |
| Inside a React component | `balast-mark-currentcolor.svg`, or `<Mark>` from `components/shell/Logo.tsx` |
| One colour, dark ink / knocked out | `balast-mark-black.svg` · `balast-mark-white.svg` |
| Full logo, dark ground | `balast-lockup.svg`, `balast-lockup-1200.png` |
| Full logo, light ground | `balast-lockup-light.svg`, `balast-lockup-light-1200.png` |
| Link previews on X, Telegram, Discord, Slack | `og-card.png` — 1200 × 630, also served at `/og-card.png` |
| Posts on X: introduction, Stakes, Positions, Router, honest numbers, contract address | `social/*.png` — 1600 × 900 at 2×, from `social/*.html`; `npm run brand:social` re-renders |
| X profile header | `social/x-header.png` — 1500 × 500 at 2× |

**No PNG here has a white pixel in it.** Every one is rasterised with
`omitBackground`, so whatever the SVG does not paint stays transparent. That
is not cosmetic: with a page background behind them, Chromium fills the area
outside a rounded corner with white, and the icon ships with four white
notches. It did, once.

Prefer **full bleed** for avatars and stores. Every one of those surfaces
applies its own rounded mask, and a pre-rounded PNG inside their mask shows a
sliver of whatever sits behind it.

## The rules that matter

**Minimum size.** 16px. The mark needs no small-size variant: its meaning is
a 5-unit central void rather than a hairline, so it is still 2.5px of clear
gap at favicon size.

**Clear space.** Half the mark's height on every side. Nothing intrudes.

**Colour.** One accent. `#3DD68C` on dark, `#1E5E43` on light — the latter is
7.0:1 against `#F2F5F3`, so it clears AA for a graphical object with room to
spare. Never colour the contours separately: §5 allows one accent, and red
means a negative number and nothing else.

**Proportion.** In the lockup the mark's ink is **1.491×** the wordmark's cap
height, and the optical gap is 0.62× cap height.

**Don't** flip or rotate the mark, close up the central gap, or scale it
non-uniformly. The gap is the idea.

## Construction

32 × 32 grid, because 32 halves cleanly to 16 and every even coordinate lands
on a whole pixel in the favicon.

| | |
|---|---|
| Outer edges | x = 5 and 27, full height y = 6 to 26 |
| Inner edges | x = 13.5 and 18.5, starting lower at y = 13 |
| Central gap | 5 units |
| Corner softening | a same-colour stroke, width 1.6, round joins |
| Ink box | 23.6 × 21.6, centred on (16, 16) |

Two solid blocks tapering toward a central gap: heavy at the edges, void in
the middle. That is the bid-ask distribution `BalastShaper` mints, so the shape
says something specific about this product rather than being a generic angular
mark.

One thing worth knowing, recorded rather than hidden: the silhouette reads as
the letter M, which is a mismatch for a product called Balast and is why the
shape feels familiar — angular M marks are a crowded space.

Every text outline here — the wordmark and all three rows of the Open Graph
card — comes from the same `outline()` helper, so nothing in `brand/` needs a
font installed to render correctly.

Full specification: `CLAUDE.md` §5 and §13, and the mark's own source in
`components/shell/Logo.tsx`.
