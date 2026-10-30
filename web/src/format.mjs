// Pure formatting helpers shared by the dashboard and its tests. No DOM, no network.

export const YOCTO = 10n ** 24n;
export const EXPLORER = 'https://testnet.nearblocks.io';

const ACCOUNT_RE = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export const isAccountId = (value) => typeof value === 'string' && ACCOUNT_RE.test(value);
export const isTestnetAccount = (value) => isAccountId(value) && value.endsWith('.testnet');
export const isTxHash = (value) => typeof value === 'string' && TX_HASH_RE.test(value);

// yoctoNEAR decimal string (or bigint) -> "1.2 NEAR". Exact: truncates, never rounds up.
export function formatNear(yocto, { maxFraction = 4, unit = true } = {}) {
  const v = BigInt(yocto);
  const sign = v < 0n ? '-' : '';
  const abs = v < 0n ? -v : v;
  const whole = abs / YOCTO;
  const rest = abs % YOCTO;
  const fraction = rest.toString().padStart(24, '0').slice(0, maxFraction).replace(/0+$/, '');
  const suffix = unit ? ' NEAR' : '';
  // Dust below the display precision stays visible instead of reading as zero.
  if (whole === 0n && rest !== 0n && !fraction) return `<${sign}0.${'0'.repeat(maxFraction - 1)}1${suffix}`;
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}${suffix}`;
}

// Integer percentage 0..100 of part/whole, computed on bigints (no float precision loss).
export function percent(part, whole) {
  const p = BigInt(part);
  const w = BigInt(whole);
  if (w <= 0n) return p > 0n ? 100 : 0;
  if (p <= 0n) return 0;
  const pct = (p * 100n) / w;
  return Number(pct > 100n ? 100n : pct);
}

// NEAR block timestamps are nanoseconds since the epoch, as decimal strings.
export const nsToMs = (ns) => Number(BigInt(ns) / 1_000_000n);

export function formatUtc(ms) {
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

// "in 3h 05m", "4m ago", "just now"
export function relativeTime(targetMs, nowMs) {
  const diff = targetMs - nowMs;
  const abs = Math.abs(diff);
  if (abs < 45_000) return 'just now';
  const minutes = Math.floor(abs / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  let text;
  if (days > 0) text = `${days}d ${hours}h`;
  else if (hours > 0) text = `${hours}h ${String(mins).padStart(2, '0')}m`;
  else text = `${mins}m`;
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

export const shortHash = (hash, keep = 8) => (hash.length > keep + 1 ? `${hash.slice(0, keep)}…` : hash);
export const explorerTx = (hash) => `${EXPLORER}/txns/${encodeURIComponent(hash)}`;
export const explorerAccount = (id) => `${EXPLORER}/address/${encodeURIComponent(id)}`;

// Next UTC midnight after nowMs: when the daily budget resets and pending requests expire.
export function nextUtcMidnight(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
