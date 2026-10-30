// DOM rendering. Chain data (memos, account ids) only ever reaches the page as text nodes.
import { explorerAccount, explorerTx, formatUtc, relativeTime, shortHash, formatNear } from './format.mjs';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const badge = (label, tone = 'neutral') => el('span', { class: `badge badge-${tone}` }, label);
const link = (href, text, cls = 'mono') => el('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls }, text);
const account = (id) => link(explorerAccount(id), id);

function copyButton(text) {
  const button = el('button', { class: 'copy', type: 'button', title: 'Copy command' }, 'Copy');
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; } catch { button.textContent = 'Select & copy'; }
    setTimeout(() => { button.textContent = 'Copy'; }, 1500);
  });
  return button;
}

// CSSOM, not a style attribute, so the strict CSP (no inline styles) still allows it.
function meterFill(pct) {
  const fill = el('span');
  fill.style.width = `${pct}%`;
  return fill;
}

const empty = (text) => el('p', { class: 'empty' }, text);

export function renderKpis(root, m, nowMs) {
  const cards = [];
  cards.push(el('div', { class: 'kpi' },
    el('span', { class: 'kpi-label' }, 'Agent'),
    el('div', { class: 'kpi-value' }, badge(m.status.label, m.status.tone)),
    el('span', { class: 'kpi-foot mono' }, m.agent)));
  if (m.budget) {
    cards.push(el('div', { class: 'kpi' },
      el('span', { class: 'kpi-label' }, 'Spent today (UTC)'),
      el('div', { class: 'kpi-value' }, formatNear(m.budget.spent), el('small', {}, ` / ${formatNear(m.budget.cap)}`)),
      el('div', { class: `meter meter-${m.budget.tone}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': m.budget.pct, 'aria-label': 'daily budget used' },
        meterFill(m.budget.pct)),
      el('span', { class: 'kpi-foot' }, `${formatNear(m.budget.left)} left · resets ${relativeTime(m.resetMs, nowMs)}`)));
  }
  cards.push(el('div', { class: 'kpi' },
    el('span', { class: 'kpi-label' }, 'Awaiting owner approval'),
    el('div', { class: 'kpi-value' }, String(m.pending.length), m.pending.length ? badge('action needed', 'warn') : badge('clear', 'ok')),
    el('span', { class: 'kpi-foot' }, m.otherPending ? `+${m.otherPending} for other agents` : 'requests above the approval threshold')));
  cards.push(el('div', { class: 'kpi' },
    el('span', { class: 'kpi-label' }, 'Guard balance'),
    el('div', { class: 'kpi-value' }, m.balance ?? '—'),
    el('span', { class: 'kpi-foot' }, account(m.contract))));
  root.replaceChildren(...cards);
}

export function renderPolicy(root, m) {
  if (!m.policy) { root.replaceChildren(empty(`${m.agent} is not registered on this guard.`)); return; }
  const p = m.policy;
  const row = (label, value, hint) => el('div', { class: 'kv' }, el('span', {}, label), el('strong', {}, value), hint ? el('em', {}, hint) : null);
  root.replaceChildren(
    row('Per-transaction cap', p.perTx, 'hard limit: refused above it (E_PER_TX)'),
    row('Daily cap', p.daily, 'hard limit per UTC day, pending counted (E_DAILY)'),
    row('Approval threshold', p.threshold, 'above it: held for the owner'),
    el('div', { class: 'kv kv-list' }, el('span', {}, 'Allowlist'),
      el('div', { class: 'chips' }, p.allowlist.length ? p.allowlist.map((a) => el('span', { class: 'chip mono' }, a)) : badge('empty: nothing payable', 'bad')),
      el('em', {}, 'any other receiver is refused (E_NOT_ALLOWLISTED)')),
    row('Owner', m.owner, 'the only account that can change policy, approve or withdraw'),
  );
}

export function renderKeys(root, m) {
  if (!m.keys) { root.replaceChildren(empty('Could not read the agent account keys.')); return; }
  const k = m.keys;
  const items = k.spendOnly.map((key) => el('div', { class: 'keycard' },
    el('div', {}, key.onlySpend ? badge('spend only', 'ok') : badge(`methods: ${key.methods.join(', ') || 'any'}`, 'warn'), ' ', badge('function-call key', 'info')),
    el('div', { class: 'kv' }, el('span', {}, 'Receiver'), el('strong', { class: 'mono' }, m.contract)),
    el('div', { class: 'kv' }, el('span', {}, 'Methods'), el('strong', { class: 'mono' }, `[${key.methods.join(', ')}]`)),
    el('div', { class: 'kv' }, el('span', {}, 'Gas allowance left'), el('strong', {}, key.allowance)),
    el('div', { class: 'kv' }, el('span', {}, 'Public key'), el('strong', { class: 'mono small' }, shortHash(key.publicKey, 22)))));
  root.replaceChildren(
    ...(items.length ? items : [empty('No function-call key for this contract on the agent account.')]),
    el('p', { class: 'note' },
      'The agent signs only with this key: it can call ', el('code', {}, 'spend'), ' on the guard and nothing else — no transfers, no admin methods. ',
      `The account also has ${k.fullAccess} full-access key(s), held by the account owner and never given to the agent.`),
  );
}

export function renderPending(root, m, nowMs) {
  if (!m.pending.length) { root.replaceChildren(empty('Nothing is waiting. Spends above the approval threshold appear here until the owner approves or rejects them, or they expire at UTC midnight.')); return; }
  const rows = m.pending.map((r) => el('tr', {},
    el('td', {}, `#${r.id}`),
    el('td', {}, el('strong', {}, r.amount)),
    el('td', { class: 'mono' }, r.receiver),
    el('td', {}, r.memo),
    el('td', {}, r.expired ? badge('expired', 'neutral') : badge(`expires ${relativeTime(r.expiresMs, nowMs)}`, 'warn')),
    el('td', { class: 'cmds' },
      el('div', { class: 'cmd' }, el('code', {}, r.approveCmd), copyButton(r.approveCmd)),
      el('div', { class: 'cmd' }, el('code', {}, r.rejectCmd), copyButton(r.rejectCmd)))));
  root.replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, ['Request', 'Amount', 'Receiver', 'Memo', 'Status', 'Owner action (run in the repo with the owner key)'].map((h) => el('th', {}, h)))),
    el('tbody', {}, rows)));
}

