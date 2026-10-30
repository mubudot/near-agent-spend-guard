// Dashboard logic tests: formatting, view model, transaction outcomes (real testnet fixtures),
// the read-only RPC client (mocked fetch) and the static server's path handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatNear, percent, relativeTime, nextUtcMidnight, isTestnetAccount, isTxHash, isAccountId, shortHash, nsToMs,
} from '../src/format.mjs';
import { dashboardModel, describeEvent, summarizeTx, parseTxList, budget, agentStatus, summarizeKeys, refusalCode, isProvisional, latestOnly } from '../src/model.mjs';
import { createClient, loadSnapshot, findTx, RpcError } from '../src/near-rpc.mjs';
import { createDashboardServer, resolvePath, ROOT } from '../server.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
const CONTRACT = 'guard.spendguard-b31c91.testnet';
const AGENT = 'agent.spendguard-b31c91.testnet';
const SHOP = 'shop.spendguard-b31c91.testnet';
const NEAR = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 18n).toString();

test('formatNear is exact, truncates and keeps dust visible', () => {
  assert.equal(formatNear('1200000000000000000000000'), '1.2 NEAR');
  assert.equal(formatNear('0'), '0 NEAR');
  assert.equal(formatNear('999999999999999999999999'), '0.9999 NEAR');
  assert.equal(formatNear('1'), '<0.0001 NEAR');
  assert.equal(formatNear(10n ** 24n * 5n, { unit: false }), '5');
  assert.equal(formatNear('340282366920938463463374607431768211455').startsWith('340282366920938'), true);
});

test('percent clamps and works on bigints', () => {
  assert.equal(percent(NEAR(0.6), NEAR(1.2)), 50);
  assert.equal(percent(NEAR(2), NEAR(1.2)), 100);
  assert.equal(percent('0', '0'), 0);
  assert.equal(percent('5', '0'), 100);
});

test('relative time and UTC reset', () => {
  const now = Date.UTC(2026, 9, 30, 21, 30);
  assert.equal(relativeTime(now + 2.5 * 3600_000, now), 'in 2h 30m');
  assert.equal(relativeTime(now - 4 * 60_000, now), '4m ago');
  assert.equal(relativeTime(now + 10_000, now), 'just now');
  assert.equal(relativeTime(now - 26 * 3600_000, now), '1d 2h ago');
  assert.equal(nextUtcMidnight(now), Date.UTC(2026, 9, 31));
  assert.equal(nsToMs('1793319797100706189'), 1793319797100);
});

test('validators accept testnet ids and tx hashes only', () => {
  assert.ok(isTestnetAccount(CONTRACT));
  assert.ok(!isTestnetAccount('guard.near'));
  assert.ok(!isTestnetAccount('Guard.testnet'));
  assert.ok(!isAccountId('a'));
  assert.ok(isTxHash('CMpUbeReZQauURBwByaUZ5xcDpCzxVbvcg6LP8tUwUrJ'));
  assert.ok(!isTxHash('0OIl' + 'x'.repeat(40)));
  assert.equal(shortHash('CMpUbeReZQauURBwByaUZ5xcDpCzxVbvcg6LP8tUwUrJ'), 'CMpUbeRe…');
});

test('budget, status and key summaries', () => {
  const policy = { per_tx_max: NEAR(1), daily_max: NEAR(1.2), approval_threshold: NEAR(0.2), allowlist: [SHOP], paused: false };
  assert.deepEqual(budget(policy, NEAR(0.6)), { spent: NEAR(0.6), cap: NEAR(1.2), left: NEAR(0.6), pct: 50, tone: 'ok' });
  assert.equal(budget(policy, NEAR(0.9)).tone, 'warn');
  assert.equal(budget(policy, NEAR(1.2)).tone, 'bad');
  assert.equal(budget(policy, NEAR(1.3)).left, '0');
  assert.equal(agentStatus(false, policy).label, 'Active');
  assert.equal(agentStatus(true, policy).label, 'Paused (guard)');
  assert.equal(agentStatus(false, { ...policy, paused: true }).label, 'Agent paused');
  assert.equal(agentStatus(false, null).label, 'Not registered');
  const keys = summarizeKeys([
    { public_key: 'ed25519:A', access_key: { permission: 'FullAccess' } },
    { public_key: 'ed25519:B', access_key: { permission: { FunctionCall: { receiver_id: CONTRACT, method_names: ['spend'], allowance: NEAR(0.9975) } } } },
    { public_key: 'ed25519:C', access_key: { permission: { FunctionCall: { receiver_id: 'other.testnet', method_names: [], allowance: null } } } },
  ], CONTRACT);
  assert.equal(keys.fullAccess, 1);
  assert.equal(keys.other, 1);
  assert.deepEqual(keys.spendOnly, [{ publicKey: 'ed25519:B', methods: ['spend'], allowance: '0.9975 NEAR', onlySpend: true, finiteAllowance: true }]);
  const broad = summarizeKeys([
    { public_key: 'ed25519:D', access_key: { permission: { FunctionCall: { receiver_id: CONTRACT, method_names: [], allowance: null } } } },
    { public_key: 'ed25519:E', access_key: { permission: { FunctionCall: { receiver_id: CONTRACT, method_names: ['spend', 'approve'], allowance: '1' } } } },
  ], CONTRACT);
  assert.deepEqual(broad.spendOnly.map((k) => [k.onlySpend, k.finiteAllowance, k.allowance]), [[false, false, 'unlimited'], [false, true, '<0.0001 NEAR']]);
});

