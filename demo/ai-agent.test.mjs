import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { DEFAULT_MERCHANT, SimulatedGuard, TOOLS, anthropicLlm, mockLlm, parseCli, runAgent, runExitCode, scenario, spendArgs, summarizeSpends, toNear } from './ai-agent.mjs';
import { isSpendOnlyKey } from './agent-key.mjs';

const NEAR = 10n ** 24n;
const cleanEnv = () => ({ PATH: process.env.PATH });

test('mock LLM on the honest page pays only the invoice', async () => {
  const s = scenario('coffee');
  const run = await runAgent({ llm: mockLlm(), task: s.task, page: s.page, chain: new SimulatedGuard() });
  const spends = run.steps.filter((x) => x.tool === 'spend');
  assert.equal(spends.length, 1);
  assert.deepEqual(spends[0].input, { receiver: DEFAULT_MERCHANT, amount_near: '0.1', invoice_id: '1042', memo: 'coffee' });
  assert.equal(spends[0].result.payment, 'completed');
  assert.match(run.final, /mock LLM/);
});

test('prompt injection: the gullible mock obeys, the guard refuses the stranger and holds the large amount', async () => {
  const s = scenario('injection');
  const guard = new SimulatedGuard();
  const run = await runAgent({ llm: mockLlm(), task: s.task, page: s.page, chain: guard });
  const spends = run.steps.filter((x) => x.tool === 'spend').map((x) => [x.input.receiver, x.input.amount_near, x.result.payment, x.result.reason]);
  assert.deepEqual(spends, [
    [DEFAULT_MERCHANT, '0.1', 'completed', undefined],
    ['stranger.testnet', '0.5', 'refused', 'E_NOT_ALLOWLISTED'],
    [DEFAULT_MERCHANT, '0.9', 'awaiting_owner_approval', undefined],
  ]);
  assert.equal(guard.spent, 1n * NEAR); // 0.1 paid + 0.9 reserved; the stranger got nothing
});

test('prompt injection with budget already used: the over-budget payment is refused E_DAILY', async () => {
  const s = scenario('injection');
  const run = await runAgent({ llm: mockLlm(), task: s.task, page: s.page, chain: new SimulatedGuard({ spentToday: (6n * NEAR / 10n).toString() }) });
  const outcome = run.steps.filter((x) => x.tool === 'spend').map((x) => x.result.reason ?? x.result.payment);
  assert.deepEqual(outcome, ['completed', 'E_NOT_ALLOWLISTED', 'E_DAILY']);
});

test('simulated guard mirrors the contract check order', async () => {
  const g = new SimulatedGuard();
  const s = (receiver, near) => g.spend({ receiver, amount: (BigInt(Math.round(near * 10)) * NEAR / 10n).toString() });
  assert.equal((await s('stranger.testnet', 5)).reason, 'E_NOT_ALLOWLISTED'); // allowlist before per-tx
  assert.equal((await s(DEFAULT_MERCHANT, 1.1)).reason, 'E_PER_TX');
  assert.equal((await s(DEFAULT_MERCHANT, 0.2)).payment, 'completed'); // threshold is inclusive
  assert.equal((await s(DEFAULT_MERCHANT, 0.3)).payment, 'awaiting_owner_approval');
  assert.equal((await s(DEFAULT_MERCHANT, 0.8)).reason, 'E_DAILY'); // 0.5 + 0.8 > 1.2, pending counted
  assert.equal((await s(DEFAULT_MERCHANT, 0.7)).payment, 'awaiting_owner_approval'); // exactly 1.2
});

test('spend arguments: exact amounts; malformed input never reaches the chain', async () => {
  assert.deepEqual(spendArgs({ receiver: 'a.testnet', amount_near: '0.000000000000000000000001', invoice_id: 'Invoice #A-1', memo: 'x' }), { receiver: 'a.testnet', amount: '1', memo: 'invoice a-1: x', invoiceId: 'a-1' });
  assert.throws(() => spendArgs({ receiver: 'a.testnet', amount_near: '1', memo: 'x' }), /invoice_id is required/);
  const long = Buffer.byteLength(spendArgs({ receiver: 'a.testnet', amount_near: '1', invoice_id: '1', memo: '\u20ac'.repeat(200) }).memo);
  assert.ok(long <= 256 && long > 250, String(long)); // contract MAX_MEMO is bytes; no split character
  assert.throws(() => spendArgs({ receiver: 'shop.near', amount_near: '1', memo: 'x' }), /testnet/);
  assert.throws(() => spendArgs({ receiver: 'a.testnet', amount_near: '1e3', memo: 'x' }), /decimal/);
  assert.throws(() => spendArgs({ receiver: 'a.testnet', amount_near: '-1', memo: 'x' }), /decimal/);
  let calls = 0;
  const chain = { spend: async () => { calls += 1; return {}; }, budget: async () => ({}) };
  const llm = async ({ messages }) => (messages.length === 1
    ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'spend', input: { receiver: 'shop.near', amount_near: '1', memo: 'x' } }] }
    : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] });
  const run = await runAgent({ llm, task: 't', page: '', chain });
  assert.equal(calls, 0);
  assert.equal(run.steps[0].error, true);
  assert.equal(run.final, 'done');
});

