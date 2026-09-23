/**
 * Writes brand/social/08–11: one banner per liquidity shape, and one with all
 * three. The bars are the site's own weights (lib/shapes.ts), at the builder's
 * defaults — 24 bins over ±15% — so a banner can never draw a shape the
 * builder does not make. The one number on each is the shape's density at the
 * price (`densityAtPrice`), a fact about the weights, not a yield (§19,
 * Banners for X). Run: npm run brand:shapes
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { densityAtPrice, shapeWeights } from '../lib/shapes';
import type { ShapeId } from '../lib/data/types';

const DIR = resolve(__dirname, '../brand/social');
const BINS = 24;
const RANGE = 0.15;

const MARK =
  '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M 5 6 L 13.5 13 L 13.5 26 L 5 26 Z" fill="#14201B" stroke="#14201B" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><path d="M 27 6 L 18.5 13 L 18.5 26 L 27 26 Z" fill="#14201B" stroke="#14201B" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';

const LABEL: Record<ShapeId, string> = { spot: 'Spot', curve: 'Curve', bidask: 'Bid-ask' };

/** The builder's bin chart: quote side (below the price) soft, token side accent, a dashed line at the price. */
function chart(shape: ShapeId, w: number, h: number, now = true): string {
  const weights = shapeWeights(shape, BINS);
  const max = Math.max(...weights);
  const gap = w / BINS / 4;
  const bw = w / BINS - gap;
  const top = now ? 34 : 6;
  const bars = weights
    .map((x, i) => {
      const bh = Math.max(6, (x / max) * (h - top));
      const fill = i >= BINS / 2 ? '#1B8353' : '#BFE3CF';
      return `<rect x="${(i * (w / BINS) + gap / 2).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="4" fill="${fill}"/>`;
    })
    .join('');
  const line = `<line x1="${w / 2}" y1="${now ? 6 : 0}" x2="${w / 2}" y2="${h}" stroke="#14201B" stroke-width="2" stroke-dasharray="6 6"/>`;
  const tag = now ? `<text x="${w / 2 + 10}" y="22" font-family="IBM Plex Mono" font-size="17" fill="#14201B">now</text>` : '';
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="display:block">${bars}${line}${tag}</svg>`;
}

const density = (shape: ShapeId) => densityAtPrice(shapeWeights(shape, BINS), -RANGE, RANGE);

const STYLE = `<style>
.banner{background:
  radial-gradient(900px 640px at 76% 46%, rgba(255,255,255,.95), rgba(255,255,255,0) 70%),
  radial-gradient(1200px 900px at 50% 50%, var(--bg) 55%, var(--raise) 100%)}
.mast.shape{grid-template-columns:minmax(0,1fr) 620px;gap:72px;align-items:center;padding-top:32px}
.mast.shape h1{font-size:112px}
.pts{list-style:none;display:flex;flex-direction:column;gap:14px;margin-top:4px}
.pts li{display:flex;gap:16px;align-items:baseline;font-size:25px;color:var(--fg-2)}
.pts li b{color:var(--fg);font-weight:600}
.pts li::before{content:"";flex:none;width:10px;height:10px;border-radius:50%;background:var(--ac);transform:translateY(-3px)}
.stack{position:relative}
.stack .ghost{position:absolute;inset:22px -16px -22px 16px;background:var(--panel-2);border:1.5px solid var(--bd-n);border-radius:28px}
.sc{position:relative;background:var(--panel);border:1.5px solid var(--bd-n);border-radius:28px;padding:30px 34px 28px;
  box-shadow:inset 0 1.5px 0 #fff,0 2px 4px rgba(20,32,27,.05),0 50px 110px -60px rgba(20,32,27,.45)}
.sc .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}
.sc .bins{font-family:var(--mono);font-size:18px;color:var(--fg-3)}
.plot{padding:18px 18px 10px;border-radius:18px;background:var(--panel-2);border:1.5px solid var(--bd-n)}
.ends{display:flex;justify-content:space-between;margin-top:10px;font-family:var(--mono);font-size:17px;color:var(--fg-3)}
.legend{display:flex;gap:22px;margin-top:16px;font-size:17px;color:var(--fg-2)}
.legend i{display:inline-block;width:14px;height:14px;border-radius:4px;margin-right:8px;vertical-align:-1px}
.dens{display:flex;justify-content:space-between;align-items:baseline;margin-top:18px;padding-top:16px;border-top:1.5px solid var(--bd-n);font-size:21px;color:var(--fg-2)}
.dens b{font-family:var(--mono);font-size:30px;font-weight:600;color:var(--fg)}
.trio{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:26px;margin-top:40px}
.trio .sc{padding:24px 24px 22px}
.trio .name{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px}
.trio .name b{font-family:var(--serif);font-weight:400;font-size:44px;line-height:1}
.trio .name span{font-family:var(--mono);font-size:19px;color:var(--fg-2)}
.trio p{font-size:20px;line-height:1.4;color:var(--fg-2);margin-top:14px}
.trio p b{color:var(--fg);font-weight:600}
.mast-t{display:flex;flex-direction:column;gap:18px;padding-top:34px}
.mast-t h1{font-size:92px}
</style>`;

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="social.css">
${STYLE}</head><body>
<div class="banner" data-w="1600" data-h="900">
<div class="top"><div class="brand">${MARK}<span>Balast</span></div><div class="chip"><i></i>Positions · through Uniswap</div></div>
${body}
<div class="foot"><span class="site">balast.xyz</span><span class="r"><span>Liquidity layer for Robinhood Chain</span><span>No custody · No emissions</span></span></div>
</div></body></html>
`;
}

