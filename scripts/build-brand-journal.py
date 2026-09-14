#!/usr/bin/env python3
"""
The Balast brand in the Journal system: ink on paper, a serif wordmark.

§19 replaced the dark terminal with paper, and the navigation draws the
brand as an ink mark beside "Balast" in Instrument Serif. The files in
brand/ still carried the prototype's mark on black, so the avatar on X and
the link preview disagreed with the site behind them. This script draws the
same lockup the navigation draws, at the navigation's own proportions (a
22px mark, a 10px gap, a 24px wordmark, letter-spacing .01em), and puts it
on the site's paper.

The wordmark and every line of text are outlines, so no file depends on a
font being installed. The three faces are fetched once from the google/fonts
repository into brand/journal/.fonts (ignored by git).

    pip install fonttools
    python3 scripts/build-brand-journal.py      # SVGs
    node scripts/build-brand-journal-png.mjs    # PNGs

or `npm run brand:journal` for both.
"""

from __future__ import annotations

import os
import subprocess
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'brand', 'journal')
FONT_DIR = os.path.join(OUT, '.fonts')
FONTS = {
    'serif': 'ofl/instrumentserif/InstrumentSerif-Regular.ttf',
    'serif-italic': 'ofl/instrumentserif/InstrumentSerif-Italic.ttf',
    'mono': 'ofl/ibmplexmono/IBMPlexMono-SemiBold.ttf',
}
FONT_SOURCE = 'https://raw.githubusercontent.com/google/fonts/main/'

# ---------------------------------------------------------------- geometry --
# The mark on its 32 × 32 grid, unchanged: components/shell/Logo.tsx.
BLOCK_L = 'M 5 6 L 13.5 13 L 13.5 26 L 5 26 Z'
BLOCK_R = 'M 27 6 L 18.5 13 L 18.5 26 L 27 26 Z'
JOIN = 1.6
INK_X0, INK_X1 = 5 - JOIN / 2, 27 + JOIN / 2
INK_Y0, INK_Y1 = 6 - JOIN / 2, 26 + JOIN / 2

# The lockup: the navigation's pairing (ink mark, "Balast" in Instrument
# Serif, letter-spacing .01em), with the mark's ink standing 1.1 × the
# wordmark's cap height and centred on it, and an optical gap of 0.62 cap
# heights. The navigation itself sets the mark a touch smaller (22px beside
# a 24px word); as a logo on its own the mark carries more of the weight.
MARK_TO_CAP = 1.1
GAP_CAPS = 0.62
TRACKING = 0.01

# ------------------------------------------------------------------ colour --
# app/globals.css, the Journal tokens. Nothing here is a new colour.
PAPER = '#F5F3EE'
PAPER_HI = '#FBFAF7'      # the paper, lit from above (the page's vignette)
PAPER_LO = '#EEEBE4'      # --raise, at the corners
INK = '#14201B'           # --fg
FG_2 = '#4A5A52'
FG_3 = '#65746C'
AC = '#1B8353'            # --ac
AC_3 = '#0F5C3A'          # --ac-3
HAIRLINE = 'rgba(20,32,27,.10)'

TILE_R = 7


def blocks(near: str, far: str) -> str:
    return '\n  '.join(
        f'<path d="{d}" fill="{c}" stroke="{c}" stroke-width="{JOIN}" '
        f'stroke-linejoin="round" stroke-linecap="round"/>'
        for d, c in ((BLOCK_L, near), (BLOCK_R, far))
    )


def paper(w: float, h: float, radius: float = 0, uid: str = 'p') -> str:
    """The site's paper: flat at a glance, lit from the centre on a look."""
    rx = f' rx="{radius:g}"' if radius else ''
    return (
        f'<defs><radialGradient id="{uid}" cx="50%" cy="42%" r="78%">'
        f'<stop offset="0" stop-color="{PAPER_HI}"/><stop offset=".55" stop-color="{PAPER}"/>'
        f'<stop offset="1" stop-color="{PAPER_LO}"/></radialGradient></defs>\n  '
        f'<rect width="{w:g}" height="{h:g}"{rx} fill="url(#{uid})"/>'
    )


def svg(body: str, view: str, w: float, h: float) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" width="{w:g}" '
        f'height="{h:g}" role="img" aria-label="Balast">\n  {body}\n</svg>\n'
    )


def write(name: str, content: str) -> None:
    with open(os.path.join(OUT, name), 'w') as fh:
        fh.write(content)
    print(f'  {name:32s} {len(content):6d} B')


# -------------------------------------------------------------- the fonts --
def font(key: str) -> TTFont:
    os.makedirs(FONT_DIR, exist_ok=True)
    path = os.path.join(FONT_DIR, os.path.basename(FONTS[key]))
    if not os.path.exists(path):
        print(f'  fetching {os.path.basename(path)}')
        subprocess.run(['curl', '-sSfL', '-o', path, FONT_SOURCE + FONTS[key]], check=True)
    return TTFont(path)


def outline(f: TTFont, text: str, size: float, baseline_y: float, x0: float, tracking_em: float = 0) -> tuple[str, float, float]:
    """Text as outlines from (x0, baseline); returns the path, the ink's right edge and the advance."""
    upm = f['head'].unitsPerEm
    glyphs = f.getGlyphSet()
    cmap = f.getBestCmap()
    hmtx = f['hmtx']
    scale = size / upm
    parts: list[str] = []
    pen_x, right = x0, x0
    for ch in text:
        if ord(ch) not in cmap:
            pen_x += hmtx[cmap[ord('n')]][0] * scale
            continue
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs, ntos=lambda v: f'{v:.2f}')
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, pen_x, baseline_y)))
        d = pen.getCommands()
        if d:
            parts.append(d)
            right = pen_x + hmtx[name][0] * scale
        pen_x += hmtx[name][0] * scale + tracking_em * size
    return ' '.join(parts), right, pen_x


