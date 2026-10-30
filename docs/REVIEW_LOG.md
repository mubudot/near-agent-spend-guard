# Review log

Cross-check process: (1) judge-style reproduction from a fresh clone following only the
README, (2) rules check ([REQUIREMENTS_CHECK.md](REQUIREMENTS_CHECK.md)), (3) independent
OpenAI Codex review plus re-review of the fixes, (4) privacy scan.

## Round 1 — 2026-10-30

### 1. Judge-style reproduction (clean x86_64 Linux host, fresh clone of the phase 1 commit)

| # | Step | Problem found | Fix |
| --- | --- | --- | --- |
| R1 | README step 1 `source scripts/rust-env.sh` | The helper hard-coded the development container's toolchain paths (`RUSTUP_HOME`, `CARGO_HOME`); on any other machine `cargo` then failed (`cargo: command not found`). | Helper and Zig wrappers removed from the repo. README uses plain `cargo`; `rust-toolchain.toml` pins Rust 1.99.1 + `wasm32-unknown-unknown`, which rustup installs automatically. |
| R2 | README step 5 `npm run test:integration` | Fails on x86_64: near-workspaces 5.0.0's bundled neard 2.6.2 rejects WASM from current Rust (`CompilationError: PrepareError: Deserialization`). README only mentioned an ARM64 override. | The test now downloads the official nearcore **2.14.0** sandbox (the release mainnet and testnet run) into `.tmp/` and uses it by default; `SPEND_GUARD_SANDBOX_BIN` still overrides. Pinning an older Rust was rejected: `near-sys` (near-sdk 5.17.2) requires rustc ≥ 1.93, and neard 2.6.2 still rejects that WASM. |
| R3 | Integration teardown with neard 2.14.0 | `ENOTEMPTY` removing `.tmp/integration/chain` while neard was still flushing a state snapshot; all subtests had passed but the test was marked failed. | Removal retries (`maxRetries`) after a 1 s grace period; a deferred cleanup is logged, not failed, and the next run clears the directory first. |
| R4 | README expected output | Step 1 pointed at STATUS.md instead of stating the count; STATUS.md carried host details. | README now states each expected count; STATUS.md rewritten with current results only. |

ARM64 note: the new downloader also covers Linux ARM64 and macOS (official builds exist for
`Linux-aarch64`, `Darwin-arm64`, `Darwin-x86_64`), replacing the old explicit ARM64 skip.
Only x86_64 Linux was executed.

### 2. Codex independent review (round 1) — verdict `fix-first`

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| F1 | high | `new(owner)` only checked `predecessor == owner`, so whoever called first after deployment could initialize with themselves as owner and withdraw funds. | **Fixed.** `new` is `#[private]` with an explicit `predecessor == current_account` check (`E_PRIVATE`); deploy + `new` is one batch transaction signed by the contract account. Unit test `init_only_by_contract_account`; integration subtest shows a third party (and the would-be owner) cannot initialize a bare deployment. Codex round 2 noted near-sdk ignores `#[private]` on initializers, so the explicit check is what protects it. |
| F2 | medium | Sweeping/cancelling up to 64 requests emitted one event each, which can exceed the 16 KiB receipt log limit and revert `spend`, `withdraw`, or `remove_agent`. | **Fixed.** Sweeps release at most 16 expired requests per call (`expire` is permissionless for the rest); `remove_agent` emits one aggregate event. Unit tests at 64 pending requests with 64-char IDs and 256-byte memos assert < 16,384 log bytes; the mocked VM enforces the protocol limit (verified). |
| F3 | medium | A callback running out of its fixed 15 Tgas leaves its transfer entry forever; 64 such entries block all spends. Callback cost grows with state. | **Fixed and confirmed by measurement.** The new max-state subtest measured `on_transfer` at **~19 Tgas** at maximum bounded state (32 agents × 32 allowlist entries, 64 pending, full audit), so 15 Tgas would really have failed. Budget raised to 50 Tgas (asserted < 30 Tgas). New owner-only `clear_stale_transfer` frees an entry from a previous UTC day without refunding (outcome unknown); a late callback then fails harmlessly. `list_transfers` view added. |
| F4 | low | Owner removing and re-adding an agent resets its daily budget. | **Documented** (README trust model): owner-only, and the owner is trusted. |
| F5 | low | Demo printed transaction status as if the payment succeeded; the transfer settles in a later receipt. | **Fixed.** `summarizeOutcome` reads the contract's events and the demo prints `payment: completed / failed / awaiting_owner_approval` (exit 2 on failure). Unit tested. |
| F6 | low | README sandbox instructions omitted the x86_64 failure. | **Fixed** (R2 above). |
| F7 | info | Coverage gaps. | **Added** tests for F1–F3, approve after removal, daily-cap reduction (including an `E_DAILY` regression on approval), max-state gas. Versioned state/migration noted as a known limitation. |

