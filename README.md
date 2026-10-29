# NEAR Agent Spend Guard

Give an AI agent a spending budget without giving it control of the wallet. This
phase 1 prototype is a Rust NEAR contract that holds native NEAR and enforces
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

   → See `pass 13` and `fail 0`, including exact amounts, rejected invalid input, and the
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
   and testnet run; ~50 MB) into the ignored `.tmp/` directory. See `pass 9` and `fail 0`
   (1 test with 8 on-chain subtests): atomic deploy + private `new`, a third party unable to
   initialize, a transfer, reserve/reject/approve, a real failed-transfer callback rollback,
   the callback's measured gas (also at maximum bounded state: 32 agents × 32 allowlist
   entries, 64 pending requests, full audit ring), owner/allowlist/cap/pause errors, and a function-call key
   that can call `spend` but cannot administer or transfer. The diagnostics print the
   sandbox version and `on_transfer gas_burnt`.

   The test does not use near-workspaces' bundled neard 2.6.2: it cannot load WASM built
   by current Rust (`PrepareError: Deserialization`). To use your own sandbox binary, set
   `SPEND_GUARD_SANDBOX_BIN=/absolute/path/to/near-sandbox`. neard raises its open-file
   limit to 65535; on a host whose hard limit is lower the test reports an explicit skip,
   which is not evidence of on-chain success.

## Deploying (phase 2)

`new` is `#[private]`: deploy and initialize in **one batch transaction signed by the
contract account** (DeployContract + FunctionCall `new {"owner": "<owner>.testnet"}`), so
nobody can front-run initialization. The integration test does exactly this.

## Scope and next phase

Phase 1 is local. Testnet deployment, account funding, policy provisioning, key
installation, and live submissions belong to phase 2 and have not been performed.
`.env.example` lists the optional testnet configuration; the demo reads process
environment variables and does not load `.env` itself. Keep private keys outside
tracked files. The contract needs its own funded balance and storage reserve.
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