test('dashboardModel: pending for this agent, events newest first, owner commands', () => {
  const now = Date.UTC(2026, 9, 30, 1, 0);
  const ns = (ms) => `${BigInt(ms) * 1_000_000n}`;
  const model = dashboardModel({
    contract: CONTRACT, agent: AGENT, owner: 'spendguard-b31c91.testnet', paused: false,
    policy: { per_tx_max: NEAR(1), daily_max: NEAR(1.2), approval_threshold: NEAR(0.2), allowlist: [SHOP], paused: false },
    spentToday: NEAR(0.6), balance: NEAR(1.95),
    pending: [
      { id: '4', agent: AGENT, receiver: SHOP, amount: NEAR(0.5), memo: 'monthly API credits', created_at: ns(now - 60_000), expires_at: ns(Date.UTC(2026, 9, 31)) },
      { id: '9', agent: 'other.testnet', receiver: SHOP, amount: NEAR(0.3), memo: 'x', created_at: ns(now), expires_at: ns(now - 1) },
    ],
    audit: [
      { id: '7', timestamp: ns(now - 120_000), event: 'spend_requested', data: { agent: AGENT, amount: NEAR(0.1), id: '3', memo: 'coffee', receiver: SHOP } },
      { id: '10', timestamp: ns(now - 60_000), event: 'pending', data: { agent: AGENT, amount: NEAR(0.5), request_id: '4' } },
      { id: '8', timestamp: ns(now - 110_000), event: 'transfer_succeeded', data: { agent: AGENT, amount: NEAR(0.1), transfer_id: '3' } },
    ],
    keys: null,
  }, now);
  assert.equal(model.status.label, 'Active');
  assert.equal(model.policy.threshold, '0.2 NEAR');
  assert.equal(model.budget.pct, 50);
  assert.equal(model.balance, '1.95 NEAR');
  assert.equal(model.pending.length, 1);
  assert.equal(model.otherPending, 1);
  assert.equal(model.pending[0].expired, false);
  assert.equal(model.pending[0].approveCmd, `NEAR_CONTRACT_ACCOUNT=${CONTRACT} node demo/owner.mjs approve 4`);
  assert.deepEqual(model.events.map((e) => e.id), ['10', '8', '7']);
  assert.equal(model.events[2].summary, `0.1 NEAR → ${SHOP} “coffee” #3`);
  assert.equal(model.events[0].tone, 'warn');
  assert.equal(model.actionable, 1);

  // After midnight the same request is retained by the contract but can no longer be approved.
  const later = dashboardModel({ contract: CONTRACT, agent: AGENT, pending: [
    { id: '4', agent: AGENT, receiver: SHOP, amount: NEAR(0.5), memo: 'm', created_at: ns(now), expires_at: ns(now + 1000) },
  ] }, now + 2000);
  assert.equal(later.pending[0].expired, true);
  assert.equal(later.actionable, 0);
  assert.match(later.pending[0].expireCmd, /expire\(\{"request_id": "4"\}\)/);
});

test('describeEvent handles unknown events and agent-only data', () => {
  const e = describeEvent({ id: '1', timestamp: '0', event: 'agent_added', data: { agent: AGENT } });
  assert.equal(e.label, 'Agent added');
  assert.equal(e.summary, AGENT);
  assert.equal(describeEvent({ id: '2', timestamp: '0', event: 'future_event', data: {} }).tone, 'neutral');
});

