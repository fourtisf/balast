/**
 * Rasterise the brand SVGs to PNG.
 *
 *   node scripts/build-brand-png.mjs
 *
 * Uses the Chromium Playwright already has, so there is no ImageMagick or
 * Inkscape dependency.
 *
 * Every PNG is written with omitBackground, so anything the SVG does not paint
 * stays transparent. That matters for the squircle icons: with a page
 * background behind them, Chromium fills the area outside the rounded corner
 * with white and the icon ships with four white notches.
 */

import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRAND = join(dirname(fileURLToPath(import.meta.url)), '..', 'brand');

/** Some sandboxes ship Chromium already; use it rather than downloading one. */
const PREINSTALLED = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].find((p) => existsSync(p));

/** [source svg, output png, width] */
const JOBS = [
  // The mark alone, transparent.
  ['depth-mark.svg', 'depth-mark-512.png', 512],
  ['depth-mark.svg', 'depth-mark-1024.png', 1024],
  ['depth-mark-white.svg', 'depth-mark-white-512.png', 512],
  ['depth-mark-black.svg', 'depth-mark-black-512.png', 512],

  // Icons on black, full bleed — no corners, so nothing shows through. This is
  // the cut for an X avatar, Telegram, a wallet's dapp list and the app
  // stores, all of which apply their own mask.
  ['icon-black.svg', 'icon-black-1024.png', 1024],
  ['icon-black.svg', 'icon-black-512.png', 512],
  ['icon-black.svg', 'icon-black-192.png', 192],
  ['icon-black-mono.svg', 'icon-black-mono-1024.png', 1024],
  ['icon-accent.svg', 'icon-accent-1024.png', 1024],

  // Squircle, for surfaces that do not mask for you.
  ['icon-black-rounded.svg', 'icon-black-rounded-1024.png', 1024],
  ['icon-app-ground.svg', 'icon-app-ground-1024.png', 1024],

  // iOS composites a touch icon onto white, so it takes the full-bleed cut.
  ['icon-black.svg', 'apple-touch-icon-180.png', 180],

  ['favicon.svg', 'favicon-16.png', 16],
  ['favicon.svg', 'favicon-32.png', 32],
  ['favicon.svg', 'favicon-48.png', 48],

  ['depth-lockup.svg', 'depth-lockup-1200.png', 1200],
  ['depth-lockup-light.svg', 'depth-lockup-light-1200.png', 1200],
  ['depth-lockup-white.svg', 'depth-lockup-white-1200.png', 1200],
];

const browser = await chromium.launch(
  PREINSTALLED ? { executablePath: PREINSTALLED } : {},
);
const page = await browser.newPage({ deviceScaleFactor: 1 });

for (const [src, out, width] of JOBS) {
  const svg = readFileSync(join(BRAND, src), 'utf8');
  // Read the intrinsic ratio off the viewBox so the height follows the art.
  const [, , vbW, vbH] = svg.match(/viewBox="([^"]+)"/)[1].trim().split(/\s+/).map(Number);
  const height = Math.round((width * vbH) / vbW);

  // Chromium refuses a viewport smaller than roughly 50px, and a favicon is
  // 16. Render into a larger page and clip back to the art.
  await page.setViewportSize({
    width: Math.max(width, 320),
    height: Math.max(height, 320),
  });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}
     svg{display:block;width:${width}px;height:${height}px}</style>${svg}`,
  );
  await page.screenshot({
    path: join(BRAND, out),
    omitBackground: true,
    clip: { x: 0, y: 0, width, height },
  });
  console.log(`  ${out.padEnd(36)} ${width}×${height}`);
}

await browser.close();
