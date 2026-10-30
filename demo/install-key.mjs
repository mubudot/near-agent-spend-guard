import { assertTestnetChain, explorerTx, keyPairFrom, nearToYocto, publicKeyFrom, testnetAccount } from './parse.mjs';

// Gas allowance only: it caps what the key can burn on gas, not what the contract pays out.
// NEAR charges the allowance for the full prepaid gas at a pessimistic price, so one 100 Tgas
// call costs ~0.101 NEAR of allowance on testnet; 0.1 NEAR would refuse every call.
const ALLOWANCE = process.env.NEAR_AGENT_KEY_ALLOWANCE || '1';

try {
  const agent = testnetAccount(process.env.NEAR_AGENT_ACCOUNT, 'NEAR_AGENT_ACCOUNT');
  const contract = testnetAccount(process.env.NEAR_CONTRACT_ACCOUNT, 'NEAR_CONTRACT_ACCOUNT');
  const { utils } = await import('near-api-js');
  // Validated and normalized before any output: a private key pasted here is never printed.
  const publicKey = publicKeyFrom(utils.PublicKey, process.env.NEAR_AGENT_PUBLIC_KEY, 'NEAR_AGENT_PUBLIC_KEY');
  const allowance = nearToYocto(ALLOWANCE);
  if (!process.argv.includes('--submit')) {
    console.log(JSON.stringify({ account: agent, publicKey, permission: { receiver_id: contract, method_names: ['spend'], allowance: allowance.toString() } }, null, 2));
  } else {
    if (!process.env.NEAR_AGENT_OWNER_PRIVATE_KEY) throw new Error('Set NEAR_AGENT_OWNER_PRIVATE_KEY to the full-access key controlling the agent account');
    const { connect, keyStores, KeyPair } = await import('near-api-js');
    const keys = new keyStores.InMemoryKeyStore();
    await keys.setKey('testnet', agent, keyPairFrom(KeyPair, process.env.NEAR_AGENT_OWNER_PRIVATE_KEY, 'NEAR_AGENT_OWNER_PRIVATE_KEY'));
    const near = await connect({ networkId: 'testnet', nodeUrl: process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com', keyStore: keys, logger: false });
    await assertTestnetChain(near.connection.provider);
    const account = await near.account(agent);
    const result = await account.addKey(publicKey, contract, ['spend'], allowance);
    console.log(JSON.stringify({ action: 'add-key', transaction: result.transaction.hash, explorer: explorerTx(result.transaction.hash), account: agent, publicKey, receiver_id: contract, method_names: ['spend'], allowance_near: ALLOWANCE }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Key installation failed');
  process.exitCode = 1;
}