test('summarizeTx on real testnet transactions', () => {
  const refused = summarizeTx(fixture('refused_not_allowlisted'), CONTRACT);
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.code, 'E_NOT_ALLOWLISTED');
  assert.equal(refused.args.receiver, 'stranger.testnet');
  assert.equal(refused.events.length, 0);

  const daily = summarizeTx(fixture('refused_daily'), CONTRACT);
  assert.equal(daily.code, 'E_DAILY');
  assert.match(daily.reason, /daily cap/);

  const paid = summarizeTx(fixture('completed'), CONTRACT);
  assert.equal(paid.outcome, 'completed');
  assert.equal(paid.signer, AGENT);
  assert.deepEqual(paid.events.map((e) => e.event), ['spend_requested', 'transfer_succeeded']);

  const held = summarizeTx(fixture('pending'), CONTRACT);
  assert.equal(held.outcome, 'awaiting_owner_approval');
  assert.equal(held.requestId, '4');

  const approved = summarizeTx(fixture('approve'), CONTRACT);
  assert.equal(approved.method, 'approve');
  assert.equal(approved.outcome, 'completed');
  assert.equal(approved.signer, 'spendguard-b31c91.testnet');
});

test('summarizeTx: unexecuted, payout failed and reject without event are not reported as done', () => {
  const pending = fixture('completed');
  const unknown = { ...structuredClone(pending), status: { NotStarted: null } };
  const u = summarizeTx(unknown, CONTRACT);
  assert.equal(u.outcome, 'unconfirmed');
  assert.ok(isProvisional(u));

  const failedPayout = structuredClone(pending);
  for (const r of failedPayout.receipts_outcome) r.outcome.logs = r.outcome.logs.map((l) => l.replaceAll('transfer_succeeded', 'transfer_failed'));
  const f = summarizeTx(failedPayout, CONTRACT);
  assert.equal(f.outcome, 'payout_failed');
  assert.equal(f.tone, 'bad');
  assert.ok(!isProvisional(f));

  const inflight = structuredClone(pending);
  for (const r of inflight.receipts_outcome) r.outcome.logs = r.outcome.logs.filter((l) => !l.includes('transfer_succeeded'));
  assert.ok(isProvisional(summarizeTx(inflight, CONTRACT)));

  const reject = structuredClone(fixture('approve'));
  reject.transaction.actions[0].FunctionCall.method_name = 'reject';
  for (const r of reject.receipts_outcome) r.outcome.logs = [];
  assert.equal(summarizeTx(reject, CONTRACT).outcome, 'success');
});

test('latestOnly lets only the newest request publish', () => {
  const l = latestOnly();
  const a = l.next();
  const b = l.next();
  assert.ok(!l.isCurrent(a));
  assert.ok(l.isCurrent(b));
});

test('summarizeTx ignores events logged by other contracts', () => {
  const tx = fixture('completed');
  const forged = structuredClone(tx);
  for (const r of forged.receipts_outcome) if (r.outcome.executor_id === CONTRACT) r.outcome.logs = [];
  forged.receipts_outcome.push({ id: 'x', outcome: { executor_id: 'evil.testnet', status: { SuccessValue: '' }, logs: tx.receipts_outcome.flatMap((r) => r.outcome.logs) } });
  assert.equal(summarizeTx(forged, CONTRACT).outcome, 'in_flight');
});

test('refusalCode and parseTxList', () => {
  assert.equal(refusalCode('Smart contract panicked: panicked at src/lib.rs:282:9:\\nE_NOT_ALLOWLISTED'), 'E_NOT_ALLOWLISTED');
  assert.equal(refusalCode('no code'), null);
  const h = 'CMpUbeReZQauURBwByaUZ5xcDpCzxVbvcg6LP8tUwUrJ';
  assert.deepEqual(parseTxList(`${h}, ${h} bad ${h.slice(1)}x@spendguard-b31c91.testnet  zz@Bad`, isTxHash, isAccountId),
    [{ hash: h, sender: null }, { hash: `${h.slice(1)}x`, sender: 'spendguard-b31c91.testnet' }]);
});

function mockFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, ...body });
    const out = await handler(url, body);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, ...out }) };
  };
  return { impl, calls };
}
const bytes = (value) => [...new TextEncoder().encode(JSON.stringify(value))];

