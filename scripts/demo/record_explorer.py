#!/usr/bin/env -S python3 -I
"""Record one public block-explorer page (a REAL capture, separate headless browser): reload until the explorer has
indexed the transaction ("Success"), then capture ~10 s with the CDP screencast. Used when the explorer was still
indexing during the UI take; make_video.py --explorer DIR then shows this capture and says it was opened later.

  record_explorer.py --url https://eth-sepolia.blockscout.com/tx/0x... --out tmp/demo/final/explorer
Writes OUT/explorer.mp4 and OUT/marks.json (start/end).
"""
import argparse, base64, json, os, re, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp_lite as c  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--url", required=True)
ap.add_argument("--out", required=True)
a = ap.parse_args()
if not re.fullmatch(r"https://eth-sepolia\.blockscout\.com/tx/0x[0-9a-f]{64}", a.url):
    raise SystemExit("only a Sepolia Blockscout transaction URL is allowed")
OUT = os.path.realpath(os.path.join(c.PROD, a.out))
if not OUT.startswith(c.PROD + "/tmp/"):
    raise SystemExit("--out must be under tmp/")
FR = os.path.join(OUT, "frames")
os.makedirs(FR, exist_ok=True)
for f in os.listdir(FR):
    os.remove(os.path.join(FR, f))
frames = []


def on_event(m):
    if m.get("method") == "Page.screencastFrame":
        p = m["params"]
        path = os.path.join(FR, f"{len(frames):06d}.jpg")
        with open(path, "wb") as f:
            f.write(base64.b64decode(p["data"]))
        frames.append((p["metadata"]["timestamp"], path))
        t.send_nowait("Page.screencastFrameAck", sessionId=p["sessionId"])


c.launch(width=1920, height=940)
t = None
try:
    t = c.Tab()
    t.viewport(1920, 940, 1, False)
    ok = False
    for _ in range(12):
        t.goto(a.url, 5.0)
        if t.js("/\\bSuccess\\b/.test(document.body.innerText)"):
            ok = True
            break
        t.pump(5.0)
    if not ok:
        raise SystemExit("explorer did not show Success")
    t.pump(1.0)
    t.on_event = on_event
    t.call("Page.startScreencast", format="jpeg", quality=85, maxWidth=1920, maxHeight=940, everyNthFrame=1)
    t.pump(0.5)
    t.js("window.scrollTo({top: 0}); true")
    # gentle scroll so the frames change (headless sends frames only when the page paints)
    for y in range(0, 241, 8):
        t.js(f"window.scrollTo({{top: {y}}}); true")
        t.pump(0.12)
    t.pump(5.5)
    t.call("Page.stopScreencast")
    t.pump(0.5)
finally:
    if t:
        t.close()
    c.stop()
if len(frames) < 3:
    raise SystemExit("too few frames")
end_ts = frames[-1][0] + 1.0
lst = os.path.join(OUT, "frames.txt")
with open(lst, "w") as f:
    f.write("ffconcat version 1.0\n")
    for i, (ts, path) in enumerate(frames):
        nxt = frames[i + 1][0] if i + 1 < len(frames) else end_ts
        f.write(f"file '{path}'\nduration {max(0.034, nxt - ts):.3f}\n")
    f.write(f"file '{frames[-1][1]}'\n")
subprocess.run(["/usr/bin/ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-vf", "format=yuv420p", "-r", "30",
                "-c:v", "libx264", "-crf", "18", "-preset", "medium", os.path.join(OUT, "explorer.mp4")], check=True)
json.dump({"frames": len(frames), "duration": round(end_ts - frames[0][0], 2), "marks": {"start": 0.0}, "url": a.url,
           "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, open(os.path.join(OUT, "marks.json"), "w"), indent=1)
print(json.dumps({"out": os.path.relpath(os.path.join(OUT, "explorer.mp4"), c.PROD), "frames": len(frames)}))
