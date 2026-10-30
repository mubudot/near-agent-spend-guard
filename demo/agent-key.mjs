// Shared testnet path for the agent: connect with the restricted function-call key, verify that
// the key can only call `spend` on the guard, submit `spend`, and report the on-chain outcome.
// Used by demo/agent.mjs (rule-based) and demo/ai-agent.mjs (LLM-driven).
import { assertTestnetChain, explorerTx, keyPairFrom, refusalCode, summarizeOutcome, testnetAccount } from './parse.mjs';

export const SPEND_GAS = 100_000_000_000_000n;

// The spend return value (`{status, request_id | transfer_id}`) is base64 JSON in SuccessValue.
export function spendResult(result) {
  try { return JSON.parse(Buffer.from(result.status.SuccessValue, 'base64').toString()); } catch { return null; }
}

// Accept only a function-call key for exactly [spend] on this contract with a finite allowance.
export function isSpendOnlyKey(key, contract) {
  const permission = key?.access_key?.permission?.FunctionCall;
  return Boolean(permission && permission.receiver_id === contract && permission.method_names.length === 1
    && permission.method_names[0] === 'spend' && permission.allowance !== null);
}

export async function connectAgent(env = process.env) {
  const agent = testnetAccount(env.NEAR_AGENT_ACCOUNT, 'NEAR_AGENT_ACCOUNT');
  const contract = testnetAccount(env.NEAR_CONTRACT_ACCOUNT, 'NEAR_CONTRACT_ACCOUNT');
  if (!env.NEAR_AGENT_PRIVATE_KEY) throw new Error('Set NEAR_AGENT_PRIVATE_KEY to the restricted function-call key');
  const { connect, keyStores, KeyPair } = await import('near-api-js');
  const keyPair = keyPairFrom(KeyPair, env.NEAR_AGENT_PRIVATE_KEY, 'NEAR_AGENT_PRIVATE_KEY');
  const keys = new keyStores.InMemoryKeyStore();
  await keys.setKey('testnet', agent, keyPair);
  const near = await connect({ networkId: 'testnet', nodeUrl: env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com', keyStore: keys, logger: false });
  await assertTestnetChain(near.connection.provider);
  const account = await near.account(agent);
  // Refuse a full-access key or a broader function-call key before spending.
  const key = await account.getAccessKeys().then((all) => all.find((k) => k.public_key === keyPair.getPublicKey().toString()));
  if (!isSpendOnlyKey(key, contract)) throw new Error('Agent key must allow only spend on this contract with a finite gas allowance');
  return { agent, contract, account };
}

// Submit one spend. Returns the structured outcome; an on-chain refusal is a result, not an error.
export async function submitSpend({ account, contract }, args) {
  let result;
  try {
    result = await account.functionCall({ contractId: contract, methodName: 'spend', args, gas: SPEND_GAS, attachedDeposit: 0n });
  } catch (error) {
    // The contract refused the request on chain: the transaction exists but moved no funds.
    const hash = error?.transaction_outcome?.id;
    const code = refusalCode(error?.message);
    if (!hash || !code) throw error;
    return { transaction: hash, explorer: explorerTx(hash), accepted: false, payment: 'refused', reason: code };
  }
  const summary = summarizeOutcome(result);
  const extra = summary.payment === 'awaiting_owner_approval' ? { request_id: spendResult(result)?.request_id } : {};
  return { transaction: result.transaction.hash, explorer: explorerTx(result.transaction.hash), ...summary, ...extra };
}

// Read-only budget view for the agent (finalized state; no key needed).
export async function readBudget({ account, contract, agent }) {
  const view = (methodName, args) => account.viewFunction({ contractId: contract, methodName, args });
  return { agent, contract, paused: await view('is_paused', {}), policy: await view('get_policy', { agent }), spent_today: await view('get_spent_today', { agent }) };
}
