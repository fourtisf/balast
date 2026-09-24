import { expect, test } from '@playwright/test';

/** §1 and §7. These are product rules, so they are asserted, not eyeballed. */
test.describe('honest numbers', () => {
  test('never says APY or APR anywhere in the app', async ({ page }) => {
    for (const route of ['/pools', '/stakes', '/positions', '/router', '/portfolio', '/learn']) {
      await page.goto(route, { waitUntil: 'networkidle' });
      const text = await page.locator('body').innerText();
      expect(text, `${route} contains APY`).not.toMatch(/APY/i);
      expect(text, `${route} contains APR`).not.toMatch(/\bAPR\b/);
    }
  });

  test('every vault yield names the basis it was computed on', async ({ page }) => {
    // ALFA chose Uniswap's basis — 24h fees annualised — over §1's
    // trailing-7d-everywhere. The rule that survives, and matters more, is
    // that the label always says which: a figure from one day must never be
    // called a trailing seven, and nothing is ever called APY or APR.
    await page.goto('/stakes', { waitUntil: 'networkidle' });
    const cards = page.locator('.vault .apr small');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(cards.nth(i)).toHaveText(/^fee yield(, trailing 7d| · 24h, annualised)$/);
    }
  });

  test('a pool under 24h old shows an em dash, not a number', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    await page.fill('#q', 'TWINE');
    await page.locator('#main .lb-row .stake-btn').first().click();
    const drawer = page.locator('.drawer');
    await expect(drawer).toHaveClass(/on/);
    // An em dash, and never a figure — with the reason beside it rather than
    // only in a tooltip, which is what §7 asks of an empty state.
    const cell = drawer.locator('.kv .v').first();
    await expect(cell).toContainText('—');
    await expect(cell).toContainText('not enough data yet');
    expect(await cell.innerText()).not.toMatch(/\d/);
    // And it cannot be staked while it is still on its launchpad curve (§4).
    await expect(drawer).toContainText('Not offered for staking');
    await expect(drawer.getByRole('button', { name: 'Stake full range', exact: true })).toBeDisabled();
  });

  test('a pool under 7d old is labelled est. and carries its age', async ({ page }) => {
    // §7, untouched by the change of basis: the liquidity a young pool's
    // yield divides by has as little history as the fees above it.
    await page.goto('/pools', { waitUntil: 'networkidle' });
    await page.fill('#q', 'LAURA');
    await page.locator('#main .lb-row .stake-btn').first().click();
    const drawer = page.locator('.drawer');
    const caption = drawer.locator('.kv .est').first();
    await expect(caption).toContainText('est.');
    await expect(caption).toContainText('1d');
  });

  test('discloses the fee, the custody and the contract address in the drawer before signing', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    await page.fill('#q', 'PONS');
    await page.locator('#main .lb-row .stake-btn').first().click();
    const drawer = page.locator('.drawer');
    // §7: the fee is disclosed here. Under §20 there is none, and that is said.
    await expect(drawer).toContainText('Balast fee');
    await expect(drawer).toContainText('every fee is yours');
    await expect(drawer).toContainText('Lockup');
    await expect(drawer).toContainText('Your wallet, as an NFT');
    await expect(drawer.locator('.ca code')).toContainText('0x');
    // Stake is the builder's real flow, not a toast: it navigates.
    await drawer.getByRole('button', { name: 'Stake full range' }).click();
    await expect(page).toHaveURL(/\/positions\?pool=.*&range=full/);
  });

  test('says out-of-range positions earn nothing, in the row, in red', async ({ page }) => {
    await page.goto('/portfolio', { waitUntil: 'networkidle' });
    const status = page.locator('.pnl-row .down').first();
    await expect(status).toContainText('out of range — earning nothing');
    await expect(status).toHaveCSS('color', 'rgb(255, 92, 103)');
  });

  test('shows price impact on holdings as a negative figure', async ({ page }) => {
    await page.goto('/portfolio', { waitUntil: 'networkidle' });
    const card = page.locator('.stat', { hasText: 'Price impact on holdings' });
    await expect(card.locator('.v')).toContainText('−');
    await expect(card.locator('.v')).toHaveClass(/down/);
  });

  test('states that routed liquidity is permanent', async ({ page }) => {
    await page.goto('/router', { waitUntil: 'networkidle' });
    await expect(page.locator('main')).toContainText('Routed liquidity is permanent');
    await expect(page.locator('main')).toContainText('cannot be withdrawn');
  });

  test('the masthead total agrees with the rows underneath it', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    // Both figures are read in one pass, so a tick cannot land between them.
    const { locked, depths } = await page.evaluate(() => ({
      locked: document.querySelector('.facts [data-fact="tvl"]')!.textContent ?? '',
      depths: Array.from(document.querySelectorAll('#main .lb-row .tok-id .s')).map(
        (el) => el.textContent ?? '',
      ),
    }));
    const scale: Record<string, number> = { '': 1, K: 1e3, M: 1e6, B: 1e9 };
    const money = (m: RegExpExecArray | null) =>
      m ? Number(m[1].replace(/,/g, '')) * scale[m[2] ?? ''] : NaN;
    const top = money(/\$([\d.,]+)([KMB])?/.exec(locked));
    const rows = depths.reduce((sum, t) => sum + money(/liquidity \$([\d.]+)([KMB])?/.exec(t)), 0);
    expect(depths.length).toBeGreaterThan(1);
    // $15.11M in the masthead, eleven rounded depths beneath it — the same
    // number, to within the rounding of the row figures.
    expect(Math.abs(rows - top) / top).toBeLessThan(0.01);
  });
});
