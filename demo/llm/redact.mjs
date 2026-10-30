// What an upstream LLM error may show: only a known error type and a short message, never the
// raw body (a gateway may echo headers or keys there). A message that contains any configured
// secret is withheld entirely; otherwise key-like tokens are masked. Same rules as the sibling
// PayPal project (app/llm/errors.py).

const SECRETISH = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|[A-Za-z0-9_-]{40,})/g;
export const ERROR_TYPES = new Set([
  // Anthropic Messages API
  'invalid_request_error', 'authentication_error', 'billing_error', 'permission_error', 'not_found_error',
  'request_too_large', 'rate_limit_error', 'timeout_error', 'api_error', 'overloaded_error',
  // OpenAI-compatible servers (OpenAI, OpenRouter, vLLM, Ollama ...)
  'server_error', 'insufficient_quota', 'rate_limit_exceeded', 'invalid_api_key', 'model_not_found',
  'context_length_exceeded', 'requests', 'tokens',
]);

const SECRET_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'NEAR_AGENT_PRIVATE_KEY', 'NEAR_AGENT_OWNER_PRIVATE_KEY'];
export const configuredSecrets = (env) => SECRET_VARS.map((k) => env[k]).filter((v) => typeof v === 'string' && v.length > 0);

export function safeErrorDetail(body, secrets = []) {
  if (!body || typeof body !== 'object') return 'non-JSON error body (not shown)';
  let err = body.error ?? {};
  if (typeof err === 'string') err = { message: err }; // e.g. Ollama: {"error": "text"}
  if (!err || typeof err !== 'object') err = {};
  let type = typeof err.type === 'string' && ERROR_TYPES.has(err.type) ? err.type : null;
  if (!type && typeof err.code === 'string' && ERROR_TYPES.has(err.code)) type = err.code;
  type ??= 'unknown_error';
  // Only plain strings are shown: a stringified object could re-encode a secret past the check below.
  const msg = typeof err.message === 'string' ? err.message : '';
  if (secrets.some((s) => msg.includes(s))) return `${type} (message withheld: it contained a configured secret)`;
  const masked = msg.replace(SECRETISH, '[redacted]').slice(0, 200);
  return masked ? `${type}: ${masked}` : type;
}

// POST JSON and return the parsed body; every failure becomes an Error without secrets.
export async function postJson(fetchImpl, url, headers, payload, { label, secrets, missingKeyHint = '' }) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(90_000) });
  } catch {
    throw new Error(`${label} request failed (network error)`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const hint = (res.status === 401 || res.status === 403) && missingKeyHint ? ` -- ${missingKeyHint}` : '';
    throw new Error(`LLM request failed: ${label} HTTP ${res.status}: ${safeErrorDetail(body, secrets)}${hint}`);
  }
  if (!body || typeof body !== 'object') throw new Error(`LLM request failed: ${label} returned a non-JSON body (not shown)`);
  return body;
}
