import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Page Object for the demo home page.
 * Locators live here so tests read as behaviour, not selectors.
 */
export class HomePage {
  readonly page: Page;
  readonly todoInput: Locator;
  readonly addButton: Locator;
  readonly todoItems: Locator;
  readonly emptyMessage: Locator;
  readonly counterButton: Locator;
  readonly counterOutput: Locator;

  constructor(page: Page) {
    this.page = page;
    this.todoInput = page.getByLabel('Add a task');
    this.addButton = page.getByRole('button', { name: 'Add' });
    this.todoItems = page.getByTestId('todo-item');
    this.emptyMessage = page.getByText('No tasks yet.');
    this.counterButton = page.getByRole('button', { name: 'Increment' });
    this.counterOutput = page.locator('#count');
  }

  async goto() {
    await this.page.goto('/');
    await expect(this.page.getByRole('heading', { level: 1 })).toBeVisible();
  }

  async addTask(text: string) {
    await this.todoInput.fill(text);
    await this.addButton.click();
  }

  async completeTask(index = 0) {
    await this.todoItems.nth(index).getByTestId('todo-toggle').click();
  }

  async deleteTask(index = 0) {
    await this.todoItems.nth(index).getByTestId('todo-delete').click();
  }
}
