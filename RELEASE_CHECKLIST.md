# Release checklist (NEAR HACKATHON)

Walked before every submission candidate. Rules: https://nearhackathon.com/HACKATHON.md (re-read 2026-10-30 and 2026-10-31).
Full rule-by-rule table: [docs/REQUIREMENTS_CHECK.md](docs/REQUIREMENTS_CHECK.md).

| # | Item | Rule | How to check | Last result (2026-10-30) |
| --- | --- | --- | --- | --- |
| 1 | `LICENSE` file present | Q-014 | `test -f LICENSE` | ✅ MIT |
| 2 | README is "do X → see Y" for a Claude Code / Codex screener, no marketing | Procedure §1, Q-017 | Fresh `git clone` to /tmp, follow README steps 1–5 and the judge quick start verbatim, no keys | ✅ `cargo test` 26 passed; `npm test` 61 passed; demo preview + `.near` rejection; `--scenario injection` / `duplicate` outputs as documented; WASM builds; live `status` read works. Integration test skipped on this host (hard nofile 4096 < 65535); 9/9 passed on x86_64 in phase 1 |
| 3 | AI tools and libraries disclosed | Q-005 | README "Scope" names Hark, OpenAI Codex, near-sdk, borsh, near-api-js, near-workspaces | ✅ |
| 4 | Testnet only; nothing on mainnet | Q-010, "Never without confirmation" | scripts refuse non-`.testnet` accounts and non-testnet `chain_id` | ✅ |
| 5 | Other project by the same author named | Q-015 | README last section names **paypal-guardrail-buyer** (PayPal AI Hackathon, independent) | ✅ (if a second NEAR entry is added, both READMEs must name each other) |
| 6 | No secrets or personal data in tree or history | "Never commit secrets" | `git grep` + `git log -p` for keys, real name, personal email, proxy hostnames | ✅ clean |
| 7 | Tests and README counts agree | — | README/STATUS counts vs. actual runs | ✅ |
| 8 | Repo public, X demo post, submission payload confirmed by the human | Start here §2–4 | human action | ✅ repo public + X post live (2026-10-31); ⏳ payload confirmation and sending (window opens 2026-11-01 08:00 CST) |
| 9 | Provenance: first commit, history and submission tag linked from the README | Q-001, Q-003 | README "Hackathon provenance"; `git tag -l hackathon-submission` | ✅ (2026-10-31) |
