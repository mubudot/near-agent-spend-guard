import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ONE = 10n ** 24n;
const GAS = 100_000_000_000_000n;

test('sandbox: transfers, reservations, approvals, rollback and restricted access key', { timeout: 180_000 }, async (t) => {
  // No public RPC endpoints. Sandbox keys and chain data remain inside the repository.
  const temp = resolve('.tmp/integration');
  await mkdir(temp, { recursive: true });
  process.env.TMPDIR = temp;
  const binary = process.env.SPEND_GUARD_SANDBOX_BIN;
  if (binary) {
    await access(binary);
    const preflight = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15_000 });
    if (preflight.status !== 0) {
      if (preflight.stderr?.includes("couldn't set the file descriptor limit")) {
        t.skip(`Sandbox cannot start with this container's hard file-descriptor limit: ${preflight.stderr.split('\n')[0]}`);
        return;
      }
      throw new Error(`Sandbox preflight failed: ${preflight.error?.message ?? preflight.stderr}`);
    }
    // near-workspaces 5's bundled downloader predates Linux ARM support. Its exported
    // binary factory lets us use a locally installed, newer official sandbox binary.
    const utils = require(join(dirname(require.resolve('near-workspaces')), 'internal-utils.js'));
    utils.sandboxBinary = async () => ({ binPath: binary, exists: async () => true });
  } else if (process.platform === 'linux' && process.arch === 'arm64') {
    t.skip('near-workspaces bundled downloader does not support Linux ARM64; set SPEND_GUARD_SANDBOX_BIN to an official ARM binary');
    return;
  }
  // Avoid the old downloader's ~/.near default on supported hosts as well.
  process.env.NEAR_SANDBOX_BIN_PATH = temp;
  process.env.NEAR_SANDBOX_BINARY_PATH = temp;
  const wasm = resolve('target/wasm32-unknown-unknown/release/near_agent_spend_guard.wasm');
  await access(wasm);
  const { Worker } = await import('near-workspaces');
  const { KeyPair, transactions } = await import('near-api-js');
  const worker = await Worker.init({ network: 'sandbox', homeDir: join(temp, 'chain'), rm: true });
  try {
    const root = worker.rootAccount;
    const guard = await root.createSubAccount('guard', { initialBalance: 20n * ONE });
    const agent = await root.createSubAccount('agent');
    const shop = await root.createSubAccount('shop');
    const stranger = await root.createSubAccount('stranger');
    const missing = `missing.${root.accountId}`;
    await guard.deploy(wasm);
    await root.call(guard, 'new', { owner: root.accountId });
    const policy = {
      per_tx_max: (ONE / 2n).toString(), daily_max: (2n * ONE).toString(),
      approval_threshold: (ONE / 5n).toString(), allowlist: [shop.accountId, missing], paused: false,
    };
    await root.call(guard, 'add_agent', { agent: agent.accountId, policy });
    const spend = (receiver, amount, signWithKey) => agent.call(guard, 'spend', {
      receiver, amount: amount.toString(), memo: 'sandbox',
    }, { gas: GAS, signWithKey });
    const spent = () => guard.view('get_spent_today', { agent: agent.accountId });
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
      await agent.batch(agent).addKey(key.getPublicKey(), transactions.functionCallAccessKey(guard.accountId, ['spend'], ONE / 10n)).transact();
      await spend(shop.accountId, 1n, key);
      await assert.rejects(agent.call(guard, 'pause', {}, { signWithKey: key }));
      await assert.rejects(agent.batch(shop).transfer(ONE / 10n).transact(key));
    });
  } finally {
    await worker.tearDown();
  }
});
