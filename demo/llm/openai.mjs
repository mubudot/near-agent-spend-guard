// OpenAI-compatible Chat Completions provider with function calling: OpenAI, OpenRouter,
// DeepSeek, vLLM, Ollama or any gateway serving POST {OPENAI_BASE_URL}/chat/completions.
// The agent loop keeps Anthropic-shaped messages; toOpenAiRequest / fromOpenAiResponse
// translate at the HTTP boundary, so tool calls and results map one-to-one and the same
// tools (and the guard contract behind `spend`) apply to both providers.
import { configuredSecrets, postJson } from './redact.mjs';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MAX_TOKENS_PARAMS = new Set(['max_tokens', 'max_completion_tokens', 'none']);

const textOf = (blocks) => blocks.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n');

export function toOpenAiRequest({ system, messages = [], tools = [], max_tokens: maxTokens }, model, env = {}) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    const text = textOf(blocks);
    if (m.role === 'assistant') {
      const calls = blocks.filter((b) => b?.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of blocks) {
        if (b?.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
      }
      if (text) out.push({ role: 'user', content: text });
    }
  }
  const req = { model, messages: out };
  if (tools.length) {
    req.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object' } } }));
    req.tool_choice = 'auto';
  }
  if (maxTokens) {
    const field = (env.OPENAI_MAX_TOKENS_PARAM || 'max_tokens').trim();
    if (!MAX_TOKENS_PARAMS.has(field)) throw new Error('OPENAI_MAX_TOKENS_PARAM must be max_tokens, max_completion_tokens or none');
    if (field !== 'none') req[field] = maxTokens;
  }
  return req;
}

const FINISH = { stop: 'end_turn', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const tokens = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

// A JSON object (or a string decoding to one) is the input; a missing or blank value is a
// no-argument call ({}). Anything else (invalid JSON, a list, a number ...) is marked
// { _invalid_arguments: true }, which the agent loop refuses before any tool runs.
export function toolArguments(raw) {
  if (isObject(raw)) return raw; // some servers (Ollama) send an object, not a JSON string
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (isObject(parsed)) return parsed;
    } catch { /* fall through */ }
  }
  return { _invalid_arguments: true };
}

export function fromOpenAiResponse(body) {
  const choice = Array.isArray(body?.choices) && isObject(body.choices[0]) ? body.choices[0] : null;
  const msg = choice?.message;
  if (!isObject(msg)) throw new Error('LLM request failed: Chat Completions response has no choices[0].message');
  const content = [];
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  const seen = new Set();
  (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).forEach((tc, i) => {
    const name = isObject(tc) && isObject(tc.function) ? tc.function.name : undefined;
    if (typeof name !== 'string' || !name) return;
    let id = typeof tc.id === 'string' && tc.id ? tc.id : `call_${i}`;
    while (seen.has(id)) id += '_'; // ids must be unique so every result maps back to its call
    seen.add(id);
    content.push({ type: 'tool_use', id, name, input: toolArguments(tc.function.arguments) });
  });
  const finish = choice.finish_reason;
  const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : (FINISH[finish ?? 'stop'] ?? (typeof finish === 'string' ? finish : 'end_turn'));
  const usage = isObject(body.usage) ? body.usage : {};
  return { stop_reason: stop, content, usage: { input_tokens: tokens(usage.prompt_tokens), output_tokens: tokens(usage.completion_tokens) } };
}

export function openaiLlm({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const base = (env.OPENAI_BASE_URL || OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = env.OPENAI_MODEL;
  if (!model) throw new Error('Set OPENAI_MODEL for --llm openai (the model id your endpoint serves)');
  const headers = { 'content-type': 'application/json' };
  if (env.OPENAI_API_KEY) headers.authorization = `Bearer ${env.OPENAI_API_KEY}`; // optional for local servers
  const secrets = configuredSecrets(env);
  const missingKeyHint = env.OPENAI_API_KEY ? '' : 'no OPENAI_API_KEY is set (or use the default --llm mock)';
  const llm = async ({ system, messages, tools }) => {
    const req = toOpenAiRequest({ system, messages, tools, max_tokens: 1024 }, model, env);
    const body = await postJson(fetchImpl, `${base}/chat/completions`, headers, req, { label: 'Chat Completions', secrets, missingKeyHint });
    const out = fromOpenAiResponse(body);
    llm.usage.input_tokens += out.usage.input_tokens;
    llm.usage.output_tokens += out.usage.output_tokens;
    return { stop_reason: out.stop_reason, content: out.content };
  };
  llm.provider = 'openai';
  llm.model = model;
  llm.usage = { input_tokens: 0, output_tokens: 0 };
  return llm;
}
