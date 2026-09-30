import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { build } from 'vite';

const base = '/trailmaker-app/';
const port = Number(process.env.TRAILMAKER_PAGES_PORT ?? 4177);
process.env.TRAILMAKER_BASE = base;
await build({ mode: 'test', base });

const root = resolve('dist');
const mime: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname;
  if (!pathname.startsWith(base)) {
    response.writeHead(404).end('Not found');
    return;
  }
  const relativePath = decodeURIComponent(pathname.slice(base.length));
  let filePath = resolve(root, relativePath || 'index.html');
  if (!filePath.startsWith(`${root}${sep}`) && filePath !== resolve(root, 'index.html')) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    if ((await stat(filePath)).isDirectory()) {
      filePath = resolve(filePath, 'index.html');
      await stat(filePath);
    }
    const contentType = mime[extname(filePath)] ?? 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': contentType });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.listen(port, '127.0.0.1');
