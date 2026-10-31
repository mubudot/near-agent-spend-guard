import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createClient, DEFAULT_RPC, DEFAULT_ARCHIVAL_RPC } from '../src/near-rpc.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('static bundle uses local assets and direct HTTPS RPC, without server endpoints', async () => {
  const html = read('../index.html');
  const modules = readdirSync(new URL('../src/', import.meta.url));
  const source = modules.map((name) => read(`../src/${name}`)).join('\n');
  assert.match(html, /src="src\/app\.mjs"/);
  assert.match(html, /href="styles\.css"/);
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, 'CSP meta tag present');
  assert.equal(csp[1], "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src https:; base-uri 'none'; form-action 'none'");
  assert.doesNotMatch(source, /(?:server\.mjs|\/api\/|\/rpc\b|\/config\b|node:)/);
  // Browser imports must resolve entirely inside the published src/ directory.
  for (const [, path] of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    assert.ok(path.startsWith('./') && modules.includes(path.slice(2)), path);
  }
  const calls = [];
  const client = createClient({ fetchImpl: async (url, init) => {
    const { method } = JSON.parse(init.body);
    calls.push([url, method]);
    return { json: async () => method === 'status'
      ? { result: { chain_id: 'testnet' } }
      : url === DEFAULT_RPC ? { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } } : { result: { found: true } } };
  } });
  assert.deepEqual(await client.tx('HASH', 'agent.testnet'), { found: true });
  assert.deepEqual(calls, [[DEFAULT_RPC, 'status'], [DEFAULT_RPC, 'tx'], [DEFAULT_ARCHIVAL_RPC, 'tx']]);
  assert.ok(calls.every(([url]) => url.startsWith('https://')));
});

test('recorded dashboard examples match the five full Dashboard video take hashes', () => {
  const take = read('../../docs/TESTNET_RUN.md').split('## Dashboard video take\n')[1].split('\n## ')[0];
  const hashes = [...take.matchAll(/https:\/\/testnet\.nearblocks\.io\/txns\/([A-Za-z0-9]+)/g)].map((m) => m[1]);
  const examples = [...read('../index.html').matchAll(/data-example="([^"]+)">([^<]+)</g)];
  assert.equal(hashes.length, 5);
  assert.deepEqual(examples.map((m) => m[1]), hashes);
  assert.deepEqual(examples.map((m) => m[2]), ['paid', 'held', 'approved', 'not allowlisted', 'over daily cap']);
});
