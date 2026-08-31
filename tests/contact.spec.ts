import { expect, test } from '@playwright/test';
import { ContactPage } from './pages/contact.page';

test.describe('contact form', () => {
  test.beforeEach(async ({ page }) => {
    await new ContactPage(page).goto();
  });

  test('shows validation errors when required fields are blank', async ({ page }) => {
    const contact = new ContactPage(page);
    await contact.submit.click();

    await expect(contact.errorFor('Name')).toHaveText('Name is required.');
    await expect(contact.errorFor('Email')).toHaveText('Email is required.');
    await expect(contact.errorFor('Message')).toHaveText('Message must be at least 10 characters.');
    await expect(contact.status).toHaveAttribute('data-state', 'error');
  });

  test('rejects a malformed email address', async ({ page }) => {
    const contact = new ContactPage(page);
    await contact.submitForm({
      name: 'Ada Lovelace',
      email: 'not-an-email',
      message: 'I would like to know more about your widgets.',
    });

    await expect(contact.errorFor('Email')).toHaveText('Enter a valid email address.');
    await expect(contact.status).toHaveText('Please fix the errors above.');
  });

  test('accepts a complete submission', async ({ page }) => {
    const contact = new ContactPage(page);
    await contact.submitForm({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      topic: 'support',
      message: 'Please help me configure the widget pipeline.',
    });

    await expect(contact.status).toHaveText('Thanks! Your message has been sent.');
    await expect(contact.status).toHaveAttribute('data-state', 'success');
    await expect(contact.name).toBeEmpty();
    await expect(contact.email).toBeEmpty();
  });

  test('marks invalid inputs as aria-invalid for assistive tech', async ({ page }) => {
    const contact = new ContactPage(page);
    await contact.submit.click();

    await expect(contact.name).toHaveAttribute('aria-invalid', 'true');
    await expect(contact.email).toHaveAttribute('aria-invalid', 'true');
  });
});
