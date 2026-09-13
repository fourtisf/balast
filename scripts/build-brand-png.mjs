/**
 * Rasterise the brand SVGs to PNG.
 *
 *   node scripts/build-brand-png.mjs
 *
 * Uses the Chromium that Playwright already has, so there is no ImageMagick or
 * Inkscape dependency. Transparent where a transparent PNG is the right answer
 * and opaque where the platform demands it — iOS composites an apple-touch
 * icon onto white, so that one ships with its own ground.
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

/** [source svg, output png, width, opaque] */
const JOBS = [
  ['depth-mark.svg', 'depth-mark-512.png', 512, false],
  ['depth-mark.svg', 'depth-mark-1024.png', 1024, false],
  ['depth-mark-white.svg', 'depth-mark-white-512.png', 512, false],
  ['depth-mark-black.svg', 'depth-mark-black-512.png', 512, false],
  ['depth-lockup.svg', 'depth-lockup-1200.png', 1200, false],
  ['depth-lockup-light.svg', 'depth-lockup-light-1200.png', 1200, false],
  ['favicon.svg', 'favicon-16.png', 16, true],
  ['favicon.svg', 'favicon-32.png', 32, true],
  ['favicon.svg', 'favicon-48.png', 48, true],
  ['apple-touch-icon.svg', 'apple-touch-icon-180.png', 180, true],
];

const browser = await chromium.launch(
  PREINSTALLED ? { executablePath: PREINSTALLED } : {},
);
const page = await browser.newPage({ deviceScaleFactor: 1 });

for (const [src, out, width, opaque] of JOBS) {
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
    `<style>html,body{margin:0;padding:0;background:${opaque ? '#050807' : 'transparent'}}
     svg{display:block;width:${width}px;height:${height}px}</style>${svg}`,
  );
  await page.screenshot({
    path: join(BRAND, out),
    omitBackground: !opaque,
    clip: { x: 0, y: 0, width, height },
  });
  console.log(`  ${out.padEnd(34)} ${width}×${height}${opaque ? '' : ' transparent'}`);
}

await browser.close();
