import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ONE = 10n ** 24n;
const GAS = 100_000_000_000_000n;
// near-workspaces 5.0.0 bundles neard 2.6.2, which rejects WASM from current Rust
// (PrepareError: Deserialization). Use the nearcore release that mainnet/testnet run.
const SANDBOX_VERSION = '2.14.0';
const PLATFORMS = { 'linux-x64': 'Linux-x86_64', 'linux-arm64': 'Linux-aarch64', 'darwin-arm64': 'Darwin-arm64', 'darwin-x64': 'Darwin-x86_64' };

async function findFile(dir, name) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) { const hit = await findFile(path, name); if (hit) return hit; }
  }
  return null;
}

// Downloads the official nearcore sandbox build once into the ignored .tmp/ directory.
async function sandboxBinary(temp) {
  const platform = PLATFORMS[`${process.platform}-${process.arch}`];
  if (!platform) throw new Error(`No official sandbox build for ${process.platform}-${process.arch}; set SPEND_GUARD_SANDBOX_BIN`);
  const dir = join(temp, '..', 'sandbox', SANDBOX_VERSION);
  const cached = await findFile(dir, 'near-sandbox').catch(() => null);
  if (cached) return cached;
  await mkdir(dir, { recursive: true });
  const url = `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/${platform}/${SANDBOX_VERSION}/near-sandbox.tar.gz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Sandbox download failed: ${response.status} ${url}`);
  const archive = join(dir, 'near-sandbox.tar.gz');
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  const untar = spawnSync('tar', ['-xzf', archive, '-C', dir], { encoding: 'utf8' });
  if (untar.status !== 0) throw new Error(`Sandbox extraction failed: ${untar.stderr}`);
  await rm(archive);
  const binary = await findFile(dir, 'near-sandbox');
  if (!binary) throw new Error('near-sandbox binary missing from archive');
  return binary;
}