### 3. Codex re-review (round 2) — verdict `ship`

No critical/high/medium issues. Two low notes: REVIEW_LOG.md was not yet written
(this file), and the gas test did not cover maximum state. The maximum-state subtest was
added in response, and it exposed the real gas risk recorded under F3.

### 3b. Codex re-review (round 3, after the 50 Tgas change) — verdict `ship`

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| R3-1 | low | The "maximum state" fixture had 994 allowlist entries (original agent kept 2). | **Fixed**: all 32 agents now have 32 entries (1,024); docs say "maximum occupancy". |
| R3-2 | low | An immediate-transfer `spend` at that state (50 Tgas reserved) was not measured. | **Fixed**: subtest runs it at 100 Tgas, asserts every receipt succeeded and the receiver got paid, and prints its gas: measured `spend` **20.0 Tgas** + its `on_transfer` **19.2 Tgas**; `approve` 19.9 + 19.3 Tgas (fresh-clone run). The 16-request expiry sweep inside `spend` needs a UTC midnight and is not measured on chain; README suggests 150 Tgas as conservative headroom. |
| R3-3 | low | README said every spend reserves 50 Tgas; pending spends schedule no callback. | **Fixed** wording. |

Stopped here: the maximum of two re-review rounds after the first review was reached.

### 4. Privacy scan

