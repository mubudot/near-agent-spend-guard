# Testnet demo video

Run `bash scripts/video/make_demo.sh` from the repository root. Requires Python 3,
Pillow, DejaVu fonts, and system `ffmpeg` / `ffprobe` with libx264. On Debian/Ubuntu:
`apt-get install python3-pil fonts-dejavu-core ffmpeg`.

The default is a 130-second, 1920×1080 H.264 MP4 at `../work/near_demo.mp4`, with
captions rendered into the frames and no audio or music. `--out /absolute/path.mp4`
changes the destination; it must stay outside the repository. Optional offline
narration uses an already installed `piper-tts` and
`--voice /path/to/voice.onnx` with its adjacent `.onnx.json`. Supply a voice you have
permission to use and preserve its license attribution when distributing it.
The renderer rejects a narrated cut that would reach three minutes.

This **130-second first-run replay** is distinct from the **127-second (2:07)
published dashboard video** linked in the root README. The published cut uses
headless-Chrome dashboard screenshots and terminal frames rendered from the real
JSON output of the later [Dashboard video take](../../docs/TESTNET_RUN.md#dashboard-video-take),
as documented in [VIDEO_PLAN.md](../../docs/VIDEO_PLAN.md#dashboard-version-2026-10-30-replaces-the-148-take-for-posting).
`make_demo.sh` / `make_demo.py` here render the first-run replay, not that dashboard
cut; how the published cut was assembled is described in VIDEO_PLAN.md (linked above).
The replay's generated captions and scene timings do not match the published cut.

This is an explicitly labeled edited replay of the first run in
`docs/TESTNET_RUN.md`, not a new screen recording. Policy amounts are displayed in
NEAR and terminal responses are condensed. It includes immediate settlement,
pending approval and owner payout, allowlist and daily-cap refusals, and the
public transaction identifiers. It does not open credentials, capture a desktop,
read environment secrets, make network calls, or submit transactions. The only
external source of displayed data is the public transaction list in the document.

Generated scene PNGs, captions, scene timing/evidence JSON, intermediate clips,
and frames extracted from the final MP4 are placed in `../work/near_demo_assets/`.
Inspect **every** `review_*.png` before sharing; a text denylist also checks scene
definitions for key prefixes, email addresses, credential headers, and local paths.
No recording artifact belongs in git. This command only builds the local video;
posting or uploading is a separate action.
