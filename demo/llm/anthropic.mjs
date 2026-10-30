// Anthropic Messages API provider: POST {ANTHROPIC_BASE_URL}/v1/messages with tool use.
// The agent loop already speaks this format, so the provider is a thin HTTP call.
import { configuredSecrets, postJson } from './redact.mjs';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';

export function anthropicLlm({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const base = (env.ANTHROPIC_BASE_URL || ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (env.ANTHROPIC_API_KEY) headers['x-api-key'] = env.ANTHROPIC_API_KEY;
  else if (env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`;
  else throw new Error('Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for --llm anthropic (or use the default --llm mock)');
  const model = env.AI_AGENT_MODEL || ANTHROPIC_DEFAULT_MODEL;
  const secrets = configuredSecrets(env);
  const llm = async ({ system, messages, tools }) => {
    const body = await postJson(fetchImpl, `${base}/v1/messages`, headers, { model, max_tokens: 1024, system, tools, messages }, { label: 'Messages API', secrets });
    llm.usage.input_tokens += body.usage?.input_tokens ?? 0;
    llm.usage.output_tokens += body.usage?.output_tokens ?? 0;
    return { stop_reason: body.stop_reason, content: Array.isArray(body.content) ? body.content : [] };
  };
  llm.provider = 'anthropic';
  llm.model = model;
  llm.usage = { input_tokens: 0, output_tokens: 0 };
  return llm;
}
