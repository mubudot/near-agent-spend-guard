// Paid-invoice ledger for demo/ai-agent.mjs: each merchant invoice is paid at most once.
//
// This is an agent-harness control, not an on-chain one. The guard contract enforces the
// allowlist and the caps; it does not (yet) know invoice ids, so two identical `spend` calls
// within the caps are both accepted on chain. The ledger refuses the second one before it is
// submitted. It is kept in memory for the run and, when a path is configured, persisted as a
// small JSON file outside the repository so a rerun cannot pay the same invoice again either.
// On-chain per-invoice idempotency (an invoice id / nonce checked by the contract) is a planned
// contract upgrade; until then a second harness (or a second machine) is not covered.
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_LEDGER_PATH = join(homedir(), '.near-agent-spend-guard', 'paid-invoices.json');

// "Invoice #1042", "#1042" and "1042" are the same invoice. Ids are short and printable.
export function normalizeInvoiceId(raw) {
  const id = String(raw ?? '').trim().replace(/^invoice\b\s*/i, '').replace(/^#\s*/, '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:/-]{0,63}$/.test(id)) {
    throw new Error('invoice_id is required: copy the invoice number from the merchant page (letters, digits, . _ : / -; at most 64 characters)');
  }
  return id;
}

// Payment states that block a second payment: money moved, may still move (held for the owner),
// may have moved (submission outcome unknown), or the submission is in flight ("submitting" is
// written before the transaction is sent, so a crash mid-submission still blocks a rerun).
// A contract refusal or a failed payout moved nothing: its reservation is released, so the
// invoice can be paid later (e.g. after the owner raises a cap).
const BLOCKING = new Set(['submitting', 'completed', 'awaiting_owner_approval', 'unknown']);

export class InvoiceLedger {
  // path: JSON file to persist to, or null for an in-memory ledger (this run only).
  // scope: what the ids are unique within (the guard contract account, or "simulated").
  constructor({ path = null, scope = 'simulated' } = {}) {
    this.path = path;
    this.scope = scope;
    this.entries = path ? load(path) : {};
  }

  key(receiver, invoiceId) { return `${this.scope}|${receiver}|${invoiceId}`; }

  // Returns the earlier record if this invoice was already paid (or is in flight / unknown).
  find(receiver, invoiceId) { return this.entries[this.key(receiver, invoiceId)] ?? null; }

  // Throws the error the model sees when the invoice was already paid.
  assertUnpaid(receiver, invoiceId) {
    const prior = this.find(receiver, invoiceId);
    if (!prior) return;
    const tx = prior.transaction ? `, transaction ${prior.transaction}` : '';
    const error = new Error(`duplicate payment refused: invoice ${invoiceId} to ${receiver} was already paid or submitted (${prior.payment}, ${prior.amount_near} NEAR, ${prior.at}${tx}). Each invoice is paid at most once; do not pay it again.`);
    error.duplicate = true;
    throw error;
  }

  // Before submitting: write a blocking "submitting" record (persisted first when a path is set).
  // Throws (and the caller must not submit) if the invoice is already recorded or the write fails.
  reserve(receiver, invoiceId, amountNear) {
    this.assertUnpaid(receiver, invoiceId);
    const key = this.key(receiver, invoiceId);
    this.entries[key] = { receiver, invoice_id: invoiceId, amount_near: amountNear, payment: 'submitting', at: new Date().toISOString() };
    try { this.persist(); } catch (error) { delete this.entries[key]; throw error; }
  }

  // After the contract answered (or the submission failed: payment "unknown"): keep a blocking
  // outcome, release the reservation otherwise. A failed write leaves the earlier on-disk record
  // ("submitting"), which still blocks.
  settle(receiver, invoiceId, { payment, transaction } = {}) {
    const key = this.key(receiver, invoiceId);
    const prior = this.entries[key];
    if (!prior) return;
    if (BLOCKING.has(payment)) this.entries[key] = { ...prior, payment, ...(transaction ? { transaction } : {}), at: new Date().toISOString() };
    else delete this.entries[key];
    this.persist();
  }

  persist() { if (this.path) save(this.path, this.entries); }
}

// A record is valid only under its own key (<scope>|<receiver>|<invoice_id>), so a misfiled
// record cannot leave its invoice looking unpaid.
const isRecord = ([key, e]) => e !== null && typeof e === 'object' && !Array.isArray(e)
  && typeof e.receiver === 'string' && typeof e.invoice_id === 'string' && BLOCKING.has(e.payment)
  && key.endsWith(`|${e.receiver}|${e.invoice_id}`);

function load(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`cannot read the paid-invoice ledger (${error?.code ?? 'read error'}); fix or move AI_AGENT_LEDGER before paying`);
  }
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  // Fail closed: a damaged ledger (or a damaged record in it) could hide a paid invoice.
  const paid = data?.version === 1 ? data.paid : null;
  if (paid === null || typeof paid !== 'object' || Array.isArray(paid) || !Object.entries(paid).every(isRecord)) {
    throw new Error('the paid-invoice ledger is not valid JSON in the expected format; fix or move AI_AGENT_LEDGER before paying');
  }
  return paid;
}

function save(path, paid) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // A fresh, unpredictable temp file created exclusively (never follows or reuses an existing
  // file), mode 0600, then renamed over the ledger: a crash never leaves half a ledger.
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify({ version: 1, paid }, null, 2)}\n`); } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (error) { rmSync(tmp, { force: true }); throw error; }
}

// Where the CLI keeps the ledger: AI_AGENT_LEDGER (a path, or "memory" for this run only).
// Default: persisted for --submit (real payments), in memory for the offline simulator,
// whose budget also resets every run.
export function ledgerFor({ submit, env = process.env }) {
  const configured = (env.AI_AGENT_LEDGER ?? '').trim();
  const scope = submit ? `testnet:${env.NEAR_CONTRACT_ACCOUNT ?? ''}` : 'simulated';
  if (configured.toLowerCase() === 'memory') return new InvoiceLedger({ scope });
  if (configured) return new InvoiceLedger({ path: configured, scope });
  return new InvoiceLedger({ path: submit ? DEFAULT_LEDGER_PATH : null, scope });
}
