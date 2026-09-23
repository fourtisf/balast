/**
 * The premium banner series (ink): brand/social/p01–p11.
 *
 * One stylesheet (brand/social/premium.css) and this one file, so the series
 * stays one system. Every chart is drawn from the builder's own weights
 * (lib/shapes.ts), and no banner carries a figure a reader could take as a
 * yield (§19, Banners for X): amounts are deposits, the one ratio is a
 * shape's density at the price, and example tokens say they are examples.
 *
 * Run: npm run brand:premium   (writes the HTML, then renders the PNGs)
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { densityAtPrice, shapeWeights } from '../lib/shapes';
import type { ShapeId } from '../lib/data/types';

const DIR = resolve(__dirname, '../brand/social');
const BINS = 24;
const RANGE = 0.15;
const LABEL: Record<ShapeId, string> = { spot: 'Spot', curve: 'Curve', bidask: 'Bid-ask' };
const SHAPES: ShapeId[] = ['spot', 'curve', 'bidask'];

const MARK =
  '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M 5 6 L 13.5 13 L 13.5 26 L 5 26 Z" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><path d="M 27 6 L 18.5 13 L 18.5 26 L 27 26 Z" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';
const ARROW =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const TICK =
  '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ETH = '<img src="../../public/tokens/eth.svg" alt="">';

/** The site's derived monogram for an example token (lib/token-mark.ts colours). */
const coin = (mono: string, hue: number) =>
  `<div class="coin tk" style="background:hsl(${hue} 60% 86%);color:hsl(${hue} 45% 28%)">${mono}</div>`;
const pairCoins = (mono: string, hue: number, sm = false) =>
  `<div class="coins${sm ? ' sm' : ''}">${coin(mono, hue)}<div class="coin q">${ETH}</div></div>`;

const density = (shape: ShapeId) => densityAtPrice(shapeWeights(shape, BINS), -RANGE, RANGE);

/** The builder's bin chart, in the ink palette. */
function chart(shape: ShapeId, w: number, h: number, now = true): string {
  const weights = shapeWeights(shape, BINS);
  const max = Math.max(...weights);
  const step = w / BINS;
  const gap = step / 4;
  const top = now ? 34 : 6;
  const bars = weights
    .map((x, i) => {
      const bh = Math.max(6, (x / max) * (h - top));
      const above = i >= BINS / 2;
      return `<rect x="${(i * step + gap / 2).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(step - gap).toFixed(1)}" height="${bh.toFixed(1)}" rx="4" fill="#3DD68C"${above ? '' : ' fill-opacity=".3"'}/>`;
    })
    .join('');
  const line = `<line x1="${w / 2}" y1="${now ? 8 : 0}" x2="${w / 2}" y2="${h}" stroke="#F1EEE6" stroke-width="2" stroke-dasharray="6 6"/>`;
  const tag = now
    ? `<rect x="${w / 2 - 28}" y="0" width="56" height="24" rx="12" fill="#F1EEE6"/><text x="${w / 2}" y="17" text-anchor="middle" font-family="IBM Plex Mono" font-weight="600" font-size="14" fill="#0C1311">now</text>`
    : '';
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="display:block">${bars}${line}${tag}</svg>`;
}

function page(body: string, opts: { chip?: string; glow?: 'r' | 'l' | 'c'; w?: number; h?: number; bare?: boolean } = {}): string {
  const w = opts.w ?? 1600;
  const h = opts.h ?? 900;
  const glow = opts.glow === 'l' ? ' glow-l' : opts.glow === 'c' ? ' glow-c' : '';
  const top = opts.bare
    ? ''
    : `<div class="top"><div class="brand">${MARK}<span>Balast</span></div><div class="chip"><i></i>${opts.chip ?? 'Live on Robinhood Chain'}</div></div>`;
  const foot = opts.bare
    ? ''
    : '<div class="foot"><span class="site">balast.xyz</span><span class="r"><span>Liquidity layer for Robinhood Chain</span><span>No custody · No emissions</span></span></div>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="social.css"><link rel="stylesheet" href="premium.css"></head><body>
<div class="banner${glow}" data-w="${w}" data-h="${h}" style="width:${w}px;height:${h}px">
${top}
${body}
${foot}
</div></body></html>
`;
}

/* ------------------------------------------------------------ the pieces -- */

