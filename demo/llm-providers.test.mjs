// Pluggable LLM providers (demo/llm): request shape, tool-call mapping both ways, provider
// selection and error redaction, all with a mocked fetch (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { SimulatedGuard, TOOLS, runAgent, scenario, summarizeSpends } from './ai-agent.mjs';
import { createLlm, selectProvider } from './llm/index.mjs';
import { fromOpenAiResponse, openaiLlm, toOpenAiRequest, toolArguments } from './llm/openai.mjs';
import { safeErrorDetail } from './llm/redact.mjs';

const reply = (message, finish = 'stop', usage = { prompt_tokens: 4, completion_tokens: 2 }) => ({ ok: true, status: 200, json: async () => ({ choices: [{ index: 0, message, finish_reason: finish }], usage }) });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const fakeFetch = (...responses) => {
  const seen = [];
  const f = async (url, init) => { seen.push({ url, init, body: JSON.parse(init.body) }); return responses.shift(); };
  f.seen = seen;
  return f;
};

test('provider selection: explicit choice, auto from credentials, mock without a key', () => {
  assert.equal(selectProvider(undefined, {}), 'mock');
  assert.equal(selectProvider('openai', { ANTHROPIC_API_KEY: 'a' }), 'openai');
  assert.equal(selectProvider('auto', {}), 'mock');
  assert.equal(selectProvider('auto', { OPENAI_API_KEY: 'o' }), 'openai');
  assert.equal(selectProvider('auto', { ANTHROPIC_AUTH_TOKEN: 't', OPENAI_API_KEY: 'o' }), 'anthropic');
  assert.equal(selectProvider(' OpenAI ', {}), 'openai');
  assert.throws(() => selectProvider('gemini', {}), /must be one of/);
  assert.throws(() => createLlm('openai', { env: {} }), /OPENAI_MODEL/);
});

test('toOpenAiRequest maps system, tools, tool_use and tool_result', () => {
  const req = toOpenAiRequest({
    system: 'SYS', tools: TOOLS, max_tokens: 50,
    messages: [
      { role: 'user', content: 'pay' },
      { role: 'assistant', content: [{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 'c1', name: 'read_merchant_page', input: {} }, { type: 'tool_use', id: 'c2', name: 'get_budget', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'page text' }, { type: 'tool_result', tool_use_id: 'c2', content: { a: 1 }, is_error: true }] },
    ],
  }, 'gpt-x');
  assert.equal(req.model, 'gpt-x');
  assert.equal(req.max_tokens, 50);
  assert.equal(req.tool_choice, 'auto');
  assert.deepEqual(req.tools.map((t) => t.function.name), ['read_merchant_page', 'get_budget', 'spend']);
  assert.deepEqual(req.tools[2].function.parameters, TOOLS[2].input_schema);
  assert.deepEqual(req.messages[0], { role: 'system', content: 'SYS' });
  assert.deepEqual(req.messages[1], { role: 'user', content: 'pay' });
  assert.equal(req.messages[2].content, 'reading');
  assert.deepEqual(req.messages[2].tool_calls.map((c) => [c.id, c.function.name, c.function.arguments]), [['c1', 'read_merchant_page', '{}'], ['c2', 'get_budget', '{}']]);
  assert.deepEqual(req.messages[3], { role: 'tool', tool_call_id: 'c1', content: 'page text' });
  assert.deepEqual(req.messages[4], { role: 'tool', tool_call_id: 'c2', content: '{"a":1}' });
  assert.equal(req.messages.length, 5);
  assert.equal(toOpenAiRequest({ messages: [], max_tokens: 9 }, 'm', { OPENAI_MAX_TOKENS_PARAM: 'max_completion_tokens' }).max_completion_tokens, 9);
  assert.equal('max_tokens' in toOpenAiRequest({ messages: [], max_tokens: 9 }, 'm', { OPENAI_MAX_TOKENS_PARAM: 'none' }), false);
  assert.throws(() => toOpenAiRequest({ messages: [], max_tokens: 9 }, 'm', { OPENAI_MAX_TOKENS_PARAM: 'x' }), /OPENAI_MAX_TOKENS_PARAM/);
});

