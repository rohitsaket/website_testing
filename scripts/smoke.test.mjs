import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;

/** Minimal request helper that does NOT normalise the path, so traversal can be tested. */
function request(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', rejectPromise);
    req.end();
  });
}

async function waitForServer(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await request('/');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start in time');
}

let server;

test.before(async () => {
  server = spawn('node', ['server/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  await waitForServer();
});

test.after(() => server?.kill());

test('home page returns 200 with expected content', async () => {
  const res = await request('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /Ship websites you trust/);
});

test('about and contact pages return 200', async () => {
  for (const path of ['/about.html', '/contact.html']) {
    const res = await request(path);
    assert.equal(res.status, 200, `${path} should be 200`);
    assert.match(res.body, /Acme Widgets/);
  }
});

test('static assets are served with the right content type', async () => {
  const css = await request('/styles.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);

  const js = await request('/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
});

test('unknown paths return a 404 page', async () => {
  const res = await request('/does-not-exist.html');
  assert.equal(res.status, 404);
  assert.match(res.body, /404/);
});

test('path traversal cannot escape the site root', async () => {
  const res = await request('/../package.json');
  assert.notEqual(res.status, 200);
  assert.doesNotMatch(res.body, /@playwright\/test/);
});
