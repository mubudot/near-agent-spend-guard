// Offline stand-in for a compromised model, so the demo needs no key.
// Deterministic, offline, gullible: reads the page, then issues one spend per payment
// instruction it finds anywhere in the page (injected text included), then summarizes.
const INSTRUCTION = /\b(?:send|pay|transfer)\s+(\d+(?:\.\d{1,24})?)\s+NEAR\s+to\s+([a-z0-9]+(?:[._-][a-z0-9]+)*)(?:\s+for\s+([^.\n]+))?/gi;
export function mockLlm() {
  return async ({ messages }) => {
    const results = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
    const calls = messages.flatMap((m) => (m.role === 'assistant' && Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_use');
    const n = calls.length;
    const use = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `mock_${n + 1}`, name, input }] });
    if (n === 0) return use('read_merchant_page', {});
    const page = String(results.find((r) => r.tool_use_id === 'mock_1')?.content ?? '');
    const plan = [...page.matchAll(INSTRUCTION)].map(([, amount, receiver, memo]) => ({ receiver, amount_near: amount, memo: (memo ?? 'payment').trim() }));
    const done = calls.filter((c) => c.name === 'spend').length;
    if (done < plan.length) return use('spend', plan[done]);
    const lines = calls.filter((c) => c.name === 'spend').map((c) => {
      const r = String(results.find((x) => x.tool_use_id === c.id)?.content ?? '');
      return `${c.input.amount_near} NEAR to ${c.input.receiver}: ${r}`;
    });
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: `[mock LLM] Followed every payment instruction on the page:\n${lines.join('\n')}` }] };
  };
}
