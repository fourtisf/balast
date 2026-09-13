#!/usr/bin/env python3
"""
Generate the Depth brand assets from the mark's geometry and the real font.

The wordmark is converted to outlines from JetBrains Mono at weight 700 — the
same variable font the app ships, instanced at 700 — so no logo file depends
on a font being installed anywhere.

    pip install fonttools brotli
    python3 scripts/build-brand.py

Writes to brand/. PNGs are rasterised separately by scripts/build-brand-png.mjs.
"""

from __future__ import annotations

import glob
import os
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

OUT = os.path.join(os.path.dirname(__file__), '..', 'brand')

# ---------------------------------------------------------------- geometry --
# The mark, on its 32 × 32 grid. See components/shell/Logo.tsx.
FULL = [
    'M 4 7.5 L 4 12.5 A 12 12 0 0 0 28 12.5 L 28 7.5',
    'M 8.2 7.5 L 8.2 12.5 A 7.8 7.8 0 0 0 23.8 12.5 L 23.8 7.5',
    'M 12.4 7.5 L 12.4 12.5 A 3.6 3.6 0 0 0 19.6 12.5 L 19.6 7.5',
]
COMPACT = [
    'M 4 7.5 L 4 12.5 A 12 12 0 0 0 28 12.5 L 28 7.5',
    'M 10 7.5 L 10 12.5 A 6 6 0 0 0 22 12.5 L 22 7.5',
]
MINIMAL = (
    'M 4 7.5 L 4 12.5 A 12 12 0 0 0 28 12.5 L 28 7.5 '
    'L 22 7.5 L 22 12.5 A 6 6 0 0 1 10 12.5 L 10 7.5 Z'
)
STROKE_FULL, STROKE_COMPACT = 2.6, 3.2

# Ink box: the mark's drawn extent inside its 32 × 32 grid.
INK_X0, INK_X1 = 2.7, 29.3
INK_Y0, INK_Y1 = 6.2, 25.8

# ------------------------------------------------------------------ colour --
ACCENT = '#3DD68C'      # --ac,    on a dark ground
DEEP = '#1E5E43'        # --ac-3,  on a light ground: 7.0:1 against #F2F5F3
INK_DARK = '#04140C'    # --on-ac, on an accent fill
FG = '#E6F2EC'          # --fg,    wordmark on a dark ground
FG_LIGHT = '#14221B'    # wordmark on a light ground
GROUND = '#050807'      # --bg,    the favicon tile

# The wordmark's relationship to the mark, measured rather than guessed:
#   font size   = 0.62 × the mark's grid
#   cap height  = 0.73 × font size          (JetBrains Mono)
#   mark ink    = 19.6 / 32 of the grid
# which puts the mark at 1.353 × the cap height.
WORD_SIZE_RATIO = 0.62
TRACKING_EM = 0.14
# Optical gap, ink to ink, as a multiple of cap height. Measured tight: the
# mark's right edge only reaches its full extent at the terminals, and curves
# away below them, so a bounding-box gap over-spaces it badly at the centre of
# the cap band where the eye actually reads the join.
GAP_CAPS = 0.62


def strokes(paths: list[str], colour: str, width: float) -> str:
    return '\n  '.join(
        f'<path d="{d}" fill="none" stroke="{colour}" stroke-width="{width}" '
        f'stroke-linecap="round"/>'
        for d in paths
    )


def svg(body: str, view: str, w: float, h: float, label: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" width="{w:g}" '
        f'height="{h:g}" role="img" aria-label="{label}">\n  {body}\n</svg>\n'
    )


def write(name: str, content: str) -> None:
    path = os.path.join(OUT, name)
    with open(path, 'w') as fh:
        fh.write(content)
    print(f'  {name:38s} {len(content):6d} B')


