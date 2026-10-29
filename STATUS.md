# Status

## Phase 1: complete (local). Phase 2 (testnet deploy and live demo): not started.

Last verified 2026-10-30 from a **fresh clone** on a clean x86_64 Linux host
(Ubuntu 24.04, rustup + build-essential, Node.js 24.11.1, npm 11.6.2), following only the
README, with no extra environment variables:

| README step | Result |
| --- | --- |
| 1. `cargo test` (rustup auto-installed the pinned Rust 1.99.1 + wasm32 target) | **26 passed, 0 failed** |
| 2. `npm ci --ignore-scripts && npm test` | **13 passed, 0 failed** |
| 3. Offline demo / mainnet receiver | Expected `spend` JSON / `Demo receivers must end in .testnet`, exit 1 |
| 4. `cargo build --locked --target wasm32-unknown-unknown --release` | Passed, ~277 KB WASM |
| 5. `npm run test:integration` (auto-downloaded nearcore 2.14.0 sandbox) | **9 passed (1 test + 8 on-chain subtests), 0 failed, 0 skipped**; a second run (cached sandbox) also 9/9 |

Total: **48 passed, 0 failed.** Measured `on_transfer` callback: ~2.3 Tgas at small state and ~19 Tgas at maximum
occupancy (budget 50 Tgas; the original 15 Tgas would have run out there). An immediate
`spend` at maximum occupancy burns ~20 Tgas plus the ~19 Tgas callback, within 100 Tgas prepaid.

Review history, findings, and fixes: [docs/REVIEW_LOG.md](docs/REVIEW_LOG.md).
Rules checklist: [docs/REQUIREMENTS_CHECK.md](docs/REQUIREMENTS_CHECK.md).

## Known limitations

- near-workspaces 5.0.0 bundles neard 2.6.2, which cannot load WASM from current Rust
  (`PrepareError: Deserialization`). The integration test therefore uses the official
  nearcore 2.14.0 sandbox (same release as mainnet and testnet), or `SPEND_GUARD_SANDBOX_BIN`.
- The owner is trusted: removing and re-adding an agent resets its daily budget.
- State is one unversioned Borsh value; a future layout change needs a migration method.
- No professional audit; AI-assisted review only.
- `npm` reports deprecated `tar@6.2.1` inside near-workspaces' dependency tree (dev only).

## Phase 2 (not done)

Testnet deployment (atomic deploy + private `new`), funding, owner policy setup,
restricted-key installation (`demo/install-key.mjs`), a live `demo/agent.mjs --submit`
run, and the demo video. No push, public-chain deployment, real-fund transaction, or LLM
call has been performed.