export function renderEvents(root, events, nowMs, { limit = 12 } = {}) {
  if (!events.length) { root.replaceChildren(empty('No events yet.')); return; }
  const list = el('ol', { class: 'feed' }, events.slice(0, limit).map((e) => el('li', {},
    badge(e.label, e.tone),
    el('span', { class: 'feed-summary' }, e.summary),
    el('time', { datetime: new Date(e.timeMs).toISOString(), title: formatUtc(e.timeMs) }, relativeTime(e.timeMs, nowMs)))));
  root.replaceChildren(list,
    el('p', { class: 'note' }, `Newest first from the contract's on-chain audit ring (${events.length} retained). Refused spends are failed transactions and leave no event — inspect them on the right.`));
}

const OUTCOME_LABEL = {
  completed: 'Paid', awaiting_owner_approval: 'Held for approval', refused: 'Refused on chain', failed: 'Failed',
  payout_failed: 'Payout failed', rejected: 'Rejected', in_flight: 'Payout in flight', success: 'Success',
};

export function renderTx(summary) {
  const a = summary.args ?? {};
  const what = summary.method === 'spend'
    ? `${a.amount ? formatNear(a.amount) : '?'} → ${a.receiver ?? '?'}${a.memo ? ` “${a.memo}”` : ''}`
    : `${summary.method ?? 'transaction'}${a.request_id ? ` request #${a.request_id}` : ''}`;
  return el('li', { class: `tx tx-${summary.tone}` },
    el('div', { class: 'tx-head' },
      badge(OUTCOME_LABEL[summary.outcome] ?? summary.outcome, summary.tone),
      summary.code ? el('code', { class: 'code' }, summary.code) : null,
      summary.requestId && summary.outcome === 'awaiting_owner_approval' ? badge(`request #${summary.requestId}`, 'warn') : null,
      link(explorerTx(summary.hash), shortHash(summary.hash, 10), 'mono tx-link')),
    el('div', { class: 'tx-what' }, what),
    el('div', { class: 'tx-meta' }, `signed by ${summary.signer}`, summary.reason ? ` · ${summary.reason}` : '',
      summary.events.length ? ` · events: ${summary.events.map((e) => e.event).join(' → ')}` : ''));
}