Tracked files and full git history were scanned for the author's private email and
provider, real name, location, tunnel URLs, IP addresses (including the test host's),
private-key and token patterns, and absolute workspace paths. Findings, all removed:
the test host's IP and workspace paths in STATUS.md, the container-only helper scripts,
and two internal task-brief files. History was rewritten locally (never pushed) so no
earlier commit contains them. The only identity left is the pseudonymous Git author `mubudot` (a GitHub
no-reply address in commit metadata, not in any tracked file). `.env.example` has empty values.

### 5. Final results (fresh clone, README only, clean x86_64 host)

See [STATUS.md](../STATUS.md): `cargo test` 26/26, `npm test` 13/13,
`npm run test:integration` 9/9 (1 test + 8 on-chain subtests) on nearcore 2.14.0, twice
(second run with the cached sandbox and a leftover chain directory).

## Phase 2 — 2026-10-30 (testnet deployment)

### 1. Live testnet run

Deployment, live demo, and the findings it surfaced (T1–T5: 0.1 NEAR key allowance too
small for a 100 Tgas call, unstructured refusals, noisy stdout, deprecated RPC endpoint,
missing key-install hash) are in [TESTNET_RUN.md](TESTNET_RUN.md).

### 2. Codex review of the phase 2 diff — verdict `fix-first`

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| P1 | high | Key files: `existsSync` + `writeFileSync` was not exclusive; a concurrent run or a dangling symlink could overwrite a key or write it outside `NEAR_KEY_DIR`. | **Fixed.** `writeFileSync(..., { flag: 'wx', mode: 0o600 })` (O_EXCL: no overwrite, no symlink follow); no pathname `chmod`. |
| P2 | high | `JSON.parse` / `KeyPair.fromString` errors could quote secret input on stderr. | **Fixed.** Key parsing goes through `keyPairFrom` and a guarded `loadKey` with fixed messages in all three scripts; unit test asserts a marker in a bad key never appears in the error. |
| P3 | medium | `NEAR_RPC_URL` could point at a non-testnet RPC; `networkId` does not verify the chain. | **Fixed.** Every connection calls `assertTestnetChain` (`status.chain_id === 'testnet'`) before signing or creating anything; unit tested. |
| P4 | medium | README rerun not copy-pasteable (`<hex>`, `<request_id>` placeholders; npm install step not stated). | **Fixed.** Owner id, public key and request id are captured by a small `json` shell helper; `npm ci` named. Both blocks were then executed unmodified from the README with a fresh faucet account (TESTNET_RUN.md, rerun 2). |
| P5 | medium | `owner.mjs approve` exited 0 even if the payout failed. | **Fixed.** Prints `payment` from the contract's events; exit 2 unless `completed`. |
| P6 | medium | A failed faucet/create left a key file behind and blocked a retry. | **Fixed.** Inputs are validated before any write; on failure the script checks the account on chain and removes the key file only if the account does not exist (kept if it exists or the state is unknown). |
| P7 | low | VIDEO_PLAN preflight used `status`, which showed neither liquidity nor key allowance; reserve estimate wrong (1.4 vs ~1.95 NEAR). | **Fixed.** `status` adds `balance`, `available_for_payouts` (the contract's `ensure_liquid` rule) and the agent's contract-scoped keys with allowance; VIDEO_PLAN uses the measured numbers. |

Checks Codex reported as passing: single contract-signed DeployContract + `new` batch
(confirmed read-only on chain, code hash = local WASM), policy/argument shapes, agent key
restrictions, refusal detection against near-api-js 5.1.1's error shape, exact amounts,
funding vs. storage, documentation consistency, privacy.

### 2b. Codex re-review of the phase 2 diff (round 2, `ee5ced3..8976d22`) — verdict `fix-first`

Fix verification: P1 and P3 verified; P2, P4, P5, P6, P7 partially fixed, with the gaps
below. New findings, all fixed with tests (`npm test` 17 → 21):

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| R1-1 | high | After an uncertain create (timeout after broadcast, unclear faucet reply), cleanup deleted the key when the account was absent at the final block; the account could still be created later with its only key gone. | **Fixed.** The key is never deleted: an absent account moves the file aside to `<name>.json.unconfirmed-<random>` via `link` + `unlink` (never overwrites, `EEXIST` otherwise), so a retry is unblocked and the key survives. Unit test. |
| R1-2 | high | The README `json` helper parsed private-key files without a catch; a malformed file's `SyntaxError` quoted the start of its content on stderr. | **Fixed.** The helper catches, prints a fixed message (`json: no field <f> in input`) and exits 1; a missing field also exits 1 instead of printing `undefined`. A unit test extracts the helper from README.md and runs it on a marked malformed input. |
| R1-3 | medium | `install-key.mjs` accepted any `ed25519:` string as `NEAR_AGENT_PUBLIC_KEY` and printed it, so a pasted private key was echoed. | **Fixed.** `publicKeyFrom` parses with `PublicKey.fromString` (32-byte length check) before any output and prints only the normalized public key; fixed error text. Unit test with a real private key. |
| R1-4 | medium | `agent.mjs` exited 0 when the payout outcome was `unknown` (no terminal event). | **Fixed.** `paymentExitCode`: 0 only for `completed` / `awaiting_owner_approval`, 2 for `failed` / `unknown` (hash still printed). Unit test. README now lists all exit codes (0/1/2/3). |
| R1-5 | medium | `status` mixed optimistic views with finalized balance; right after an approval it could overstate `available_for_payouts`. | **Fixed.** All reads (views, `view_account`, protocol config, access keys) use one finalized block hash, printed as `block`. Checked read-only on testnet. |
| R1-6 | low | REVIEW_LOG.md quoted the Git author's no-reply e-mail address. | **Fixed.** Address removed from tracked prose. |
| P4 gap | medium | Bare expected refusals stop a `set -e` shell; `export X=$(…)` masks failures; no `pipefail`. | **Fixed.** `set -o pipefail`, `X=$(…) && export X`, refusals end in `\|\| test $? -eq 3`. Both blocks were then executed unmodified under `bash -e` with a fresh faucet account (TESTNET_RUN.md, rerun 3). |
| P5 gap | low | README omitted unknown-settlement and error exit codes. | **Fixed** with R1-4. |

Codex confirmed: no path or shell injection from account ids or arguments, exact amounts at
the 1-yocto and `u128` bounds, refusal detection requires a transaction outcome, no path
labels a failed payment `completed`. Stopped here (one re-review round, as planned).

### 3. Privacy scan (phase 2)

Tracked and new files scanned for the author's private email/provider, real name,
location, IP addresses, absolute workspace paths, and private-key patterns: no matches.
Testnet keys live outside the repository; only public keys and testnet account ids appear.
