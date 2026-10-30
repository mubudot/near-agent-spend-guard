#!/usr/bin/env python3
"""Render the documented testnet run, without reading credentials or sending transactions.

Needs Python 3 + Pillow and ffmpeg/ffprobe. Optional narration: piper-tts and
--voice /path/to/voice.onnx (the voice's adjacent .onnx.json must also exist).
Default output is ../work/near_demo.mp4; all generated assets stay outside git.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import wave
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
BG, PANEL, INK = "#0a1019", "#111d2c", "#edf4fb"
MUTED, GREEN, AMBER, RED = "#9aafc4", "#62edba", "#ffd182", "#ff8f9f"
FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")


def font(size, mono=False, bold=False):
    name = "DejaVuSansMono" if mono else "DejaVuSans"
    return ImageFont.truetype(str(FONT_DIR / f"{name}{'-Bold' if bold else ''}.ttf"), size)


def scenes():
    # Extract only public identifiers from the documented first run. Nothing from
    # environment variables, credential directories, git identity, or shell output.
    doc = (ROOT / "docs/TESTNET_RUN.md").read_text()
    first_run = doc.split("## Judge-style reruns")[0]
    hashes = re.findall(r"https://testnet.nearblocks.io/txns/([1-9A-HJ-NP-Za-km-z]{43,44})", first_run)
    if len(hashes) != 13:
        raise SystemExit("Documented first-run transactions changed; review the video script.")
    small, pending, approval, stranger, daily = hashes[-5:]
    agent, guard, shop = (f"{role}.spendguard-b31c91.testnet" for role in ("agent", "guard", "shop"))
    data = [
        dict(id="intro", seconds=10, title="Give an agent a budget.", subtitle="Keep control of the wallet.",
             command="NEAR Agent Spend Guard", color=GREEN,
             lines=[("Built at NEAR HACKATHON", GREEN),
                    ("Owner-set spending policy, enforced on chain.", INK),
                    ("Restricted agent key + native NEAR payments", INK),
                    ("Documented testnet run: 29 Oct 2026, 23:39-23:49 UTC", MUTED),
                    ("Edited replay from docs/TESTNET_RUN.md", MUTED)],
             caption="A mistaken or injected agent still has to obey the contract.",
             narration="NEAR Agent Spend Guard. Give an agent a budget and keep control of the wallet. Built at NEAR Hackathon. This is an edited replay of the documented testnet run."),
        dict(id="policy", seconds=15, title="The owner sets the rules.", subtitle="01 / Policy on the contract", color=GREEN,
             command=f"$ node demo/owner.mjs status {agent}",
             lines=[("Policy summary (amounts displayed in NEAR):", MUTED),
                    (f"allowlist             {shop}", INK),
                    ("per_tx_max            1.0 NEAR", INK),
                    ("daily_max             1.2 NEAR", INK),
                    ("approval_threshold    0.2 NEAR", AMBER),
                    ("paused                false", GREEN)],
             caption="Only the shop is allowed. Hard caps apply even with approval.",
             narration="The owner allows one shop, a maximum of one NEAR per transaction, and one point two NEAR per UTC day. Payments above zero point two NEAR need owner approval. Hard caps still apply."),
        dict(id="key", seconds=12, title="The agent uses a restricted key.", subtitle="02 / Function-call permission", color=GREEN,
             command="Installed agent key permission (public summary)",
             lines=[("FunctionCall {", INK), (f'  receiver_id: "{guard}",', INK),
                    ('  method_names: ["spend"],', GREEN),
                    ('  allowance: 1 NEAR  // finite gas allowance at install', INK),
                    ("}", INK), ("The demo checks these permissions before submission.", MUTED)],
             caption="This key can call spend on the guard; it cannot transfer or administer.",
             narration="The agent uses only a function call key, restricted to spend on this contract, with a finite gas allowance. This key cannot transfer funds directly or change policy. Gas allowance and payment budget are separate."),
        dict(id="small", seconds=14, title="A small purchase settles immediately.", subtitle="03 / Below the approval threshold", color=GREEN,
             command='$ npm run -s demo -- --submit "send 0.1 NEAR to $SHOP for coffee"',
             lines=[("{", INK), ('  "payment": "completed"', GREEN), ("}", INK),
                    ("spend_requested  ->  transfer_succeeded", GREEN),
                    ("0.1 NEAR paid to the allowlisted shop.", INK)],
             caption="Completed means the transfer settled in a later receipt.", transaction=small,
             narration="A request for zero point one NEAR is below the threshold. The contract accepts it, the transfer settles, and the demo reports payment completed. Accepted alone would not prove payment."),
        dict(id="pending", seconds=16, title="A larger purchase waits for the owner.", subtitle="04 / Above the threshold, within the caps", color=AMBER,
             command='$ npm run -s demo -- --submit "send 0.5 NEAR to $SHOP for API credits"',
             lines=[("{", INK), ('  "payment": "awaiting_owner_approval",', AMBER),
                    ('  "request_id": "2"', INK), ("}", INK),
                    ("0.5 NEAR reserved; no payment yet.", AMBER),
                    ("Reservation counts against daily budget and liquidity.", MUTED)],
             caption="Pending is a reservation, not a completed transfer.", transaction=pending,
             narration="Zero point five NEAR exceeds the approval threshold but stays within the hard caps. The contract creates pending request two and reserves the funds and daily budget. The shop has not been paid yet."),
        dict(id="approve", seconds=12, title="The owner approves. The shop is paid.", subtitle="05 / Owner action", color=GREEN,
             command="$ node demo/owner.mjs approve 2",
             lines=[("{", INK), ('  "action": "approve",', INK), ('  "request_id": "2",', INK),
                    ('  "payment": "completed"', GREEN), ("}", INK),
                    ("approved  ->  transfer_succeeded", GREEN)],
             caption="The contract rechecks the current policy before paying.", transaction=approval,
             narration="The owner approves request two. The contract rechecks current policy and pause state, then pays the shop. The result confirms that the payment completed."),
        dict(id="stranger", seconds=15, title="An injected request hits the allowlist.", subtitle="06 / Refused on chain", color=RED,
             command='$ npm run -s demo -- --submit "send 0.1 NEAR to stranger.testnet"',
             lines=[("{", INK), ('  "accepted": false,', INK), ('  "payment": "refused",', RED),
                    ('  "reason": "E_NOT_ALLOWLISTED"', RED), ("}", INK),
                    ("Exit 3 / failed transaction / no payout", MUTED)],
             caption="A scam destination is refused by the contract. No payment funds move.", transaction=stranger,
             narration="Now the agent tries to pay a stranger. The contract refuses the transaction with E not allowlisted. No payment funds move. The refusal happens on chain, even if the agent wants to comply."),
        dict(id="daily", seconds=14, title="The daily cap blocks overspending.", subtitle="07 / Refused even for the allowed shop", color=RED,
             command='$ npm run -s demo -- --submit "send 0.7 NEAR to $SHOP for second order"',
             lines=[('"payment": "refused"', RED), ('"reason": "E_DAILY"', RED),
                    ("", INK), ("0.1 paid + 0.5 approved = 0.6 NEAR already spent", INK),
                    ("0.6 + 0.7 = 1.3 NEAR  >  1.2 NEAR daily cap", AMBER),
                    ("Same UTC day. No payment funds move.", MUTED)],
             caption="Approval cannot override the owner's hard spending caps.", transaction=daily,
             narration="The shop is allowed, but a further zero point seven NEAR would take daily spending from zero point six to one point three. That exceeds the one point two cap. The contract refuses it with E daily."),
        dict(id="evidence", seconds=12, title="Every outcome leaves public evidence.", subtitle="08 / Inspect the testnet transaction", color=GREEN,
             command="Public evidence / stranger-payment refusal",
             lines=[("testnet.nearblocks.io/txns/", MUTED), (stranger, INK),
                    ("", INK), ("Recorded explorer result: Failed / E_NOT_ALLOWLISTED", RED),
                    ("Final state: pending [] / spent_today 0.6 NEAR", GREEN),
                    ("Full transaction links: docs/TESTNET_RUN.md", INK)],
             caption="This is documented testnet evidence; no new transactions are submitted.",
             narration="Every outcome has a public testnet transaction. The stranger refusal shows a failed transaction and its contract error. All links are in the testnet run document. Final state has no pending requests and zero point six NEAR spent."),
        dict(id="reproduce", seconds=10, title="Run it. Inspect it. Reproduce it.", subtitle="NEAR Agent Spend Guard / mubudot", color=GREEN,
             command="$ # Start with README.md",
             lines=[("cargo test", INK), ("npm ci --ignore-scripts && npm test", INK),
                    ("npm run test:integration", INK),
                    ("", INK), ("README.md             Local + testnet reproduction", MUTED),
                    ("docs/TESTNET_RUN.md    Public transaction evidence", MUTED)],
             caption="Testnet only. No real funds. MIT licensed. Offline rule-based demo.",
             narration="The README includes local tests, sandbox integration, and testnet reproduction. The demo uses an offline rule based parser. Testnet only, no real funds. MIT licensed."),
    ]
    # Displayed prose is curated, not a verbatim terminal capture. Keep that
    # distinction visible, and fail closed if unexpected sensitive text is added.
    serialized = json.dumps(data)
    forbidden = [r"ed25519:", r"-----BEGIN", r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", r"/home/", r"/workspace/"]
    if any(re.search(pattern, serialized) for pattern in forbidden):
        raise SystemExit("Unsafe content in scene definitions")
    return data


def draw_scene(scene, index, count, target):
    image = Image.new("RGB", (1920, 1080), BG)
    d = ImageDraw.Draw(image)

    def text(x, y, value, size=30, color=INK, mono=False, bold=False, max_width=1744):
        face = font(size, mono, bold)
        if d.textbbox((0, 0), value, font=face)[2] > max_width:
            raise ValueError(f"Text overflows: {scene['id']}")
        d.text((x, y), value, font=face, fill=color)

    d.rounded_rectangle((80, 48, 266, 92), radius=22, fill=GREEN)
    text(101, 56, "NEAR / DEMO", 20, BG, bold=True)
    text(304, 58, "AGENT SPEND GUARD", 22, MUTED, bold=True)
    text(1480, 58, "TESTNET ONLY", 22, GREEN, bold=True, max_width=360)
    text(80, 130, scene["subtitle"], 25, scene["color"])
    text(80, 176, scene["title"], 53, INK, bold=True)

    d.rounded_rectangle((80, 279, 1840, 872), radius=22, fill=PANEL, outline="#2a3e54", width=2)
    for x, color in ((115, RED), (141, AMBER), (167, GREEN)):
        d.ellipse((x, 303, x + 13, 316), fill=color)
    text(211, 297, "DOCUMENTED OUTPUT / CONDENSED REPLAY", 20, MUTED, mono=True)
    d.line((104, 339, 1816, 339), fill="#2a3e54", width=2)
    text(116, 364, scene["command"], 27, GREEN, mono=True, max_width=1680)
    for n, (line, color) in enumerate(scene["lines"]):
        text(116, 431 + n * 53, line, 30, color, mono=True, max_width=1680)
    evidence = scene.get("transaction")
    if evidence:
        text(116, 818, "TX  " + evidence, 23, MUTED, mono=True)
    else:
        text(116, 818, "SOURCE  docs/TESTNET_RUN.md + README.md", 23, MUTED, mono=True)

    d.rounded_rectangle((80, 908, 1840, 991), radius=16, fill="#192a38")
    text(106, 930, scene["caption"], 30, INK, max_width=1700)
    text(80, 1021, "Edited replay / 29 Oct 2026 testnet run / amounts shown in NEAR", 21, MUTED)
    text(1690, 1021, f"{index + 1:02d} / {count:02d}", 21, MUTED)
    d.rectangle((0, 1072, round(1920 * (index + 1) / count), 1080), fill=scene["color"])
    image.save(target)


def timestamp(seconds):
    milliseconds = round(seconds * 1000)
    hours, rest = divmod(milliseconds, 3600000)
    minutes, rest = divmod(rest, 60000)
    seconds, milliseconds = divmod(rest, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT.parent / "work/near_demo.mp4")
    parser.add_argument("--voice", type=Path, help="Optional installed Piper ONNX voice")
    args = parser.parse_args()
    out = args.out.resolve()
    build = out.parent / (out.stem + "_assets")
    if out.is_relative_to(ROOT) or build.is_relative_to(ROOT):
        parser.error("Video and generated assets must be outside the repository")
    for program in ("ffmpeg", "ffprobe"):
        if not shutil.which(program):
            parser.error(f"Missing executable: {program}")
    build.mkdir(parents=True, exist_ok=True)
    data = scenes()
    total = 0
    subtitles, concat = [], []
    for i, scene in enumerate(data):
        png, clip = build / f"{i:02d}_{scene['id']}.png", build / f"{i:02d}.mp4"
        draw_scene(scene, i, len(data), png)
        seconds = scene["seconds"]
        audio = []
        if args.voice:
            wav = build / f"{i:02d}.wav"
            subprocess.run([sys.executable, "-m", "piper", "-m", str(args.voice.resolve()), "-f", str(wav)],
                           input=scene["narration"].encode(), check=True, capture_output=True)
            with wave.open(str(wav)) as stream:
                seconds = max(seconds, stream.getnframes() / stream.getframerate() + 1)
            audio = ["-i", str(wav), "-af", "apad", "-c:a", "aac", "-b:a", "128k"]
        if total + seconds >= 180:
            raise SystemExit("Video must be shorter than three minutes; shorten narration")
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "1",
                        "-i", str(png), *audio, "-t", str(seconds), "-r", "24", "-c:v", "libx264", "-preset", "ultrafast",
                        "-crf", "20", "-threads", "2", "-pix_fmt", "yuv420p", "-map_metadata", "-1", str(clip)], check=True)
        # ffconcat supports single-quoted paths with escaped single quotes.
        concat.append("file '" + str(clip).replace("'", "'\\''") + "'")
        subtitles.append(f"{i + 1}\n{timestamp(total)} --> {timestamp(total + seconds)}\n{scene['caption']}\n")
        scene["start"], scene["duration"] = total, seconds
        total += seconds
        print(f"Rendered {i + 1}/{len(data)}: {scene['id']} ({seconds:.1f}s)", flush=True)
    (build / "scenes.json").write_text(json.dumps(data, indent=2) + "\n")
    (build / "captions.srt").write_text("\n".join(subtitles))
    listing = build / "concat.txt"
    listing.write_text("\n".join(concat) + "\n")
    # Assemble to a fresh inode, validate it, then replace the destination. This
    # also avoids stale MP4 headers when overwriting an earlier cut on a mount.
    staged = build / ".assembling.mp4"
    staged.unlink(missing_ok=True)
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing),
                    "-map", "0", "-c", "copy", "-map_metadata", "-1", "-movflags", "+faststart", str(staged)], check=True)
    probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(staged)]))
    duration = float(probe["format"]["duration"])
    video = next(s for s in probe["streams"] if s["codec_type"] == "video")
    assert duration < 180 and video["codec_name"] == "h264" and video["pix_fmt"] == "yuv420p"
    assert (video["width"], video["height"]) == (1920, 1080)
    assert abs(duration - total) < 0.2 and video["r_frame_rate"] == "24/1"
    subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", str(staged), "-f", "null", "-"],
                   check=True, capture_output=True)
    staged.replace(out)
    # Extract the actual encoded video, not source PNGs, for the final visual review.
    for i, scene in enumerate(data):
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-xerror", "-y", "-ss", str(scene["start"] + scene["duration"] / 2),
                        "-i", str(out), "-frames:v", "1", "-update", "1", str(build / f"review_{i:02d}.png")],
                       check=True, capture_output=True)
    print(f"Saved {out} ({duration:.2f}s). Review frames: {build}/review_*.png")


if __name__ == "__main__":
    main()
