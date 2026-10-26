#!/usr/bin/env -S python3 -I
"""Make SYNTHETIC test recordings (English + Swahili) for the ASR benchmark and the demo.

Dev-time only (needs the network; never part of the offline app). Uses our vetted Edge-TTS wire client
(an edge-tts compatible client, folder in SAUTI_TTS_DIR) with Kenyan / Tanzanian neural voices, then ffmpeg -> 16 kHz mono WAV.
  scripts/make_test_audio.py            (writes test/audio/*.wav from test/audio/prompts.json)
"""
import json, os, subprocess, sys, time

# an edge-tts compatible client module "tts" (synth(text, out, voice=..., rate=...)); its folder in SAUTI_TTS_DIR
if not os.environ.get("SAUTI_TTS_DIR"):
    raise SystemExit("set SAUTI_TTS_DIR to the folder of a tts.py client (dev-only: test audio generation)")
sys.path.insert(0, os.environ["SAUTI_TTS_DIR"])
import tts  # noqa: E402

PROD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VOICES = {"sw-KE-ZuriNeural", "sw-KE-RafikiNeural", "sw-TZ-RehemaNeural", "sw-TZ-DaudiNeural",
          "en-KE-AsiliaNeural", "en-KE-ChilembaNeural", "en-US-AriaNeural"}
tts.ALLOWED_VOICES = set(tts.ALLOWED_VOICES) | VOICES

out_dir = os.path.join(PROD, "test", "audio")
prompts = json.load(open(os.path.join(out_dir, "prompts.json"), encoding="utf-8"))
for p in prompts:
    sid = "".join(c for c in p["id"] if c.isalnum() or c in "_-")
    wav = os.path.join(out_dir, sid + ".wav")
    if os.path.exists(wav):
        continue
    mp3 = os.path.join(PROD, "tmp", sid + ".mp3")
    for attempt in range(4):
        try:
            tts.synth(p["text"], mp3, voice=p["voice"], rate=p.get("rate", "+0%"))
            break
        except Exception as e:  # the free endpoint rate-limits bursts (HTTP 429)
            print("retry", sid, type(e).__name__, file=sys.stderr)
            time.sleep(10 * (attempt + 1))
    else:
        raise SystemExit(f"failed {sid}")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", mp3, "-ac", "1", "-ar", "16000",
                    "-sample_fmt", "s16", wav], check=True)
    os.remove(mp3)
    print(sid, os.path.getsize(wav))
    time.sleep(5)
