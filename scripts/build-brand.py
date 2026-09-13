#!/usr/bin/env python3
"""
Generate the Balast brand assets from the mark's geometry and the real font.

The wordmark is converted to outlines from JetBrains Mono at weight 700 — the
same variable font the app ships, instanced at 700 — so no logo file depends
on a font being installed anywhere.

    pip install fonttools brotli
    python3 scripts/build-brand.py

Writes to brand/. PNGs are rasterised by scripts/build-brand-png.mjs.
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
# The mark, on a 32 × 32 grid: two solid blocks tapering toward a central gap.
# Heavy at the edges, void in the middle — the bid-ask distribution
# BalastShaper mints. See components/shell/Logo.tsx.
BLOCK_L = 'M 5 6 L 13.5 13 L 13.5 26 L 5 26 Z'
BLOCK_R = 'M 27 6 L 18.5 13 L 18.5 26 L 27 26 Z'
# A same-colour stroke with round joins softens the corners to the product's
# radius language without changing the silhouette.
JOIN = 1.6

# Ink box, including the softening stroke: 23.6 × 21.6, centred on (16, 16).
INK_X0, INK_X1 = 5 - JOIN / 2, 27 + JOIN / 2
INK_Y0, INK_Y1 = 6 - JOIN / 2, 26 + JOIN / 2

# ------------------------------------------------------------------ colour --
ACCENT = '#3DD68C'      # --ac,    the near block
DEEP = '#1E5E43'        # --ac-3,  the far block, and the mark on a light ground
INK_DARK = '#04140C'    # --on-ac, on an accent fill
FG = '#E6F2EC'          # --fg,    wordmark on a dark ground
FG_LIGHT = '#14221B'    # wordmark on a light ground
GROUND = '#050807'      # --bg,    the app's own ground
BLACK = '#000000'       # the icon ground: black, as asked

# The wordmark's relationship to the mark, measured rather than guessed:
#   font size  = 0.62 × the mark's grid
#   cap height = 0.73 × font size            (JetBrains Mono)
WORD_SIZE_RATIO = 0.62
TRACKING_EM = 0.14
# Optical gap, ink to ink, as a multiple of cap height.
GAP_CAPS = 0.62

# rx 7 of 32 is the squircle proportion iOS and Android expect. The full-bleed
# cut uses 0, because every avatar surface applies its own mask, and a rounded
# PNG inside a rounded mask shows a sliver of whatever sits behind it.
TILE_R = 7


def blocks(near: str, far: str) -> str:
    return '\n  '.join(
        f'<path d="{d}" fill="{c}" stroke="{c}" stroke-width="{JOIN}" '
        f'stroke-linejoin="round" stroke-linecap="round"/>'
        for d, c in ((BLOCK_L, near), (BLOCK_R, far))
    )


def tile(ground: str, art: str, scale: float = 0.84, radius: float = TILE_R) -> str:
    pad = (32 - 32 * scale) / 2
    rect = (
        f'<rect width="32" height="32" fill="{ground}"/>' if radius == 0
        else f'<rect width="32" height="32" rx="{radius:g}" fill="{ground}"/>'
    )
    return f'{rect}\n  <g transform="translate({pad:g} {pad:g}) scale({scale:g})">{art}</g>'


def svg(body: str, view: str, w: float, h: float) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" width="{w:g}" '
        f'height="{h:g}" role="img" aria-label="Balast">\n  {body}\n</svg>\n'
    )


def write(name: str, content: str) -> None:
    with open(os.path.join(OUT, name), 'w') as fh:
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
        if not all(ord(c) in font.getBestCmap() for c in 'BALAST'):
            continue
        return instancer.instantiateVariableFont(font, {'wght': 700}, inplace=False)
    raise SystemExit(
        'No JetBrains Mono subset with BALAST found in .next/static/media — '
        'run `npm run build` first.'
    )


def outline(
    font: TTFont, text: str, size: float, baseline_y: float, x0: float,
    tracking_em: float = TRACKING_EM,
) -> tuple[str, float]:
    """Any string as outlines, plus the ink's right edge."""
    upm = font['head'].unitsPerEm
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    hmtx = font['hmtx']
    scale = size / upm
    tracking = tracking_em * size

    data: list[str] = []
    pen_x, right = x0, x0
    for ch in text:
        if ch == ' ':
            pen_x += hmtx[cmap[ord('n')]][0] * scale + tracking
            continue
        if ord(ch) not in cmap:
            continue
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs, ntos=lambda v: f'{v:.2f}')
        # Font space is y-up from the baseline; SVG is y-down.
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, pen_x, baseline_y)))
        d = pen.getCommands()
        if d:
            data.append(d)
            right = pen_x + hmtx[name][0] * scale
        pen_x += hmtx[name][0] * scale + tracking
    return ' '.join(data), right