function single(shape: ShapeId, h1: string, lede: string, points: string[]): string {
  const seg = (['spot', 'curve', 'bidask'] as ShapeId[])
    .map((s) => `<span${s === shape ? ' class="on"' : ''}>${LABEL[s]}</span>`)
    .join('');
  return page(`<div class="mast shape">
  <div class="mast-l">
    <span class="eyebrow">Shapes · ${LABEL[shape]}</span>
    <h1>${h1}</h1>
    <p class="lede">${lede}</p>
    <ul class="pts">${points.map((p) => `<li><span>${p}</span></li>`).join('')}</ul>
  </div>
  <div class="stack"><div class="ghost"></div>
    <div class="sc">
      <div class="head"><span class="seg">${seg}</span><span class="bins">${BINS} bins · ±${RANGE * 100}%</span></div>
      <div class="plot">${chart(shape, 516, 250)}<div class="ends"><span>−${RANGE * 100}%</span><span>+${RANGE * 100}%</span></div></div>
      <div class="legend"><span><i style="background:#1B8353"></i>Token side</span><span><i style="background:#BFE3CF"></i>ETH / USDG side</span></div>
      <div class="dens"><span>Liquidity at the price</span><span><b>${density(shape).toFixed(2)}×</b> an even spread</span></div>
    </div>
  </div>
</div>`);
}

const files: Record<string, string> = {
  '08-shape-spot.html': single(
    'spot',
    'Spot. <em>Even, all the way.</em>',
    'The same liquidity in every bin across your range. Steady while the price wanders inside it, and the simplest shape to reason about.',
    ['<b>Same weight</b> in every bin', '<b>Earns across the range</b>, not just at one point', '<b>Out of range</b> — earns nothing until it returns'],
  ),
  '09-shape-curve.html': single(
    'curve',
    'Curve. <em>Thick where the price is.</em>',
    'Bunched around the current price and thin at the edges. Only the bin holding the price earns, so this earns the most while the price sits still.',
    ['<b>Most liquidity at the price</b>', '<b>Best for a quiet market</b>', '<b>Drops away fastest</b> as the price moves'],
  ),
  '10-shape-bid-ask.html': single(
    'bidask',
    'Bid-ask. <em>Buy low, sell high.</em>',
    'Thin in the middle and thick at the edges: a ladder of orders. It buys the token as the price falls and sells it as the price rises.',
    ['<b>Most liquidity at the edges</b>', '<b>Built for volatile markets</b>', '<b>Least at the price</b> — a ladder, not a fee position'],
  ),
  '11-shapes.html': page(`<div class="mast-t">
  <span class="eyebrow">Shapes · one transaction, straight to your wallet</span>
  <h1>Three shapes. <em>Your range.</em></h1>
</div>
<div class="trio">
  ${(['spot', 'curve', 'bidask'] as ShapeId[])
    .map(
      (s) => `<div class="sc"><div class="name"><b>${LABEL[s]}</b><span>${density(s).toFixed(2)}× at the price</span></div>
    <div class="plot">${chart(s, 352, 180, false)}</div>
    <p>${
      s === 'spot'
        ? '<b>Even</b> across the range. Steady while the price wanders.'
        : s === 'curve'
          ? '<b>Bunched at the price.</b> The most while it sits still.'
          : '<b>Thick at the edges.</b> Buys dips, sells rallies.'
    }</p></div>`,
    )
    .join('\n  ')}
</div>`),
};

for (const [name, html] of Object.entries(files)) {
  writeFileSync(resolve(DIR, name), html);
  console.log(`wrote brand/social/${name}`);
}
