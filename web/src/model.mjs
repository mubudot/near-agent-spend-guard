// Turns raw contract/RPC data into what the dashboard shows. Pure functions, unit tested.
import { formatNear, nsToMs, percent, nextUtcMidnight } from './format.mjs';

// Every event the contract records (src/lib.rs `record(...)`), with a badge tone.
export const EVENT_META = {
  spend_requested: { label: 'Spend requested', tone: 'info' },
  transfer_succeeded: { label: 'Paid', tone: 'ok' },
  transfer_failed: { label: 'Payout failed', tone: 'bad' },
  pending: { label: 'Held for approval', tone: 'warn' },
  approved: { label: 'Approved by owner', tone: 'ok' },
  rejected: { label: 'Rejected by owner', tone: 'bad' },
  expired: { label: 'Expired', tone: 'neutral' },
  agent_added: { label: 'Agent added', tone: 'info' },
  agent_removed: { label: 'Agent removed', tone: 'neutral' },
  policy_updated: { label: 'Policy updated', tone: 'info' },
  paused: { label: 'Guard paused', tone: 'bad' },
  unpaused: { label: 'Guard unpaused', tone: 'ok' },
  agent_paused: { label: 'Agent paused', tone: 'bad' },
  agent_unpaused: { label: 'Agent unpaused', tone: 'ok' },
  withdraw_requested: { label: 'Owner withdrawal', tone: 'neutral' },
  transfer_cleared: { label: 'Stale transfer cleared', tone: 'neutral' },
};

// Contract panic codes a judge will see on refused transactions (src/lib.rs).
export const REFUSAL_TEXT = {
  E_NOT_ALLOWLISTED: 'receiver is not on the allowlist',
  E_PER_TX: 'amount is above the per-transaction cap',
  E_DAILY: 'would exceed the daily cap',
  E_PAUSED: 'guard or agent is paused',
  E_NOT_AGENT: 'caller is not a registered agent',
  E_AMOUNT: 'amount must be positive',
  E_BALANCE: 'contract lacks free liquidity',
  E_PENDING_LIMIT: 'too many pending requests',
  E_TRANSFER_LIMIT: 'too many payouts in flight',
  E_MEMO: 'memo is too long',
  E_OWNER: 'only the owner may call this',
  E_EXPIRED: 'request has expired',
  E_REQUEST: 'unknown request id',
  E_STALE: 'agent was re-registered since the request',
};

export function describeEvent(item) {
  const meta = EVENT_META[item.event] ?? { label: item.event, tone: 'neutral' };
  const d = item.data ?? {};
  const parts = [];
  if (d.amount) parts.push(formatNear(d.amount));
  if (d.receiver) parts.push(`→ ${d.receiver}`);
  if (d.memo) parts.push(`“${d.memo}”`);
  if (d.request_id) parts.push(`request #${d.request_id}`);
  else if (d.id && item.event === 'spend_requested') parts.push(`#${d.id}`);
  if (d.transfer_id) parts.push(`payout #${d.transfer_id}`);
  if (d.cancelled_requests) parts.push(`${d.cancelled_requests} request(s) cancelled`);
  if (!d.amount && d.agent) parts.push(d.agent);
  return { id: String(item.id), timeMs: nsToMs(item.timestamp), event: item.event, ...meta, summary: parts.join(' ') };
}

export function agentStatus(globalPaused, policy) {
  if (!policy) return { label: 'Not registered', tone: 'neutral' };
  if (globalPaused) return { label: 'Paused (guard)', tone: 'bad' };
  if (policy.paused) return { label: 'Agent paused', tone: 'bad' };
  return { label: 'Active', tone: 'ok' };
}

export function budget(policy, spentToday) {
  const cap = BigInt(policy.daily_max);
  const spent = BigInt(spentToday);
  const left = cap > spent ? cap - spent : 0n;
  const pct = percent(spent, cap);
  const tone = pct >= 100 ? 'bad' : pct >= 70 ? 'warn' : 'ok';
  return { spent: spent.toString(), cap: cap.toString(), left: left.toString(), pct, tone };
}

export function pendingView(request, nowMs, contract) {
  const expiresMs = nsToMs(request.expires_at);
  const target = contract ? `NEAR_CONTRACT_ACCOUNT=${contract} ` : '';
  return {
    id: String(request.id),
    receiver: request.receiver,
    agent: request.agent,
    amount: formatNear(request.amount),
    memo: request.memo,
    createdMs: nsToMs(request.created_at),
    expiresMs,
    expired: expiresMs <= nowMs,
    expireCmd: `anyone can call expire({"request_id": "${request.id}"}) on the guard to release its reserve`,
    approveCmd: `${target}node demo/owner.mjs approve ${request.id}`,
    rejectCmd: `${target}node demo/owner.mjs reject ${request.id}`,
  };
}

// Access keys of the agent account, split by what they can do against this contract.
export function summarizeKeys(keys, contract) {
  const out = { fullAccess: 0, spendOnly: [], other: 0 };
  for (const k of keys ?? []) {
    const perm = k.access_key?.permission;
    if (perm === 'FullAccess') { out.fullAccess += 1; continue; }
    const fc = perm?.FunctionCall;
    if (fc && fc.receiver_id === contract) {
      out.spendOnly.push({
        publicKey: k.public_key,
        methods: fc.method_names,
        allowance: fc.allowance == null ? 'unlimited' : formatNear(fc.allowance),
        onlySpend: fc.method_names.length === 1 && fc.method_names[0] === 'spend',
        finiteAllowance: fc.allowance != null,
      });
    } else out.other += 1;
  }
  return out;
}

