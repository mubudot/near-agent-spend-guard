# Demo video plan (≤ 3 minutes)

For the X demo post (rules: the post says the project was built at NEAR HACKATHON and has
the video attached). Terminal plus one browser tab; no voice required, captions carry it.
Record against the live testnet deployment in [TESTNET_RUN.md](TESTNET_RUN.md), whose
accounts and agent key are already provisioned.

## Before recording

- Start **after a UTC midnight** (08:00 CST) with nothing spent that UTC day, and finish the
  take within that day: the 0.7 NEAR `E_DAILY` refusal relies on 0.6 NEAR already spent the
  same UTC day, and pending requests expire at UTC midnight.
- Check liquidity and allowance: `NEAR_CONTRACT_ACCOUNT=guard.spendguard-b31c91.testnet
  node demo/owner.mjs status agent.spendguard-b31c91.testnet` shows `available_for_payouts`
  (balance minus storage stake, 65,536-byte headroom and pending reserves — the contract's
  own liquidity rule), `spent_today` (must be `0`) and the agent key's remaining `allowance`.
  Before the recorded take: ~1.95 NEAR available. After it (read-only `status`, 2026-10-30):
  ~1.34 NEAR available, ~0.9975 NEAR allowance. Each take pays out 0.6 testnet NEAR and uses
  ~0.0014 NEAR of allowance, so two more takes fit; the owner tops up with `node demo/owner.mjs fund 2`.
- Export the environment in a separate, unrecorded shell step (keys come from the
  key directory; never show `NEAR_AGENT_PRIVATE_KEY` or a key file on screen). Clear the
  screen afterwards. Use a large font (≥ 18 pt), 100×30 terminal, dark theme.
- Define `SHOP=shop.spendguard-b31c91.testnet` so commands fit on one line.
- Dry-run the whole script once off camera on a different day, or with a fresh faucet
  setup (README "Rerun on testnet with your own accounts"), so the take itself is clean.

## Script

| Time | Screen | Caption / narration |
| --- | --- | --- |
| 0:00–0:15 | Title card or README top | "NEAR Agent Spend Guard — give an AI agent a budget, not your wallet. Built at NEAR HACKATHON." |
| 0:15–0:35 | `cat` the policy: `node demo/owner.mjs status agent.spendguard-b31c91.testnet` | "Owner-set policy on chain: only the shop is allowlisted, 1 NEAR per tx, 1.2 NEAR per day, anything above 0.2 NEAR needs the owner." |
| 0:35–0:50 | nearblocks page of the agent account's access keys (or `curl` `view_access_key_list`) | "The agent holds only a function-call key: it can call `spend` on this contract and nothing else — no transfers, no admin." |
| 0:50–1:10 | `npm run demo -- --submit "send 0.1 NEAR to $SHOP for coffee"` | "Small purchase → paid immediately." Highlight `payment: completed`. |
| 1:10–1:35 | `npm run demo -- --submit "send 0.5 NEAR to $SHOP for monthly API credits"` | "Above the threshold → the contract holds it for approval and reserves the funds." Highlight `awaiting_owner_approval`, `request_id`. |
| 1:35–1:55 | `node demo/owner.mjs approve <id>` | "The owner approves → the contract pays." |
| 1:55–2:15 | `npm run demo -- --submit "send 0.1 NEAR to stranger.testnet for refund scam"` | "A prompt-injected agent tries to pay a stranger → refused on chain, `E_NOT_ALLOWLISTED`. No funds move." |
| 2:15–2:30 | `npm run demo -- --submit "send 0.7 NEAR to $SHOP for second order"` | "Over the daily cap → refused, `E_DAILY`." |
| 2:30–2:50 | Click one explorer link from the output (the refusal) on testnet.nearblocks.io | "Every decision is a testnet transaction anyone can inspect." |
| 2:50–3:00 | README "Reproduce" heading + repo URL | "Tests, sandbox and testnet steps in the README. Testnet only, MIT." |

## Recording plan

- **Terminal capture:** `asciinema rec work/video/take1.cast` (install with `pipx install
  asciinema`), then render with `agg take1.cast take1.gif` and convert:
  `ffmpeg -i take1.gif -movflags +faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" take1.mp4`.
  Alternative on a desktop: OBS or `ffmpeg -f x11grab -framerate 30 -video_size 1920x1080 -i :0.0 take1.mp4`
  (screen + browser in one take).
- Captions: burn in with `ffmpeg -vf subtitles=captions.srt`, or add in any editor.
- Keep every recording artefact outside the repository (`work/`), not committed.
- X accepts MP4 (H.264/AAC), ≤ 2:20 for standard accounts and longer for Premium: if the
  account is not Premium, trim the title card and the explorer click to fit 2:20.
- Before posting, scrub the frames for key material, local paths, host names and e-mail
  addresses.

Status: recorded 2026-10-30. The video (1:48, 1080p, H.264/AAC, captions plus Piper TTS
narration, no music) was rendered from a **live take**: the script's commands were run
against the deployment at 00:23–00:24 UTC on a fresh UTC day, their real output was
captured and rendered as terminal frames, with three testnet.nearblocks.io screenshots
(agent access keys, the `E_NOT_ALLOWLISTED` refusal, the immediate payment). Take
transactions: [TESTNET_RUN.md](TESTNET_RUN.md#demo-video-take). Every 0.5 s frame was OCR-checked for
e-mail addresses, names, IP addresses, local paths and private-key material: none found; only
public keys and testnet account ids appear. The file is kept outside the repository and
has not been posted. `scripts/video/` separately renders a condensed replay of the first
run from the recorded hashes (no new transactions).
