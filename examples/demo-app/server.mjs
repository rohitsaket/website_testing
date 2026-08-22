/**
 * WTE demo target — a deliberately flawed web app used to validate that the
 * platform DETECTS what it should (missing headers, a11y issues, broken link,
 * slow endpoint, invalid-JSON API). Zero dependencies, Node ≥ 20.
 *
 *   node examples/demo-app/server.mjs [port]
 */
import { createServer } from 'node:http';

const port = parseInt(process.argv[2] ?? '9090', 10);

const INDEX = `<html><!-- flaw: no doctype, no lang -->
<head>
  <!-- flaw: no title, no meta description, no charset -->
  <meta property="og:image" content="/banner.png"/>
  <link rel="stylesheet" href="/style.css"/>
</head>
<body>
  <h2>Demo Shop</h2><!-- flaw: no h1 -->
  <img src="/logo.png"/>
  <img src="/promo.png" alt="Spring promotion banner"/>
  <form action="/orders" method="post">
    <input type="text" name="email" placeholder="you@example.com"/>
    <input type="hidden" name="csrf" value="abc"/>
    <button type="submit">Place order</button>
  </form>
  <a href="/catalog"></a>
  <a href="/missing-page">Discontinued item</a>
  <script src="/app.js"></script>
</body>
</html>`;

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  if (url === '/') {
    res.writeHead(200, {
      'content-type': 'text/html',
      'server': 'DemoShop/1.4.2', // flaw: version disclosure
      'x-powered-by': 'DemoShop Engine', // flaw: tech disclosure
      'set-cookie': 'session=deadbeef; Path=/', // flaw: no HttpOnly/Secure/SameSite
    });
    res.end(INDEX);
    return;
  }
  if (url === '/catalog') {
    res.writeHead(200, { 'content-type': 'text/html', 'server': 'DemoShop/1.4.2' });
    res.end('<!doctype html><html lang="en"><head><title>Catalog</title></head><body><h1>Catalog</h1></body></html>');
    return;
  }
  if (url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }
  if (url === '/api/broken') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{ not valid json ,,'); // flaw: invalid JSON advertised as JSON
    return;
  }
  if (url === '/slow') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><title>Slow</title></head><body>slow</body></html>');
    }, 1500); // flaw: slow endpoint
    return;
  }
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><head><title>404</title></head><body>not found</body></html>');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`demo app listening on http://localhost:${port}`);
});