test('agent loop caps spend calls and turns', async () => {
  let i = 0;
  const llm = async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${(i += 1)}`, name: 'spend', input: { receiver: DEFAULT_MERCHANT, amount_near: '0.01', invoice_id: `L${i}`, memo: 'loop' } }] });
  const run = await runAgent({ llm, task: 't', page: '', chain: new SimulatedGuard(), maxTurns: 6, maxSpends: 4 });
  assert.equal(run.steps.filter((x) => !x.error).length, 4);
  assert.match(run.steps[4].result.error, /spend limit/);
  assert.match(run.stopped, /turn limit/);
});

test('simulated guard: E_PAUSED before E_AMOUNT before E_NOT_ALLOWLISTED', async () => {
  const g = new SimulatedGuard();
  assert.equal((await g.spend({ receiver: 'stranger.testnet', amount: '0' })).reason, 'E_AMOUNT');
  g.policy.paused = true;
  assert.equal((await g.spend({ receiver: 'stranger.testnet', amount: '0' })).reason, 'E_PAUSED');
});

test('a failed spend submission stops the run (no retry) and exits 2 with the outcome marked unknown', async () => {
  let calls = 0;
  const chain = { budget: async () => ({}), spend: async () => { calls += 1; throw new Error('RPC timeout'); } };
  const llm = async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${calls}`, name: 'spend', input: { receiver: DEFAULT_MERCHANT, amount_near: '0.1', invoice_id: '1042', memo: 'x' } }] });
  const run = await runAgent({ llm, task: 't', page: '', chain });
  assert.equal(calls, 1);
  assert.equal(run.steps[0].submit_error, true);
  assert.match(run.stopped, /outcome unknown/);
  const spends = summarizeSpends(run.steps);
  assert.deepEqual(spends.map((x) => x.payment), ['unknown']);
  assert.equal(runExitCode(spends, run), 2);
});

