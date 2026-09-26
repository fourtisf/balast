import { expect, test } from '@playwright/test';

/**
 * Ask LockFi AI. The simulated site has no API, so the assistant's two
 * routes are answered here: once as switched off, once as on.
 */
test.describe('Ask LockFi AI', () => {
  // The simulator has no API, so the panel is only asked about with the preview switch on.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('lockfi:ask', 'on'));
  });

  test('is not offered while the assistant is off', async ({ page }) => {
    await page.route('**/api/ask', (route) =>
      route.fulfill({ json: { enabled: false, provider: '' } }),
    );
    await page.goto('/pools');
    await page.locator('#main .lb-row .stake-btn').first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('button', { name: 'Stake full range' })).toBeVisible();
    await expect(drawer.getByTestId('ask-panel')).toHaveCount(0);
  });

  test('does not ask about the assistant on simulated data without the switch', async ({ browser }) => {
    const page = await browser.newPage();
    let asked = 0;
    await page.route('**/api/ask', (route) => {
      asked++;
      return route.fulfill({ json: { enabled: true, provider: 'Dualyne' } });
    });
    await page.goto('/positions', { waitUntil: 'networkidle' });
    expect(asked).toBe(0);
    await expect(page.getByTestId('ask-panel')).toHaveCount(0);
    await page.close();
  });

  test('answers a suggested question about the pool in the drawer', async ({ page }) => {
    const asked: { question: string; poolId: string | null }[] = [];
    await page.route('**/api/ask', async (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ json: { enabled: true, provider: 'Dualyne' } });
      }
      asked.push(route.request().postDataJSON());
      return route.fulfill({ json: { answer: 'Every swap in this pool pays its fee tier to LPs.', poolFound: true } });
    });
    await page.goto('/pools');
    await page.locator('#main .lb-row .stake-btn').first().click();
    const panel = page.getByRole('dialog').getByTestId('ask-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('via Dualyne');
    await expect(panel).toContainText('never predicts prices');

    await panel.getByRole('button', { name: 'What does this fee tier mean?' }).click();
    await expect(panel).toContainText('Every swap in this pool pays its fee tier to LPs.');
    expect(asked).toHaveLength(1);
    expect(asked[0].question).toBe('What does this fee tier mean?');
    expect(asked[0].poolId).toBeTruthy();

    // A follow-up carries the conversation, typed and sent with Enter.
    await panel.getByLabel('Your question').fill('And the risks?');
    await panel.getByLabel('Your question').press('Enter');
    await expect.poll(() => asked.length).toBe(2);
    expect((asked[1] as unknown as { history: unknown[] }).history).toHaveLength(2);
  });

  test('sends the builder’s plan with the question', async ({ page }) => {
    let body: Record<string, unknown> | null = null;
    await page.route('**/api/ask', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { enabled: true, provider: 'Dualyne' } });
      body = route.request().postDataJSON();
      return route.fulfill({ json: { answer: 'Curve puts more at the price.', poolFound: true } });
    });
    await page.goto('/positions');
    const panel = page.getByTestId('ask-panel');
    await panel.getByRole('button', { name: /shape do to my fees/ }).click();
    await expect(panel).toContainText('Curve puts more at the price.');
    expect(body).not.toBeNull();
    const plan = (body as unknown as { plan: { shape: string; bins: number } }).plan;
    expect(plan.shape).toBe('spot');
    expect(plan.bins).toBeGreaterThan(0);
  });

  test('says why when the assistant cannot answer, and keeps the question', async ({ page }) => {
    await page.route('**/api/ask', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { enabled: true, provider: 'Dualyne' } });
      return route.fulfill({ status: 429, json: { error: 'limit', message: 'The assistant has answered as many questions as it can today.' } });
    });
    await page.goto('/learn');
    const panel = page.getByTestId('ask-panel');
    await panel.getByLabel('Your question').fill('Are my funds safe?');
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('as many questions as it can today');
    await expect(panel.getByLabel('Your question')).toHaveValue('Are my funds safe?');
  });
});
