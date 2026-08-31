(function () {
  const form = document.getElementById('contact-form');
  const status = document.getElementById('form-status');

  const fields = {
    name: { input: document.getElementById('name'), error: document.getElementById('name-error') },
    email: { input: document.getElementById('email'), error: document.getElementById('email-error') },
    message: { input: document.getElementById('message'), error: document.getElementById('message-error') },
  };

  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function setError(field, message) {
    field.error.textContent = message;
    field.input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function validate() {
    let valid = true;

    if (!fields.name.input.value.trim()) {
      setError(fields.name, 'Name is required.');
      valid = false;
    } else {
      setError(fields.name, '');
    }

    const email = fields.email.input.value.trim();
    if (!email) {
      setError(fields.email, 'Email is required.');
      valid = false;
    } else if (!EMAIL_PATTERN.test(email)) {
      setError(fields.email, 'Enter a valid email address.');
      valid = false;
    } else {
      setError(fields.email, '');
    }

    if (fields.message.input.value.trim().length < 10) {
      setError(fields.message, 'Message must be at least 10 characters.');
      valid = false;
    } else {
      setError(fields.message, '');
    }

    return valid;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!validate()) {
      status.textContent = 'Please fix the errors above.';
      status.dataset.state = 'error';
      return;
    }
    status.textContent = 'Thanks! Your message has been sent.';
    status.dataset.state = 'success';
    form.reset();
  });
})();
