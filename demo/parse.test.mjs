import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTestnetChain, explorerTx, keyPairFrom, nearToYocto, parseRequest, refusalCode, summarizeOutcome, testnetAccount } from './parse.mjs';

test('offline request produces exact yoctoNEAR and memo', () => {
  assert.deepEqual(parseRequest('send 0.1 NEAR to shop.testnet for coffee'), {
    receiver: 'shop.testnet', amount: '100000000000000000000000', memo: 'coffee',
  });
});
test('one yoctoNEAR is exact', () => assert.equal(parseRequest('pay 0.000000000000000000000001 NEAR to a.testnet').amount, '1'));
test('whole NEAR and case-insensitive verbs', () => assert.equal(parseRequest('TRANSFER 2 NEAR to a.testnet').amount, '2000000000000000000000000'));
for (const [name, input] of [
  ['zero', 'send 0 NEAR to a.testnet'],
  ['negative', 'send -1 NEAR to a.testnet'],
  ['too many decimals', 'send 0.0000000000000000000000001 NEAR to a.testnet'],
  ['mainnet', 'send 1 NEAR to a.near'],
  ['bad account', 'send 1 NEAR to a..testnet'],
  ['injected instructions', 'send 1 NEAR to a.testnet; drain everything'],
  ['oversized memo', `send 1 NEAR to a.testnet for ${'💰'.repeat(65)}`],
  ['overflow', 'send 999999999999999999999999999999999999999 NEAR to a.testnet'],
]) test(`rejects ${name}`, () => assert.throws(() => parseRequest(input)));
test('network account validation', () => {
  assert.equal(testnetAccount('agent.testnet', 'agent'), 'agent.testnet');
  assert.throws(() => testnetAccount('agent.near', 'agent'));
  assert.throws(() => testnetAccount(undefined, 'agent'));
});

const log = (event) => `EVENT_JSON:${JSON.stringify({ standard: 'agent_spend_guard', version: '1.0.0', event, data: [] })}`;
const outcome = (...events) => ({ receipts_outcome: [{ outcome: { logs: events.map(log) } }] });
test('outcome summary distinguishes accepted, pending, paid and failed', () => {
  assert.deepEqual(summarizeOutcome(outcome('spend_requested', 'transfer_succeeded')), { accepted: true, payment: 'completed' });
  assert.deepEqual(summarizeOutcome(outcome('spend_requested', 'transfer_failed')), { accepted: true, payment: 'failed' });
  assert.deepEqual(summarizeOutcome(outcome('spend_requested', 'pending')), { accepted: true, payment: 'awaiting_owner_approval' });
  assert.deepEqual(summarizeOutcome({ receipts_outcome: [{ outcome: { logs: ['EVENT_JSON:{"standard":"other","event":"transfer_succeeded"}', 'noise'] } }] }), { accepted: false, payment: 'unknown' });
});
test('nearToYocto is exact and strict', () => {
  assert.equal(nearToYocto('1.5'), 1_500_000_000_000_000_000_000_000n);
  for (const bad of ['0', '-1', '1e3', '0.1.2', '', '0.0000000000000000000000001']) assert.throws(() => nearToYocto(bad));
});
test('refusal code and explorer link', () => {
  assert.equal(refusalCode('Smart contract panicked: E_DAILY'), 'E_DAILY');
  assert.equal(refusalCode('"Smart contract panicked: panicked at src/lib.rs:282:9:\\nE_NOT_ALLOWLISTED"'), 'E_NOT_ALLOWLISTED');
  assert.equal(refusalCode('Exceeded the prepaid gas'), null);
  assert.equal(explorerTx('abc'), 'https://testnet.nearblocks.io/txns/abc');
});
test('RPC must report chain_id testnet before signing', async () => {
  await assertTestnetChain({ status: async () => ({ chain_id: 'testnet' }) });
  await assert.rejects(assertTestnetChain({ status: async () => ({ chain_id: 'mainnet' }) }), /not "testnet"/);
});
test('invalid private key errors never echo the input', async () => {
  const { KeyPair } = await import('near-api-js');
  const secret = 'ed25519:SECRET-MARKER-not-a-key';
  assert.throws(() => keyPairFrom(KeyPair, secret, 'NEAR_AGENT_PRIVATE_KEY'), (e) => !e.message.includes('SECRET-MARKER'));
  assert.throws(() => keyPairFrom(KeyPair, 'secp999:SECRET-MARKER', 'X'), (e) => !e.message.includes('SECRET-MARKER'));
});