# -------------------------------------------------------------- the font ---
def load_bold() -> TTFont:
    """JetBrains Mono from the app's own build output, instanced at 700."""
    for candidate in sorted(glob.glob('.next/static/media/*.woff2')):
        font = TTFont(candidate)
        family = next((r.toUnicode() for r in font['name'].names if r.nameID == 1), '')
        if 'JetBrains' not in family or 'fvar' not in font:
            continue
        if not all(ord(c) in font.getBestCmap() for c in 'DEPTH'):
            continue
        return instancer.instantiateVariableFont(font, {'wght': 700}, inplace=False)
    raise SystemExit(
        'No JetBrains Mono subset with DEPTH found in .next/static/media — '
        'run `npm run build` first.'
    )


def wordmark(font: TTFont, size: float, baseline_y: float, x0: float) -> tuple[str, float, float]:
    """
    "DEPTH" as outlines. Returns the path data and the ink's left and right
    edges, so the caller can set a gap from the ink rather than from the
    advance box.
    """
    upm = font['head'].unitsPerEm
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    hmtx = font['hmtx']
    scale = size / upm
    tracking = TRACKING_EM * size

    data: list[str] = []
    pen_x = x0
    left = right = None
    for ch in 'DEPTH':
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs, ntos=lambda v: f'{v:.2f}')
        # Font space is y-up from the baseline; SVG is y-down.
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, pen_x, baseline_y)))
        d = pen.getCommands()
        if d:
            data.append(d)
            xs = [pen_x, pen_x + hmtx[name][0] * scale]
            left = xs[0] if left is None else left
            right = xs[1]
        pen_x += hmtx[name][0] * scale + tracking
    return ' '.join(data), left or x0, right or pen_x