const stakeCard = (cls = 'tilt', style = 'position:absolute;left:0;top:92px;width:560px') => `
<div class="card ${cls}" style="${style}">
  <div class="pair">${pairCoins('VI', 187)}
    <div><div class="t">VIRTUAL <span>/ ETH</span></div><div class="s">Uniswap v4 · 0.3% fee tier</div></div>
    <div class="tag">Example</div></div>
  <div class="range">
    <div class="row"><span class="k">Range</span><span class="v">Full range · 0 → ∞</span></div>
    <div class="band"><div class="fill"></div><div class="nowl"><span>now</span></div></div>
    <div class="ends"><span>ETH side</span><span>VIRTUAL side</span></div>
  </div>
  <div class="dep"><div><div class="k">You deposit</div><div class="v">0.10<span>ETH</span></div></div><div><div class="k">and</div><div class="v">330<span>VIRTUAL</span></div></div></div>
  <div class="terms"><div><span>Balast fee</span><b class="ac">None</b></div><div><span>Custody</span><b>Your wallet</b></div><div><span>Lockup</span><b>None</b></div></div>
  <div class="cta">Stake full range${ARROW}</div>
</div>`;

const minted = (style: string, title = 'Position minted', sub = 'to your wallet') =>
  `<div class="float" style="${style}"><i>${TICK}</i><span><b>${title}</b>${sub}</span></div>`;

function shapeCard(shape: ShapeId, style: string, cls = 'tilt'): string {
  const seg = SHAPES.map((s) => `<span${s === shape ? ' class="on"' : ''}>${LABEL[s]}</span>`).join('');
  return `<div class="card ${cls}" style="${style}">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px"><span class="seg2">${seg}</span><span class="mono" style="font-size:17px;color:var(--muted)">${BINS} bins · ±${RANGE * 100}%</span></div>
  <div class="plot">${chart(shape, 470, 240)}<div class="ends"><span>−${RANGE * 100}%</span><span>+${RANGE * 100}%</span></div></div>
  <div class="legend"><span><i style="background:#3DD68C"></i>Token side</span><span><i style="background:rgba(61,214,140,.3)"></i>ETH / USDG side</span></div>
  <div class="dens"><span>Liquidity at the price</span><span><b>${density(shape).toFixed(2)}×</b> an even spread</span></div>
</div>`;
}

const hero = (left: string, right: string) => `<div class="hero">${left}<div class="scene">${right}</div></div>`;
const heading = (eyebrow: string, h: string, lede: string, extra = '', size = '') =>
  `<div><div class="eyebrow2">${eyebrow}</div><h1 class="h ${size}">${h}</h1><p class="lede2">${lede}</p>${extra}</div>`;
const proof = (items: [string, string][]) =>
  `<div class="proof">${items.map(([b, s]) => `<div><b>${b}</b><span>${s}</span></div>`).join('')}</div>`;

/* ------------------------------------------------------------- the pages -- */

const pages: Record<string, string> = {};

pages['p01-introduction'] = page(
  `<div class="stackv">
  <div class="eyebrow2">Liquidity layer · Robinhood Chain</div>
  <h1 class="h inline" style="font-size:124px">Real fees. <em>Nothing printed.</em></h1>
  <p class="lede2" style="max-width:34em">Put tokens into Uniswap pools and collect a share of every swap fee — from real trades, never from emissions.</p>
  <div class="trio" style="margin-top:40px">
    <div class="card"><div class="num">01</div><h3>Stake</h3><p><b>One click, full range.</b> Earns on every trade, wherever the price goes.</p></div>
    <div class="card"><div class="num">02</div><h3>Shape</h3><p><b>Spot, Curve or Bid-ask.</b> Put your liquidity where you think the price will be.</p></div>
    <div class="card"><div class="num">03</div><h3>Keep</h3><p><b>It sits in your wallet.</b> Collect fees or withdraw whenever you like.</p></div>
  </div>
</div>`,
  { glow: 'c' },
);

pages['p02-stake'] = page(
  hero(
    heading(
      'Stakes · through Uniswap',
      'Stake a token.<em>Keep every fee.</em>',
      'One signature. Uniswap mints the position to your wallet, and every swap through the pool pays you your share.',
      proof([['0%', 'Balast fee'], ['Yours', 'In your wallet'], ['None', 'Lockup']]),
    ),
    `<div class="ticket" style="right:-10px;top:30px;width:380px;height:470px;transform:rotate(6deg)"><div class="tt">Your receipt · Uniswap NFT</div></div>
     ${stakeCard()}
     ${minted('left:-64px;top:-6px')}`,
  ),
);

