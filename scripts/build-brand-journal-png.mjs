/** Rasterise brand/journal/*.svg — see build-brand-journal.py. */
import { chromium } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'brand', 'journal');
const PREINSTALLED = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].find((p) => existsSync(p));

/** [source svg, output png, width] */
const JOBS = [
  ['icon-paper.svg', 'icon-paper-1024.png', 1024],
  ['icon-paper.svg', 'icon-paper-400.png', 400],
  ['icon-paper-duo.svg', 'icon-paper-duo-1024.png', 1024],
  ['icon-ink.svg', 'icon-ink-1024.png', 1024],
  ['icon-paper-rounded.svg', 'icon-paper-rounded-1024.png', 1024],
  ['lockup-ink.svg', 'lockup-ink-1600.png', 1600],
  ['lockup-duo.svg', 'lockup-duo-1600.png', 1600],
  ['lockup-paper.svg', 'lockup-paper-1600.png', 1600],
  ['og-card.svg', 'og-card.png', 1200],
];

const browser = await chromium.launch(PREINSTALLED ? { executablePath: PREINSTALLED } : {});
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [src, out, width] of JOBS) {
  const svg = readFileSync(join(DIR, src), 'utf8');
  const [, , vbW, vbH] = svg.match(/viewBox="([^"]+)"/)[1].trim().split(/\s+/).map(Number);
  const height = Math.round((width * vbH) / vbW);
  await page.setViewportSize({ width: Math.max(width, 320), height: Math.max(height, 320) });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${width}px;height:${height}px}</style>${svg}`,
  );
  await page.screenshot({ path: join(DIR, out), omitBackground: true, clip: { x: 0, y: 0, width, height } });
  console.log(`  ${out.padEnd(30)} ${width}×${height}`);
}
await browser.close();
