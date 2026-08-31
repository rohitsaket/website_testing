import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', 'demo-site');
const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const relative = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(ROOT, relative);

  // Prefix check must be separator-aware so `/demo-site-backup` can never match `/demo-site`.
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404 &mdash; Not Found</h1><p><a href="/">Back home</a></p>');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`demo site listening on http://${HOST}:${PORT}`);
});
