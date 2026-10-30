// Pluggable language models for demo/ai-agent.mjs. An llm is `async ({ system, messages, tools })
// -> { stop_reason, content }` in the Anthropic Messages shape; providers own the wire format.
//
//   mock       deterministic, offline, deliberately gullible (default; stands in for a compromised model)
//   anthropic  Anthropic Messages API: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY | ANTHROPIC_AUTH_TOKEN, AI_AGENT_MODEL
//   openai     OpenAI-compatible Chat Completions: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
//   auto       anthropic if an Anthropic credential is set, else openai if OPENAI_API_KEY is set, else mock
//
// Whatever the model says, `spend` still goes through the restricted key to the guard contract.
import { anthropicLlm } from './anthropic.mjs';
import { mockLlm } from './mock.mjs';
import { openaiLlm } from './openai.mjs';

export { anthropicLlm, mockLlm, openaiLlm };
export const LLM_CHOICES = ['mock', 'anthropic', 'openai', 'auto'];

export function selectProvider(choice, env = process.env) {
  const c = String(choice ?? 'mock').trim().toLowerCase();
  if (!LLM_CHOICES.includes(c)) throw new Error(`LLM provider must be one of ${LLM_CHOICES.join(', ')}, got ${JSON.stringify(String(choice))}`);
  if (c !== 'auto') return c;
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  return 'mock';
}

export function createLlm(provider, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (provider === 'anthropic') return anthropicLlm({ env, fetchImpl });
  if (provider === 'openai') return openaiLlm({ env, fetchImpl });
  if (provider === 'mock') return mockLlm();
  throw new Error(`unknown LLM provider ${JSON.stringify(String(provider))}`);
}
