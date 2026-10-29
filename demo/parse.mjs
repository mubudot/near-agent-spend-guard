const YOCTO = 10n ** 24n;

// Strict, intentionally small offline grammar. Never guesses a receiver or rounds money.
export function parseRequest(text) {
  const match = /^(?:send|pay|transfer)\s+(\d+(?:\.\d{1,24})?)\s+NEAR\s+to\s+([a-z0-9._-]+)(?:\s+for\s+(.+))?$/i.exec(text.trim());
  if (!match) throw new Error('Use: send <decimal> NEAR to <account.testnet> [for <memo>]');
  const [, decimal, receiver, memo = 'Offline rule-based agent'] = match;
  if (receiver.length < 2 || receiver.length > 64 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(receiver)) {
    throw new Error('Invalid NEAR account ID');
  }
  if (!receiver.endsWith('.testnet')) throw new Error('Demo receivers must end in .testnet');
  const [whole, fraction = ''] = decimal.split('.');
  const amount = BigInt(whole) * YOCTO + BigInt(fraction.padEnd(24, '0'));
  if (amount <= 0n || amount >= 2n ** 128n) throw new Error('Amount must be positive and fit u128');
  if (Buffer.byteLength(memo, 'utf8') > 256) throw new Error('Memo exceeds 256 UTF-8 bytes');
  return { receiver, amount: amount.toString(), memo };
}

export function testnetAccount(value, name) {
  if (!value || value.length > 64 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*\.testnet$/.test(value)) {
    throw new Error(`${name} must be a testnet account ID`);
  }
  return value;
}