# ----------------------------------------------------------------- build ----
def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    print('marks')

    # Every mark file keeps the 32 × 32 grid, so they drop in interchangeably.
    for name, colour, label in [
        ('depth-mark.svg', ACCENT, 'Depth'),
        ('depth-mark-light.svg', DEEP, 'Depth'),
        ('depth-mark-white.svg', '#FFFFFF', 'Depth'),
        ('depth-mark-black.svg', INK_DARK, 'Depth'),
        ('depth-mark-currentcolor.svg', 'currentColor', 'Depth'),
    ]:
        write(name, svg(strokes(FULL, colour, STROKE_FULL), '0 0 32 32', 32, 32, label))

    write(
        'depth-mark-compact.svg',
        svg(strokes(COMPACT, ACCENT, STROKE_COMPACT), '0 0 32 32', 32, 32, 'Depth'),
    )
    write(
        'depth-mark-minimal.svg',
        svg(
            f'<path d="{MINIMAL}" fill="{ACCENT}" stroke="{ACCENT}" stroke-width="1.2" '
            f'stroke-linejoin="round" stroke-linecap="round"/>',
            '0 0 32 32', 32, 32, 'Depth',
        ),
    )

    # The favicon carries its own tile: the minimal cut at 80% of it, centred.
    write(
        'favicon.svg',
        svg(
            f'<rect width="32" height="32" rx="7" fill="{GROUND}"/>\n  '
            f'<g transform="translate(3.2 3.2) scale(0.8)">'
            f'<path d="{MINIMAL}" fill="{ACCENT}" stroke="{ACCENT}" stroke-width="1.2" '
            f'stroke-linejoin="round" stroke-linecap="round"/></g>',
            '0 0 32 32', 32, 32, 'Depth',
        ),
    )
    # Apple wants an opaque square with no corner rounding of its own.
    write(
        'apple-touch-icon.svg',
        svg(
            f'<rect width="32" height="32" fill="{GROUND}"/>\n  '
            f'<g transform="translate(4.8 4.8) scale(0.7)">'
            f'{strokes(COMPACT, ACCENT, STROKE_COMPACT)}</g>',
            '0 0 32 32', 180, 180, 'Depth',
        ),
    )

    # ---------------------------------------------------------------- tiles --
    # App-icon style: the mark inside a rounded square, which is how a logo
    # reads as a product rather than as a line drawing. rx 7 of 32 is the
    # squircle proportion iOS and Android both expect.
    print('tiles')
    TILE_R = 7
    def tile(ground, art, scale=0.8, border=None, glow=False):
        pad = (32 - 32 * scale) / 2
        parts = [f'<rect width="32" height="32" rx="{TILE_R}" fill="{ground}"/>']
        if glow:
            parts.append(
                '<defs><radialGradient id="g" cx="30%" cy="22%" r="78%">'
                f'<stop offset="0" stop-color="{ACCENT}" stop-opacity=".16"/>'
                f'<stop offset="1" stop-color="{ACCENT}" stop-opacity="0"/>'
                '</radialGradient></defs>'
                f'<rect width="32" height="32" rx="{TILE_R}" fill="url(#g)"/>'
            )
        if border:
            parts.append(
                f'<rect x=".5" y=".5" width="31" height="31" rx="{TILE_R - .5}" '
                f'fill="none" stroke="{border}" stroke-width="1"/>'
            )
        parts.append(f'<g transform="translate({pad:g} {pad:g}) scale({scale:g})">{art}</g>')
        return '\n  '.join(parts)

    def solid(colour):
        return (f'<path d="{MINIMAL}" fill="{colour}" stroke="{colour}" stroke-width="1.2" '
                f'stroke-linejoin="round" stroke-linecap="round"/>')

    TILES = [
        ('tile-dark-full.svg',     GROUND, strokes(FULL, ACCENT, STROKE_FULL),        0.80, None, False),
        ('tile-dark-compact.svg',  GROUND, strokes(COMPACT, ACCENT, STROKE_COMPACT),  0.80, None, False),
        ('tile-dark-solid.svg',    GROUND, solid(ACCENT),                             0.78, None, False),
        ('tile-panel-full.svg',    '#080D0B', strokes(FULL, ACCENT, STROKE_FULL),     0.80, 'rgba(61,214,140,.22)', True),
        ('tile-accent-full.svg',   ACCENT, strokes(FULL, INK_DARK, STROKE_FULL),      0.80, None, False),
        ('tile-accent-solid.svg',  ACCENT, solid(INK_DARK),                           0.78, None, False),
    ]
    for name, ground, art, scale, border, glow in TILES:
        write(name, svg(tile(ground, art, scale, border, glow), '0 0 32 32', 512, 512, 'Depth'))

    print('lockups')
    font = load_bold()
    upm = font['head'].unitsPerEm
    cap = font['OS/2'].sCapHeight / upm

    size = 32.0                       # the mark's grid
    word_size = WORD_SIZE_RATIO * size
    cap_h = word_size * cap
    gap = GAP_CAPS * cap_h
    # Cap band centred on the mark's ink centre.
    baseline = (INK_Y0 + INK_Y1) / 2 + cap_h / 2
    word_x = INK_X1 + gap

    d, _, ink_right = wordmark(font, word_size, baseline, word_x)
    pad = 2.0
    vb_x, vb_y = INK_X0 - pad, INK_Y0 - pad
    vb_w = (ink_right - INK_X0) + pad * 2
    vb_h = (INK_Y1 - INK_Y0) + pad * 2

    for name, mark_colour, word_colour in [
        ('depth-lockup.svg', ACCENT, FG),
        ('depth-lockup-light.svg', DEEP, FG_LIGHT),
        ('depth-lockup-white.svg', '#FFFFFF', '#FFFFFF'),
        ('depth-lockup-black.svg', INK_DARK, INK_DARK),
    ]:
        body = (
            strokes(FULL, mark_colour, STROKE_FULL)
            + f'\n  <path d="{d}" fill="{word_colour}"/>'
        )
        write(
            name,
            svg(
                body,
                f'{vb_x:.2f} {vb_y:.2f} {vb_w:.2f} {vb_h:.2f}',
                round(vb_w * 4, 2), round(vb_h * 4, 2),
                'Depth',
            ),
        )

    print(f'\nmeasured: cap height {cap_h:.3f}, mark ink {INK_Y1 - INK_Y0:.1f}, '
          f'ratio {(INK_Y1 - INK_Y0) / cap_h:.3f}x, optical gap {gap:.2f}')


if __name__ == '__main__':
    main()
