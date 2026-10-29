import { testnetAccount } from './parse.mjs';

try {
  const agent = testnetAccount(process.env.NEAR_AGENT_ACCOUNT, 'NEAR_AGENT_ACCOUNT');
  const contract = testnetAccount(process.env.NEAR_CONTRACT_ACCOUNT, 'NEAR_CONTRACT_ACCOUNT');
  const publicKey = process.env.NEAR_AGENT_PUBLIC_KEY;
  if (!publicKey?.startsWith('ed25519:')) throw new Error('Set NEAR_AGENT_PUBLIC_KEY to the agent public key');
  if (!process.argv.includes('--submit')) {
    console.log(JSON.stringify({ account: agent, publicKey, permission: { receiver_id: contract, method_names: ['spend'], allowance: '100000000000000000000000' } }, null, 2));
  } else {
    if (!process.env.NEAR_AGENT_OWNER_PRIVATE_KEY) throw new Error('Set NEAR_AGENT_OWNER_PRIVATE_KEY to the full-access key controlling the agent account');
    const { connect, keyStores, KeyPair } = await import('near-api-js');
    const keys = new keyStores.InMemoryKeyStore();
    await keys.setKey('testnet', agent, KeyPair.fromString(process.env.NEAR_AGENT_OWNER_PRIVATE_KEY));
    const near = await connect({ networkId: 'testnet', nodeUrl: 'https://rpc.testnet.near.org', keyStore: keys });
    const account = await near.account(agent);
    await account.addKey(publicKey, contract, ['spend'], 100_000_000_000_000_000_000_000n);
    console.log('Restricted spend key installed on the agent account; allowance: 0.1 testnet NEAR');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Key installation failed');
  process.exitCode = 1;
}
