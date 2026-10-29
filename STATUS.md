# Phase 1 status

## Sandbox integration run — 2026-10-30 (x86_64 VPS)

Host: rented x86_64 VPS, Ubuntu 24.04, x86_64, 8 vCPU, `nofile` hard limit
204800 (`ulimit -n 65535` set). Rust 1.99.1 + `wasm32-unknown-unknown` (rustup),
Node.js 24.11.1, npm 11.6.2. Repo copied as a git bundle of `015ccb7`; the copy and
the sandbox binary were deleted from the VPS afterwards.

| Check | Result |
| --- | --- |
| `cargo test` (contract unit) | **20 passed, 0 failed** |
| `npm test` (parser) | **12 passed, 0 failed** |
| Offline demo / invalid mainnet receiver | Expected `spend` JSON / exit code 1 |
| `cargo build --locked --target wasm32-unknown-unknown --release` | Passed |
| `SPEND_GUARD_SANDBOX_BIN=<neard 2.13.4 x86_64 sandbox> npm run test:integration` | **6 passed (1 test + 5 on-chain subtests), 0 failed, 0 skipped** |
| `npm run test:integration` with near-workspaces' bundled sandbox (neard 2.6.2) | **Fails**: deploy succeeds but `new` returns `CompilationError: PrepareError: Deserialization` |

Total on the VPS: **38 passed, 0 failed**. Sandbox binary used:
`https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.13.4/near-sandbox.tar.gz`.

Command that passes:

```bash
ulimit -n 65535
SPEND_GUARD_SANDBOX_BIN=/path/to/Linux-x86_64/near-sandbox npm run test:integration
```

Findings and fixes (test harness only; no contract changes needed):

1. **Bundled sandbox too old for the WASM.** WASM built by Rust 1.99 uses WASM features
   neard 2.6.2 (bundled by near-workspaces 5.0.0) cannot parse. Use a neard ≥ 2.13.4
   sandbox via `SPEND_GUARD_SANDBOX_BIN`. Not fixed in code; a testnet deploy should
   be checked against the current testnet protocol (or built with cargo-near) in phase 2.
2. **Stale chain dir → `EISDIR`.** near-workspaces' cleanup uses a non-recursive `rm`,
   so after a failed run the next `Worker.init` failed. The test now clears
   `.tmp/integration/chain` recursively before init and after teardown (`rm: false`).
3. **Restricted-key allowance too small in the sandbox.** Sandbox gas price is 10x
   testnet's, so 100 Tgas prepaid costs ~0.101 NEAR of allowance, more than the
   0.1 NEAR key. The test key allowance is now 0.5 NEAR. The testnet demo's 0.1 NEAR
   allowance (`demo/install-key.mjs`) is left as is (~0.01 NEAR per call at testnet gas price).

---

## Earlier local validation (2026-10-29, ARM64 container)

Validated locally on 2026-10-29. Phase 1 implementation and documentation are
complete; sandbox execution remains blocked by this container's limits. No source
fixes were needed: the existing Rust unit tests passed.

## Results

| Check | Result |
| --- | --- |
| Rust contract unit tests | **20 passed, 0 failed** |
| Rust documentation tests | 0 tests, successful exit |
| JavaScript parser tests | **12 passed, 0 failed** |
| Offline demo | Expected `spend` JSON for 0.1 NEAR and memo `coffee` |
| Invalid mainnet receiver | Rejected with exit code 1 |
| Release WASM build | Passed; `target/wasm32-unknown-unknown/release/near_agent_spend_guard.wasm` |
| Sandbox, default configuration | **1 skipped**, 0 passed, 0 failed: bundled downloader lacks Linux ARM64 support |
| Sandbox, explicit local binary | **1 skipped**, 0 passed, 0 failed: hard file-descriptor limit blocks startup |

Total executed tests: **32 passed, 0 failed**. Both sandbox attempts skipped the
same integration test before its five on-chain subtests ran; no on-chain success
is claimed.

Rust coverage includes receiver allowlists (including empty), transaction and
daily caps, UTC rollover, threshold reservations, approval/rejection/expiry,
global and agent pause, non-agent/forwarded-call rejection, owner authorization,
callback privacy and failure rollback, generation/day isolation, policy updates,
liquidity reserves, and bounded NEP-297 audit history.

## Exact validation commands

Run from the repository root:

```bash
source scripts/rust-env.sh && cargo test
npm test
npm run demo -- 'send 0.1 NEAR to shop.testnet for coffee'
npm run test:integration
source scripts/rust-env.sh && cargo build --locked --target wasm32-unknown-unknown --release
SPEND_GUARD_SANDBOX_BIN=/path/to/near-sandbox npm run test:integration
npm ci --ignore-scripts --no-audit --no-fund
node demo/agent.mjs 'send 1 NEAR to shop.near'; test "$?" -eq 1
git diff --cached --check
```

Toolchain: Rust 1.99.1, Cargo 1.99.1, Node.js 22.23.3, npm 10.9.9;
host `aarch64-unknown-linux-gnu`, target `wasm32-unknown-unknown`.

The explicit sandbox attempt reported:

```text
couldn't set the file descriptor limit to (65535, 65535), current limit = (4096, 4096)
```

Re-run the documented integration command on a host with a compatible sandbox
binary and sufficient file-descriptor limits to validate actual receipts and
restricted-key behavior. Unit tests cover callback accounting, but do not replace
that integration run.

## Deliverables and repository

- README explains what/why, architecture, reproducible commands and expected
  outputs, restricted-key setup, and phase boundaries.
- AI-use disclosure names Hark and OpenAI Codex. Sibling project disclosure names
  `paypal-guardrail-buyer`, replacing the earlier task's placeholder.
- MIT license credits `mubudot`.
- `.gitignore` excludes build/dependency directories, local chain data, credentials,
  temporary files, and logs; `.env.example` contains only empty key placeholders.
- Tracked-file screening found no private-key patterns. A third-party contact email
  was removed from a lockfile deprecation message; dependency versions and integrity
  hashes are unchanged. The only remaining email is the requested pseudonymous
  Git identity.
- Existing Git repository had no commits or remotes. The phase 1 files are committed
  locally with author and committer `mubudot <mubudot@users.noreply.github.com>`.
  Retrieve the resulting commit ID with `git log -1 --format='%h %s'`.
- No push, remote creation, public-chain deployment, real-fund transaction, or
  LLM API call was performed. Generated sandbox data and logs remain ignored.

## Open work

1. ~~Run the sandbox integration test on a compatible host~~ done 2026-10-30 on x86_64 VPS (see top).
2. Phase 2: testnet deployment, funding, owner policy setup, restricted-key
   provisioning, and live demo submission. None of these steps ran in phase 1.
3. Independent security review and production hardening remain outside phase 1.
   The optional LLM mode is not implemented; the offline rule-based demo works.
4. npm reports deprecated `tar@6.2.1` in the existing sandbox development dependency
   tree. Dependency modernization was not part of this finishing task.
