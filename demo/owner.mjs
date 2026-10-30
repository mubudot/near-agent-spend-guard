// Testnet provisioning and owner actions. Keys live in NEAR_KEY_DIR (default ./.near,
// git-ignored) as <account_id>.json files; private keys are never printed.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertTestnetChain, explorerTx, keyPairFrom, nearToYocto, summarizeOutcome, testnetAccount } from './parse.mjs';

const GAS = 100_000_000_000_000n;
const KEY_DIR = resolve(process.env.NEAR_KEY_DIR || '.near');
const RPC = process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com';
const WASM = resolve(process.env.SPEND_GUARD_WASM || 'target/wasm32-unknown-unknown/release/near_agent_spend_guard.wasm');
const USAGE = `Usage (testnet only; NEAR_OWNER_ACCOUNT and NEAR_CONTRACT_ACCOUNT in the environment):
  node demo/owner.mjs faucet-account [name]           new <name>.testnet from the public testnet faucet
  node demo/owner.mjs create-account <name> <NEAR>    create <name>.<owner> funded by the owner
  node demo/owner.mjs new-key <file-name>             new key pair file; prints the public key only
  node demo/owner.mjs deploy                          DeployContract + new{owner} in one batch tx
  node demo/owner.mjs add-agent <agent> --allow <a,b> --per-tx <NEAR> --daily <NEAR> --threshold <NEAR>
  node demo/owner.mjs fund <NEAR>                     owner transfers NEAR to the contract
  node demo/owner.mjs approve <request_id> | reject <request_id>
  node demo/owner.mjs status [agent]                  read-only views`;

