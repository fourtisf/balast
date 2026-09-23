/**
 * Render brand/social/*.html to PNG at 2× — the banners for X.
 *
 * Each page is one artboard in the site's own design system (social.css
 * mirrors app/globals.css). The size comes from the root element's
 * data-w/data-h, fonts are waited for, and the file is written next to
 * its source. Run: npm run brand:social
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../brand/social');
const only = process.argv.slice(2);

// The three faces, fetched once into brand/social/.fonts (ignored by git) and
// declared in social.css ahead of the Google Fonts import. A headless browser
// behind a proxy often cannot reach Google Fonts, and a banner rendered in the
// fallback faces is not the site's — the first renders were exactly that.
const FONT_SOURCE = 'https://raw.githubusercontent.com/google/fonts/main/ofl/';
const FONTS = {
  'InstrumentSerif-Regular.ttf': 'instrumentserif/InstrumentSerif-Regular.ttf',
  'InstrumentSerif-Italic.ttf': 'instrumentserif/InstrumentSerif-Italic.ttf',
  'DMSans.ttf': 'dmsans/DMSans%5Bopsz,wght%5D.ttf',
  'IBMPlexMono-Regular.ttf': 'ibmplexmono/IBMPlexMono-Regular.ttf',
  'IBMPlexMono-Medium.ttf': 'ibmplexmono/IBMPlexMono-Medium.ttf',
  'IBMPlexMono-SemiBold.ttf': 'ibmplexmono/IBMPlexMono-SemiBold.ttf',
};
const fontDir = resolve(dir, '.fonts');
mkdirSync(fontDir, { recursive: true });
for (const [name, path] of Object.entries(FONTS)) {
  const out = resolve(fontDir, name);
  if (!existsSync(out)) execFileSync('curl', ['-sSfL', '-o', out, FONT_SOURCE + path]);
}
const files = readdirSync(dir)
  // A *.template.html is a source for other artboards, not one itself.
  .filter((f) => f.endsWith('.html') && !f.endsWith('.template.html') && (only.length === 0 || only.some((o) => f.includes(o))))
  .sort();

// The preinstalled Chromium when there is one (PLAYWRIGHT_BROWSERS_PATH), so
// a pinned Playwright version never has to download its own.
const PREINSTALLED = '/opt/pw-browsers/chromium';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || (existsSync(PREINSTALLED) ? PREINSTALLED : undefined),
});
for (const file of files) {
  const html = readFileSync(resolve(dir, file), 'utf8');
  const w = Number(/data-w="(\d+)"/.exec(html)?.[1] ?? 1600);
  const h = Number(/data-h="(\d+)"/.exec(html)?.[1] ?? 900);
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(resolve(dir, file)).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() =>
    ['italic 100px "Instrument Serif"', '600 20px "DM Sans"', '500 20px "IBM Plex Mono"'].map((f) => document.fonts.check(f)),
  );
  if (loaded.includes(false)) console.warn(`${file}: a font did not load ${JSON.stringify(loaded)}`);
  const out = resolve(dir, file.replace(/\.html$/, '.png'));
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
  console.log(`${file} -> ${w}x${h} @2x`);
}
await browser.close();
