// Minimal read-only NEAR JSON-RPC client for the dashboard. It holds no key and never signs.
// Works in the browser and in Node 20+ (tests inject `fetchImpl`).

export const DEFAULT_RPC = 'https://test.rpc.fastnear.com';
export const DEFAULT_ARCHIVAL_RPC = 'https://archival-rpc.testnet.fastnear.com';

export class RpcError extends Error {
  constructor(method, cause) {
    super(`${method}: ${cause}`);
    this.name = 'RpcError';
    this.cause = cause;
  }
}

const toBase64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const fromBytes = (bytes) => new TextDecoder().decode(Uint8Array.from(bytes));

export function createClient({ url = DEFAULT_RPC, archivalUrl = DEFAULT_ARCHIVAL_RPC, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  if (!/^https:\/\//.test(url)) throw new Error('RPC URL must use https');
  let id = 0;

  async function call(method, params, endpoint = url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let body;
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: controller.signal,
      });
      // Some providers answer RPC errors with a 4xx/5xx status and a JSON-RPC error body.
      body = await res.json().catch(() => null);
      if (!body || typeof body !== 'object' || (!('result' in body) && !body.error)) throw new RpcError(method, `HTTP ${res.status}`);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError(method, error?.name === 'AbortError' ? 'timeout' : 'network error');
    } finally {
      clearTimeout(timer);
    }
    if (body.error) throw new RpcError(method, body.error.cause?.name || body.error.name || 'RPC error');
    return body.result;
  }

  async function view(contract, method, args = {}, blockHash) {
    const params = { request_type: 'call_function', account_id: contract, method_name: method, args_base64: toBase64(JSON.stringify(args)) };
    if (blockHash) params.block_id = blockHash; else params.finality = 'final';
    const result = await call('query', params);
    return JSON.parse(fromBytes(result.result));
  }

  // Checked once per client; every snapshot and transaction lookup waits for it.
  let verified;
  function ensureTestnet() {
    verified ??= call('status', []).then((status) => {
      if (status.chain_id !== 'testnet') throw new Error(`RPC chain_id is "${status.chain_id}", expected "testnet"`);
      return true;
    });
    verified.catch(() => { verified = undefined; }); // a network blip may be retried; a wrong chain fails again
    return verified;
  }

  // Look a transaction up; older ones are served only by archival nodes.
  async function tx(hash, sender) {
    await ensureTestnet();
    const params = { tx_hash: hash, sender_account_id: sender, wait_until: 'NONE' };
    try {
      return await call('tx', params);
    } catch (error) {
      if (!archivalUrl || !(error instanceof RpcError) || error.cause !== 'UNKNOWN_TRANSACTION') throw error;
      return call('tx', params, archivalUrl);
    }
  }

  return { call, view, tx, ensureTestnet };
}

// One consistent snapshot of the guard for one agent: every read at the same final block.
export async function loadSnapshot(client, { contract, agent }) {
  await client.ensureTestnet();
  const block = (await client.call('block', { finality: 'final' })).header;
  const at = block.hash;
  const [owner, paused, policy, spentToday, pending, audit, account, keyList] = await Promise.all([
    client.view(contract, 'get_owner', {}, at),
    client.view(contract, 'is_paused', {}, at),
    client.view(contract, 'get_policy', { agent }, at),
    client.view(contract, 'get_spent_today', { agent }, at),
    client.view(contract, 'list_pending', {}, at),
    // `from` is an absolute sequence number; 0 returns the oldest retained events.
    client.view(contract, 'get_audit', { from: '0', limit: 128 }, at),
    client.call('query', { request_type: 'view_account', account_id: contract, block_id: at }),
    client.call('query', { request_type: 'view_access_key_list', account_id: agent, block_id: at }).catch(() => null),
  ]);
  return {
    contract, agent, owner, paused, policy, spentToday, pending, audit,
    balance: account.amount, keys: keyList?.keys ?? null,
    block: { height: block.height, hash: block.hash, timestampNs: block.timestamp_nanosec ?? String(block.timestamp) },
  };
}

// Try each plausible signer (the RPC routes `tx` by sender) until one finds the transaction.
export async function findTx(client, hash, senders) {
  let lastError;
  for (const sender of [...new Set(senders.filter(Boolean))]) {
    try { return await client.tx(hash, sender); } catch (error) { lastError = error; }
  }
  throw lastError ?? new Error('no sender to look the transaction up with');
}
