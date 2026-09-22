import { expect, test } from '@playwright/test';

test.describe('shape builder', () => {
  test('the bin chart follows shape, range and bin count', async ({ page }) => {
    await page.goto('/positions', { waitUntil: 'networkidle' });
    const bars = page.locator('.bins rect');

    await expect(bars).toHaveCount(24);
    await page.locator('#b-bins').fill('40');
    await expect(bars).toHaveCount(40);

    // Spot is flat; curve is not.
    const heightsOf = async () =>
      page.locator('.bins rect').evaluateAll((els) => els.map((el) => el.getAttribute('height')));
    const spot = await heightsOf();
    expect(new Set(spot).size).toBe(1);

    await page.getByRole('button', { name: 'Curve' }).click();
    const curve = await heightsOf();
    expect(new Set(curve).size).toBeGreaterThan(1);

    await page.locator('#b-max').fill('30');
    await expect(page.locator('.sum .num').first()).not.toHaveText('');
  });

  test('picks a token, then one of its markets', async ({ page }) => {
    // Two questions, asked separately (§26). One flat list of every pool on
    // the chain answered neither: choosing VIRTUAL meant scrolling past
    // TENOV, TISM and TSLA, and its other markets sat elsewhere in the same
    // alphabet rather than in front of you.
    await page.goto('/positions', { waitUntil: 'networkidle' });

    const token = page.locator('#b-token');
    await expect(token).toBeVisible();
    // The token select names tokens, not pairs: no slash in an option.
    const labels = await token.locator('option').allTextContents();
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label).not.toContain('/');

    // And the markets for the chosen one are their own control.
    const markets = page.getByRole('group', { name: 'Market' }).getByRole('button');
    await expect(markets.first()).toBeVisible();
    await expect(markets.first()).toHaveAttribute('aria-pressed', 'true');

    // Switching token keeps exactly one market selected.
    if (labels.length > 1) {
      await token.selectOption({ index: 1 });
      await expect(markets.filter({ has: page.locator('[aria-pressed="true"]') })).toHaveCount(0);
      const pressed = await markets.evaluateAll((els) =>
        els.filter((el) => el.getAttribute('aria-pressed') === 'true').length,
      );
      expect(pressed).toBe(1);
    }
  });

  test('refuses an inverted range instead of drawing nonsense', async ({ page }) => {
    await page.goto('/positions', { waitUntil: 'networkidle' });
    const mint = page.getByRole('button', { name: 'Mint position' });
    await expect(mint).toBeEnabled();

    await page.locator('#b-max').fill('-20');
    await expect(mint).toBeDisabled();
    await expect(page.locator('.builder p[role="alert"]')).toContainText('Max must be above Min');

    await page.locator('#b-max').fill('15');
    await expect(mint).toBeEnabled();
  });

  test('refuses a deposit above the balance', async ({ page }) => {
    await page.goto('/positions', { waitUntil: 'networkidle' });
    await page.locator('#b-amount').fill('999');
    await expect(page.getByRole('button', { name: 'Mint position' })).toBeDisabled();
    await expect(page.locator('.builder p[role="alert"]')).toContainText('above your balance');

    await page.locator('#b-amount').fill('0');
    await expect(page.locator('.builder p[role="alert"]')).toContainText('Enter a deposit amount');
  });

  test('shows the trailing figure the estimate is derived from', async ({ page }) => {
    await page.goto('/positions', { waitUntil: 'networkidle' });
    await expect(page.locator('.sum .est')).toContainText(/est\. · from \d+% trailing/);
  });
});

test.describe('router form', () => {
  test('rejects milestones that are out of order at config time', async ({ page }) => {
    await page.goto('/router', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Market-cap milestones' }).click();

    const enable = page.getByRole('button', { name: 'Enable router' });
    await expect(enable).toBeEnabled();

    await page.locator('#ms-mc-2').fill('1,000,000');
    await expect(enable).toBeDisabled();
    await expect(page.locator('.hint.down')).toContainText('must ascend');

    await page.locator('#ms-mc-2').fill('20,000,000');
    await expect(enable).toBeEnabled();
  });
});

test.describe('search', () => {
  test('filters the boards and shows an empty state', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    await page.fill('#q', 'pons');
    await expect(page.locator('#main .lb-row')).toHaveCount(1);
    await page.fill('#q', 'zzzz');
    await expect(page.locator('.empty')).toHaveCount(1);
  });

  test('filters the stakes page too, as its placeholder promises', async ({ page }) => {
    await page.goto('/stakes', { waitUntil: 'networkidle' });
    const all = await page.locator('.vault').count();
    expect(all).toBeGreaterThan(1);
    await page.fill('#q', 'pons');
    await expect(page.locator('.vault')).toHaveCount(1);
  });

  test('takes you to the listing when the page cannot be filtered', async ({ page }) => {
    await page.goto('/router', { waitUntil: 'networkidle' });
    await page.fill('#q', 'mooncat');
    await expect(page).toHaveURL(/\/pools/);
    await expect(page.locator('#main .lb-row .tok-btn').first()).toContainText('MOONCAT');
  });
});
