import { assertTestnetChain, explorerTx, keyPairFrom, parseRequest, paymentExitCode, refusalCode, summarizeOutcome, testnetAccount } from './parse.mjs';

// The spend return value (`{status, request_id | transfer_id}`) is base64 JSON in SuccessValue.
function spendResult(result) {
  try { return JSON.parse(Buffer.from(result.status.SuccessValue, 'base64').toString()); } catch { return null; }
}

async function main() {
  const input = process.argv.slice(2);
  const submit = input.includes('--submit');
  const args = parseRequest(input.filter((x) => x !== '--submit').join(' '));
  if (!submit) {
    console.log(JSON.stringify({ mode: 'offline', network: 'testnet', method: 'spend', args }, null, 2));
    return;
  }
  const agent = testnetAccount(process.env.NEAR_AGENT_ACCOUNT, 'NEAR_AGENT_ACCOUNT');
  const contract = testnetAccount(process.env.NEAR_CONTRACT_ACCOUNT, 'NEAR_CONTRACT_ACCOUNT');
  if (!process.env.NEAR_AGENT_PRIVATE_KEY) throw new Error('Set NEAR_AGENT_PRIVATE_KEY to the restricted function-call key');
  const { connect, keyStores, KeyPair } = await import('near-api-js');
  const keyPair = keyPairFrom(KeyPair, process.env.NEAR_AGENT_PRIVATE_KEY, 'NEAR_AGENT_PRIVATE_KEY');
  const keys = new keyStores.InMemoryKeyStore();
  await keys.setKey('testnet', agent, keyPair);
  const near = await connect({ networkId: 'testnet', nodeUrl: process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com', keyStore: keys, logger: false });
  await assertTestnetChain(near.connection.provider);
  const account = await near.account(agent);
  // Refuse a full-access key or a broader function-call key before spending.
  const key = await account.getAccessKeys().then((all) => all.find((k) => k.public_key === keyPair.getPublicKey().toString()));
  const permission = key?.access_key.permission?.FunctionCall;
  if (!permission || permission.receiver_id !== contract || permission.method_names.length !== 1 || permission.method_names[0] !== 'spend' || permission.allowance === null) {
    throw new Error('Agent key must allow only spend on this contract with a finite gas allowance');
  }
  let result;
  try {
    result = await account.functionCall({ contractId: contract, methodName: 'spend', args, gas: 100_000_000_000_000n, attachedDeposit: 0n });
  } catch (error) {
    // The contract refused the request on chain: the transaction exists but moved no funds.
    const hash = error?.transaction_outcome?.id;
    const code = refusalCode(error?.message);
    if (!hash || !code) throw error;
    console.log(JSON.stringify({ transaction: hash, explorer: explorerTx(hash), accepted: false, payment: 'refused', reason: code }, null, 2));
    process.exitCode = 3;
    return;
  }
  const summary = summarizeOutcome(result);
  const extra = summary.payment === 'awaiting_owner_approval' ? { request_id: spendResult(result)?.request_id } : {};
  console.log(JSON.stringify({ transaction: result.transaction.hash, explorer: explorerTx(result.transaction.hash), ...summary, ...extra }, null, 2));
  // `unknown` (no terminal event) is not success: keep the hash and exit 2 for reconciliation.
  if (paymentExitCode(summary.payment)) process.exitCode = 2;
}

main().catch((error) => {
  // Never echo key material or RPC request objects.
  console.error(error instanceof Error ? error.message : 'Demo failed');
  process.exitCode = 1;
});