# ----------------------------------------------------------------- build ----
def main() -> None:
    os.makedirs(OUT, exist_ok=True)

    print('marks — no ground, transparent')
    for name, near, far in [
        ('balast-mark.svg', ACCENT, DEEP),
        ('balast-mark-mono.svg', ACCENT, ACCENT),
        ('balast-mark-light.svg', DEEP, '#7FA894'),
        ('balast-mark-white.svg', '#FFFFFF', '#FFFFFF'),
        ('balast-mark-black.svg', INK_DARK, INK_DARK),
        ('balast-mark-currentcolor.svg', 'currentColor', 'currentColor'),
    ]:
        write(name, svg(blocks(near, far), '0 0 32 32', 32, 32))

    print('icons — black ground, full bleed')
    # Full bleed: black to every edge, no rounding. Nothing shows through.
    for name, ground, near, far in [
        ('icon-black.svg', BLACK, ACCENT, DEEP),
        ('icon-black-mono.svg', BLACK, ACCENT, ACCENT),
        ('icon-accent.svg', ACCENT, INK_DARK, 'rgba(4,20,12,.55)'),
    ]:
        write(name, svg(tile(ground, blocks(near, far), 0.84, 0), '0 0 32 32', 1024, 1024))

    print('icons — black ground, squircle')
    for name, ground in [('icon-black-rounded.svg', BLACK), ('icon-app-ground.svg', GROUND)]:
        write(name, svg(tile(ground, blocks(ACCENT, DEEP)), '0 0 32 32', 1024, 1024))

    # The favicon keeps its ground: a transparent one vanishes into a light
    # browser chrome.
    write('favicon.svg', svg(tile(BLACK, blocks(ACCENT, DEEP)), '0 0 32 32', 32, 32))

    print('lockups')
    font = load_bold()
    cap = font['OS/2'].sCapHeight / font['head'].unitsPerEm
    word_size = WORD_SIZE_RATIO * 32
    cap_h = word_size * cap
    baseline = (INK_Y0 + INK_Y1) / 2 + cap_h / 2
    d, ink_right = outline(font, 'BALAST', word_size, baseline, INK_X1 + GAP_CAPS * cap_h)

    pad = 2.0
    vb = (INK_X0 - pad, INK_Y0 - pad, (ink_right - INK_X0) + pad * 2, (INK_Y1 - INK_Y0) + pad * 2)
    for name, near, far, word in [
        ('balast-lockup.svg', ACCENT, DEEP, FG),
        ('balast-lockup-mono.svg', ACCENT, ACCENT, FG),
        ('balast-lockup-light.svg', DEEP, '#7FA894', FG_LIGHT),
        ('balast-lockup-white.svg', '#FFFFFF', '#FFFFFF', '#FFFFFF'),
    ]:
        write(
            name,
            svg(
                blocks(near, far) + f'\n  <path d="{d}" fill="{word}"/>',
                f'{vb[0]:.2f} {vb[1]:.2f} {vb[2]:.2f} {vb[3]:.2f}',
                round(vb[2] * 4, 2), round(vb[3] * 4, 2),
            ),
        )

    # ------------------------------------------------------------- og card --
    # 1200 × 630 is what X, Telegram, Discord and Slack all crop from. Black
    # ground, so it matches the icon wherever the two appear together.
    print('open graph')
    OG_W, OG_H = 1200, 630
    MARGIN = 96.0
    SCALE = 6.38                                # mark grid units -> card px
    mark_h = (INK_Y1 - INK_Y0) * SCALE
    mark_top = 178.0

    mark_art = blocks(ACCENT, DEEP)
    word_size = 32 * SCALE * WORD_SIZE_RATIO * 0.58
    cap_h_og = word_size * cap
    word_d, _ = outline(
        font, 'BALAST', word_size,
        mark_top + mark_h / 2 + cap_h_og / 2,
        MARGIN + (INK_X1 - INK_X0) * SCALE + GAP_CAPS * cap_h_og,
    )
    # Three text rows below the lockup, each given room rather than stacked.
    tag_d, _ = outline(font, 'LIQUIDITY LAYER FOR ROBINHOOD CHAIN', 27,
                       mark_top + mark_h + 62, MARGIN, 0.16)
    sub_d, _ = outline(font, 'FEE YIELD, TRAILING 7D. PAID IN WETH. NO EMISSIONS.', 21,
                       mark_top + mark_h + 106, MARGIN, 0.1)
    url_d, _ = outline(font, 'BALAST.XYZ', 24, OG_H - 72, MARGIN, 0.22)

    write(
        'og-card.svg',
        svg(
            f'<rect width="{OG_W}" height="{OG_H}" fill="{BLACK}"/>\n  '
            f'<rect x="0" y="0" width="{OG_W}" height="4" fill="{ACCENT}"/>\n  '
            f'<g transform="translate({MARGIN - INK_X0 * SCALE:.2f} '
            f'{mark_top - INK_Y0 * SCALE:.2f}) scale({SCALE:.4f})">{mark_art}</g>\n  '
            f'<path d="{word_d}" fill="{FG}"/>\n  '
            f'<path d="{tag_d}" fill="{FG}" opacity=".92"/>\n  '
            f'<path d="{sub_d}" fill="#8FA79B"/>\n  '
            f'<path d="{url_d}" fill="{ACCENT}"/>',
            f'0 0 {OG_W} {OG_H}', OG_W, OG_H,
        ),
    )

    print(f'\nink box {INK_X1 - INK_X0:.1f} × {INK_Y1 - INK_Y0:.1f} centred on (16, 16) · '
          f'cap height {cap_h:.2f} · mark {(INK_Y1 - INK_Y0) / cap_h:.3f}× caps')


if __name__ == '__main__':
    main()
