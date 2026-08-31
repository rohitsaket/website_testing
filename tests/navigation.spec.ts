import { expect, test } from '@playwright/test';

test.describe('navigation', () => {
  test('moves between pages and marks the current page', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('link', { name: 'About' }).click();
    await expect(page).toHaveURL(/\/about\.html$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('About us');
    await expect(page.getByRole('link', { name: 'About', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await page.getByRole('link', { name: 'Contact' }).click();
    await expect(page).toHaveURL(/\/contact\.html$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Contact us');

    await page.getByRole('link', { name: 'Home' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ship websites you trust');
  });

  test('serves a 404 for unknown pages', async ({ page }) => {
    const response = await page.goto('/does-not-exist.html');

    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('404');
  });

  test('keeps every page titled and free of console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    for (const path of ['/', '/about.html', '/contact.html']) {
      await page.goto(path);
      await expect(page).toHaveTitle(/Acme Widgets/);
    }

    expect(consoleErrors).toEqual([]);
  });
});
