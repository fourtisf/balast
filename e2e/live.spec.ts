import { expect, test } from '@playwright/test';

/** §6: values flash on change, rows reorder with a FLIP transform. */
test.describe('live boards', () => {
  test('values update in place and flash green or red', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });

    const before = await page.locator('#main table tbody td.num').allTextContents();
    const seen = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const directions = new Set<string>();
          const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
              const el = m.target as HTMLElement;
              if (el.classList?.contains('fu')) directions.add('fu');
              if (el.classList?.contains('fd')) directions.add('fd');
            }
          });
          observer.observe(document.querySelector('#main')!, {
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
          });
          setTimeout(() => {
            observer.disconnect();
            resolve([...directions]);
          }, 12_000);
        }),
    );
    const after = await page.locator('#main table tbody td.num').allTextContents();

    expect(after).not.toEqual(before);
    expect(seen.length, 'no value flashed in 12s').toBeGreaterThan(0);
  });

  test('rows animate to a new rank instead of jumping', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });

    // Changing the quote filter reorders the rows deterministically; a tick
    // does it too, but only when ranks happen to cross.
    const transforms = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let count = 0;
          const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
              const el = m.target as HTMLElement;
              if (el.tagName === 'TR' && el.style.transform.includes('translateY')) count++;
            }
          });
          observer.observe(document.querySelector('#main')!, {
            subtree: true,
            attributes: true,
            attributeFilter: ['style'],
          });
          document
            .querySelectorAll('.seg')[0]
            .querySelectorAll('button')[1]
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
          setTimeout(() => {
            observer.disconnect();
            resolve(count);
          }, 1200);
        }),
    );
    expect(transforms, 'rows jumped instead of animating').toBeGreaterThan(0);
  });

  test('row one carries the leader highlight on both boards', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    await expect(page.locator('#main tbody tr.lead')).toHaveCount(2);
  });

  test('Stake appears on row hover and opens the drawer without navigating', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    const button = page.locator('#main tbody tr .stake-btn').first();
    await expect(button).toHaveCSS('opacity', '0');
    await page.locator('#main tbody tr').first().hover();
    await expect(button).toHaveCSS('opacity', '1');
    await button.click();
    await expect(page.locator('.drawer')).toHaveClass(/on/);
    await expect(page).toHaveURL(/\/pools$/);
  });

  test('the indexer lag shows in the top bar when it falls behind', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    // The simulator drops behind head periodically so this state is reachable.
    await expect(page.locator('.lag.behind')).toBeVisible({ timeout: 150_000 });
    await expect(page.locator('.lag.behind')).toContainText(/behind/i);
  });
});