const keyPath = (name) => join(KEY_DIR, `${name}.json`);
function saveKey(name, accountId, keyPair) {
  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  // 'wx' = O_CREAT|O_EXCL: never overwrites and never follows a planted symlink.
  try {
    writeFileSync(keyPath(name), JSON.stringify({ account_id: accountId, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Refusing to overwrite ${name}.json in NEAR_KEY_DIR`);
    throw new Error(`Cannot write ${name}.json in NEAR_KEY_DIR (${error?.code ?? 'error'})`);
  }
}
function loadKey(accountId) {
  const path = keyPath(accountId);
  if (!existsSync(path)) throw new Error(`No key file for ${accountId} in NEAR_KEY_DIR (expected ${accountId}.json)`);
  // Never let a parse error quote the file's contents.
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`${accountId}.json in NEAR_KEY_DIR is not valid JSON`); }
}
// After a failed create, keep the key only if the account exists on chain; otherwise a
// leftover file would block a retry with the same name.
async function cleanupKey(name, accountId) {
  const exists = await (await rpc()).connection.provider.query({ request_type: 'view_account', finality: 'final', account_id: accountId }).then(() => true, (e) => (/does not exist|UNKNOWN_ACCOUNT/i.test(String(e?.message)) ? false : null));
  if (exists === false) { unlinkSync(keyPath(name)); return 'key file removed (account was not created)'; }
  return exists ? 'account exists; key file kept' : 'account state unknown; key file kept (delete it if the account does not exist)';
}

async function signer(accountId) {
  const { connect, keyStores, KeyPair } = await import('near-api-js');
  const keys = new keyStores.InMemoryKeyStore();
  await keys.setKey('testnet', accountId, keyPairFrom(KeyPair, loadKey(accountId).private_key, `${accountId}.json private_key`));
  const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore: keys, logger: false });
  await assertTestnetChain(near.connection.provider);
  return near.account(accountId);
}
async function rpc() {
  const { connect } = await import('near-api-js');
  const near = await connect({ networkId: 'testnet', nodeUrl: RPC, logger: false });
  await assertTestnetChain(near.connection.provider);
  return near.account('dontcare');
}
function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}\n${USAGE}`);
  return args[i + 1];
}
const done = (action, result, extra = {}) => console.log(JSON.stringify({ action, transaction: result.transaction.hash, explorer: explorerTx(result.transaction.hash), ...extra }, null, 2));

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { KeyPair, transactions } = await import('near-api-js');
  const owner = () => testnetAccount(process.env.NEAR_OWNER_ACCOUNT, 'NEAR_OWNER_ACCOUNT');
  const contract = () => testnetAccount(process.env.NEAR_CONTRACT_ACCOUNT, 'NEAR_CONTRACT_ACCOUNT');
  switch (command) {
    case 'faucet-account': {
      // Free testnet account from the public faucet helper (the one near-cli-rs
      // `sponsor-by-faucet-service` uses). Testnet NEAR only; no real funds involved.
      const id = testnetAccount(`${args[0] ?? `spendguard-${randomBytes(3).toString('hex')}`}.testnet`, 'new account');
      await rpc(); // chain check before creating anything
      const keyPair = KeyPair.fromRandom('ed25519');
      saveKey(id, id, keyPair);
      const res = await fetch(process.env.NEAR_FAUCET_URL || 'https://helper.nearprotocol.com/account', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newAccountId: id, newAccountPublicKey: keyPair.getPublicKey().toString() }),
      }).catch(() => null);
      if (!res?.ok) {
        const detail = res ? `${res.status} ${(await res.text()).slice(0, 200)}` : 'network error';
        throw new Error(`Faucet did not create ${id}: ${detail}; ${await cleanupKey(id, id)}`);
      }
      const hash = (await res.json())?.transaction?.hash;
      return console.log(JSON.stringify({ action: 'faucet-account', account: id, public_key: keyPair.getPublicKey().toString(), ...(hash ? { transaction: hash, explorer: explorerTx(hash) } : {}) }, null, 2));
    }
    case 'create-account': {
      const [name, amount] = args;
      if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(name ?? '') || !amount) throw new Error(USAGE);
      const id = testnetAccount(`${name}.${owner()}`, 'new account');
      const deposit = nearToYocto(amount);
      const funder = await signer(owner());
      const keyPair = KeyPair.fromRandom('ed25519');
      saveKey(id, id, keyPair);
      let result;
      try { result = await funder.createAccount(id, keyPair.getPublicKey(), deposit); } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : 'createAccount failed'}; ${await cleanupKey(id, id)}`);
      }
      return done('create-account', result, { account: id, public_key: keyPair.getPublicKey().toString() });
    }
    case 'new-key': {
      const [name] = args;
      if (!/^[a-z0-9-]+$/.test(name ?? '')) throw new Error(USAGE);
      const keyPair = KeyPair.fromRandom('ed25519');
      saveKey(name, null, keyPair);
      return console.log(JSON.stringify({ key_file: `${name}.json`, public_key: keyPair.getPublicKey().toString() }, null, 2));
    }
    case 'deploy': {
      // `new` is private: only a batch signed by the contract account can initialize it.
      const code = readFileSync(WASM);
      const result = await (await signer(contract())).signAndSendTransaction({
        receiverId: contract(),
        actions: [transactions.deployContract(code), transactions.functionCall('new', { owner: owner() }, GAS, 0n)],
      });
      return done('deploy+new', result, { contract: contract(), owner: owner(), wasm_bytes: code.length });
    }
    case 'add-agent': {
      const agent = testnetAccount(args[0], 'agent');
      const allowlist = flag(args, '--allow').split(',').map((a) => testnetAccount(a.trim(), 'allowlist entry'));
      const policy = {
        per_tx_max: nearToYocto(flag(args, '--per-tx')).toString(), daily_max: nearToYocto(flag(args, '--daily')).toString(),
        approval_threshold: nearToYocto(flag(args, '--threshold')).toString(), allowlist, paused: false,
      };
      const result = await (await signer(owner())).functionCall({ contractId: contract(), methodName: 'add_agent', args: { agent, policy }, gas: GAS });
      return done('add-agent', result, { agent, policy });
    }
    case 'fund': {
      const result = await (await signer(owner())).sendMoney(contract(), nearToYocto(args[0] ?? ''));
      return done('fund', result, { to: contract(), amount_near: args[0] });
    }
    case 'approve':
    case 'reject': {
      if (!/^\d+$/.test(args[0] ?? '')) throw new Error(USAGE);
      const result = await (await signer(owner())).functionCall({ contractId: contract(), methodName: command, args: { request_id: args[0] }, gas: GAS });
      if (command === 'reject') return done(command, result, { request_id: args[0] });
      // Approval schedules the payout in a later receipt; report how it settled.
      const { payment } = summarizeOutcome(result);
      done(command, result, { request_id: args[0], payment });
      if (payment !== 'completed') process.exitCode = 2;
      return;
    }
    case 'status': {
      const v = await rpc();
      const view = (methodName, a = {}) => v.viewFunction({ contractId: contract(), methodName, args: a });
      const pending = await view('list_pending');
      // Mirrors the contract's ensure_liquid: storage stake + 65,536 bytes headroom + pending reserves.
      const state = await v.connection.provider.query({ request_type: 'view_account', finality: 'final', account_id: contract() });
      const { storage_amount_per_byte: perByte } = (await v.connection.provider.experimental_protocolConfig({ finality: 'final' })).runtime_config;
      const reserved = pending.reduce((sum, r) => sum + BigInt(r.amount), 0n);
      const available = BigInt(state.amount) - (BigInt(state.storage_usage) + 65_536n) * BigInt(perByte) - reserved;
      const out = {
        contract: contract(), owner: await view('get_owner'), paused: await view('is_paused'), pending,
        balance: state.amount, available_for_payouts: (available > 0n ? available : 0n).toString(),
      };
      if (args[0]) {
        const agent = testnetAccount(args[0], 'agent');
        const keys = (await v.connection.provider.query({ request_type: 'view_access_key_list', finality: 'final', account_id: agent })).keys;
        const spendKeys = keys.filter((k) => k.access_key.permission?.FunctionCall?.receiver_id === contract())
          .map((k) => ({ public_key: k.public_key, method_names: k.access_key.permission.FunctionCall.method_names, allowance: k.access_key.permission.FunctionCall.allowance }));
        Object.assign(out, { agent, policy: await view('get_policy', { agent }), spent_today: await view('get_spent_today', { agent }), agent_keys_for_contract: spendKeys });
      }
      return console.log(JSON.stringify(out, null, 2));
    }
    default:
      throw new Error(USAGE);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Owner command failed');
  process.exitCode = 1;
});