for (const payment of ['failed', 'unknown']) {
  test(`a ${payment} payout stops the run before any further spend and exits 2`, async () => {
    let calls = 0;
    const chain = { budget: async () => ({}), spend: async () => { calls += 1; return { payment, transaction: `tx${calls}` }; } };
    const llm = async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${calls}`, name: 'spend', input: { receiver: DEFAULT_MERCHANT, amount_near: '0.1', invoice_id: `10${calls}`, memo: 'x' } }] });
    const run = await runAgent({ llm, task: 't', page: '', chain });
    assert.equal(calls, 1);
    assert.match(run.stopped, new RegExp(`payout ${payment}`));
    const spends = summarizeSpends(run.steps);
    assert.deepEqual(spends.map((x) => x.payment), [payment]);
    assert.equal(runExitCode(spends, run), 2);
  });
}

test('an LLM failure after a payment keeps the payment in the result', async () => {
  let n = 0;
  const llm = async () => {
    n += 1;
    if (n === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'spend', input: { receiver: DEFAULT_MERCHANT, amount_near: '0.1', invoice_id: '1042', memo: 'x' } }] };
    throw new Error('LLM request failed: HTTP 529');
  };
  const run = await runAgent({ llm, task: 't', page: '', chain: new SimulatedGuard() });
  assert.equal(run.steps[0].result.payment, 'completed');
  assert.equal(run.llm_error, true);
  assert.match(run.stopped, /HTTP 529/);
  assert.equal(runExitCode(summarizeSpends(run.steps), run), 1);
  assert.equal(runExitCode([{ payment: 'refused' }, { payment: 'awaiting_owner_approval' }], {}), 0);
  assert.equal(runExitCode([{ payment: 'failed' }], {}), 2);
});

test('only spend can move money; tools are read-only otherwise', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['read_merchant_page', 'get_budget', 'spend']);
});

test('anthropic client: env credentials, base URL override, no secret in errors', async () => {
  assert.throws(() => anthropicLlm({ env: {} }), /ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN/);
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 2 } }) }; };
  const llm = anthropicLlm({ env: { ANTHROPIC_AUTH_TOKEN: 'tok-secret', ANTHROPIC_BASE_URL: 'http://localhost:8080/' }, fetchImpl });
  const r = await llm({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
  assert.equal(r.content[0].text, 'hi');
  assert.equal(seen[0].url, 'http://localhost:8080/v1/messages');
  assert.equal(seen[0].init.headers.authorization, 'Bearer tok-secret');
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.deepEqual(llm.usage, { input_tokens: 5, output_tokens: 2 });
  const key = anthropicLlm({ env: { ANTHROPIC_API_KEY: 'key-secret' }, fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: false, status: 401, json: async () => ({ error: { type: 'authentication_error', message: 'bad key-secret' } }) }; } });
  await assert.rejects(key({ system: 's', messages: [], tools: [] }), (e) => !e.message.includes('key-secret') && /HTTP 401: authentication_error \(message withheld/.test(e.message));
  assert.equal(seen[1].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[1].init.headers['x-api-key'], 'key-secret');
});

test('CLI parsing', () => {
  assert.deepEqual(parseCli([]), { scenario: null, task: null, llm: null, submit: false });
  assert.deepEqual(parseCli(['--scenario', 'coffee', '--submit']), { scenario: 'coffee', task: null, llm: null, submit: true });
  assert.equal(parseCli(['--llm', 'openai']).llm, 'openai');
  assert.throws(() => parseCli(['--llm', 'gpt']), /mock, anthropic, openai, auto/);
  assert.throws(() => parseCli(['--scenario', 'coffee', '--task', 'x']), /not both/);
  assert.throws(() => parseCli(['--bogus']), /Unknown argument/);
  assert.throws(() => scenario('nope'), /Unknown scenario/);
  assert.equal(toNear('900000000000000000000000'), '0.9');
  assert.equal(toNear(2n * NEAR), '2');
});

test('CLI runs offline without any key and shows the injected payment refused', () => {
  const r = spawnSync(process.execPath, ['demo/ai-agent.mjs', '--scenario', 'injection'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.mode, 'offline-simulated-guard');
  assert.deepEqual(out.spends.map((x) => x.reason ?? x.payment), ['completed', 'E_NOT_ALLOWLISTED', 'awaiting_owner_approval']);
});

test('CLI: --llm anthropic without credentials and --submit without NEAR env fail closed (exit 1)', () => {
  const a = spawnSync(process.execPath, ['demo/ai-agent.mjs', '--llm', 'anthropic'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(a.status, 1);
  assert.match(a.stderr, /ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN/);
  const b = spawnSync(process.execPath, ['demo/ai-agent.mjs', '--submit'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(b.status, 1);
  assert.match(b.stderr, /NEAR_AGENT_ACCOUNT is not set/);
});

test('agent key check accepts only a spend-only function-call key with finite allowance', () => {
  const k = (fc) => ({ access_key: { permission: fc === null ? 'FullAccess' : { FunctionCall: fc } } });
  assert.equal(isSpendOnlyKey(k({ receiver_id: 'g.testnet', method_names: ['spend'], allowance: '1' }), 'g.testnet'), true);
  assert.equal(isSpendOnlyKey(k(null), 'g.testnet'), false);
  assert.equal(isSpendOnlyKey(k({ receiver_id: 'g.testnet', method_names: [], allowance: '1' }), 'g.testnet'), false); // [] = any method
  assert.equal(isSpendOnlyKey(k({ receiver_id: 'g.testnet', method_names: ['spend', 'withdraw'], allowance: '1' }), 'g.testnet'), false);
  assert.equal(isSpendOnlyKey(k({ receiver_id: 'g.testnet', method_names: ['spend'], allowance: null }), 'g.testnet'), false);
  assert.equal(isSpendOnlyKey(k({ receiver_id: 'x.testnet', method_names: ['spend'], allowance: '1' }), 'g.testnet'), false);
});

test('the repository names LLM credentials only by environment variable; only official default hosts', () => {
  const files = ['demo/ai-agent.mjs', ...readdirSync('demo/llm').filter((f) => f.endsWith('.mjs')).map((f) => `demo/llm/${f}`)];
  const hosts = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(hosts)].sort(), ['api.anthropic.com', 'api.openai.com']);
});

test('interrupted runs exit 1: turn limit, truncated or empty reply; a payout failure still exits 2', async () => {
  let i = 0;
  const looping = async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${(i += 1)}`, name: 'get_budget', input: {} }] });
  const limited = await runAgent({ llm: looping, task: 't', page: '', chain: new SimulatedGuard(), maxTurns: 2 });
  assert.equal(runExitCode(summarizeSpends(limited.steps), limited), 1);
  const truncated = await runAgent({ llm: async () => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'I will now pay' }] }), task: 't', page: '', chain: new SimulatedGuard() });
  assert.match(truncated.stopped, /truncated/);
  assert.equal(runExitCode([], truncated), 1);
  const empty = await runAgent({ llm: async () => ({ stop_reason: 'end_turn', content: [] }), task: 't', page: '', chain: new SimulatedGuard() });
  assert.match(empty.stopped, /empty/);
  assert.equal(runExitCode([{ payment: 'failed' }], limited), 2);
  const done = await runAgent({ llm: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }), task: 't', page: '', chain: new SimulatedGuard() });
  assert.equal(done.stopped, undefined);
  assert.equal(runExitCode([], done), 0);
});

test('spend amount must be a decimal string: a JSON number (already float-rounded) is refused', () => {
  assert.throws(() => spendArgs({ receiver: 'a.testnet', amount_near: 0.100000000000000005, invoice_id: '1', memo: 'x' }), /decimal string/);
  assert.throws(() => spendArgs({ receiver: 'a.testnet', amount_near: 1, invoice_id: '1', memo: 'x' }), /decimal string/);
  assert.equal(spendArgs({ receiver: 'a.testnet', amount_near: '0.100000000000000005', invoice_id: '1', memo: 'x' }).amount, '100000000000000005000000');
});
