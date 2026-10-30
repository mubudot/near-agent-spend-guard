# NEAR Agent Spend Guard

Give an AI agent a spending budget without giving it control of the wallet. This
prototype is a Rust NEAR contract that holds native NEAR and enforces
owner-set policies for each agent account. A small Node demo turns a constrained
natural-language request into a `spend` call without an AI service or API key.

An agent can be mistaken or prompt-injected. Receiver allowlists, per-transaction
and daily caps, approval thresholds, and pause controls put the spending decision
on chain. The owner keeps the full-access keys; the agent receives a function-call
key on its own account restricted to this contract's `spend` method, with a finite
gas allowance. The demo checks those permissions before submission. Gas allowance
pays for calls; the contract's policy separately limits the funds it transfers.

## Architecture and behavior

- `src/lib.rs`: contract and bounded state; `src/tests.rs`: unit tests.
- `demo/parse.mjs`: strict offline grammar and exact decimal-to-yoctoNEAR conversion.
- `demo/agent.mjs`: offline preview by default; explicit `--submit` uses testnet.
- `demo/install-key.mjs`: previews a restricted key permission, or installs it on
  testnet with `--submit` using the account owner's separate credential.
- `demo/owner.mjs`: testnet provisioning and owner actions (faucet account, sub-accounts,
  atomic deploy + `new`, `add-agent`, `approve`/`reject`, read-only `status`).
- `integration/guard.test.mjs`: local near-workspaces sandbox test.

The contract account initializes itself (`new` is private) and names the owner. The
owner adds agents, updates policies, pauses globally
or per agent, approves/rejects pending requests, removes agents, and withdraws
unreserved funds, and can clear a transfer entry whose callback never completed once its
UTC day has passed (`clear_stale_transfer`). Owner and contract accounts cannot be registered as agents.
Agents must call directly: predecessor and signer accounts must match.

Each policy has `per_tx_max`, `daily_max`, `allowlist`, `approval_threshold`, and
`paused`. Amounts are decimal strings in yoctoNEAR (1 NEAR = 10^24 yoctoNEAR).
An empty allowlist permits no receivers. A spend at or below the approval
threshold transfers immediately; one above it creates a pending request, provided
it remains within the hard caps. Hard-cap violations fail even with approval.

Pending requests reserve both daily budget and contract liquidity. They expire at
the next UTC midnight derived from block time. Rejecting or expiring releases the
reservation; anyone can call `expire`. `spend` and `withdraw` also sweep expired
requests (at most 16 per call, so events stay under the 16 KiB receipt log limit).
Approval rechecks the current policy and pause state. Failed transfer
callbacks restore the agent's daily budget, with day and agent-generation checks
so an old callback cannot reduce a new budget. Withdrawals retain pending reserves
and storage headroom.

Views are `get_owner`, `is_paused`, `get_policy`, `get_spent_today`, `list_pending`,
`list_transfers`, and `get_audit`. Audit history retains the latest 128 entries and emits NEP-297
`EVENT_JSON` logs with standard `agent_spend_guard`, version `1.0.0`. The audit
`from` argument is an absolute event ID; expired pending entries remain visible
until explicitly expired or swept. Limits are 32 agents, 32 allowlist entries per
policy, 64 pending requests, 64 in-flight agent transfers, and 256 memo bytes.

Trust model: the owner is trusted; the agent is not. Removing and re-adding an agent is an
owner action and starts that agent's daily budget from zero. State is a single
unversioned Borsh value; a future layout change needs a migration method. The `spend`
result means "accepted"; the payment itself settles in a later receipt, which the demo
reports separately (`payment: completed | failed | awaiting_owner_approval`).

## Reproduce locally: do X → see Y

Prerequisites: [rustup](https://rustup.rs) with a C toolchain (`build-essential` on
Debian/Ubuntu, Xcode CLT on macOS), Node.js 20+ with npm, `tar`, and internet access for
the first run. `rust-toolchain.toml` pins Rust 1.99.1 with the `wasm32-unknown-unknown`
target; rustup installs both automatically on the first `cargo` command. Run everything
from the repository root. No account, key, or API token is needed.

1. Run the Rust unit tests:

   ```bash
   cargo test
   ```

   → See `test result: ok. 26 passed; 0 failed`. Tests cover allowlists, caps, UTC rollover,
   approvals, rejection, expiry, pause, authorization, private initialization, callback
   rollback, reservations, the 16 KiB receipt log limit at maximum pending requests,
   stale-transfer cleanup, and bounded audit logs.

2. Install the locked JavaScript dependencies and test the parser:

   ```bash
   npm ci --ignore-scripts
   npm test
   ```

   → See `pass 17` and `fail 0`, including exact amounts, rejected invalid input, and the
   outcome summary that tells "accepted" apart from "paid".

