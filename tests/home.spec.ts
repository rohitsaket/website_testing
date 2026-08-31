import { expect, test } from '@playwright/test';
import { HomePage } from './pages/home.page';

test.describe('home page', () => {
  test('renders the hero heading and empty state', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ship websites you trust');
    await expect(home.emptyMessage).toBeVisible();
    await expect(home.todoItems).toHaveCount(0);
  });

  test('adds, completes and deletes a task', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();

    await home.addTask('Write e2e tests');
    await expect(home.todoItems).toHaveCount(1);
    await expect(home.emptyMessage).toBeHidden();

    await home.completeTask(0);
    await expect(home.todoItems.first()).toHaveClass(/done/);

    await home.deleteTask(0);
    await expect(home.todoItems).toHaveCount(0);
    await expect(home.emptyMessage).toBeVisible();
  });

  test('ignores empty submissions', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();

    await home.addButton.click();
    await expect(home.todoItems).toHaveCount(0);
  });

  test('persists tasks across a reload', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await home.addTask('Survive a refresh');

    await page.reload();

    await expect(home.todoItems).toHaveCount(1);
    await expect(home.todoItems.first()).toContainText('Survive a refresh');
  });

  test('counter increments on each click', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await expect(home.counterOutput).toHaveText('0');

    await home.counterButton.click();
    await home.counterButton.click();

    await expect(home.counterOutput).toHaveText('2');
  });
});
