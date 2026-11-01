# Release checklist (NEAR HACKATHON)

Walked before every submission candidate. Rules: https://nearhackathon.com/HACKATHON.md (re-read 2026-10-30 and 2026-10-31).
Full rule-by-rule table: [docs/REQUIREMENTS_CHECK.md](docs/REQUIREMENTS_CHECK.md).

| # | Item | Rule | How to check | Last recorded result |
| --- | --- | --- | --- | --- |
| 1 | `LICENSE` file present | Q-014 | `test -f LICENSE` | ✅ MIT |
| 2 | README is "do X → see Y" for a Claude Code / Codex screener, no marketing | Procedure §1, Q-017 | Fresh `git clone` to /tmp, follow README steps 1–5 and the judge quick start verbatim, no keys | ✅ Public CI at `21aeec3` ([run 41269150414](https://github.com/mubudot/near-agent-spend-guard/actions/runs/41269150414)): install, Rust 26, Node 88, WASM, sandbox 9/9 all passed, nothing skipped. Local ARM64 snapshot below kept for history |
| 3 | AI tools and libraries disclosed | Q-005 | README "Scope" names Hark, OpenAI Codex, near-sdk, borsh, near-api-js, near-workspaces | ✅ |
| 4 | Testnet only; nothing on mainnet | Q-010, "Never without confirmation" | scripts refuse non-`.testnet` accounts and non-testnet `chain_id` | ✅ |
| 5 | Other project by the same author named | Q-015 | README last section names **paypal-guardrail-buyer** (PayPal AI Hackathon, independent) | ✅ (if a second NEAR entry is added, both READMEs must name each other) |
| 6 | No secrets or personal data in tree or history | "Never commit secrets" | `git grep` + `git log -p` for keys, real name, personal email, proxy hostnames | ✅ clean |
| 7 | Tests and README counts agree | — | README expected counts vs. commit-specific results below | ✅ Node: 88 passed; Rust and sandbox evidence stated separately. STATUS.md retains historical runs |
| 8 | Repo public, X demo post, submission payload confirmed by the human | Start here §2–4 | human action | ✅ repo public + X post live (2026-10-31); ⏳ payload confirmation and sending (window opens 2026-11-01 08:00 CST) |
| 9 | Provenance: first commit, history and submission tag linked from the README | Q-001, Q-003 | README "Hackathon provenance"; `git ls-remote origin near-hackathon hackathon-submission` | ✅ `near-hackathon` and `hackathon-submission` stay at `938b272`; the later judge-audit commits (dashboard publication, CI) are on public `main` |
| 10 | Live dashboard link (only after the user approves publishing) | Q-012 (hosted demo is a plus) | First time only: Settings → Pages → Source: **GitHub Actions** (`configure-pages` does not enable Pages by itself). Then run the manual Pages workflow, check HTTPS, module MIME types, RPC and archival lookup in a browser, then replace the README placeholder comment with the verified link | ✅ https://mubudot.github.io/near-agent-spend-guard/ (Pages from `21aeec3`): HTTPS, `text/javascript` modules, `server.mjs`/tests 404, live testnet data, `?tx=` lookups of a payment and both refusals, checked in headless Chromium and a cloud browser |

## Public CI verification (2026-11-01)

[GitHub Actions run 41269150414](https://github.com/mubudot/near-agent-spend-guard/actions/runs/41269150414) (`verify.yml`, push, ubuntu-24.04 x86_64) tested
commit `21aeec318e2e67f06b3207495f0566b4f2a6e047`, clean worktree, `--ci` (no skips allowed):
`npm ci --ignore-scripts` passed; `cargo test --locked` **26 passed**; `npm test` **88 passed,
0 failed, 0 skipped**; release WASM build passed (SHA-256 of that x86_64 build
`b0a474b7c37d9a3aeccc0fc0b43b169471eafdf5a9af1f1154763e2dfd98036b`, not a claim of byte
identity with the deployed contract); sandbox integration **9 passed, 0 skipped** (nearcore
2.14.0, nofile 65536). Verification: **passed**. Logs, toolchains and the hash are in the
run's `verification-<sha>` artifact (30-day retention). Later pushes run the same workflow.

## Commit-specific local verification (2026-10-31)

Code snapshot: `6c0d2255561b24734809063f7a86e09e10a676fc` on private local
`judge-audit`, following public base `938b272`. Later commits changed dashboard code
(`web/src/app.mjs`, `web/src/near-rpc.mjs`), its tests and workflow permissions; their
evidence is the public CI run in the section above, not this snapshot. Everything below describes the 2026-10-31 local run only. Host: Linux ARM64, Node v22.23.3, npm 10.9.9, pinned Rust 1.99.1
(Zig used as the C compiler/linker on this ARM64 host). Rule/publication entries above retain
their earlier evidence; this snapshot updates local verification only.

- `node scripts/verify.mjs --skip=rust,wasm,sandbox`: **incomplete**, exit 2,
  clean worktree at the tested commit. Its `npm ci --ignore-scripts` passed;
  `npm test` passed **88**, failed **0**, skipped **0**.
- `cargo test --locked`: **26 passed, 0 failed,
  0 ignored**; doc tests: **0**.
- `cargo build --locked --target wasm32-unknown-unknown --release`:
  succeeded. WASM SHA-256:
  `cfef43f3ff9e7898766ef76efb439aae103025396e9278bd56862e2edb0f8c92`.
  This local build hash is not a claim of byte identity with the deployed contract.
- `npm run test:integration`: **0 passed, 0 failed, 1 skipped**. The pinned nearcore
  2.14.0 binary could not raise hard nofile from 4096 to 65535. No sandbox subtests ran.
- Static staging served with Python's HTTP server, without `web/server.mjs`:
  HTML, CSS and all five modules returned HTTP 200 with correct MIME types;
  `server.mjs` returned 404. All five recorded hashes resolved to their documented
  outcomes through public testnet RPC; explicit archival lookup and both endpoints'
  CORS preflights succeeded. Headless Chromium did not complete a render; stopped
  without a screenshot. (At that time hosted HTTPS/browser verification was still planned; it is now done, see row 10.)
- Both workflows parse as YAML. Pages is manual-dispatch only. Verification CI had not run yet; this local verification run did not push, publish, or deploy changes.

Contract sources and Rust
manifests/toolchain pins are unchanged from `938b272`. That local run was
**incomplete** because the sandbox was skipped; the complete current evidence is the public CI run above.