test('loadSnapshot reads every value at one final block and refuses non-testnet RPCs', async () => {
  const views = { get_owner: 'spendguard-b31c91.testnet', is_paused: false, get_policy: null, get_spent_today: '0', list_pending: [], get_audit: [] };
  const { impl, calls } = mockFetch(async (_url, { method, params }) => {
    if (method === 'status') return { result: { chain_id: 'testnet' } };
    if (method === 'block') return { result: { header: { hash: 'BLOCK', height: 42, timestamp_nanosec: '1' } } };
    if (params.request_type === 'call_function') return { result: { result: bytes(views[params.method_name]) } };
    if (params.request_type === 'view_account') return { result: { amount: NEAR(2) } };
    return { error: { cause: { name: 'UNKNOWN_ACCOUNT' } } };
  });
  const snap = await loadSnapshot(createClient({ fetchImpl: impl }), { contract: CONTRACT, agent: AGENT });
  assert.equal(snap.owner, 'spendguard-b31c91.testnet');
  assert.equal(snap.keys, null); // key list failure is tolerated
  assert.equal(snap.block.height, 42);
  const queries = calls.filter((c) => c.method === 'query');
  assert.ok(queries.length >= 8 && queries.every((c) => c.params.block_id === 'BLOCK' && !('finality' in c.params)));
  const audit = queries.find((c) => c.params.method_name === 'get_audit');
  assert.deepEqual(JSON.parse(atob(audit.params.args_base64)), { from: '0', limit: 128 });

  const mainnet = mockFetch(async () => ({ result: { chain_id: 'mainnet' } }));
  await assert.rejects(loadSnapshot(createClient({ fetchImpl: mainnet.impl }), { contract: CONTRACT, agent: AGENT }), /expected "testnet"/);
});

test('rpc client: https only, error causes, archival fallback, sender retry', async () => {
  assert.throws(() => createClient({ url: 'http://rpc.example' }), /https/);
  const { impl, calls } = mockFetch(async (url, { method, params }) => {
    if (method === 'status') return { result: { chain_id: 'testnet' } };
    if (url.includes('archival') && params.sender_account_id === 'spendguard-b31c91.testnet') return { result: { ok: true } };
    return { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } };
  });
  const client = createClient({ fetchImpl: impl, url: 'https://rpc.example', archivalUrl: 'https://archival.example' });
  await assert.rejects(client.call('tx', {}), (e) => e instanceof RpcError && e.cause === 'UNKNOWN_TRANSACTION');
  const found = await findTx(client, 'HASH', [null, AGENT, 'spendguard-b31c91.testnet', AGENT]);
  assert.deepEqual(found, { ok: true });
  assert.deepEqual(calls.filter((c) => c.method === 'tx' && c.params.sender_account_id).map((c) => `${c.url}|${c.params.sender_account_id}`), [
    `https://rpc.example|${AGENT}`, `https://archival.example|${AGENT}`,
    'https://rpc.example|spendguard-b31c91.testnet', 'https://archival.example|spendguard-b31c91.testnet',
  ]);
  assert.equal(calls.filter((c) => c.method === 'status').length, 1); // verified once per client

  // A non-testnet RPC never gets a transaction lookup (also covers ?tx= preloads).
  const mainnet = mockFetch(async (_url, { method }) => (method === 'status' ? { result: { chain_id: 'mainnet' } } : { result: { ok: true } }));
  const wrong = createClient({ fetchImpl: mainnet.impl, url: 'https://rpc.example' });
  await assert.rejects(findTx(wrong, 'HASH', [AGENT]), /expected "testnet"/);
  assert.deepEqual(mainnet.calls.map((c) => c.method), ['status']);

  const down = createClient({ url: 'https://rpc.example', fetchImpl: async () => { throw new TypeError('fail'); } });
  await assert.rejects(down.call('status', []), /network error/);
  const html = createClient({ url: 'https://rpc.example', fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } }) });
  await assert.rejects(html.call('status', []), /HTTP 502/);
});

test('static server: serves the app with CSP, never files outside web/ or tests', async () => {
  assert.equal(resolvePath(ROOT, '/'), join(ROOT, 'index.html'));
  assert.equal(resolvePath(ROOT, '/src/app.mjs'), join(ROOT, 'src', 'app.mjs'));
  for (const bad of ['/../package.json', '/%2e%2e/package.json', '/..%2f..%2fREADME.md', '/test/dashboard.test.mjs', '/server.mjs', '/test/fixtures/pending.json', '/.env', '/%00']) {
    assert.equal(resolvePath(ROOT, bad), null, bad);
  }
  const server = createDashboardServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await index.text(), /Agent Spend Guard/);
    assert.equal((await fetch(`${base}/src/model.mjs`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  } finally {
    server.close();
  }
  assert.equal(resolve(ROOT), ROOT);
});
