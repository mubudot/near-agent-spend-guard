# Requirements check: NEAR HACKATHON

Checked against the live rules at https://nearhackathon.com/HACKATHON.md (re-read
2026-10-30, and again 2026-10-31 17:00 CST before submission: no rule, date, field or track changed). Status: ✅ met · ⏳ human action before submission · ➖ not applicable.

| # | Rule | Status | Evidence / action |
| --- | --- | --- | --- |
| 1 | Public repository by Sun 2026-11-15 07:59 CST (UTC+08:00) | ✅ | Public since 2026-10-31: https://github.com/mubudot/near-agent-spend-guard (MIT). Made public by the human. |
| 2 | README for machine and human readers: what it is, the problem, "do X → see Y" steps, no marketing (Procedure §1, Q-017) | ✅ | README: purpose, architecture, reproduction steps with expected output. Current local evidence for private code snapshot `6c0d225` is in the commit-specific verification below; earlier fresh-clone checks remain historical (docs/REVIEW_LOG.md). |
| 3 | Reproducible README (Q-012, Q-017 screening by Claude Code / Codex) | ✅ | Public CI ([run 41269150414](https://github.com/mubudot/near-agent-spend-guard/actions/runs/41269150414), commit `21aeec3`): locked npm install, 26 Rust unit tests, 88 Node tests, WASM release build and the sandbox suite (9 of 9, nothing skipped) passed. Every push re-runs it. Earlier local ARM64 snapshot kept below. |
| 4 | Demo post on X saying it was built at NEAR HACKATHON, with video or screenshots (Start here §3) | ✅ | Posted by the human: https://x.com/mubu_dot/status/2116372906745991631 ("Built at NEAR HACKATHON", tags @NEARProtocol and #NEARHackathon, 2:07 demo video attached; also on YouTube: https://youtu.be/XA7GZ8nHDVM). Script and recording plan: [VIDEO_PLAN.md](VIDEO_PLAN.md). A video is the safe choice (Q-012: screenshots are not enough when judges cannot open the demo); the testnet contract is viewable by anyone. |
| 5 | Local-only demo acceptable; hosted demo a plus (Q-012) | ✅ | Local sandbox + offline demo, **plus** a live testnet deployment `guard.spendguard-b31c91.testnet` anyone can query ([TESTNET_RUN.md](TESTNET_RUN.md)) and a hosted read-only dashboard, https://mubudot.github.io/near-agent-spend-guard/ (GitHub Pages; keep online through 2026-11-18, ideally 2026-11-25). Keep its accounts as they are through 2026-11-18, ideally 2026-11-25 (testnet accounts do not expire; do not delete them). |
| 6 | Testnet-only projects eligible (Q-010) | ✅ | Deployed on testnet only; scripts accept only `.testnet` accounts; `demo/parse.mjs` rejects non-`.testnet` receivers and accounts. No mainnet deploy. |
| 7 | No mainnet deploy / signing / spending without explicit human confirmation | ✅ | None performed; only free faucet testnet NEAR was signed for. Mainnet appears only in the prize payout account the human provides. |
| 8 | No committed secrets; keys in environment variables | ✅ | `.env.example` has empty placeholders; `.env*` and the `.near/` key directory are git-ignored; testnet keys were kept outside the repository and never printed; privacy scan in docs/REVIEW_LOG.md. |
| 9 | LICENSE file (Q-014) | ✅ | `LICENSE` (MIT, mubudot); `Cargo.toml` `license = "MIT"`. |
| 10 | Libraries, templates, AI code listed in README (Q-005) | ✅ | README names Hark and OpenAI Codex, near-sdk 5.17.2, near-api-js 5.1.1, near-workspaces 5.0.0. |
| 11 | Code timing and provenance (Q-001, Q-003, Q-004) | ✅ | All commits are after the 2026-10-19 announcement, which opens the window (first commit `d086de7`, 2026-10-29 22:30 UTC); no pre-existing product or baseline. README section "Hackathon provenance" links the first commit, the full history and the compare view `d086de7...hackathon-submission` and the dedicated branch `near-hackathon`; branch and tag are published with the final push. |
| 12 | Existing product on another chain disclosed (Q-002) | ➖ | New project, NEAR only. |
| 13 | One person, at most 2 different projects, each README names the other (Q-015) | ✅ | This is the author's only NEAR HACKATHON entry so far. README still discloses the author's other hackathon project, **paypal-guardrail-buyer** (PayPal AI Hackathon, independent, no shared code), and that README names this one. If a second NEAR HACKATHON project is entered, both READMEs must name each other. |
| 14 | Mandatory integrations (Q-011) | ✅ | None needed; own NEAR contract fits the track. |
| 15 | Track fit | ✅ | `security`: enforced spending limits and restricted keys; `agents`: an untrusted agent payment tool. `business` is a possible treasury/procurement use, with no autonomous business demonstrated. |
| 16 | Repo stays public through judging (Q-014) | ⏳ | Public since 2026-10-31; keep it public until results (by 2026-11-19). |
| 17 | Submission window Sun 2026-11-01 08:00 → Sun 2026-11-15 07:59 CST; one submission per project; payload confirmed by the human | ⏳ | Not submitted. All fields (name, lead, email, team size, tracks, mainnet payout account, repo URL, demo URL, description, consent) come from the human; never invented. |
| 18 | `website` field is a spam trap; send exactly the listed fields | ⏳ | Applies at submission time. |

## Commit-specific verification (2026-10-31)

Current code snapshot: `6c0d2255561b24734809063f7a86e09e10a676fc`, private local
`judge-audit`; later commits changed dashboard code and tests, see the public CI run below. Full commands and limitations are in [RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md#commit-specific-local-verification-2026-10-31).

- `node scripts/verify.mjs --skip=rust,wasm,sandbox`: **incomplete**, exit 2;
  locked npm installation passed; `npm test`: **88 passed, 0 failed, 0 skipped**.
- `cargo test --locked`: **26 passed, 0 failed,
  0 ignored**; doc tests: **0**.
- Release WASM build: succeeded; SHA-256
  `cfef43f3ff9e7898766ef76efb439aae103025396e9278bd56862e2edb0f8c92`.
- `npm run test:integration`: **0 passed, 0 failed, 1 skipped**; hard nofile is
  4096, below the pinned sandbox's required 65535. No on-chain subtests ran.
- Static HTTP/MIME checks, the five recorded transaction lookups, explicit archival
  lookup and public RPC CORS preflights passed. Headless browser rendering did not
  complete locally at that time.

## Public verification (2026-11-01)

- [GitHub Actions run 41269150414](https://github.com/mubudot/near-agent-spend-guard/actions/runs/41269150414) at `21aeec3`: all five stages passed on x86_64,
  including the sandbox suite (**9 passed, 0 skipped**, nearcore 2.14.0); Rust 26, Node 88.
- Live dashboard https://mubudot.github.io/near-agent-spend-guard/ (GitHub Pages, manual workflow): HTTPS, JavaScript module MIME types,
  live testnet reads and `?tx=` lookups verified in a browser. Hosted demo kept online through judging (Q-012).

## Open before submission

1. Human: confirm the exact submission payload (window opens Sun 2026-11-01 08:00 CST) and keep the
   repository public through judging. Repository, demo video and X post are done; Phase 2 (testnet deploy,
   policy setup, restricted key, live `--submit` run) is in [TESTNET_RUN.md](TESTNET_RUN.md).
