// Dashboard wiring: config from the URL/form, periodic refresh, transaction inspector.
import { createClient, loadSnapshot, findTx, DEFAULT_RPC } from './near-rpc.mjs';
import { dashboardModel, summarizeTx, parseTxList } from './model.mjs';
import { isTestnetAccount, isTxHash, isAccountId } from './format.mjs';
import { el, renderKpis, renderPolicy, renderKeys, renderPending, renderEvents, renderTx } from './view.mjs';

const DEFAULTS = {
  contract: 'guard.spendguard-b31c91.testnet',
  agent: 'agent.spendguard-b31c91.testnet',
  rpc: DEFAULT_RPC,
};
const REFRESH_MS = 20_000;
const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const config = {
  contract: params.get('contract') || DEFAULTS.contract,
  agent: params.get('agent') || DEFAULTS.agent,
  rpc: params.get('rpc') || DEFAULTS.rpc,
};
let client;
let snapshot = null;
let lastLoadedMs = 0;
let timer;
let showAllEvents = false;
let loading = false;

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function validate(c) {
  if (!isTestnetAccount(c.contract) || !isTestnetAccount(c.agent)) return 'Contract and agent must be testnet account ids (…testnet).';
  if (!/^https:\/\/[^\s]+$/.test(c.rpc)) return 'RPC URL must use https.';
  return null;
}

function render() {
  if (!snapshot) return;
  const now = Date.now();
  const m = dashboardModel(snapshot, now);
  renderKpis($('kpis'), m, now);
  renderPolicy($('policy'), m);
  renderKeys($('keys'), m);
  renderPending($('pending'), m, now);
  renderEvents($('events'), m.events, now, { limit: showAllEvents ? m.events.length : 10 });
  $('more-events').hidden = m.events.length <= 10;
  $('more-events').textContent = showAllEvents ? 'Show fewer' : `Show all ${m.events.length}`;
  const ago = Math.round((now - lastLoadedMs) / 1000);
  $('updated').textContent = `block #${snapshot.block.height} · updated ${ago < 5 ? 'just now' : `${ago}s ago`}`;
}

async function refresh() {
  if (loading) return;
  loading = true;
  document.body.classList.add('is-loading');
  try {
    snapshot = await loadSnapshot(client, config);
    lastLoadedMs = Date.now();
    showError('');
    render();
  } catch (error) {
    showError(`Could not read the guard: ${error instanceof Error ? error.message : 'unknown error'}`);
  } finally {
    loading = false;
    document.body.classList.remove('is-loading');
  }
}

function schedule() {
  clearInterval(timer);
  if ($('auto').checked) timer = setInterval(refresh, REFRESH_MS);
}

function applyConfig(next, { pushUrl = true } = {}) {
  const problem = validate(next);
  if (problem) { showError(problem); return false; }
  Object.assign(config, next);
  client = createClient({ url: config.rpc });
  $('cfg-summary').textContent = `${config.contract} · agent ${config.agent}`;
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
const inspected = new Map();

async function inspect(hash, sender) {
  if (inspected.has(hash)) return;
  const placeholder = el('li', { class: 'tx tx-neutral' }, `Looking up ${hash.slice(0, 10)}…`);
  $('tx-list').prepend(placeholder);
  inspected.set(hash, placeholder);
  try {
    const result = await findTx(client, hash, [sender, config.agent, snapshot?.owner]);
    const node = renderTx(summarizeTx(result, config.contract));
    placeholder.replaceWith(node);
    inspected.set(hash, node);
  } catch (error) {
    placeholder.textContent = `${hash.slice(0, 10)}…: not found (${error instanceof Error ? error.message : 'error'}). Pass hash@signer if another account signed it.`;
    placeholder.className = 'tx tx-bad';
    inspected.delete(hash);
  }
}

async function inspectList(text) {
  const items = parseTxList(text, isTxHash, isAccountId);
  if (!items.length) { showError('Enter a transaction hash (optionally hash@signer).'); return; }
  showError('');
  // Oldest first so the newest ends up on top of the list.
  for (const { hash, sender } of items.reverse()) await inspect(hash, sender);
}

function init() {
  $('contract').value = config.contract;
  $('agent').value = config.agent;
  $('rpc').value = config.rpc;
  if (!applyConfig(config, { pushUrl: false })) return;

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
  setInterval(render, 5_000); // keep relative times fresh between refreshes
}

init();