export function dashboardModel(raw, nowMs) {
  const { contract, agent, owner, paused, policy, spentToday, pending, audit, keys, balance } = raw;
  const mine = (pending ?? []).filter((r) => !agent || r.agent === agent).map((r) => pendingView(r, nowMs, contract));
  return {
    contract, agent, owner, paused,
    status: agentStatus(paused, policy),
    policy: policy && {
      perTx: formatNear(policy.per_tx_max),
      daily: formatNear(policy.daily_max),
      threshold: formatNear(policy.approval_threshold),
      allowlist: [...policy.allowlist],
      paused: policy.paused,
    },
    budget: policy ? budget(policy, spentToday ?? '0') : null,
    resetMs: nextUtcMidnight(nowMs),
    pending: mine,
    actionable: mine.filter((r) => !r.expired).length,
    otherPending: (pending ?? []).filter((r) => agent && r.agent !== agent).length,
    events: [...(audit ?? [])].sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))).map(describeEvent),
    keys: keys ? summarizeKeys(keys, contract) : null,
    balance: balance == null ? null : formatNear(balance),
  };
}

// ---- Transaction outcomes (the RPC `tx` result) ------------------------------------------

const b64json = (value) => {
  try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)))); } catch { return null; }
};

export function refusalCode(message) {
  return /(?:^|[^A-Z_])(E_[A-Z][A-Z_]*)/.exec(String(message ?? ''))?.[1] ?? null;
}

function contractEvents(result, contract) {
  const events = [];
  for (const r of result.receipts_outcome ?? []) {
    if (contract && r.outcome?.executor_id !== contract) continue;
    for (const log of r.outcome?.logs ?? []) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      try {
        const e = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (e.standard === 'agent_spend_guard') for (const item of e.data ?? []) events.push(item);
      } catch { /* not ours */ }
    }
  }
  return events;
}

// Summarize what a guard transaction did: completed / awaiting_owner_approval / refused / ...
export function summarizeTx(result, contract) {
  const tx = result.transaction ?? {};
  const call = (tx.actions ?? []).map((a) => a.FunctionCall).find(Boolean);
  const method = call?.method_name ?? null;
  const args = call?.args ? b64json(call.args) : null;
  const events = contractEvents(result, contract);
  const names = events.map((e) => e.event);
  const base = {
    hash: tx.hash, signer: tx.signer_id, receiverId: tx.receiver_id, method, args,
    events: events.map(describeEvent), code: null,
  };
  // Only a transaction sent to the watched guard can be one of its decisions. Another contract's
  // `spend` (or its panic) must not be shown as a guard approval or refusal.
  if (contract && tx.receiver_id !== contract) {
    return { ...base, outcome: 'other_contract', tone: 'neutral', requestId: null,
      reason: `sent to ${tx.receiver_id ?? 'an unknown account'}, not the watched guard; not a guard decision` };
  }
  const failure = result.status?.Failure;
  const executed = failure || (result.status && 'SuccessValue' in result.status);
  if (!executed) {
    return { ...base, outcome: 'unconfirmed', tone: 'info', reason: 'not executed yet; refresh to update', requestId: null };
  }
  if (failure) {
    const code = refusalCode(JSON.stringify(failure));
    return { ...base, outcome: method === 'spend' ? 'refused' : 'failed', code, tone: 'bad',
      reason: (code && REFUSAL_TEXT[code]) || 'transaction failed; no state changed' };
  }
  const value = result.status?.SuccessValue ? b64json(result.status.SuccessValue) : null;
  const paid = names.includes('transfer_succeeded');
  const payoutFailed = names.includes('transfer_failed');
  let outcome = 'success';
  if (method === 'spend' && value?.status === 'pending') outcome = 'awaiting_owner_approval';
  else if (method === 'spend' || method === 'approve') outcome = paid ? 'completed' : payoutFailed ? 'payout_failed' : 'in_flight';
  else if (method === 'reject' && names.includes('rejected')) outcome = 'rejected';
  const tone = { completed: 'ok', awaiting_owner_approval: 'warn', payout_failed: 'bad', rejected: 'bad', in_flight: 'info' }[outcome] ?? 'neutral';
  const requestId = value?.status === 'pending' ? value.request_id : (args?.request_id ?? null);
  return { ...base, outcome, tone, requestId };
}

// Outcomes that can still change, so the inspector looks them up again on refresh.
export const isProvisional = (summary) => summary.outcome === 'in_flight' || summary.outcome === 'unconfirmed';

// Hands out tokens so only the newest request may publish its result (config changes, overlapping refreshes).
export function latestOnly() {
  let current = 0;
  return { next: () => ++current, isCurrent: (token) => token === current };
}

// Parse the `?tx=` list: "hash" or "hash@sender", comma separated, validated and de-duplicated.
export function parseTxList(text, isTxHash, isAccountId) {
  const seen = new Set();
  const out = [];
  for (const part of String(text ?? '').split(/[\s,]+/)) {
    if (!part) continue;
    const [hash, sender] = part.split('@');
    if (!isTxHash(hash) || (sender && !isAccountId(sender)) || seen.has(hash)) continue;
    seen.add(hash);
    out.push({ hash, sender: sender || null });
    if (out.length >= 20) break;
  }
  return out;
}