3. Preview an agent request without credentials:

   ```bash
   npm run demo -- 'send 0.1 NEAR to shop.testnet for coffee'
   ```

   → See `mode: "offline"`, `method: "spend"`, and arguments:

   ```json
   {"receiver":"shop.testnet","amount":"100000000000000000000000","memo":"coffee"}
   ```

   ```bash
   npm run demo -- 'send 1 NEAR to shop.near'
   ```

   → See `Demo receivers must end in .testnet` and exit status 1.
   Accepted verbs are `send`, `pay`, and `transfer`, with an optional `for <memo>`.

4. Build the contract:

   ```bash
   cargo build --locked --target wasm32-unknown-unknown --release
   ```

   → See `target/wasm32-unknown-unknown/release/near_agent_spend_guard.wasm` (~270 KB).

5. Run the on-chain integration test against a local NEAR sandbox:

   ```bash
   npm run test:integration
   ```

   → The first run downloads the official nearcore **2.14.0** sandbox (the release mainnet
   and testnet run; ~36 MB download) into the ignored `.tmp/` directory. See `pass 9` and `fail 0`
   (1 test with 8 on-chain subtests): atomic deploy + private `new`, a third party unable to
   initialize, a transfer, reserve/reject/approve, a real failed-transfer callback rollback,
   the callback's measured gas (also at maximum occupancy: 32 agents × 32 allowlist
   entries, 64 pending requests, full audit ring, for `approve` and an immediate `spend`), owner/allowlist/cap/pause errors, and a function-call key
   that can call `spend` but cannot administer or transfer. The diagnostics print the
   sandbox version and `on_transfer gas_burnt`.

   The test does not use near-workspaces' bundled neard 2.6.2: it cannot load WASM built
   by current Rust (`PrepareError: Deserialization`). To use your own sandbox binary, set
   `SPEND_GUARD_SANDBOX_BIN=/absolute/path/to/near-sandbox`. neard raises its open-file
   limit to 65535; on a host whose hard limit is lower the test reports an explicit skip,
   which is not evidence of on-chain success.

## Live on testnet

The contract is deployed on NEAR **testnet** (no mainnet deployment, no real funds):

| Role | Account |
| --- | --- |
| Contract (guard) | [`guard.spendguard-b31c91.testnet`](https://testnet.nearblocks.io/address/guard.spendguard-b31c91.testnet) |
| Owner | `spendguard-b31c91.testnet` |
| Agent (only a `spend`-restricted function-call key is used) | `agent.spendguard-b31c91.testnet` |
| Allowlisted merchant | `shop.spendguard-b31c91.testnet` |

The deployed code hash `CuJqiX8P7XpVgYRBtX3vwZuHFHJNiNE1KHmny3picmdf` is the base58
SHA-256 of the WASM that step 4 builds from this repository. The live run (immediate
payment, owner-approved pending payment, two on-chain refusals) with every transaction
link is in [docs/TESTNET_RUN.md](docs/TESTNET_RUN.md).

View it without any account or key (read-only RPC calls; needs the npm dependencies from step 2):

```bash
NEAR_CONTRACT_ACCOUNT=guard.spendguard-b31c91.testnet node demo/owner.mjs status agent.spendguard-b31c91.testnet
```

→ See `owner`, `paused: false`, `available_for_payouts`, the agent's `policy` (allowlist,
caps, threshold), `spent_today` (current UTC day; resets at UTC midnight) and its single
function-call key (`method_names: ["spend"]`, finite `allowance`).

### Rerun on testnet with your own accounts

Optional. Needs Node, the npm dependencies from step 2 (`npm ci --ignore-scripts`) and the
WASM from step 4, run from the repository root in bash. The first command creates a fresh
owner account from the public testnet faucet (free testnet NEAR, 10 NEAR) and stores its keys
in `./.near/` (git-ignored, file mode 600). Private keys are never printed. Run all steps
within one UTC day: pending requests expire and daily budgets reset at UTC midnight.

```bash
export NEAR_KEY_DIR=$PWD/.near
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)['$1']))"; }
export NEAR_OWNER_ACCOUNT=$(node demo/owner.mjs faucet-account | json account)
echo "$NEAR_OWNER_ACCOUNT"                    # → spendguard-<6 hex>.testnet
export NEAR_CONTRACT_ACCOUNT=guard.$NEAR_OWNER_ACCOUNT NEAR_AGENT_ACCOUNT=agent.$NEAR_OWNER_ACCOUNT
export SHOP=shop.$NEAR_OWNER_ACCOUNT
node demo/owner.mjs create-account guard 6    # contract account; ~2.8 NEAR is storage stake
node demo/owner.mjs create-account agent 0.5
node demo/owner.mjs create-account shop 0.1
node demo/owner.mjs deploy                    # DeployContract + new{owner} in one batch tx
node demo/owner.mjs add-agent $NEAR_AGENT_ACCOUNT --allow $SHOP --per-tx 1 --daily 1.2 --threshold 0.2
export NEAR_AGENT_PUBLIC_KEY=$(node demo/owner.mjs new-key agent-spend-key | json public_key)
NEAR_AGENT_OWNER_PRIVATE_KEY=$(json private_key < "$NEAR_KEY_DIR/$NEAR_AGENT_ACCOUNT.json") \
  node demo/install-key.mjs --submit          # FunctionCall key: receiver = guard, methods = [spend], allowance 1 NEAR
export NEAR_AGENT_PRIVATE_KEY=$(json private_key < "$NEAR_KEY_DIR/agent-spend-key.json")
```