test('sandbox: transfers, reservations, approvals, rollback and restricted access key', { timeout: 400_000 }, async (t) => {
  // No public RPC endpoints. Sandbox keys and chain data remain inside the repository.
  const temp = resolve('.tmp/integration');
  await mkdir(temp, { recursive: true });
  process.env.TMPDIR = temp;
  const wasm = resolve('target/wasm32-unknown-unknown/release/near_agent_spend_guard.wasm');
  await access(wasm).catch(() => { throw new Error('Build the contract first: cargo build --locked --target wasm32-unknown-unknown --release'); });
  const binary = process.env.SPEND_GUARD_SANDBOX_BIN || await sandboxBinary(temp);
  {
    await access(binary);
    const preflight = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15_000 });
    if (preflight.status !== 0) {
      if (preflight.stderr?.includes("couldn't set the file descriptor limit")) {
        t.skip(`Sandbox cannot start with this container's hard file-descriptor limit: ${preflight.stderr.split('\n')[0]}`);
        return;
      }
      throw new Error(`Sandbox preflight failed: ${preflight.error?.message ?? preflight.stderr}`);
    }
    // Replace near-workspaces' bundled (too old) sandbox through its exported binary factory.
    const utils = require(join(dirname(require.resolve('near-workspaces')), 'internal-utils.js'));
    utils.sandboxBinary = async () => ({ binPath: binary, exists: async () => true });
    t.diagnostic(`sandbox: ${spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim()}`);
  }
  // Avoid the old downloader's ~/.near default on supported hosts as well.
  process.env.NEAR_SANDBOX_BIN_PATH = temp;
  process.env.NEAR_SANDBOX_BINARY_PATH = temp;
  const { Worker } = await import('near-workspaces');
  const { KeyPair, transactions } = await import('near-api-js');
  // near-workspaces' own cleanup uses a non-recursive rm and leaves chain data behind
  // after a failed run, which makes the next Worker.init fail with EISDIR. Clear it here.
  const homeDir = join(temp, 'chain');
  // neard can still be flushing state snapshots right after it is killed; retry the removal.
  const clean = () => rm(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await clean();
  const worker = await Worker.init({ network: 'sandbox', homeDir, rm: false });
  try {
    const root = worker.rootAccount;
    const guard = await root.createSubAccount('guard', { initialBalance: 20n * ONE });
    const agent = await root.createSubAccount('agent');
    const shop = await root.createSubAccount('shop');
    const stranger = await root.createSubAccount('stranger');
    const missing = `missing.${root.accountId}`;
    const code = await readFile(wasm);
    // Deploy and initialize atomically, signed by the contract account (new is private).
    await guard.batch(guard).deployContract(code).functionCall('new', { owner: root.accountId }, { gas: GAS }).transact();
    assert.equal(await guard.view('get_owner'), root.accountId);
    const policy = {
      per_tx_max: (ONE / 2n).toString(), daily_max: (2n * ONE).toString(),
      approval_threshold: (ONE / 5n).toString(), allowlist: [shop.accountId, missing], paused: false,
    };
    await root.call(guard, 'add_agent', { agent: agent.accountId, policy });
    const spend = (receiver, amount, signWithKey) => agent.call(guard, 'spend', {
      receiver, amount: amount.toString(), memo: 'sandbox',
    }, { gas: GAS, signWithKey });
    const spent = () => guard.view('get_spent_today', { agent: agent.accountId });
    await t.test('a third party cannot initialize an undeployed-and-uninitialized guard', async () => {
      const bare = await root.createSubAccount('bare', { initialBalance: 5n * ONE });
      await bare.deploy(wasm);
      await assert.rejects(stranger.call(bare, 'new', { owner: stranger.accountId }), /private|E_PRIVATE/);
      await assert.rejects(root.call(bare, 'new', { owner: root.accountId }), /private|E_PRIVATE/);
    });
    await t.test('successful transfer reaches allowlisted receiver', async () => {
      const before = BigInt((await shop.balance()).total);
      await spend(shop.accountId, ONE / 10n);
      assert.equal(BigInt((await shop.balance()).total) - before, ONE / 10n);
      assert.equal(await spent(), (ONE / 10n).toString());
    });
    await t.test('approval reserves and reject releases the budget', async () => {
      const before = (await shop.balance()).total;
      const pending = await spend(shop.accountId, ONE / 2n);
      assert.equal(pending.status, 'pending');
      assert.equal((await shop.balance()).total, before);
      assert.equal(await spent(), (ONE * 6n / 10n).toString());
      await root.call(guard, 'reject', { request_id: pending.request_id });
      assert.equal(await spent(), (ONE / 10n).toString());
      const again = await spend(shop.accountId, ONE / 2n);
      await root.call(guard, 'approve', { request_id: again.request_id }, { gas: GAS });
      assert.equal(await spent(), (ONE * 6n / 10n).toString());
      assert.deepEqual(await guard.view('list_pending'), []);
    });
    await t.test('failed native transfer triggers real callback rollback', async () => {
      const before = await spent();
      // Native transfers cannot create named accounts. The spend call itself succeeds;
      // its transfer receipt fails and on_transfer restores the reserved daily amount.
      await agent.callRaw(guard, 'spend', { receiver: missing, amount: (ONE / 10n).toString(), memo: 'fail' }, { gas: GAS });
      assert.equal(await spent(), before);
      const audit = await guard.view('get_audit', { from: '0', limit: 128 });
      assert.ok(audit.some((e) => e.event === 'transfer_failed'));
    });
    await t.test('on_transfer callback fits its gas budget with a full allowlist', async () => {
      const longIds = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(51)}.test.near`);
      await root.call(guard, 'update_policy', { agent: agent.accountId, policy: { ...policy, allowlist: [shop.accountId, missing, ...longIds] } });
      const result = await agent.callRaw(guard, 'spend', { receiver: shop.accountId, amount: '1', memo: 'm'.repeat(256) }, { gas: GAS });
      const callback = result.result.receipts_outcome.find((r) => r.outcome.logs.some((l) => l.includes('"transfer_succeeded"')));
      assert.ok(callback, 'callback receipt found');
      const burnt = BigInt(callback.outcome.gas_burnt);
      t.diagnostic(`on_transfer gas_burnt: ${Number(burnt) / 1e12} Tgas (budget 50 Tgas)`);
      assert.ok(burnt < 15_000_000_000_000n, `callback used ${burnt}`);
      assert.deepEqual(await guard.view('list_transfers'), []);
      await root.call(guard, 'update_policy', { agent: agent.accountId, policy });
    });
    await t.test('owner, allowlist, caps and pause enforced on chain', async () => {
      await assert.rejects(stranger.call(guard, 'pause', {}), /E_OWNER/);
      await assert.rejects(stranger.call(guard, 'spend', { receiver: shop.accountId, amount: '1', memo: '' }), /E_NOT_AGENT/);
      await assert.rejects(spend(stranger.accountId, 1n), /E_NOT_ALLOWLISTED/);
      await assert.rejects(spend(shop.accountId, ONE), /E_PER_TX/);
      await root.call(guard, 'pause', {});
      await assert.rejects(spend(shop.accountId, 1n), /E_PAUSED/);
      await root.call(guard, 'unpause', {});
    });
    await t.test('actual function-call key can spend but cannot administer or transfer', async () => {
      const key = KeyPair.fromRandom('ed25519');
      // Sandbox gas price is 10x testnet's, so 100 Tgas of prepaid gas costs ~0.101 NEAR of
      // allowance here; 0.1 NEAR (the testnet demo value) is exhausted before the first call.
      await agent.batch(agent).addKey(key.getPublicKey(), transactions.functionCallAccessKey(guard.accountId, ['spend'], ONE / 2n)).transact();
      await spend(shop.accountId, 1n, key);
      await assert.rejects(agent.call(guard, 'pause', {}, { signWithKey: key }));
      await assert.rejects(agent.batch(shop).transfer(ONE / 10n).transact(key));
    });
    await t.test('callback and approval fit their gas at maximum bounded state', async () => {
      // 32 agents with 32-entry allowlists, 64 pending requests, a full 128-entry audit ring.
      const TG = 1_000_000_000_000n;
      const allow = (n) => Array.from({ length: 32 }, (_, i) => (i === 0 ? shop.accountId : `${n}${String(i).padStart(2, '0')}${'z'.repeat(48)}.test.near`));
      const big = { per_tx_max: ONE.toString(), daily_max: (100n * ONE).toString(), approval_threshold: '0', paused: false };
      const bulk = await root.createSubAccount('bulk');
      for (let start = 0; start < 31; start += 8) {
        let tx = root.batch(guard);
        for (let i = start; i < Math.min(start + 8, 31); i += 1) {
          const id = i === 0 ? bulk.accountId : `a${i}.test.near`;
          tx = tx.functionCall('add_agent', { agent: id, policy: { ...big, allowlist: allow(String(i).padStart(3, '0')) } }, { gas: 30n * TG });
        }
        await tx.transact();
      }
      const pendingNow = (await guard.view('list_pending')).length;
      for (let n = pendingNow; n < 64; n += 8) {
        let tx = bulk.batch(guard);
        for (let i = n; i < Math.min(n + 8, 64); i += 1) {
          tx = tx.functionCall('spend', { receiver: shop.accountId, amount: (ONE / 100n).toString(), memo: 'm'.repeat(256) }, { gas: 30n * TG });
        }
        await tx.transact();
      }
      const pendingList = await guard.view('list_pending');
      assert.equal(pendingList.length, 64);
      assert.equal((await guard.view('get_audit', { from: '0', limit: 128 })).length, 128);
      // Fill the original agent's allowlist too: 32 x 32 = 1,024 entries in total.
      await root.call(guard, 'update_policy', { agent: agent.accountId, policy: { ...policy, allowlist: allow('zzz') } });
      const request = pendingList.find((r) => r.agent === bulk.accountId);
      const result = await root.callRaw(guard, 'approve', { request_id: request.id }, { gas: GAS });
      const outcomes = result.result.receipts_outcome;
      const callback = outcomes.find((r) => r.outcome.logs.some((l) => l.includes('"transfer_succeeded"')));
      assert.ok(callback, 'callback receipt found');
      const approveBurnt = BigInt(outcomes[0].outcome.gas_burnt);
      const callbackBurnt = BigInt(callback.outcome.gas_burnt);
      t.diagnostic(`max state: approve ${Number(approveBurnt) / 1e12} Tgas, on_transfer ${Number(callbackBurnt) / 1e12} Tgas (budget 50)`);
      assert.ok(callbackBurnt < 30n * TG, `callback used ${callbackBurnt}`);
      assert.deepEqual(await guard.view('list_transfers'), []);
      // An immediate-transfer spend at this state, with 100 Tgas prepaid and 50 reserved.
      await root.call(guard, 'update_policy', { agent: bulk.accountId, policy: { ...big, approval_threshold: ONE.toString(), allowlist: allow('000') } });
      const before = BigInt((await shop.balance()).total);
      const direct = await bulk.callRaw(guard, 'spend', { receiver: shop.accountId, amount: '1', memo: 'm'.repeat(256) }, { gas: GAS });
      const failures = direct.result.receipts_outcome.filter((r) => r.outcome.status.Failure);
      assert.deepEqual(failures, [], 'all receipts succeed');
      assert.equal(BigInt((await shop.balance()).total) - before, 1n);
      const spendBurnt = BigInt(direct.result.receipts_outcome[0].outcome.gas_burnt);
      const spendCallback = direct.result.receipts_outcome.find((r) => r.outcome.logs.some((l) => l.includes('"transfer_succeeded"')));
      assert.ok(spendCallback, 'spend callback receipt found');
      t.diagnostic(`max state: spend ${Number(spendBurnt) / 1e12} Tgas, its on_transfer ${Number(BigInt(spendCallback.outcome.gas_burnt)) / 1e12} Tgas`);
      assert.deepEqual(await guard.view('list_transfers'), []);
      await root.call(guard, 'remove_agent', { agent: bulk.accountId }, { gas: GAS });
      assert.equal((await guard.view('list_pending')).length, 0);
    });
  } finally {
    await worker.tearDown();
    await new Promise((r) => setTimeout(r, 1000));
    await clean().catch((e) => t.diagnostic(`chain dir cleanup deferred to next run: ${e.code}`));
  }
});