def advance(f: TTFont, text: str, size: float, tracking_em: float = 0) -> float:
    """How far the pen moves over `text` — a space counts, ink or not."""
    return outline(f, text, size, 0, 0, tracking_em)[2]


def cap_ratio(f: TTFont) -> float:
    """Cap height as a fraction of the font size, from the font's own table."""
    return f['OS/2'].sCapHeight / f['head'].unitsPerEm


# ----------------------------------------------------------------- build ----
def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    serif = font('serif')
    italic = font('serif-italic')
    mono = font('mono')

    print('marks — transparent')
    write('mark-ink.svg', svg(blocks(INK, INK), '0 0 32 32', 32, 32))
    write('mark-duo.svg', svg(blocks(AC, AC_3), '0 0 32 32', 32, 32))
    write('mark-paper.svg', svg(blocks(PAPER, PAPER), '0 0 32 32', 32, 32))

    print('icons — paper, full bleed (the avatar cut) and squircle')
    def tile(ground: str, art: str, radius: float = 0, scale: float = 0.84) -> str:
        pad = (32 - 32 * scale) / 2
        return f'{ground}\n  <g transform="translate({pad:g} {pad:g}) scale({scale:g})">{art}</g>'
    ink_ground = f'<rect width="32" height="32" fill="{INK}"/>'
    write('icon-paper.svg', svg(tile(paper(32, 32), blocks(INK, INK)), '0 0 32 32', 1024, 1024))
    write('icon-paper-duo.svg', svg(tile(paper(32, 32), blocks(AC, AC_3)), '0 0 32 32', 1024, 1024))
    write('icon-ink.svg', svg(tile(ink_ground, blocks(PAPER, PAPER)), '0 0 32 32', 1024, 1024))
    write('icon-paper-rounded.svg', svg(tile(paper(32, 32, TILE_R), blocks(INK, INK), TILE_R), '0 0 32 32', 1024, 1024))

    print('lockup — the navigation\'s, as outlines')
    cap_h = (INK_Y1 - INK_Y0) / MARK_TO_CAP
    word_size = cap_h / cap_ratio(serif)
    baseline = 16 + cap_h / 2
    d, right, _ = outline(serif, 'Balast', word_size, baseline, INK_X1 + GAP_CAPS * cap_h, TRACKING)
    # Clear space: half the mark's height on every side (brand/README.md).
    clear = (INK_Y1 - INK_Y0) / 2
    x0, y0 = INK_X0 - clear, INK_Y0 - clear
    w, h = (right - INK_X0) + clear * 2, (INK_Y1 - INK_Y0) + clear * 2
    view = f'{x0:.2f} {y0:.2f} {w:.2f} {h:.2f}'
    lockup = blocks(INK, INK) + f'\n  <path d="{d}" fill="{INK}"/>'
    write('lockup-ink.svg', svg(lockup, view, round(w * 8, 1), round(h * 8, 1)))
    write('lockup-paper.svg', svg(
        f'<g transform="translate({x0:.2f} {y0:.2f})">{paper(w, h, 2.2, "lp")}</g>\n  ' + lockup,
        view, round(w * 8, 1), round(h * 8, 1),
    ))
    lockup_duo = blocks(AC, AC_3) + f'\n  <path d="{d}" fill="{INK}"/>'
    write('lockup-duo.svg', svg(lockup_duo, view, round(w * 8, 1), round(h * 8, 1)))

    print('og card — 1200 × 630, the link preview on X')
    W, H = 1200, 630
    body = [paper(W, H, 0, 'og')]
    # The lockup, large and centred.
    s = 3.4
    lock_w = (right - INK_X0) * s
    lx = (W - lock_w) / 2 - INK_X0 * s
    ly = 222 - 16 * s
    body.append(f'<g transform="translate({lx:.2f} {ly:.2f}) scale({s})">{lockup}</g>')
    # The headline the banners open with, in the masthead's voice.
    size = 54
    a, b = 'Real fees, paid in ETH. ', 'Nothing printed.'
    tw = advance(serif, a, size) + advance(italic, b, size)
    tx = (W - tw) / 2
    ty = 386
    da, _, ax = outline(serif, a, size, ty, tx)
    db, _, _ = outline(italic, b, size, ty, ax)
    body.append(f'<path d="{da}" fill="{INK}"/>\n  <path d="{db}" fill="{AC}"/>')
    # The masthead's rule, and the footer line beneath it.
    body.append(f'<rect x="96" y="522" width="{W - 192}" height="2" fill="{INK}"/>')
    du, _, _ = outline(mono, 'balast.xyz', 22, 574, 96)
    body.append(f'<path d="{du}" fill="{INK}"/>')
    tag = 'Liquidity layer for Robinhood Chain'
    dt, _, _ = outline(mono, tag, 19, 573, W - 96 - advance(mono, tag, 19))
    body.append(f'<path d="{dt}" fill="{FG_3}"/>')
    write('og-card.svg', svg('\n  '.join(body), f'0 0 {W} {H}', W, H))


if __name__ == '__main__':
    main()