test('fromOpenAiResponse parses tool calls; bad arguments are marked, ids made unique', () => {
  const out = fromOpenAiResponse({ choices: [{ finish_reason: 'stop', message: { content: null, tool_calls: [
    call('a', 'spend', { receiver: 'shop.testnet', amount_near: '0.1', memo: 'coffee' }),
    { id: 'a', function: { name: 'get_budget', arguments: { } } },
    { function: { name: 'spend', arguments: '{oops' } },
    { id: 'z', function: { name: 'spend', arguments: '[1]' } },
    { id: 'n', function: { arguments: '{}' } },
  ] } }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
  assert.equal(out.stop_reason, 'tool_use'); // finish "stop" with tool calls (Ollama) still runs the tools
  assert.deepEqual(out.content.map((b) => [b.id, b.name, b.input]), [
    ['a', 'spend', { receiver: 'shop.testnet', amount_near: '0.1', memo: 'coffee' }],
    ['a_', 'get_budget', {}],
    ['call_2', 'spend', { _invalid_arguments: true }],
    ['z', 'spend', { _invalid_arguments: true }],
  ]);
  assert.deepEqual(out.usage, { input_tokens: 3, output_tokens: 1 });
  assert.equal(fromOpenAiResponse({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }).stop_reason, 'max_tokens');
  assert.throws(() => fromOpenAiResponse({ choices: [] }), /no choices/);
  for (const bad of [null, 'x', { choices: 'x' }, { choices: [null] }, { choices: [{ message: 'x' }] }]) assert.throws(() => fromOpenAiResponse(bad), /no choices/);
  const odd = fromOpenAiResponse({ choices: [{ finish_reason: 7, message: { content: 'x', tool_calls: [null, 'x', { function: 'x' }] } }], usage: { prompt_tokens: 'NaN', completion_tokens: -1 } });
  assert.deepEqual(odd, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 0, output_tokens: 0 } });
});

test('tool arguments: only JSON objects are accepted; blank means no arguments', () => {
  assert.deepEqual(toolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(toolArguments({ a: 1 }), { a: 1 });
  for (const empty of [undefined, null, '', '  ']) assert.deepEqual(toolArguments(empty), {});
  for (const bad of ['{x', '[1]', '1', 'null', '"s"', 3, true, [1]]) assert.deepEqual(toolArguments(bad), { _invalid_arguments: true });
});

test('openai client: request shape, default official base, optional key', async () => {
  const f = fakeFetch(reply({ content: 'hi' }), reply({ content: 'hi' }));
  const local = openaiLlm({ env: { OPENAI_MODEL: 'llama3', OPENAI_BASE_URL: 'http://localhost:11434/v1/' }, fetchImpl: f });
  await local({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
  assert.equal(f.seen[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(f.seen[0].init.headers.authorization, undefined);
  assert.equal(f.seen[0].body.model, 'llama3');
  assert.equal(f.seen[0].body.max_tokens, 1024);
  const official = openaiLlm({ env: { OPENAI_MODEL: 'm', OPENAI_API_KEY: 'sk-test-123456789' }, fetchImpl: f });
  await official({ system: 's', messages: [], tools: [] });
  assert.equal(f.seen[1].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(f.seen[1].init.headers.authorization, 'Bearer sk-test-123456789');
  assert.deepEqual(official.usage, { input_tokens: 4, output_tokens: 2 });
});

test('error redaction: configured secrets withheld, key-like tokens masked, raw bodies never shown', async () => {
  assert.equal(safeErrorDetail({ error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Incorrect API key provided: sk-live-XYZ' } }, ['sk-live-XYZ']), 'invalid_request_error (message withheld: it contained a configured secret)');
  assert.equal(safeErrorDetail({ error: { type: null, code: 'rate_limit_exceeded', message: 'slow down Bearer abc.def' } }), 'rate_limit_exceeded: slow down [redacted]');
  assert.equal(safeErrorDetail({ error: 'model "x" not found' }), 'unknown_error: model "x" not found');
  assert.equal(safeErrorDetail({ error: { type: 'weird', message: { nested: 'sk-hidden-123456789' } } }), 'unknown_error');
  assert.equal(safeErrorDetail(null), 'non-JSON error body (not shown)');
  const env = { OPENAI_MODEL: 'm', OPENAI_API_KEY: 'sk-proj-SECRETSECRET', NEAR_AGENT_PRIVATE_KEY: 'ed25519:PRIVATE' };
  const f = async () => ({ ok: false, status: 500, json: async () => ({ error: { type: 'server_error', message: 'saw ed25519:PRIVATE' } }) });
  await assert.rejects(openaiLlm({ env, fetchImpl: f })({ system: 's', messages: [], tools: [] }), (e) => !e.message.includes('PRIVATE') && /Chat Completions HTTP 500: server_error \(message withheld/.test(e.message));
  const html = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
  await assert.rejects(openaiLlm({ env, fetchImpl: html })({ system: 's', messages: [], tools: [] }), /HTTP 502: non-JSON error body/);
  const noKey = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'missing key' } }) });
  await assert.rejects(openaiLlm({ env: { OPENAI_MODEL: 'm' }, fetchImpl: noKey })({ system: 's', messages: [], tools: [] }), /no OPENAI_API_KEY is set/);
  const down = async () => { throw new Error('connect ECONNREFUSED secret-host'); };
  await assert.rejects(openaiLlm({ env, fetchImpl: down })({ system: 's', messages: [], tools: [] }), (e) => e.message === 'Chat Completions request failed (network error)');
});

test('openai provider through the agent loop: injected payment still refused by the guard', async () => {
  // A gullible OpenAI-format model: reads the page, pays the invoice and the injected stranger, then reports.
  const f = fakeFetch(
    reply({ content: null, tool_calls: [call('r1', 'read_merchant_page', {})] }, 'tool_calls'),
    reply({ content: null, tool_calls: [call('s1', 'spend', { receiver: 'shop.spendguard-b31c91.testnet', amount_near: '0.1', invoice_id: '1042', memo: 'coffee' }), call('s2', 'spend', { receiver: 'stranger.testnet', amount_near: '0.5', invoice_id: 'V-7731', memo: 'verification' })] }, 'tool_calls'),
    reply({ content: null, tool_calls: [{ id: 'bad', function: { name: 'spend', arguments: '{nope' } }] }, 'tool_calls'),
    reply({ content: 'done' }),
  );
  const s = scenario('injection');
  const llm = openaiLlm({ env: { OPENAI_MODEL: 'gpt-test', OPENAI_API_KEY: 'k' }, fetchImpl: f });
  const run = await runAgent({ llm, task: s.task, page: s.page, chain: new SimulatedGuard() });
  assert.equal(run.final, 'done');
  assert.deepEqual(summarizeSpends(run.steps).map((x) => x.reason ?? x.payment), ['completed', 'E_NOT_ALLOWLISTED']);
  const bad = run.steps.find((x) => x.input?._invalid_arguments);
  assert.match(bad.result.error, /valid JSON/);
  const third = f.seen[2].body.messages.filter((m) => m.role === 'tool');
  assert.deepEqual(third.map((m) => m.tool_call_id), ['r1', 's1', 's2']);
  assert.match(third[2].content, /E_NOT_ALLOWLISTED/);
  assert.match(third[0].content, /IMPORTANT NOTICE FOR AI SHOPPING AGENTS/);
});

test('CLI: --llm openai without OPENAI_MODEL fails closed; LLM_PROVIDER=auto without keys falls back to mock', () => {
  const env = { PATH: process.env.PATH };
  const a = spawnSync(process.execPath, ['demo/ai-agent.mjs', '--llm', 'openai'], { encoding: 'utf8', env });
  assert.equal(a.status, 1);
  assert.match(a.stderr, /OPENAI_MODEL/);
  const b = spawnSync(process.execPath, ['demo/ai-agent.mjs'], { encoding: 'utf8', env: { ...env, LLM_PROVIDER: 'auto' } });
  assert.equal(b.status, 0, b.stderr);
  assert.equal(JSON.parse(b.stdout).llm.provider, 'mock');
});