Each command prints JSON with the transaction hash and a testnet.nearblocks.io link. Then
act as the agent and the owner:

```bash
npm run -s demo -- --submit "send 0.1 NEAR to $SHOP for coffee"
# → "payment": "completed"  (below the 0.2 NEAR threshold: paid immediately)
npm run -s demo -- --submit "send 0.5 NEAR to $SHOP for API credits" | tee "$NEAR_KEY_DIR/pending.json"
# → "payment": "awaiting_owner_approval", "request_id": "<n>"  (0.5 NEAR reserved, not paid)
ID=$(json request_id < "$NEAR_KEY_DIR/pending.json")
node demo/owner.mjs approve "$ID"
# → "action": "approve", "payment": "completed"  (exit 2 if the payout failed)
npm run -s demo -- --submit "send 0.1 NEAR to stranger.testnet for refund"
# → "payment": "refused", "reason": "E_NOT_ALLOWLISTED"  (exit status 3, no funds moved)
npm run -s demo -- --submit "send 0.7 NEAR to $SHOP for second order"
# → "payment": "refused", "reason": "E_DAILY"  (0.6 + 0.7 > 1.2 daily cap; exit status 3)
node demo/owner.mjs status $NEAR_AGENT_ACCOUNT
# → "pending": [], "spent_today": "600000000000000000000000" (0.6 NEAR), the policy,
#   available_for_payouts, and the agent's spend-only key with its remaining allowance
```

All scripts use FastNEAR's public testnet RPC `https://test.rpc.fastnear.com`
(`rpc.testnet.near.org` is deprecated and rate-limits); set `NEAR_RPC_URL` to use another.
Every signing command first checks that the RPC reports `chain_id` `testnet`, and every
account must end in `.testnet`. Refused requests are real failed transactions on chain:
the contract panics with the error code and no funds move. If a create step fails, the
script removes the new key file when the account does not exist, so the step can be
rerun. To use an account you already have instead of the faucet, put its key file
(`{"account_id","public_key","private_key"}`, the near-cli legacy format, e.g.
`~/.near-credentials/testnet/<you>.testnet.json`) in `NEAR_KEY_DIR`, set
`NEAR_OWNER_ACCOUNT` to it, and skip the `faucet-account` line.

## Deploying

`new` is `#[private]`: deploy and initialize in **one batch transaction signed by the
contract account** (DeployContract + FunctionCall `new {"owner": "<owner>.testnet"}`), so
nobody can front-run initialization. The integration test does exactly this.
`demo/owner.mjs deploy` sends exactly this batch. Attach 100 Tgas to `spend` and `approve`.
The agent key's gas allowance must exceed one call's prepaid gas at NEAR's pessimistic gas
price (~0.101 NEAR for 100 Tgas on testnet; a 0.1 NEAR allowance rejects every call), so
`install-key.mjs` defaults to 1 NEAR (`NEAR_AGENT_KEY_ALLOWANCE` overrides). Unused gas is
refunded to the allowance; the live run used ~0.0014 NEAR of it for four calls. Immediate-transfer spends and approvals reserve
50 Tgas for the `on_transfer` callback (pending spends schedule none). The integration test
measures the callback at ~19 Tgas in its maximum-occupancy configuration. The expiry sweep
(up to 16 requests) inside `spend` is not measured on chain; 150 Tgas is a conservative choice.

## Scope

Testnet only: nothing is deployed to mainnet and no real funds are used. The local
steps 1–5 need no account. `.env.example` lists the optional testnet configuration; the
demo reads process environment variables and does not load `.env` itself. Keep private
keys outside tracked files (`.near/` and `.env*` are git-ignored). The contract needs its own funded balance and storage reserve.
This prototype has not received a professional security audit; it has had AI-assisted
review only (see [docs/REVIEW_LOG.md](docs/REVIEW_LOG.md)).

The demo is deliberately rule-based. It makes no LLM calls and implements no LLM
mode. AI tools used for development: Hark and OpenAI Codex (coding agents, including code
review). Libraries: near-sdk 5.17.2 (Rust), near-api-js 5.1.1, near-workspaces 5.0.0.
All code was written for this hackathon; no earlier codebase is reused.
Rule-by-rule checklist: [docs/REQUIREMENTS_CHECK.md](docs/REQUIREMENTS_CHECK.md).

Author: **mubudot**. The author's sibling project is
**paypal-guardrail-buyer**, a separate project disclosed alongside this NEAR
hackathon entry. License: [MIT](LICENSE).
