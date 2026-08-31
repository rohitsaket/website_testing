import { type Locator, type Page } from '@playwright/test';

/** Page Object for the demo contact form. */
export class ContactPage {
  readonly page: Page;
  readonly name: Locator;
  readonly email: Locator;
  readonly topic: Locator;
  readonly message: Locator;
  readonly submit: Locator;
  readonly status: Locator;

  constructor(page: Page) {
    this.page = page;
    this.name = page.getByLabel('Name');
    this.email = page.getByLabel('Email');
    this.topic = page.getByLabel('Topic');
    this.message = page.getByLabel('Message');
    this.submit = page.getByRole('button', { name: 'Send message' });
    this.status = page.locator('#form-status');
  }

  async goto() {
    await this.page.goto('/contact.html');
  }

  async submitForm(values: { name: string; email: string; message: string; topic?: string }) {
    await this.name.fill(values.name);
    await this.email.fill(values.email);
    if (values.topic) await this.topic.selectOption(values.topic);
    await this.message.fill(values.message);
    await this.submit.click();
  }

  errorFor(field: 'Name' | 'Email' | 'Message') {
    return this.page.locator(`#${field.toLowerCase()}-error`);
  }
}
