/**
 * The LockFi brand files, from one geometry.
 *
 *   node scripts/build-brand-lockfi.mjs      (npm run brand:lockfi)
 *
 * Writes the favicon (app/icon.svg), the home-screen icon (app/apple-icon.png),
 * the link preview card (public/og-card.png) and the distributable set in
 * brand/lockfi/. The mark's numbers are the ones in components/shell/Logo.tsx;
 * change one, change both.
 *
 * The wordmark is set in Instrument Sans, the site's own face. It is fetched
 * once from the google/fonts repository into brand/lockfi/.fonts (ignored) and
 * embedded while rendering, so the PNGs never fall back to a system face.
 */
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'brand', 'lockfi');
const FONTS = join(OUT, '.fonts');
const FONT_FILE = join(FONTS, 'InstrumentSans.ttf');
const FONT_URL =
  'https://raw.githubusercontent.com/google/fonts/main/ofl/instrumentsans/InstrumentSans%5Bwdth,wght%5D.ttf';

/** The site's own ground and ink (app/globals.css). */
const INK = '#0A0B0D';
const WHITE = '#EDEEF1';
const PAPER = '#F3F3F1';

// ── The mark: Logo.tsx, on a 64-unit grid ─────────────────────────────────
const SHACKLE = 'M23 53.5V22.5a9 9 0 0 1 18 0v31';
const STROKE = 6.5;
const PINS = [
  [9.75, 41.5, 12],
  [28.75, 32.5, 21],
  [47.75, 41.5, 12],
];
const PIN_W = 6.5;
const PIN_R = 1.5;

/** The mark's shapes in one colour, as SVG children on the 64 grid. */
function markShapes(color) {
  return [
    `<path d="${SHACKLE}" fill="none" stroke="${color}" stroke-width="${STROKE}"/>`,
    ...PINS.map(
      ([x, y, h]) => `<rect x="${x}" y="${y}" width="${PIN_W}" height="${h}" rx="${PIN_R}" fill="${color}"/>`,
    ),
  ].join('');
}

function markSvg(color, label = 'LockFi') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="${label}">${markShapes(color)}</svg>\n`;
}

/**
 * The mark on a tile. `radius` 0 is full-bleed (a platform masks it); the
 * mark takes `scale` of the tile, centred.
 */
function iconSvg({ ground, ink, radius = 14, scale = 0.72 }) {
  const t = (64 - 64 * scale) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="LockFi">` +
    `<rect width="64" height="64" rx="${radius}" fill="${ground}"/>` +
    `<g transform="translate(${t} ${t}) scale(${scale})">${markShapes(ink)}</g></svg>\n`
  );
}

// ── Files that need no font ────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const svgs = {
  'mark-white.svg': markSvg(WHITE),
  'mark-black.svg': markSvg(INK),
  'mark-currentcolor.svg': markSvg('currentColor'),
  'icon-dark.svg': iconSvg({ ground: INK, ink: WHITE }),
  'icon-dark-square.svg': iconSvg({ ground: INK, ink: WHITE, radius: 0 }),
  'icon-light.svg': iconSvg({ ground: PAPER, ink: INK }),
  'icon-white-tile.svg': iconSvg({ ground: WHITE, ink: INK }),
};
for (const [name, svg] of Object.entries(svgs)) writeFileSync(join(OUT, name), svg);
// The favicon: the dark tile, a touch larger mark so it holds at 16px.
writeFileSync(join(ROOT, 'app', 'icon.svg'), iconSvg({ ground: INK, ink: WHITE, radius: 14, scale: 0.8 }));

// ── The face, for the lockups and the card ────────────────────────────────
mkdirSync(FONTS, { recursive: true });
if (!existsSync(FONT_FILE)) {
  const res = await fetch(FONT_URL);
  if (!res.ok) throw new Error(`Instrument Sans: HTTP ${res.status} from ${FONT_URL}`);
  writeFileSync(FONT_FILE, Buffer.from(await res.arrayBuffer()));
}
const FONT_FACE = `@font-face{font-family:'Instrument Sans';src:url(data:font/ttf;base64,${readFileSync(FONT_FILE).toString('base64')}) format('truetype');font-weight:400 700;font-stretch:75% 100%}`;

/** Mark and wordmark side by side; the wordmark is 0.82 × the mark's box, as in Logo.tsx. */
function lockupHtml({ ground, ink, mark = 160 }) {
  return `<div class="lk" style="background:${ground};color:${ink}">
    <svg viewBox="0 0 64 64" style="width:${mark}px;height:${mark}px">${markShapes(ink)}</svg>
    <span style="font-size:${mark * 0.82}px">LockFi</span></div>`;
}

