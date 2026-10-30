// Paid-invoice ledger (demo/invoice-ledger.mjs): one payment per invoice, through the mock and
// both real providers' wire formats (mocked fetch), in memory and persisted across runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MERCHANT, SYSTEM_PROMPT, SimulatedGuard, TOOLS, anthropicLlm, mockLlm, openaiLlm, runAgent, runExitCode, scenario, summarizeSpends } from './ai-agent.mjs';
import { DEFAULT_LEDGER_PATH, InvoiceLedger, ledgerFor, normalizeInvoiceId } from './invoice-ledger.mjs';

const NEAR = 10n ** 24n;
const tmp = () => mkdtempSync(join(tmpdir(), 'spendguard-ledger-'));
const coffee = (invoiceId = '1042') => ({ receiver: DEFAULT_MERCHANT, amount_near: '0.1', invoice_id: invoiceId, memo: 'coffee' });
const counting = (inner = new SimulatedGuard()) => {
  const chain = { calls: [], budget: () => inner.budget(), spend: async (args) => { chain.calls.push(args); return inner.spend(args); } };
  return chain;
};
const sequence = (...replies) => {
  const seen = [];
  const f = async (url, init) => { seen.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => replies.shift() }; };
  f.seen = seen;
  return f;
};

test('invoice ids are normalized; a missing or odd id is refused before any spend', () => {
  for (const raw of ['1042', '#1042', 'Invoice #1042', ' invoice 1042 ']) assert.equal(normalizeInvoiceId(raw), '1042');
  assert.equal(normalizeInvoiceId('INV-2026/07'), 'inv-2026/07');
  for (const bad of [undefined, '', '   ', '#', 'a b', 'x'.repeat(65), '<script>']) assert.throws(() => normalizeInvoiceId(bad), /invoice_id is required/);
});

test('the model is told: invoice_id is required and each invoice is paid at most once', () => {
  const spend = TOOLS.find((t) => t.name === 'spend');
  assert.ok(spend.input_schema.required.includes('invoice_id'));
  assert.match(spend.description, /at most once/);
  assert.match(SYSTEM_PROMPT, /Each invoice is paid at most once/);
});

test('duplicate scenario: the gullible mock pays invoice 1042 twice, the second call is refused before submission', async () => {
  const s = scenario('duplicate');
  const guard = new SimulatedGuard();
  const chain = counting(guard);
  const run = await runAgent({ llm: mockLlm(), task: s.task, page: s.page, chain });
  assert.equal(chain.calls.length, 1);
  assert.equal(chain.calls[0].memo, 'invoice 1042: coffee');
  assert.equal('invoiceId' in chain.calls[0], false); // only the contract's own arguments are submitted
  assert.equal(guard.spent, NEAR / 10n);
  const spends = summarizeSpends(run.steps);
  assert.deepEqual(spends.map((x) => [x.invoice_id, x.payment, x.reason]), [['1042', 'completed', undefined], ['1042', 'refused', 'duplicate_invoice']]);
  assert.match(run.steps.at(-1).result.error, /duplicate payment refused: invoice 1042 .* already paid/);
  assert.match(run.final, /duplicate payment refused/); // the mock saw the tool error
});

test('Anthropic path: the same invoice paid in back-to-back turns (the live smoke) is refused, and the model sees the error', async () => {
  const use = (id, name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 1, output_tokens: 1 } });
  const f = sequence(
    use('t1', 'read_merchant_page', {}),
    use('t2', 'spend', coffee('1042')),
    use('t3', 'spend', coffee('Invoice #1042')), // same invoice, different spelling
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Paid invoice 1042 once.' }], usage: {} },
  );
  const chain = counting();
  const s = scenario('coffee');
  const run = await runAgent({ llm: anthropicLlm({ env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: f }), task: s.task, page: s.page, chain });
  assert.equal(chain.calls.length, 1);
  assert.equal(run.final, 'Paid invoice 1042 once.');
  assert.match(f.seen[0].system, /at most once/);
  const last = f.seen[3].messages.at(-1).content[0];
  assert.equal(last.tool_use_id, 't3');
  assert.equal(last.is_error, true);
  assert.match(last.content, /duplicate payment refused/);
});

