# Live testnet run

NEAR **testnet** only (chain id `testnet`, protocol 88, nearcore 2.14.0). No mainnet
deployment, no real funds. Run on 2026-10-29 between 23:39 and 23:49 UTC
(2026-10-30 07:39–07:49 CST, UTC+08:00), all within UTC day 20755, so the daily budget
did not reset in between. Every link opens the transaction on testnet.nearblocks.io; the
same hashes can be checked against any testnet RPC (`tx` method, sender = the signer below).

## Accounts

| Role | Account | Created by |
| --- | --- | --- |
| Owner | `spendguard-b31c91.testnet` | public testnet faucet helper (10 testnet NEAR) |
| Contract (guard) | [`guard.spendguard-b31c91.testnet`](https://testnet.nearblocks.io/address/guard.spendguard-b31c91.testnet) | owner, 4 NEAR + 2 NEAR `fund` |
| Agent | `agent.spendguard-b31c91.testnet` | owner, 0.5 NEAR |
| Merchant (allowlisted) | `shop.spendguard-b31c91.testnet` | owner, 0.1 NEAR |

Deployed code hash: `CuJqiX8P7XpVgYRBtX3vwZuHFHJNiNE1KHmny3picmdf`, equal to the
base58 SHA-256 of `target/wasm32-unknown-unknown/release/near_agent_spend_guard.wasm`
(277,735 bytes) built with `cargo build --locked --target wasm32-unknown-unknown --release`
from the contract source in this repository (unchanged in phase 2).

Policy for the agent: allowlist `[shop.spendguard-b31c91.testnet]`, `per_tx_max` 1 NEAR,
`daily_max` 1.2 NEAR, `approval_threshold` 0.2 NEAR, not paused.

## Provisioning

| Step | Command | Signer | Transaction |
| --- | --- | --- | --- |
| Create contract account | `owner.mjs create-account guard 4` | owner | [FCQgr3fE…](https://testnet.nearblocks.io/txns/FCQgr3fEBYUKZyAYcqYDJUKfFWrSrPG1wzb5GoX25qAJ) |
| Create agent account | `owner.mjs create-account agent 0.5` | owner | [xfBBHfYs…](https://testnet.nearblocks.io/txns/xfBBHfYsqsjLZTz7pX2y2ytNiGoQDQZz3nmS2r8Zgnn) |
| Create merchant account | `owner.mjs create-account shop 0.1` | owner | [DG26XwrW…](https://testnet.nearblocks.io/txns/DG26XwrWtSMPZLVb27GgRNMMKdpuLrSDAJR32QB9UjER) |
| **DeployContract + `new{owner}` in one batch** | `owner.mjs deploy` | contract account | [5KzhzkVC…](https://testnet.nearblocks.io/txns/5KzhzkVCx1eFuCpegLbR7wBUvA1ULxzVKyFnprN8uUFA) |
| Fund contract with 2 NEAR | `owner.mjs fund 2` | owner | [Bx84tWet…](https://testnet.nearblocks.io/txns/Bx84tWetaArXGD8vnE9kLuFskmqTcAgdDfuuNPCfvT83) |
| Register agent + policy (`agent_added` event) | `owner.mjs add-agent …` | owner | [3k3C5KrQ…](https://testnet.nearblocks.io/txns/3k3C5KrQPzdQwnksWUh4RFXWQRQfaKKj4BSWfwpvmqAw) |
| Remove the first restricted key (0.1 NEAR allowance, see finding T1) | internal one-off `deleteKey` | agent full-access key | [8SmrqBxb…](https://testnet.nearblocks.io/txns/8SmrqBxbQreVXR1a7XrAzx6AL432Cmzsc6PCdAWYYQ2W) |
| Install restricted key: receiver = guard, methods = `[spend]`, allowance 1 NEAR | `install-key.mjs --submit` | agent full-access key | [G4nK8ec3…](https://testnet.nearblocks.io/txns/G4nK8ec3CbxF14Xvtdacgw285ZQSCUaF2M4wDWMy9heg) |

From here on the agent signs only with that function-call key (`agent.mjs` checks its
permission on chain and refuses a full-access or broader key before submitting).

## Demo: the four outcomes

| # | Agent request (`npm run demo -- --submit "…"`) | Result | Transaction |
| --- | --- | --- | --- |
| 1 | `send 0.1 NEAR to shop.spendguard-b31c91.testnet for coffee` | `payment: completed` — below the 0.2 threshold, paid immediately (`spend_requested` → `transfer_succeeded`) | [AXvCV7FP…](https://testnet.nearblocks.io/txns/AXvCV7FPZzxrbfqmxUsDGUyWLZVvW4QdkvpFxGA7Eyun) |
| 2 | `send 0.5 NEAR to shop.spendguard-b31c91.testnet for monthly API credits` | `payment: awaiting_owner_approval`, `request_id: 2` (`spend_requested` → `pending`; 0.5 NEAR reserved, no transfer) | [7NcGKv2b…](https://testnet.nearblocks.io/txns/7NcGKv2b6uyT4epEHY8PWMBVfoqeGajqsTBg7UYKCTfo) |
| 2b | Owner: `node demo/owner.mjs approve 2` | `approved` → `transfer_succeeded` (0.5 NEAR paid to the shop) | [6UYyCaah…](https://testnet.nearblocks.io/txns/6UYyCaah8VSYS3GV8NZUmznuewaKRYWaY5vLZaSR8Zxq) |
| 3 | `send 0.1 NEAR to stranger.testnet for refund scam` | `payment: refused`, `reason: E_NOT_ALLOWLISTED` (contract panic, no funds moved, exit 3) | [93Ms8kvD…](https://testnet.nearblocks.io/txns/93Ms8kvDEbVyoyieC9nEC8Jb5BfwSiXCfPw811oNJZdb) |
| 4 | `send 0.7 NEAR to shop.spendguard-b31c91.testnet for second order` | `payment: refused`, `reason: E_DAILY` (0.6 spent + 0.7 > 1.2 daily cap; exit 3) | [5aAXeDrC…](https://testnet.nearblocks.io/txns/5aAXeDrCHs8zLJhi5UoCuVuCw9gHGSLUPGdYsxLYWCo1) |

State afterwards (`node demo/owner.mjs status agent.spendguard-b31c91.testnet`):
`pending: []`, `spent_today: 600000000000000000000000` (0.6 NEAR). Merchant balance went
from 0.1 to 0.7 NEAR. The agent key's allowance went from 1 NEAR to ~0.9986 NEAR after
four calls (unused prepaid gas is refunded to the allowance).

## Judge-style reruns with fresh accounts

**Rerun 1** (23:46–23:49 UTC, before the Codex review): the README's first draft of
"Rerun on testnet with your own accounts", from a clean copy of the working tree with a
new faucet account (owner `spendguard-ab4394.testnet`). The owner account id was copied
by hand there; the final README captures it automatically (Codex finding P4).

| Step | Transaction |
| --- | --- |
| `faucet-account` → `spendguard-ab4394.testnet` | [2RK7kyuK…](https://testnet.nearblocks.io/txns/2RK7kyuKvPq6T8scxiXioUCgXKj9XmWkBEbWaSsX1QMM) |
| `create-account guard 6` / `agent 0.5` / `shop 0.1` | [AfV2YFqd…](https://testnet.nearblocks.io/txns/AfV2YFqdS3BtxCyg4DKXkEKurbfNaM2z4rFt4W3xDKRV) · [4CQynthU…](https://testnet.nearblocks.io/txns/4CQynthUiFo1As8JkvkyynV3FKCkWkj9RRNiLELYu23Q) · [Ebee23SY…](https://testnet.nearblocks.io/txns/Ebee23SYDyM6YtSpd4Cmvjrb94Zp2SkAk7jrQ4LKqSEG) |
| `deploy` (batch DeployContract + `new`) | [Eea8raqC…](https://testnet.nearblocks.io/txns/Eea8raqCqkGEQKwoYdEyNJyapRkJZ1GrBHJYUGWr3fYa) |
| `add-agent` | [CBpbttbM…](https://testnet.nearblocks.io/txns/CBpbttbMAWpCL4t3NYAmy48ukKCCVj7XwSbHGcNBvAg9) |
| `install-key.mjs --submit` (1 NEAR allowance) | [9UQeR9U3…](https://testnet.nearblocks.io/txns/9UQeR9U3RCi2pzjMFLDYX8ms1xFVKcE7ne2nYTdPp4vN) |
| 0.1 NEAR → `completed` | [HrE2y283…](https://testnet.nearblocks.io/txns/HrE2y283VfuSZ7CPZyjUjxJ3LGHsM5P9Y8mGvyp5DKTe) |
| 0.5 NEAR → `awaiting_owner_approval`, request 2 | [2FF4TyRS…](https://testnet.nearblocks.io/txns/2FF4TyRSM1ekdLSdK9WcLYs33cjiMgg9NTZcaPAspP62) |
| `approve 2` → paid | [EpAJebwd…](https://testnet.nearblocks.io/txns/EpAJebwdrncY87jNV6KMxa6XyyEoFVQ2XScLs9qb2tr2) |
| `stranger.testnet` → `refused E_NOT_ALLOWLISTED` | [HCZ12kbX…](https://testnet.nearblocks.io/txns/HCZ12kbXRpgejXZGKX89nhZDjMxG4YT71opPiJ8PBJFD) |
| 0.7 NEAR → `refused E_DAILY` | [CnpeJi7h…](https://testnet.nearblocks.io/txns/CnpeJi7hKQxpizSoxmgrxQJRCkyp1bZEmiC8q5yJziWk) |

Final `status`: `pending: []`, `spent_today: 600000000000000000000000`. Identical outcomes.

**Rerun 2** (2026-10-30 00:00–00:02 UTC, after the Codex fixes): both bash blocks of the
final README section were extracted from the file and executed unmodified by `bash`,
except that `NEAR_KEY_DIR` pointed outside the clone. Owner `spendguard-b074a0.testnet`:

| Step | Transaction |
| --- | --- |
| `create-account guard 6` / `agent 0.5` / `shop 0.1` | [2e4MgAJZ…](https://testnet.nearblocks.io/txns/2e4MgAJZxLbtEHWUcgAb9fxMR2bded7zbjoKkr38tcRj) · [9Ue1d31e…](https://testnet.nearblocks.io/txns/9Ue1d31eW9ctkUAi7Pe6m17wE49nTCT1UWRCaDrnEXvz) · [HpZAte97…](https://testnet.nearblocks.io/txns/HpZAte97vCwHGYipxgHoPpwMiotxf9nZxUNcNRcRKfAp) |
| `deploy` | [3EVYvNnZ…](https://testnet.nearblocks.io/txns/3EVYvNnZ4JFVXM3Un8tS2hYN3KL9wQ3bk678oRYfA65U) |
| `add-agent` | [6ScQQ6oR…](https://testnet.nearblocks.io/txns/6ScQQ6oRnadrByagubnRbmosnSTLJPUX7ZM4zne7E3y8) |
| `install-key.mjs --submit` | [3a6e733v…](https://testnet.nearblocks.io/txns/3a6e733vY2AhneqVQviaZQnSuCFtDyufdQdZrpEDGhre) |
| 0.1 NEAR → `completed` | [6f8K9UeQ…](https://testnet.nearblocks.io/txns/6f8K9UeQ6HrdWVLEiqot3haCM46ryAkGRLaAWD5nkHLB) |
| `approve 2` → `payment: completed` | [5LoMU1B2…](https://testnet.nearblocks.io/txns/5LoMU1B27AY2qDch3N18DnfVkB5BbfmcTrNU9VCfCmJP) |
| `stranger.testnet` → `refused E_NOT_ALLOWLISTED` | [2CA8k6df…](https://testnet.nearblocks.io/txns/2CA8k6dfnTbKPoSdTUUNkL6L34czcoLzUqmyNaoxREHx) |
| 0.7 NEAR → `refused E_DAILY` | [CsPRi8Bh…](https://testnet.nearblocks.io/txns/CsPRi8BhGAHKpJLToB5RRPTjh8C8PtK7vhGa2ejaMmZ9) |

Final `status`: `pending: []`, `spent_today: 600000000000000000000000`. The pending-request
transaction (request 2) of this run is not listed: its output went through
`tee /dev/stderr` into a log file, which truncated it. The README now tees into
`$NEAR_KEY_DIR/pending.json` instead; those two lines were then rerun on the same accounts
(request 3: [5vdj54Qa…](https://testnet.nearblocks.io/txns/5vdj54QambG6APNH1sqhWibKcowqHBwQU5vYbSCXuYaA)
→ `awaiting_owner_approval`, approve [bSEJaeu9…](https://testnet.nearblocks.io/txns/bSEJaeu9ch2PrinZKk4SfuJ98YSN6GBeq7mTg4YMbYW) → `payment: completed`).

**Rerun 3** (2026-10-30 00:20–00:22 UTC, after the second Codex round): both bash blocks
of the updated README section (`set -o pipefail`, guarded `json` helper, `|| test $? -eq 3`
on the two refusals) were extracted from the file and run unmodified with `bash -e` in a
copy of the working tree, owner `spendguard-b506b3.testnet`. Exit status 0.

| Step | Transaction |
| --- | --- |
| `create-account guard 6` / `agent 0.5` / `shop 0.1` | [2FWG4mPG…](https://testnet.nearblocks.io/txns/2FWG4mPGW8pWqML7uybRkaoRJQ5EEReysQZQJZrCwXgx) · [DpF2XYRW…](https://testnet.nearblocks.io/txns/DpF2XYRWbxW3KAGs7iVXcozgeJKArAcKScGdgyhKrSVP) · [9kSxpwbo…](https://testnet.nearblocks.io/txns/9kSxpwboYgpscP5f1YKAtFsPjcFSbuW1DR1ecpp5kWHJ) |
| `deploy` | [7g2y29Yo…](https://testnet.nearblocks.io/txns/7g2y29YoLwn3fkM2gNmfbJ2kXBR59TGjom2ptZSxX68K) |
| `add-agent` | [EXKdWptu…](https://testnet.nearblocks.io/txns/EXKdWptuvYE2HpVV5XZ41XdTjxxi4Wu9gn41TqfsUGT2) |
| `install-key.mjs --submit` | [5ndZfEhL…](https://testnet.nearblocks.io/txns/5ndZfEhLD2AGS7C8jgE8JDCHqugUndQ7ZZZGibwYsMiy) |
| 0.1 NEAR → `completed` | [2TfQ6c9Z…](https://testnet.nearblocks.io/txns/2TfQ6c9ZEeQE7rjXHeY3TjzH9XgG9ggfDcGNSTYWZ2ZB) |
| 0.5 NEAR → `awaiting_owner_approval`, request 2 | [HkcEeAAm…](https://testnet.nearblocks.io/txns/HkcEeAAmXdCrxYc4NoYkBb9NFTXX47PG4fV93SgY29Sz) |
| `approve 2` → `payment: completed` | [DTw5uD1E…](https://testnet.nearblocks.io/txns/DTw5uD1EuX3Xq2oEyreDDwmYCNsqyKvrwdRWortC5KHn) |
| `stranger.testnet` → `refused E_NOT_ALLOWLISTED` | [5HmC4XaV…](https://testnet.nearblocks.io/txns/5HmC4XaVMg2mvdfV9mS84Q4E5XGRhigLXaYDvD84XCBZ) |
| 0.7 NEAR → `refused E_DAILY` | [E3XPdvFt…](https://testnet.nearblocks.io/txns/E3XPdvFtxUvQ2psdj7tPEqNgE1zcTGhutUe7ZWw7FPxv) |

Final `status`: `pending: []`, `spent_today: 600000000000000000000000`. Identical outcomes.

## Demo video take

Recorded 2026-10-30 00:23–00:24 UTC (UTC day 20756, `spent_today` was `0` beforehand) on
the main deployment with the commands of [VIDEO_PLAN.md](VIDEO_PLAN.md), after the second
Codex round's fixes:

| Step | Result | Transaction |
| --- | --- | --- |
| 0.1 NEAR coffee | `payment: completed` | [C6WyNnUj…](https://testnet.nearblocks.io/txns/C6WyNnUj8NAspgs6jpAVH6A8ARCaM5R6m27rmppfQ2tn) |
| 0.5 NEAR API credits | `awaiting_owner_approval`, `request_id: 4` | [7ZZH2pmS…](https://testnet.nearblocks.io/txns/7ZZH2pmSZsAd9esCqfitURPg5YkUeueMkyohUq9VcsD1) |
| `approve 4` | `payment: completed` | [CxeyidAH…](https://testnet.nearblocks.io/txns/CxeyidAH9VPyz5YUVfrtLCCa7F8FWim5ayHuBUE5QtR6) |
| `stranger.testnet` | `refused`, `E_NOT_ALLOWLISTED`, exit 3 | [CMpUbeRe…](https://testnet.nearblocks.io/txns/CMpUbeReZQauURBwByaUZ5xcDpCzxVbvcg6LP8tUwUrJ) |
| 0.7 NEAR second order | `refused`, `E_DAILY`, exit 3 | [AoooFQrD…](https://testnet.nearblocks.io/txns/AoooFQrDUfw8T7Tybrju6KreaQFomcxuuMCYcvEHx5UN) |

Afterwards: `pending: []`, `spent_today: 600000000000000000000000`,
`available_for_payouts` ~1.34 NEAR. On nearblocks the refusal shows Failed with
`E_NOT_ALLOWLISTED` and the coffee payment shows Success.

Explorer pages were opened in a browser on 2026-10-30: the immediate-payment transaction
shows Success (`spend`, agent → guard), the stranger refusal shows Failed with
`E_NOT_ALLOWLISTED`, and the guard account page shows the deployed contract (279.07 kB storage).

## Findings from the live run (fixed)

| ID | Finding | Fix |
| --- | --- | --- |
| T1 | The phase 1 `install-key.mjs` granted a **0.1 NEAR** gas allowance. Testnet RPC rejected every `spend` before inclusion: `Access Key … does not have enough balance 0.1 for transaction costing 0.1009…` (100 Tgas prepaid at the pessimistic gas price). The sandbox test used 0.5 NEAR and never hit it. | Default allowance 1 NEAR (`NEAR_AGENT_KEY_ALLOWANCE` overrides); the key was deleted and reinstalled. The allowance is still finite and still only pays gas; payouts are limited by the contract policy. |
| T2 | A refused spend surfaced only as a raw RPC error; the panic text is JSON-escaped (`…lib.rs:282:9:\nE_NOT_ALLOWLISTED`), so a `\b`-anchored match missed the code. | `agent.mjs` reports `{transaction, explorer, accepted: false, payment: "refused", reason: "E_…"}` and exits 3; `refusalCode` handles the escaped form (unit tested). |
| T3 | near-api-js printed receipt logs to stdout, mixing them into the JSON output. | `logger: false` on every connection. |
| T4 | `rpc.testnet.near.org` is deprecated and answered `-429` ("THIS ENDPOINT IS DEPRECATED … Switch to https://fastnear.com") midway through the rerun. | Default RPC is FastNEAR's public testnet endpoint `https://test.rpc.fastnear.com` (listed at https://docs.near.org/api/rpc/providers); `NEAR_RPC_URL` overrides. |
| T5 | `install-key.mjs` did not print its transaction hash. | It now prints the hash and explorer link. The first (0.1 NEAR) key installation therefore has no recorded hash; it was removed by the `deleteKey` transaction above. |

Account keys are kept outside the repository and were never printed or committed.
