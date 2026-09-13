import { expect, test } from '@playwright/test';

/** §11: visible keyboard focus everywhere, drawer traps focus, Escape closes. */
test.describe('keyboard and motion', () => {
  test('the drawer traps focus, closes on Escape and restores focus', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    const opener = page.locator('#main tbody tr .stake-btn').first();
    await opener.click();

    const drawer = page.locator('.drawer');
    await expect(drawer).toHaveClass(/on/);
    await expect(drawer).toHaveAttribute('aria-modal', 'true');

    expect(await page.evaluate(() => document.querySelector('.drawer')!.contains(document.activeElement))).toBe(true);

    // Tab all the way round; focus must never escape the drawer.
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() => document.querySelector('.drawer')!.contains(document.activeElement)),
        `focus left the drawer after ${i + 1} tabs`,
      ).toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.querySelector('.drawer')!.contains(document.activeElement))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(drawer).not.toHaveClass(/on/);
    await expect(opener).toBeFocused();
  });

  test('every tab stop shows a focus indicator', async ({ page }) => {
    for (const route of ['/pools', '/positions', '/router']) {
      await page.goto(route, { waitUntil: 'networkidle' });
      const invisible: string[] = [];
      for (let i = 0; i < 22; i++) {
        await page.keyboard.press('Tab');
        // Controls transition over 150ms, so let the outline settle.
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const style = getComputedStyle(el);
          const wrapper = el.closest('.inp, .search');
          return {
            id: `${el.tagName}.${el.className}`,
            outline: style.outlineWidth,
            // Inputs inside a field are indicated by the field's own ring.
            ring: wrapper ? getComputedStyle(wrapper).boxShadow !== 'none' : false,
          };
        });
        if (state && state.outline === '0px' && !state.ring) invisible.push(state.id);
      }
      expect(invisible, `${route} has tab stops with no focus indicator`).toEqual([]);
    }
  });

  test('every pool row is reachable by keyboard, including on a phone', async ({ page }) => {
    // The Stake button sits in a column that is hidden below 640px, so the
    // token cell has to be the keyboard path.
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/pools', { waitUntil: 'networkidle' });
    const tokenButton = page.locator('#main tbody tr .tok-btn').first();
    await tokenButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.drawer')).toHaveClass(/on/);
  });

  test('the fee heatmap exposes its values to a screen reader', async ({ page }) => {
    await page.goto('/portfolio', { waitUntil: 'networkidle' });
    const table = page.locator('.sr-only table');
    await expect(table).toHaveCount(1);
    await expect(table.locator('td')).toHaveCount(56);
    await expect(page.locator('.cal')).toHaveAttribute('aria-hidden', 'true');
  });

  test.describe('reduced motion', () => {
    test('disables the flash and the FLIP, not the data updates', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/pools', { waitUntil: 'networkidle' });
      const board = page.locator('#main table tbody').first();
      const before = await board.innerText();

      const observed = await page.evaluate(
        () =>
          new Promise<{ flash: number; transforms: number }>((resolve) => {
            const out = { flash: 0, transforms: 0 };
            const observer = new MutationObserver((mutations) => {
              for (const m of mutations) {
                const el = m.target as HTMLElement;
                if (m.attributeName === 'class' && (el.classList?.contains('fu') || el.classList?.contains('fd'))) out.flash++;
                if (m.attributeName === 'style' && el.tagName === 'TR' && el.style.transform.includes('translateY')) out.transforms++;
              }
            });
            observer.observe(document.querySelector('#main')!, {
              subtree: true,
              attributes: true,
              attributeFilter: ['class', 'style'],
            });
            setTimeout(() => {
              observer.disconnect();
              resolve(out);
            }, 20_000);
          }),
      );
      const after = await board.innerText();

      expect(observed.flash, 'flashed under prefers-reduced-motion').toBe(0);
      expect(observed.transforms, 'transformed under prefers-reduced-motion').toBe(0);
      expect(after, 'data stopped updating under prefers-reduced-motion').not.toEqual(before);
    });
  });
});
