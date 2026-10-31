# Release checklist (NEAR HACKATHON)

Walked before every submission candidate. Rules: https://nearhackathon.com/HACKATHON.md (re-read 2026-10-30 and 2026-10-31).
Full rule-by-rule table: [docs/REQUIREMENTS_CHECK.md](docs/REQUIREMENTS_CHECK.md).

| # | Item | Rule | How to check | Last recorded result |
| --- | --- | --- | --- | --- |
| 1 | `LICENSE` file present | Q-014 | `test -f LICENSE` | ✅ MIT |
| 2 | README is "do X → see Y" for a Claude Code / Codex screener, no marketing | Procedure §1, Q-017 | Fresh `git clone` to /tmp, follow README steps 1–5 and the judge quick start verbatim, no keys | ⏳ Current local snapshot: `6c0d225`, `npm test` 88 passed, Rust unit tests 26 passed, WASM release build succeeded; sandbox skipped (hard nofile 4096 < 65535). See commit-specific verification below; no current CI or sandbox pass claimed |
| 3 | AI tools and libraries disclosed | Q-005 | README "Scope" names Hark, OpenAI Codex, near-sdk, borsh, near-api-js, near-workspaces | ✅ |
| 4 | Testnet only; nothing on mainnet | Q-010, "Never without confirmation" | scripts refuse non-`.testnet` accounts and non-testnet `chain_id` | ✅ |
| 5 | Other project by the same author named | Q-015 | README last section names **paypal-guardrail-buyer** (PayPal AI Hackathon, independent) | ✅ (if a second NEAR entry is added, both READMEs must name each other) |
| 6 | No secrets or personal data in tree or history | "Never commit secrets" | `git grep` + `git log -p` for keys, real name, personal email, proxy hostnames | ✅ clean |
| 7 | Tests and README counts agree | — | README expected counts vs. commit-specific results below | ✅ Node: 88 passed; Rust and sandbox evidence stated separately. STATUS.md retains historical runs |
| 8 | Repo public, X demo post, submission payload confirmed by the human | Start here §2–4 | human action | ✅ repo public + X post live (2026-10-31); ⏳ payload confirmation and sending (window opens 2026-11-01 08:00 CST) |
| 9 | Provenance: first commit, history and submission tag linked from the README | Q-001, Q-003 | README "Hackathon provenance"; `git ls-remote origin near-hackathon hackathon-submission` | ✅ Audited public base `938b272` contains provenance links; these `judge-audit` changes remain private local commits |

## Commit-specific local verification (2026-10-31)

Code snapshot: `6c0d2255561b24734809063f7a86e09e10a676fc` on private local
`judge-audit`, following public base `938b272`. Subsequent edits in this review are
documentation only. Host: Linux ARM64, Node v22.23.3, npm 10.9.9, pinned Rust 1.99.1
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
  without a screenshot. Hosted HTTPS/browser verification remains planned.
- Both workflows parse as YAML. Pages is manual-dispatch only. Verification CI is
  available but has not run; nothing was pushed, published or deployed.

Contract sources and Rust
manifests/toolchain pins are unchanged from `938b272`. Overall verification remains
**incomplete** while the sandbox is skipped; historical x86_64 results are not
substituted for this commit's missing execution evidence.
