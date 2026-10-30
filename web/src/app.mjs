// Dashboard wiring: config from the URL/form, periodic refresh, transaction inspector.
import { createClient, loadSnapshot, findTx, DEFAULT_RPC } from './near-rpc.mjs';
import { dashboardModel, summarizeTx, parseTxList, isProvisional, latestOnly } from './model.mjs';
import { isTestnetAccount, isTxHash, isAccountId, nsToMs } from './format.mjs';
import { el, renderKpis, renderPolicy, renderKeys, renderPending, renderEvents, renderTx, updateTimes } from './view.mjs';

const DEFAULTS = {
  contract: 'guard.spendguard-b31c91.testnet',
  agent: 'agent.spendguard-b31c91.testnet',
  rpc: DEFAULT_RPC,
};
const REFRESH_MS = 20_000;
const EVENTS_SHOWN = 10;
const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const config = {
  contract: params.get('contract') || DEFAULTS.contract,
  agent: params.get('agent') || DEFAULTS.agent,
  rpc: params.get('rpc') || DEFAULTS.rpc,
};
let client;
let snapshot = null;
let snapshotKey = '';
let lastLoadedMs = 0;
let timer;
let showAllEvents = false;
const requests = latestOnly(); // a config change or a newer refresh supersedes older responses
const inspected = new Map(); // hash -> { sender, summary | null }

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function validate(c) {
  if (!isTestnetAccount(c.contract) || !isTestnetAccount(c.agent)) return 'Contract and agent must be testnet account ids (…testnet).';
  if (!/^https:\/\/[^\s]+$/.test(c.rpc)) return 'RPC URL must use https.';
  return null;
}

function updateStamp() {
  if (!snapshot) { $('updated').textContent = 'not connected'; return; }
  const ago = Math.round((Date.now() - lastLoadedMs) / 1000);
  $('updated').textContent = `block #${snapshot.block.height} · updated ${ago < 5 ? 'just now' : `${ago}s ago`}`;
}

// Full rebuild: only when the data changed, so focus and selection survive quiet refreshes.
function render() {
  const now = Date.now();
  const sections = ['kpis', 'policy', 'keys', 'pending', 'events'];
  if (!snapshot) {
    for (const id of sections) $(id).replaceChildren();
    $('more-events').hidden = true;
    updateStamp();
    return;
  }
  lastRenderMs = now;
  const m = dashboardModel(snapshot, now);
  renderKpis($('kpis'), m, now);
  renderPolicy($('policy'), m);
  renderKeys($('keys'), m);
  renderPending($('pending'), m, now);
  renderEvents($('events'), m.events, now, { limit: showAllEvents ? m.events.length : EVENTS_SHOWN });
  $('more-events').hidden = m.events.length <= EVENTS_SHOWN;
  $('more-events').textContent = showAllEvents ? 'Show fewer' : `Show all ${m.events.length}`;
  updateStamp();
}

let lastRenderMs = 0;
function tick() {
  const now = Date.now();
  // A request that expired since the last render changes what is actionable: rebuild once.
  const crossed = snapshot?.pending?.some((r) => { const t = nsToMs(r.expires_at); return t > lastRenderMs && t <= now; });
  if (crossed) { render(); return; }
  updateTimes(document, now);
  updateStamp();
}

async function refresh() {
  const token = requests.next();
  document.body.classList.add('is-loading');
  try {
    const next = await loadSnapshot(client, config);
    if (!requests.isCurrent(token)) return;
    const { block, ...data } = next;
    const key = JSON.stringify(data);
    snapshot = next;
    lastLoadedMs = Date.now();
    showError('');
    if (key !== snapshotKey) { snapshotKey = key; render(); } else tick();
    reinspectProvisional();
  } catch (error) {
    if (!requests.isCurrent(token)) return;
    showError(`Could not read the guard: ${error instanceof Error ? error.message : 'unknown error'}`);
  } finally {
    if (requests.isCurrent(token)) document.body.classList.remove('is-loading');
  }
}

function schedule() {
  clearInterval(timer);
  if ($('auto').checked) timer = setInterval(refresh, REFRESH_MS);
}

