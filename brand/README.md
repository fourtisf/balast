# Depth — brand assets

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
| Anywhere on a dark ground | `depth-mark.svg` |
| On a light ground | `depth-mark-light.svg` |
| Inside a React component | `depth-mark-currentcolor.svg`, or `<Mark>` from `components/shell/Logo.tsx` |
| One-colour print, dark ink | `depth-mark-black.svg` |
| One-colour print, knocked out | `depth-mark-white.svg` |
| Between 20 and 32px | `depth-mark-compact.svg` |
| Below 20px, and token lists | `depth-mark-minimal.svg` |
| Browser tab | `favicon.svg`, `favicon-16/32/48.png` |
| iOS home screen | `apple-touch-icon-180.png` |
| Full logo, dark ground | `depth-lockup.svg`, `depth-lockup-1200.png` |
| Full logo, light ground | `depth-lockup-light.svg`, `depth-lockup-light-1200.png` |
| Slides, social, partner decks | `depth-mark-1024.png`, `depth-lockup-1200.png` |

Every PNG except the favicons and the Apple icon is transparent. Those three
carry the `#050807` ground on purpose: iOS composites a touch icon onto white
and a transparent favicon disappears in a light browser chrome.

## The rules that matter

**Minimum sizes.** Full cut 32px. Compact 20px. Minimal 12px. Below 12px use
nothing — a smudge is worse than no mark.

**Clear space.** Half the mark's height on every side. Nothing intrudes.

**Colour.** One accent. `#3DD68C` on dark, `#1E5E43` on light — the latter is
7.0:1 against `#F2F5F3`, so it clears AA for a graphical object with room to
spare. Never colour the contours separately: §5 allows one accent, and red
means a negative number and nothing else.

**Proportion.** In the lockup the mark's ink is **1.353×** the wordmark's cap
height, and the optical gap is 0.62× cap height. That gap is deliberately
tighter than a bounding-box measurement would give: the mark's right edge only
reaches its full extent at the terminals and curves away below them, so
box-to-box spacing leaves a hole at the middle of the cap band, which is where
the eye reads the join.

**Don't** thin the stroke, flip or rotate the mark, or scale it non-uniformly.
The contours are circular; they only survive uniform scaling.

## Construction

32 × 32 grid, because 32 halves cleanly to 16 and every even coordinate lands
on a whole pixel in the favicon.

| | |
|---|---|
| Surface line | y = 12.5, the shared centre of all three contours |
| Terminals | rise to y = 7.5, tangent to the arc |
| Radii | 12 · 7.8 · 3.6, a uniform 4.2 apart |
| Stroke | 2.6, round caps (compact: 3.2) |
| Ink box | 26.6 × 19.6, centred on (16, 16) |

Each contour is a vertical terminal, a true semicircle, and a second terminal.
A circle's tangent at its leftmost and rightmost point is vertical, so the
straight sections meet the arc without a kink, and the gaps between contours
are identical everywhere as a property of the geometry rather than a judgement
call.

Full specification: `CLAUDE.md` §5, and the mark's own source in
`components/shell/Logo.tsx`.
