/**
 * Writes the two editions of the premium stake banner from one template:
 * 12-premium-stake (paper, the site's own ground) and 13-premium-stake-ink
 * (the night edition). The template is the only file to edit; the editions
 * differ by one class. Run: npm run brand:premium
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../brand/social');
const template = readFileSync(resolve(dir, 'premium-stake.template.html'), 'utf8');
for (const [name, edition] of [['12-premium-stake.html', ''], ['13-premium-stake-ink.html', ' ink']]) {
  writeFileSync(resolve(dir, name), template.replace('banner EDITION', `banner${edition}`));
  console.log(`wrote brand/social/${name}`);
}