test('OpenAI path: two spends for one invoice in a single reply; only the first is submitted', async () => {
  const msg = (message) => ({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] });
  const call = (id, args) => ({ id, type: 'function', function: { name: 'spend', arguments: JSON.stringify(args) } });
  const f = sequence(msg({ content: null, tool_calls: [call('a', coffee('1042')), call('b', coffee('#1042'))] }), msg({ content: 'done' }));
  const chain = counting();
  const run = await runAgent({ llm: openaiLlm({ env: { OPENAI_MODEL: 'm' }, fetchImpl: f }), task: 't', page: '', chain });
  assert.equal(chain.calls.length, 1);
  assert.equal(run.final, 'done');
  const tools = f.seen[1].messages.filter((m) => m.role === 'tool');
  assert.deepEqual(tools.map((m) => m.tool_call_id), ['a', 'b']);
  assert.match(tools[0].content, /completed/);
  assert.match(tools[1].content, /duplicate payment refused/);
  assert.match(f.seen[0].messages[0].content, /at most once/);
});

test('persisted ledger: a second run cannot pay the same invoice; refusals are not recorded; a new invoice still pays', async () => {
  const path = join(tmp(), 'nested', 'paid.json');
  const s = scenario('coffee');
  const first = await runAgent({ llm: mockLlm(), task: s.task, page: s.page, chain: counting(), ledger: new InvoiceLedger({ path }) });
  assert.equal(first.steps.at(-1).result.payment, 'completed');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(Object.values(saved.paid).map((e) => [e.invoice_id, e.payment, e.amount_near]), [['1042', 'completed', '0.1']]);
  const chain = counting();
  const second = await runAgent({ llm: mockLlm(), task: s.task, page: s.page, chain, ledger: new InvoiceLedger({ path }) });
  assert.equal(chain.calls.length, 0);
  assert.equal(summarizeSpends(second.steps)[0].reason, 'duplicate_invoice');
  // Another contract (scope) or another invoice is unaffected; a refusal leaves no record.
  const other = new InvoiceLedger({ path, scope: 'testnet:other.testnet' });
  assert.equal(other.find(DEFAULT_MERCHANT, '1042'), null);
  for (const [receiver, id, payment] of [['stranger.testnet', 'v-7731', 'refused'], [DEFAULT_MERCHANT, '1043', 'failed']]) {
    other.reserve(receiver, id, '0.1');
    other.settle(receiver, id, { payment });
    assert.equal(new InvoiceLedger({ path, scope: other.scope }).find(receiver, id), null); // released
  }
});

test('the reservation is on disk before the transaction is sent; ledger write failures never submit and exit 1', async () => {
  const dir = tmp();
  const path = join(dir, 'paid.json');
  let seenOnDisk = null;
  const chain = { budget: async () => ({}), spend: async () => { seenOnDisk = new InvoiceLedger({ path }).find(DEFAULT_MERCHANT, '1042')?.payment; return { payment: 'completed', transaction: 'TX1' }; } };
  const s = scenario('coffee');
  await runAgent({ llm: mockLlm(), task: s.task, page: s.page, chain, ledger: new InvoiceLedger({ path }) });
  assert.equal(seenOnDisk, 'submitting');
  const done = new InvoiceLedger({ path }).find(DEFAULT_MERCHANT, '1042');
  assert.deepEqual([done.payment, done.transaction], ['completed', 'TX1']);
  // Reservation cannot be written (the ledger's parent is a file): nothing is submitted.
  writeFileSync(join(dir, 'file'), 'x');
  const blocked = counting();
  const unwritable = new InvoiceLedger({ path: join(dir, 'fresh.json') });
  unwritable.path = join(dir, 'file', 'paid.json');
  const r1 = await runAgent({ llm: mockLlm(), task: s.task, page: s.page, chain: blocked, ledger: unwritable });
  assert.equal(blocked.calls.length, 0);
  assert.match(r1.stopped, /nothing was submitted/);
  assert.equal(runExitCode(summarizeSpends(r1.steps), r1), 1);
  // Paid, then the update fails: the run stops with exit 1 and the on-disk record still blocks.
  const p2 = join(dir, 'paid2.json');
  const ledger = new InvoiceLedger({ path: p2 });
  const chain2 = { budget: async () => ({}), spend: async () => { ledger.path = join(dir, 'file', 'x.json'); return { payment: 'completed' }; } };
  const r2 = await runAgent({ llm: mockLlm(), task: s.task, page: s.page, chain: chain2, ledger });
  assert.match(r2.stopped, /stays blocked as "submitting"/);
  assert.equal(runExitCode(summarizeSpends(r2.steps), r2), 1);
  assert.equal(new InvoiceLedger({ path: p2 }).find(DEFAULT_MERCHANT, '1042').payment, 'submitting');
});

