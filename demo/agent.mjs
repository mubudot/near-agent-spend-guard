import { parseRequest, testnetAccount } from './parse.mjs';

try {
  const input = process.argv.slice(2);
  const submit = input.includes('--submit');
  const args = parseRequest(input.filter((x) => x !== '--submit').join(' '));
  if (!submit) {
    console.log(JSON.stringify({ mode: 'offline', network: 'testnet', method: 'spend', args }, null, 2));
  } else {
    const agent = testnetAccount(process.env.NEAR_AGENT_ACCOUNT, 'NEAR_AGENT_ACCOUNT');
    const contract = testnetAccount(process.env.NEAR_CONTRACT_ACCOUNT, 'NEAR_CONTRACT_ACCOUNT');
    if (!process.env.NEAR_AGENT_PRIVATE_KEY) throw new Error('Set NEAR_AGENT_PRIVATE_KEY to the restricted function-call key');
    const { connect, keyStores, KeyPair } = await import('near-api-js');
    const keys = new keyStores.InMemoryKeyStore();
    await keys.setKey('testnet', agent, KeyPair.fromString(process.env.NEAR_AGENT_PRIVATE_KEY));
    const near = await connect({ networkId: 'testnet', nodeUrl: 'https://rpc.testnet.near.org', keyStore: keys });
    const account = await near.account(agent);
    // Refuse a full-access key or a broader function-call key before spending.
    const key = await account.getAccessKeys().then((all) => all.find((k) => k.public_key === KeyPair.fromString(process.env.NEAR_AGENT_PRIVATE_KEY).getPublicKey().toString()));
    const permission = key?.access_key.permission?.FunctionCall;
    if (!permission || permission.receiver_id !== contract || permission.method_names.length !== 1 || permission.method_names[0] !== 'spend' || permission.allowance === null) {
      throw new Error('Agent key must allow only spend on this contract with a finite gas allowance');
    }
    const result = await account.functionCall({ contractId: contract, methodName: 'spend', args, gas: 100_000_000_000_000n, attachedDeposit: 0n });
    console.log(JSON.stringify({ transaction: result.transaction.hash, status: result.status }, null, 2));
  }
} catch (error) {
  // Never echo key material or RPC request objects.
  console.error(error instanceof Error ? error.message : 'Demo failed');
  process.exitCode = 1;
}