pages['p03-how-it-works'] = page(
  `<div class="stackv">
  <div class="eyebrow2">How it works</div>
  <h1 class="h inline" style="font-size:108px">Three steps. <em>One signature.</em></h1>
  <div class="trio" style="margin-top:44px">
    <div class="card"><div class="num">01</div><h3>Pick a pool</h3>
      <div class="mini" style="display:flex;align-items:center;gap:12px;padding:12px 14px;border:1.5px solid var(--hair);border-radius:16px">${pairCoins('VI', 187, true)}<div><div style="font-weight:700;font-size:21px">VIRTUAL <span style="color:var(--muted);font-weight:500">/ ETH</span></div><div class="mono" style="font-size:14px;color:var(--muted);margin-top:2px">0xc691…9c31 · copy</div></div></div>
      <p>Every token shows its <b>contract address</b>, so you know exactly which one.</p></div>
    <div class="card"><div class="num">02</div><h3>Deposit &amp; sign</h3>
      <div class="mini" style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border:1.5px solid var(--hair);border-radius:16px"><span class="mono" style="font-size:24px;font-weight:600">0.10 <span style="font-family:var(--sans);font-size:17px;color:var(--muted)">ETH</span></span><span class="pill in"><i></i>Checked</span></div>
      <p>The node <b>dry-runs the exact transaction</b> before your wallet asks you to sign.</p></div>
    <div class="card"><div class="num">03</div><h3>Get your receipt</h3>
      <div class="mini ticket" style="position:relative;height:66px;padding:16px 18px;border-radius:16px"><div class="tt" style="font-size:13px">Uniswap position NFT</div></div>
      <p>Uniswap mints the position <b>to your wallet</b>. It is your receipt, and your key.</p></div>
  </div>
</div>`,
  { chip: 'Through Uniswap · on Robinhood Chain', glow: 'c' },
);

pages['p04-shapes'] = page(
  `<div class="stackv">
  <div class="eyebrow2">Shapes · one transaction</div>
  <h1 class="h inline" style="font-size:104px">Three shapes. <em>Your range.</em></h1>
  <div class="trio" style="margin-top:40px">
    ${SHAPES.map(
      (s) => `<div class="card" style="padding:24px 24px 22px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px"><h3 style="font-family:var(--serif);font-weight:400;font-size:46px;line-height:1">${LABEL[s]}</h3><span class="mono" style="font-size:18px;color:var(--soft)">${density(s).toFixed(2)}× at the price</span></div>
      <div class="plot">${chart(s, 356, 170, false)}</div>
      <p style="font-size:20px;line-height:1.4;color:var(--soft);margin-top:14px">${
        s === 'spot'
          ? '<b style="color:var(--ink-t)">Even</b> across the range. Steady while the price wanders.'
          : s === 'curve'
            ? '<b style="color:var(--ink-t)">Bunched at the price.</b> The most while it sits still.'
            : '<b style="color:var(--ink-t)">Thick at the edges.</b> Buys dips, sells rallies.'
      }</p></div>`,
    ).join('')}
  </div>
</div>`,
  { chip: 'Positions · through Uniswap', glow: 'c' },
);

const shapeCopy: Record<ShapeId, [string, string, string, [string, string][]]> = {
  spot: [
    'p05-spot',
    'Spot.<em>Even, all the way.</em>',
    'The same liquidity in every bin across your range. Steady while the price wanders inside it.',
    [['Even', 'Every bin'], ['Steady', 'Across the range'], ['Simple', 'To reason about']],
  ],
  curve: [
    'p06-curve',
    'Curve.<em>Thick at the price.</em>',
    'Bunched around the current price, thin at the edges. Earns the most while the market is quiet.',
    [['2.25×', 'At the price'], ['Quiet', 'Markets'], ['Fastest', 'To drop off']],
  ],
  bidask: [
    'p07-bid-ask',
    'Bid-ask.<em>Buy low, sell high.</em>',
    'Thin in the middle, thick at the edges — a ladder of orders that buys dips and sells rallies.',
    [['Edges', 'Most liquidity'], ['Volatile', 'Markets'], ['Ladder', 'Not a fee shape']],
  ],
};
for (const s of SHAPES) {
  const [name, h, lede, items] = shapeCopy[s];
  pages[name] = page(
    hero(
      heading(`Shapes · ${LABEL[s]}`, h, lede, proof(items), 'md'),
      `<div class="ticket" style="right:-10px;top:40px;width:360px;height:440px;transform:rotate(6deg)"><div class="tt">Shape · ${LABEL[s]}</div></div>
       ${shapeCard(s, 'position:absolute;left:0;top:110px;width:570px')}`,
    ),
    { chip: 'Positions · through Uniswap' },
  );
}