const CARD = `<div class="card">
  <div class="glow"></div>
  <div class="top">
    <div class="tile"><svg viewBox="0 0 64 64">${markShapes(INK)}</svg></div>
    <span class="name">LockFi</span>
  </div>
  <div class="mid">
    <h1>Earn real swap fees<br>on Robinhood Chain.</h1>
    <p>Liquidity positions minted by Uniswap straight to your wallet. No lockup, no emissions, no custody.</p>
  </div>
  <div class="bars">${[18, 30, 46, 62, 78, 88, 78, 62, 46, 30, 18]
    .map((h) => `<i style="height:${h}px"></i>`)
    .join('')}</div>
</div>`;

const CSS = `${FONT_FACE}
html,body{margin:0;padding:0;background:transparent}
.lk{display:inline-flex;align-items:center;gap:48px;padding:72px 88px;font-family:'Instrument Sans',sans-serif;font-weight:700;letter-spacing:-.04em;line-height:1}
.lk svg{display:block}
.card{position:relative;width:1200px;height:630px;box-sizing:border-box;padding:72px 80px;background:${INK};color:${WHITE};font-family:'Instrument Sans',sans-serif;overflow:hidden;display:flex;flex-direction:column;justify-content:space-between}
.glow{position:absolute;inset:-40% -10% auto auto;width:900px;height:700px;background:radial-gradient(closest-side,rgba(237,238,241,.10),transparent);pointer-events:none}
.top{display:flex;align-items:center;gap:22px;position:relative}
.tile{width:84px;height:84px;border-radius:20px;background:${WHITE};display:grid;place-items:center}
.tile svg{width:62px;height:62px;display:block}
.name{font-size:56px;font-weight:700;letter-spacing:-.04em}
.mid{position:relative}
h1{margin:0;font-size:72px;line-height:1.02;letter-spacing:-.045em;font-weight:700}
p{margin:22px 0 0;font-size:26px;line-height:1.35;color:#9A9EA8;max-width:760px;font-weight:500}
.bars{position:absolute;right:80px;bottom:72px;display:flex;align-items:flex-end;gap:8px}
.bars i{display:block;width:14px;border-radius:3px;background:#23252B}
`;

// ── Rasterise ─────────────────────────────────────────────────────────────
const PREINSTALLED = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].find((p) => existsSync(p));
const browser = await chromium.launch(PREINSTALLED ? { executablePath: PREINSTALLED } : {});
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function shoot(html, out, { width, height, transparent = true, selector } = {}) {
  await page.setViewportSize({ width: Math.max(width ?? 1600, 320), height: Math.max(height ?? 900, 320) });
  await page.setContent(`<style>${CSS}</style>${html}`);
  await page.evaluate(() => document.fonts.ready);
  const opts = { path: out, omitBackground: transparent };
  if (selector) await page.locator(selector).screenshot(opts);
  else await page.screenshot({ ...opts, clip: { x: 0, y: 0, width, height } });
  console.log(`  ${out.replace(ROOT + '/', '').padEnd(36)} ${selector ? 'element' : `${width}×${height}`}`);
}

const svgPage = (svg, px) =>
  `<div style="width:${px}px;height:${px}px">${svg.replace('width="64" height="64"', `width="${px}" height="${px}"`)}</div>`;

for (const [src, px] of [
  ['icon-dark.svg', 1024],
  ['icon-dark.svg', 512],
  ['icon-dark-square.svg', 1024],
  ['icon-light.svg', 1024],
  ['mark-white.svg', 512],
  ['mark-black.svg', 512],
]) {
  await shoot(svgPage(svgs[src], px), join(OUT, src.replace('.svg', `-${px}.png`)), { width: px, height: px });
}
await shoot(svgPage(iconSvg({ ground: INK, ink: WHITE, radius: 0, scale: 0.72 }), 180), join(ROOT, 'app', 'apple-icon.png'), {
  width: 180,
  height: 180,
  transparent: false,
});
await shoot(lockupHtml({ ground: INK, ink: WHITE }), join(OUT, 'lockup-dark.png'), { selector: '.lk' });
await shoot(lockupHtml({ ground: PAPER, ink: INK }), join(OUT, 'lockup-light.png'), { selector: '.lk' });
await shoot(lockupHtml({ ground: 'transparent', ink: WHITE }), join(OUT, 'lockup-white-transparent.png'), { selector: '.lk' });
await shoot(CARD, join(OUT, 'og-card.png'), { width: 1200, height: 630, transparent: false });
writeFileSync(join(ROOT, 'public', 'og-card.png'), readFileSync(join(OUT, 'og-card.png')));
console.log('  public/og-card.png                   copied');

await browser.close();
