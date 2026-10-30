import { linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

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
  const amount = nearToYocto(decimal);
  if (Buffer.byteLength(memo, 'utf8') > 256) throw new Error('Memo exceeds 256 UTF-8 bytes');
  return { receiver, amount: amount.toString(), memo };
}

// Exact decimal NEAR -> yoctoNEAR (1 NEAR = 10^24); no floating point, no rounding.
export function nearToYocto(decimal) {
  if (!/^\d+(?:\.\d{1,24})?$/.test(String(decimal))) throw new Error('Amount must be a decimal NEAR value with at most 24 decimals');
  const [whole, fraction = ''] = String(decimal).split('.');
  const amount = BigInt(whole) * YOCTO + BigInt(fraction.padEnd(24, '0'));
  if (amount <= 0n || amount >= 2n ** 128n) throw new Error('Amount must be positive and fit u128');
  return amount;
}

export const explorerTx = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;

// A refused spend panics in the contract; keep only the contract's error code (E_...).
export function refusalCode(message) {
  // RPC errors embed the panic text JSON-escaped (`...lib.rs:282:9:\\nE_DAILY`), so no \\b.
  return /(?:^|[^A-Z_])(E_[A-Z][A-Z_]*)/.exec(String(message ?? ''))?.[1] ?? null;
}

export function testnetAccount(value, name) {
  if (!value) {
    throw new Error(`${name} is not set: export ${name}=<account>.testnet (see README "Rerun on testnet with your own accounts")`);
  }
  if (value.length > 64 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*\.testnet$/.test(value)) {
    throw new Error(`${name} must be a testnet account ID: lowercase, at most 64 characters, ending in .testnet`);
  }
  return value;
}

// Accepting a spend is not the same as paying: the transfer runs in a later receipt and
// can fail. Read the contract's own audit events from the final execution outcome.
export function summarizeOutcome(result) {
  const events = (result?.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? [])
    .filter((l) => l.startsWith('EVENT_JSON:'))
    .map((l) => { try { return JSON.parse(l.slice('EVENT_JSON:'.length)); } catch { return null; } })
    .filter((e) => e?.standard === 'agent_spend_guard').map((e) => e.event);
  if (events.includes('pending')) return { accepted: true, payment: 'awaiting_owner_approval' };
  if (events.includes('transfer_succeeded')) return { accepted: true, payment: 'completed' };
  if (events.includes('transfer_failed')) return { accepted: true, payment: 'failed' };
  return { accepted: events.includes('spend_requested'), payment: 'unknown' };
}

// Fail closed unless the RPC really serves testnet (networkId alone only names the key namespace).
export async function assertTestnetChain(provider) {
  const { chain_id: chainId } = await provider.status();
  if (chainId !== 'testnet') throw new Error(`RPC chain_id is ${JSON.stringify(chainId)}, not "testnet"; refusing to sign`);
}

// Parse a private key without ever echoing the input in an error message.
export function keyPairFrom(KeyPair, secret, label) {
  try { return KeyPair.fromString(secret); } catch { throw new Error(`${label} is not a valid ed25519 private key`); }
}

// Parse a public key (ed25519, 32 bytes) without echoing the input; a pasted private key
// (64 bytes, same `ed25519:` prefix) is rejected before anything is printed.
export function publicKeyFrom(PublicKey, value, label) {
  let key;
  try { key = PublicKey.fromString(String(value ?? '')); } catch { key = null; }
  if (!key || key.data?.length !== 32 || !String(value).startsWith('ed25519:')) throw new Error(`${label} must be an ed25519 public key (32 bytes)`);
  return key.toString();
}

// Exit status for a submitted spend or approval: 0 only for a settled payment or a request
// held for the owner; 2 when the payout failed or its outcome could not be determined.
export const paymentExitCode = (payment) => (payment === 'completed' || payment === 'awaiting_owner_approval' ? 0 : 2);

export function setAsideKey(dir, name, suffix = randomBytes(4).toString('hex')) {
  const from = join(dir, `${name}.json`);
  const to = join(dir, `${name}.json.unconfirmed-${suffix}`);
  linkSync(from, to); // fails with EEXIST instead of overwriting
  unlinkSync(from);
  return `${name}.json.unconfirmed-${suffix}`;
}