pages['p08-portfolio'] = page(
  hero(
    heading(
      'Portfolio',
      'Your position.<em>Your keys.</em>',
      'Collect fees or withdraw any time. Every button sends one transaction to Uniswap, from your wallet.',
      proof([['Any time', 'Collect fees'], ['Any time', 'Withdraw'], ['Nothing', 'Held by Balast']]),
      'md',
    ),
    `<div class="card tilt" style="position:absolute;left:0;top:80px;width:600px;padding:26px 30px">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="k">Your positions</span><span class="tag" style="margin:0">Example</span></div>
      <div class="rows2" style="margin-top:6px">
        <div>${pairCoins('VI', 187, true)}<div style="flex:1"><div style="font-weight:700;font-size:22px">VIRTUAL <span style="color:var(--muted);font-weight:500">/ ETH</span></div><div class="mono" style="font-size:15px;color:var(--muted);margin-top:3px">Full range · Uniswap v4</div></div><span class="pill in"><i></i>In range</span></div>
        <div style="gap:10px;padding-top:6px"><span class="btn dark">Collect fees</span><span class="btn line">Withdraw</span><span style="margin-left:auto;font-size:15px;color:var(--muted)">earning on every swap</span></div>
        <div>${pairCoins('AG', 38, true)}<div style="flex:1"><div style="font-weight:700;font-size:22px">AGENT <span style="color:var(--muted);font-weight:500">/ ETH</span></div><div class="mono" style="font-size:15px;color:var(--muted);margin-top:3px">−12% / +12% · Curve</div></div><span class="pill out"><i></i>Out of range</span></div>
        <div style="gap:10px;padding-top:6px"><span class="btn line">Collect fees</span><span class="btn line">Withdraw</span><span style="margin-left:auto;font-size:15px;color:var(--neg)">earning nothing</span></div>
      </div>
    </div>
    ${minted('right:-10px;bottom:30px', 'Withdrawn', 'both tokens back to your wallet')}`,
  ),
);

pages['p09-honest-numbers'] = page(
  hero(
    heading(
      'Honest numbers',
      'Numbers you<em>can check.</em>',
      'Every figure is read from the chain. No emissions, no projections dressed up as yield, and the data’s age always on screen.',
      '',
      'md',
    ),
    `<div class="card tilt" style="position:absolute;left:0;top:70px;width:590px;padding:22px 30px">
      <div class="rows2">
        ${(
          [
            ['Rewards', 'Swap fees only'],
            ['Emissions', 'None, ever'],
            ['Balast fee', 'None'],
            ['Custody', 'Your wallet'],
            ['Data', 'Read from the chain'],
            ['Out of range', 'Says so, in red'],
          ] as [string, string][]
        )
          .map(([k, v]) => `<div><span class="check">${TICK}</span><div class="fact"><span>${k}</span><b>${v}</b></div></div>`)
          .join('')}
      </div>
    </div>
    ${minted('right:-14px;bottom:30px', 'Indexer lag', 'always shown in the top bar')}`,
  ),
  { glow: 'l' },
);

pages['p10-contract-address'] = page(
  hero(
    heading(
      'Contract address',
      'There is<em>no token yet.</em>',
      'When there is one, its address appears on balast.xyz first. Any address circulating before that is not ours.',
      '',
      'md',
    ),
    `<div class="card tilt" style="position:absolute;left:0;top:130px;width:580px;padding:26px 30px">
      <div class="k">Balast token · CA</div>
      <div style="margin-top:12px;display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border:1.5px dashed var(--hair);border-radius:16px"><span class="mono" style="font-size:26px;color:var(--muted)">0x — coming soon</span><span class="btn line" style="opacity:.5">Copy</span></div>
      <div class="rows2" style="margin-top:8px">
        <div><div class="fact"><span>Where it will be posted</span><b>balast.xyz</b></div></div>
        <div><div class="fact"><span>Posted anywhere else first</span><b>Not ours</b></div></div>
        <div><div class="fact"><span>Someone DMs you a CA</span><b>Not ours</b></div></div>
      </div>
    </div>`,
  ),
);

pages['p11-x-header'] = page(
  `<div style="position:absolute;inset:0;display:grid;grid-template-columns:minmax(0,1fr) 440px;align-items:center;padding:0 80px 0 440px;gap:48px">
    <div>
      <div class="brand" style="margin-bottom:18px">${MARK}<span>Balast</span></div>
      <h1 class="h" style="font-size:70px;margin:0;line-height:1">Stake a token.<em>Keep every fee.</em></h1>
      <div class="mono" style="margin-top:18px;font-size:18px;color:var(--muted);white-space:nowrap">balast.xyz · Liquidity layer for Robinhood Chain</div>
    </div>
    <div class="card" style="padding:16px 16px 12px"><div class="plot" style="padding:12px 12px 6px">${chart('curve', 376, 190)}</div></div>
  </div>`,
  { w: 1500, h: 500, bare: true, glow: 'r' },
);

for (const [name, html] of Object.entries(pages)) {
  writeFileSync(resolve(DIR, `${name}.html`), html);
  console.log(`wrote brand/social/${name}.html`);
}
