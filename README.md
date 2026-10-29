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

The owner initializes the contract, adds agents, updates policies, pauses globally
or per agent, approves/rejects pending requests, removes agents, and withdraws
unreserved funds. Owner and contract accounts cannot be registered as agents.
Agents must call directly: predecessor and signer accounts must match.

Each policy has `per_tx_max`, `daily_max`, `allowlist`, `approval_threshold`, and
`paused`. Amounts are decimal strings in yoctoNEAR (1 NEAR = 10^24 yoctoNEAR).
An empty allowlist permits no receivers. A spend at or below the approval
threshold transfers immediately; one above it creates a pending request, provided
it remains within the hard caps. Hard-cap violations fail even with approval.

Pending requests reserve both daily budget and contract liquidity. They expire at
the next UTC midnight derived from block time. Rejecting or expiring releases the
reservation; anyone can call `expire`. `spend` and `withdraw` also sweep expired
requests. Approval rechecks the current policy and pause state. Failed transfer
callbacks restore the agent's daily budget, with day and agent-generation checks
so an old callback cannot reduce a new budget. Withdrawals retain pending reserves
and storage headroom.

Views are `get_owner`, `is_paused`, `get_policy`, `get_spent_today`, `list_pending`,
and `get_audit`. Audit history retains the latest 128 entries and emits NEP-297
`EVENT_JSON` logs with standard `agent_spend_guard`, version `1.0.0`. The audit
`from` argument is an absolute event ID; expired pending entries remain visible
until explicitly expired or swept. Limits are 32 agents, 32 allowlist entries per
policy, 64 pending requests, 64 in-flight agent transfers, and 256 memo bytes.

## Reproduce locally: do X → see Y

Use Node.js 20+ and npm. Rust builds require a native C/C++ toolchain (or the
provided Zig wrappers) and the `wasm32-unknown-unknown` target. Run commands from
the repository root. The environment helper selects toolchains installed under
`<toolchain dir>` and keeps temporary files under the ignored `.tmp/` directory.
On another machine, install Rust there or adapt those helper paths to your setup.

1. Run the Rust unit tests:

   ```bash
   source scripts/rust-env.sh
   cargo test
   ```

   → See tests for allowlists, caps, UTC rollover, approvals, rejection, expiry,
   pause, authorization, callback rollback, reservations, and bounded audit logs.
   See [STATUS.md](STATUS.md) for the observed result and test count.

2. Install the locked JavaScript dependencies and test the parser:

   ```bash
   npm ci --ignore-scripts
   npm test
   ```

   → See 12 passing tests, including exact amounts and rejected invalid input.
   Dependency installation needs registry access; the parser and offline demo do
   not contact a network. Install scripts are deferred so the sandbox downloader
   is only invoked when the integration test needs it.

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

   → See `Demo receivers must end in .testnet` and a nonzero exit status.
   Accepted verbs are `send`, `pay`, and `transfer`, with an optional `for <memo>`.

4. Build the contract:

   ```bash
   source scripts/rust-env.sh
   cargo build --locked --target wasm32-unknown-unknown --release
   ```

   → See `target/wasm32-unknown-unknown/release/near_agent_spend_guard.wasm`.

5. Exercise a local sandbox after building:

   ```bash
   npm run test:integration
   ```

   → On a supported host, run transfers, reservations, approvals, real callback
   rollback, policy checks, and restricted-key checks against a local chain. The
   sandbox downloader may need network access for its binary. Linux ARM64 needs
   an explicit compatible binary:

   ```bash
   SPEND_GUARD_SANDBOX_BIN=/absolute/path/to/near-sandbox npm run test:integration
   ```

   → Unsupported ARM64 downloads or the detected container file-descriptor limit
   produce an explicit skip. A skipped test is not evidence of on-chain success;
   the actual result in this workspace is recorded in [STATUS.md](STATUS.md).

## Scope and next phase

Phase 1 is local. Testnet deployment, account funding, policy provisioning, key
installation, and live submissions belong to phase 2 and have not been performed.
`.env.example` lists the optional testnet configuration; the demo reads process
environment variables and does not load `.env` itself. Keep private keys outside
tracked files. The contract needs its own funded balance and storage reserve.
This prototype has not received an independent security audit; real-chain callback
behavior remains subject to the integration result above.

The demo is deliberately rule-based. It makes no LLM calls and implements no LLM
mode. AI tools used for development: Hark and OpenAI Codex (coding agents).

Author: **mubudot**. The author's sibling project is
**paypal-guardrail-buyer**, a separate project disclosed alongside this NEAR
hackathon entry. License: [MIT](LICENSE).
