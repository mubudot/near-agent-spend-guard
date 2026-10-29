import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, testnetAccount } from './parse.mjs';

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