function applyConfig(next, { pushUrl = true } = {}) {
  const problem = validate(next);
  if (problem) { showError(problem); return false; }
  const changed = Object.keys(config).some((k) => config[k] !== next[k]);
  Object.assign(config, next);
  client = createClient({ url: config.rpc });
  $('cfg-summary').textContent = `${config.contract} · agent ${config.agent}`;
  if (changed) {
    // Never show one guard's data under another guard's label.
    requests.next();
    snapshot = null;
    snapshotKey = '';
    inspected.clear();
    lookups.clear(); // in-flight lookups for the old config can no longer publish
    $('tx-list').replaceChildren();
    render();
  }
  if (pushUrl) {
    const url = new URL(location.href);
    for (const [k, v] of Object.entries(config)) {
      if (v === DEFAULTS[k]) url.searchParams.delete(k); else url.searchParams.set(k, v);
    }
    history.replaceState(null, '', url);
  }
  return true;
}

// ---- Transaction inspector --------------------------------------------------------------
function txNode(hash) {
  return [...$('tx-list').children].find((n) => n.dataset.hash === hash);
}

const lookups = new Map(); // hash -> token of its newest lookup; older lookups may not publish
let lookupSeq = 0; // global, so a token is never reused after lookups.clear()

async function inspect(hash, sender) {
  const owner = snapshot?.owner;
  const token = ++lookupSeq;
  lookups.set(hash, token);
  const isNewest = () => lookups.get(hash) === token;
  let node = txNode(hash);
  if (!node) {
    node = el('li', { class: 'tx tx-neutral', 'data-hash': hash }, `Looking up ${hash.slice(0, 10)}…`);
    $('tx-list').prepend(node);
  }
  try {
    const result = await findTx(client, hash, [sender, config.agent, owner]);
    if (!isNewest()) return; // superseded by a newer lookup or a config change
    const summary = summarizeTx(result, config.contract);
    inspected.set(hash, { sender, summary });
    txNode(hash)?.replaceWith(renderTx(summary));
  } catch (error) {
    if (!isNewest()) return;
    const message = error instanceof Error ? error.message : 'error';
    const known = inspected.get(hash);
    const current = txNode(hash);
    if (known?.summary) {
      // Keep the last known result (and its retry on refresh); note the failed update.
      current?.querySelector('.tx-meta')?.append(` · update failed (${message}), retrying on refresh`);
      return;
    }
    inspected.delete(hash);
    if (current) {
      current.className = 'tx tx-bad';
      current.textContent = `${hash.slice(0, 10)}…: not found (${message}). Pass hash@signer if another account signed it.`;
    }
  }
}

function reinspectProvisional() {
  for (const [hash, { sender, summary }] of inspected) if (summary && isProvisional(summary)) inspect(hash, sender);
}

async function inspectList(text) {
  const items = parseTxList(text, isTxHash, isAccountId);
  $('tx-hint').textContent = items.length ? '' : 'Enter a transaction hash (optionally hash@signer).';
  // Oldest first so the newest ends up on top of the list; a repeat hash is looked up again.
  for (const { hash, sender } of items.reverse()) await inspect(hash, sender);
}

function init() {
  $('contract').value = config.contract;
  $('agent').value = config.agent;
  $('rpc').value = config.rpc;
  if (!applyConfig(config, { pushUrl: false })) return;
  render();

  $('config').addEventListener('submit', (e) => {
    e.preventDefault();
    if (applyConfig({ contract: $('contract').value.trim(), agent: $('agent').value.trim(), rpc: $('rpc').value.trim() })) refresh();
  });
  $('refresh').addEventListener('click', refresh);
  $('auto').addEventListener('change', schedule);
  $('more-events').addEventListener('click', () => { showAllEvents = !showAllEvents; render(); });
  $('tx-form').addEventListener('submit', (e) => { e.preventDefault(); inspectList($('tx-input').value); $('tx-input').value = ''; });
  for (const button of document.querySelectorAll('[data-example]')) {
    button.addEventListener('click', () => inspectList(button.dataset.example));
  }

  refresh().then(() => { if (params.get('tx')) inspectList(params.get('tx')); });
  schedule();
  setInterval(tick, 5_000); // relative times only; the DOM is rebuilt only when data changes
}

init();
