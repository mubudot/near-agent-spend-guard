#!/usr/bin/env node
// Zero-dependency static server for the dashboard: `npm run dashboard` → http://127.0.0.1:5173
// Serves only files inside web/, binds to loopback, sends a strict CSP. No keys, no proxying.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
};
const SERVED = new Set(Object.keys(TYPES));
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Map a URL path to a file under root, or null (outside root, hidden, tests, or unknown type).
export function resolvePath(root, urlPath) {
  let path;
  try { path = decodeURIComponent(new URL(urlPath, 'http://x').pathname); } catch { return null; }
  if (path.includes('\0')) return null;
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(root, path));
  if (!file.startsWith(root + sep)) return null;
  const rel = file.slice(root.length + 1);
  if (rel.split(sep).some((p) => p.startsWith('.')) || rel.startsWith(`test${sep}`) || rel === 'server.mjs') return null;
  return SERVED.has(extname(file)) ? file : null;
}

export function createDashboardServer(root = ROOT) {
  return createServer(async (req, res) => {
    const headers = { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers).end(); return; }
    const file = resolvePath(root, req.url ?? '/');
    try {
      if (!file || !(await stat(file)).isFile()) throw new Error('not found');
      const body = await readFile(file);
      res.writeHead(200, { ...headers, 'content-type': TYPES[extname(file)] });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 5173);
  const host = process.env.HOST ?? '127.0.0.1';
  createDashboardServer().listen(port, host, () => {
    console.log(`Agent Spend Guard dashboard (read-only, NEAR testnet): http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`);
  });
}
