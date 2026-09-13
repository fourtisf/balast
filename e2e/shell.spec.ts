import { expect, test } from '@playwright/test';

const ROUTES = ['/pools', '/stakes', '/positions', '/router', '/portfolio'];
const WIDTHS = [1600, 1180, 760, 360];

test.describe('shell', () => {
  test('every route renders without a console error', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    for (const route of ROUTES) {
      await page.goto(route, { waitUntil: 'networkidle' });
      await expect(page.locator('main#main')).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test('/ redirects to the listing', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/pools$/);
  });

  /** §5: a table must never overflow its card, and §11: responsive to 360px. */
  for (const width of WIDTHS) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ROUTES) {
        await page.goto(route, { waitUntil: 'networkidle' });
        const result = await page.evaluate(() => {
          const doc = document.documentElement;
          const spilling: string[] = [];
          document.querySelectorAll('table').forEach((t) => {
            const wrap = t.parentElement;
            if (wrap && t.scrollWidth > wrap.clientWidth + 1) {
              spilling.push(`${t.scrollWidth}>${wrap.clientWidth}`);
            }
          });
          return { page: doc.scrollWidth - doc.clientWidth, spilling };
        });
        expect(result.page, `page scrolls sideways on ${route}`).toBeLessThanOrEqual(1);
        expect(result.spilling, `table overflows its card on ${route}`).toEqual([]);
      }
    });
  }

  test('the rail collapses to icons below 1180px', async ({ page }) => {
    await page.goto('/pools');
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.locator('.rail a', { hasText: 'Pools' }).first()).toBeVisible();
    await page.setViewportSize({ width: 900, height: 900 });
    const railWidth = await page.evaluate(
      () => document.querySelector('.rail')!.getBoundingClientRect().width,
    );
    expect(railWidth).toBeLessThanOrEqual(64);
  });
});
