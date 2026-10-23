#!/usr/bin/env node
/**
 * Serve cheerpx/smoke/ at / and cheerpx-assets/ at /assets/ with what CheerpX
 * needs from a server: the cross-origin-isolation headers (SharedArrayBuffer)
 * and HTTP range requests (the disk image is streamed block by block).
 *
 *   node scripts/serve-cheerpx-smoke.mjs [port]     # default 9020
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = [
  ['/assets/', join(UI, 'cheerpx-assets')],
  ['/', join(UI, 'cheerpx', 'smoke')],
];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.ext2': 'application/octet-stream',
};
const port = Number(process.argv[2] ?? 9020);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const root = ROOTS.find(([prefix]) => pathname.startsWith(prefix));
  const file = root && normalize(join(root[1], pathname.slice(root[0].length)));
  const info = file && file.startsWith(root[1]) ? await stat(file).catch(() => null) : null;
  if (!info?.isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  const headers = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Accept-Ranges': 'bytes',
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    // HttpBytesDevice refuses an image it cannot validate.
    'Last-Modified': info.mtime.toUTCString(),
    ETag: `"${info.size}-${info.mtimeMs}"`,
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${info.size}`,
      'Content-Length': end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': info.size });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`smoke page: http://localhost:${port}/`));
