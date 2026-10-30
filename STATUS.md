# Status

## Phase 1 (local): complete. Phase 2 (testnet deploy and live demo): complete. Demo video: recorded (not posted). AI-agent mode: added and run live.

### AI-agent mode (2026-10-30)

`demo/ai-agent.mjs`: an LLM (Anthropic Messages API, or a deterministic offline mock that obeys every
injected instruction) drives the agent through the same `spend`-only function-call key; `spend` is its only
money tool and arguments are format-checked only, so the contract decides. Scripted prompt-injection scenario
(hidden text on a merchant page asking for 0.5 NEAR to `stranger.testnet` and 0.9 NEAR "priority processing").
Live on testnet: mock → `completed`, `E_NOT_ALLOWLISTED`, `E_DAILY`; Claude (`claude-sonnet-5-5`, one run)
paid only the 0.1 NEAR invoice and flagged the injection. Offline the 0.9 NEAR call is held for owner approval.
Also `docs/status.html`, a static read-only page that reads the live policy, spent today, pending requests and
the audit ring from testnet RPC. Hashes: [docs/TESTNET_RUN.md](docs/TESTNET_RUN.md#ai-agent-mode-prompt-injection).

### Phase 2 — live on NEAR testnet (2026-10-29 23:39–23:49 UTC)

Contract `guard.spendguard-b31c91.testnet` (owner `spendguard-b31c91.testnet`), deployed
and initialized in one batch transaction; code hash matches the locally built WASM. Live
outcomes, each a testnet transaction: immediate payment below the approval threshold,
a pending request above it that the owner approved and that then paid, and two on-chain
refusals (`E_NOT_ALLOWLISTED`, `E_DAILY`). The README's "Rerun on testnet with your own
accounts" steps were then run verbatim with a fresh faucet account and gave identical
results; after the Codex review fixes, both bash blocks of that README section were
executed unmodified from the file with another fresh faucet account, again with identical
results. Hashes and links: [docs/TESTNET_RUN.md](docs/TESTNET_RUN.md).

Live-run fixes: restricted-key gas allowance 0.1 → 1 NEAR (0.1 refused every 100 Tgas call),
structured `refused` output with the contract error code, quiet JSON output, FastNEAR
testnet RPC as default (the old endpoint is deprecated and rate-limits). Codex review
fixes: exclusive 0600 key-file creation, no secret echo in errors, `chain_id == testnet`
check before signing, `approve` reports payout settlement, failed creates clean up their
key file, `status` shows liquidity and key allowance, README rerun fully copy-pasteable.

### Tests

| Suite | Result |
| --- | --- |
| `cargo test` | **26 passed, 0 failed** (final re-check 2026-10-30, fresh clone, Linux ARM64; `src/` unchanged since phase 1) |
| `npm test` | **39 passed, 0 failed** (AI-agent round: +16 tests for `demo/ai-agent.mjs` and the shared key check; before: 23) |
| `npm run test:integration` (nearcore 2.14.0 sandbox) | **9 passed (1 test + 8 on-chain subtests), 0 failed** in the phase 1 fresh-clone run on x86_64. On the 2026-10-30 ARM64 host it was **skipped** (re-confirmed in the final re-check): neard needs a file-descriptor limit of 65,535 and the host's hard limit is 4,096. Test file and contract unchanged since that run. |

Total: **74 passed, 0 failed** (26 + 39 + 9), plus the live testnet run, three fresh-account
reruns (the third after the second Codex round, README blocks run unmodified under `bash -e`)
and the recorded demo take ([TESTNET_RUN.md](docs/TESTNET_RUN.md)).
The deployed code hash equals the WASM built from the unchanged source on the x86_64 build host (cargo registry at `/root/.cargo`); an ARM64 rebuild differs by 189 bytes even with the registry path remapped, see README "Live on testnet".

Measured `on_transfer` callback: ~2.3 Tgas at small state and ~19 Tgas at maximum
occupancy (budget 50 Tgas). An immediate `spend` at maximum occupancy burns ~20 Tgas plus
the ~19 Tgas callback, within 100 Tgas prepaid.

Review history, findings, and fixes: [docs/REVIEW_LOG.md](docs/REVIEW_LOG.md).
Rules checklist: [docs/REQUIREMENTS_CHECK.md](docs/REQUIREMENTS_CHECK.md).

## Known limitations

- near-workspaces 5.0.0 bundles neard 2.6.2, which cannot load WASM from current Rust
  (`PrepareError: Deserialization`). The integration test therefore uses the official
  nearcore 2.14.0 sandbox (same release as mainnet and testnet), or `SPEND_GUARD_SANDBOX_BIN`.
- The owner is trusted: removing and re-adding an agent resets its daily budget.
- State is one unversioned Borsh value; a future layout change needs a migration method.
- The testnet demo depends on public testnet services (faucet helper, FastNEAR RPC).
- No professional audit; AI-assisted review only.
- `npm` reports deprecated `tar@6.2.1` inside near-workspaces' dependency tree (dev only).

## Left

Reviewing and posting the demo video (recorded from a live take, kept outside the repository; [docs/VIDEO_PLAN.md](docs/VIDEO_PLAN.md)), making the repository public,
the X demo post, and the submission — all by the human. No push, mainnet deployment, or
real-fund transaction has been performed. LLM use: one live AI-agent run (4 model calls) plus three tiny connectivity checks.
