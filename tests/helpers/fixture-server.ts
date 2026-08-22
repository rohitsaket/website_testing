/**
 * Test fixture: a deliberately flawed web application on an ephemeral port.
 * Mirrors examples/demo-app but self-contained for deterministic tests.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureServer {
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
}

const INDEX = `<html>
<head>
  <link rel="stylesheet" href="/style.css"/>
</head>
<body>
  <h2>Demo Shop</h2>
  <img src="/logo.png"/>
  <img src="/promo.png" alt="promo"/>
  <form action="/orders" method="post">
    <input type="text" name="email" placeholder="email"/>
    <button type="submit">Buy</button>
  </form>
  <a href="/ok-page">OK</a>
  <a href="/broken-link">Broken</a>
</body>
</html>`;

export async function startFixtureApp(): Promise<FixtureServer> {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/') {
      res.writeHead(200, {
        'content-type': 'text/html',
        server: 'FixtureShop/9.9.9',
        'x-powered-by': 'Fixture',
        'set-cookie': 'sid=xyz; Path=/',
      });
      res.end(INDEX);
      return;
    }
    if (url === '/ok-page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html lang="en"><head><title>OK</title></head><body><h1>OK</h1></body></html>');
      return;
    }
    if (url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (url === '/api/bad-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{invalid,json');
      return;
    }
    if (url === '/api/error') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"boom"}');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Force-close keep-alive sockets from fetch so close() doesn't linger.
        setTimeout(() => {
          server.closeAllConnections();
        }, 25).unref();
      }),
  };
}

export const FIXTURE_AUTH = {
  allowedHosts: ['127.0.0.1', 'localhost'],
  allowPassive: true,
  allowActive: true,
  statement: 'Automated test fixture — self-contained loopback',
};