test('an unknown submission outcome blocks the invoice; a damaged ledger fails closed', async () => {
  const dir = tmp();
  const path = join(dir, 'paid.json');
  const chain = { budget: async () => ({}), spend: async () => { throw new Error('RPC timeout'); } };
  const llm = async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'spend', input: coffee() }] });
  const run = await runAgent({ llm, task: 't', page: '', chain, ledger: new InvoiceLedger({ path }) });
  assert.match(run.stopped, /outcome unknown/);
  assert.equal(new InvoiceLedger({ path }).find(DEFAULT_MERCHANT, '1042').payment, 'unknown');
  const record = (e) => JSON.stringify({ version: 1, paid: { k: e } });
  for (const bad of ['{nope', '[]', '{"version":2,"paid":{}}', '{"version":1,"paid":[]}', record(null), record({ receiver: 'a', invoice_id: '1', payment: 'refused' }), record({ invoice_id: '1', payment: 'completed' }),
    JSON.stringify({ version: 1, paid: { [`simulated|${DEFAULT_MERCHANT}|1043`]: { receiver: DEFAULT_MERCHANT, invoice_id: '1042', payment: 'completed' } } })]) { // misfiled record
    writeFileSync(path, bad);
    assert.throws(() => new InvoiceLedger({ path }), /fix or move AI_AGENT_LEDGER/);
  }
  assert.throws(() => new InvoiceLedger({ path: dir }), /cannot read the paid-invoice ledger \(EISDIR\)/);
});

test('ledger location: persisted by default only for --submit; AI_AGENT_LEDGER overrides', () => {
  assert.equal(ledgerFor({ submit: false, env: {} }).path, null);
  const live = ledgerFor({ submit: true, env: { NEAR_CONTRACT_ACCOUNT: 'g.testnet' } });
  assert.equal(live.path, DEFAULT_LEDGER_PATH);
  assert.equal(live.scope, 'testnet:g.testnet');
  assert.equal(ledgerFor({ submit: true, env: { AI_AGENT_LEDGER: 'memory' } }).path, null);
  const path = join(tmp(), 'x.json');
  assert.equal(ledgerFor({ submit: false, env: { AI_AGENT_LEDGER: path } }).path, path);
});

test('CLI: --scenario duplicate shows the refusal (exit 0); AI_AGENT_LEDGER persists across runs', () => {
  const env = { PATH: process.env.PATH };
  const run = (args, extra = {}) => spawnSync(process.execPath, ['demo/ai-agent.mjs', ...args], { encoding: 'utf8', env: { ...env, ...extra } });
  const d = run(['--scenario', 'duplicate']);
  assert.equal(d.status, 0, d.stderr);
  assert.deepEqual(JSON.parse(d.stdout).spends.map((x) => x.reason ?? x.payment), ['completed', 'duplicate_invoice']);
  const AI_AGENT_LEDGER = join(tmp(), 'paid.json');
  assert.equal(JSON.parse(run(['--scenario', 'coffee'], { AI_AGENT_LEDGER }).stdout).spends[0].payment, 'completed');
  const again = run(['--scenario', 'coffee'], { AI_AGENT_LEDGER });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).spends.map((x) => x.reason), ['duplicate_invoice']);
  writeFileSync(AI_AGENT_LEDGER, 'garbage');
  const broken = run(['--scenario', 'coffee'], { AI_AGENT_LEDGER });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /fix or move AI_AGENT_LEDGER/);
});
