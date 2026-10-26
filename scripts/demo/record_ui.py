#!/usr/bin/env -S python3 -I
"""Record the Sauti Pesa demo: a REAL run of the local app (engine + bridge must be running), driven like a
person (real mouse clicks, real key events; the microphone is Chrome's fake device playing a synthetic test
clip), captured with the CDP screencast at real frame timing.

  record_ui.py --out tmp/demo/ui --network sepolia [--port 8787] [--clip test/audio/sw_juma_15.wav]

Writes OUT/frames/*.jpg, OUT/ui.mp4 (real timing, 30 fps CFR) and OUT/marks.json (scene markers in seconds
from the first frame), used by make_video.py for captions and narration.
"""
import argparse, base64, json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp_lite as c

PROD = c.PROD
ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--network", choices=["devnet", "sepolia"], required=True)
ap.add_argument("--port", type=int, default=8787)
ap.add_argument("--clip", default=os.path.join(PROD, "test/audio/sw_juma_15.wav"))
ap.add_argument("--poison", default=None)
ap.add_argument("--abort-slow", type=float, default=0, help="abort BEFORE confirming the first two payments if the AI step took longer (s); 0 = never")
a = ap.parse_args()
OUT = os.path.join(PROD, a.out)
FR = os.path.join(OUT, "frames")
os.makedirs(FR, exist_ok=True)
for f in os.listdir(FR):
    os.remove(os.path.join(FR, f))
URL = c.ui_url(a.port)  # with this launch's UI key in the #fragment
POISON = a.poison or json.load(open(os.path.join(PROD, "data/demo-attack.json")))["poisoned_amina"]

frames = []  # (ts, path)
marks = []   # (wallclock, name)


def on_event(m):
    if m.get("method") == "Page.screencastFrame":
        p = m["params"]
        path = os.path.join(FR, f"{len(frames):06d}.jpg")
        with open(path, "wb") as f:
            f.write(base64.b64decode(p["data"]))
        frames.append((p["metadata"]["timestamp"], path))
        t.send_nowait("Page.screencastFrameAck", sessionId=p["sessionId"])


def mark(name):
    marks.append((time.time(), name))
    print(f"{time.strftime('%H:%M:%S')} {name}", flush=True)


def slow_guard(a_name, b_name, extra=0.0):
    """A busy shared CPU can make one take much slower than usual. Stop BEFORE anything is signed in that step,
    so a new recording starts from the same wallet state (and stays inside the daily limit)."""
    if not a.abort_slow:
        return
    ta = next(w for (w, n) in marks if n == a_name)
    tb = next(w for (w, n) in marks if n == b_name)
    if tb - ta > a.abort_slow + extra:
        raise SystemExit(f"ABORT: {a_name}->{b_name} took {tb - ta:.1f} s (limit {a.abort_slow + extra:.1f} s); nothing signed in this step, record again later")


def wait_view(expr, timeout=60):
    return t.wait_js(expr, timeout=timeout, every=0.15)


c.launch(fake_audio=a.clip, width=1920, height=940)
t = None
try:
    t = c.Tab()
    t.on_event = on_event
    t.call("Emulation.setTimezoneOverride", timezoneId="Africa/Nairobi")
    t.viewport(1920, 940, 1, False)
    t.goto(URL, 1.0)
    t.js(f"localStorage.setItem('sauti.network', '{a.network}'); localStorage.setItem('sauti.lang', 'sw'); true")
    t.goto(URL, 2.0)
    wait_view("document.querySelector('.pill') && !document.querySelector('.pill.loading') && !document.querySelector('.pill.down') && document.querySelectorAll('.person').length > 0", 60)
    t.pump(1.0)
    t.call("Page.startScreencast", format="jpeg", quality=85, maxWidth=1920, maxHeight=940, everyNthFrame=2)  # lighter on the shared CPU
    t.pump(0.5)
    mark("start")
    t.pump(3.0)

    # 1. the status pill and the live offline proof
    mark("proof_open")
    t.click("#pill")
    t.pump(5.5)
    t.click_text(".sheet .btn", "Funga")
    mark("proof_closed")
    t.pump(1.0)

    # 2. Swahili voice payment (fake microphone plays the synthetic clip from the start of capture)
    mark("voice_rec")
    t.click(".mic")
    t.pump(6.2)
    t.click(".mic")
    mark("voice_stop")
    wait_view("!!document.querySelector('.amount-big') || !!document.querySelector('.banner')", 60)
    mark("voice_result")
    slow_guard("voice_stop", "voice_result")
    t.pump(4.5)
    t.click_text(".actions .btn.primary", "Thibitisha")
    wait_view("!!document.querySelector('.success')", 30)
    mark("voice_signed")
    t.pump(3.5)
    t.click_text(".actions .btn", "Malipo mapya")
    t.pump(1.0)

    # 3. English, typed
    mark("en_switch")
    t.click("#langSeg button[data-lang='en']")
    t.pump(1.2)
    t.click("#reqText")
    mark("en_type")
    t.type("Send 40 USDT to Otieno for rent", 0.06)
    t.pump(0.4)
    t.key("Enter", "Enter", 13)
    wait_view("!!document.querySelector('.amount-big') || !!document.querySelector('.banner')", 60)
    mark("en_result")
    slow_guard("en_type", "en_result", 2.5)
    t.pump(4.0)
    t.click_text(".actions .btn.primary", "Confirm")
    wait_view("!!document.querySelector('.success')", 30)
    mark("en_signed")
    t.pump(2.5)
    t.click_text(".actions .btn", "New payment")
    t.pump(1.0)

    # 4. look-alike address (address poisoning)
    t.click("#reqText")
    mark("poison_type")
    t.type("Send 10 USDT to ", 0.05)
    t.type(POISON, 0.012)
    t.type(" for rent", 0.05)
    t.pump(0.3)
    t.key("Enter", "Enter", 13)
    wait_view("!!document.querySelector('.banner.bad') || !!document.querySelector('.amount-big')", 60)
    mark("poison_result")
    t.pump(6.5)
    t.click_text(".actions .btn", "OK, got it")
    t.pump(0.8)

    # 5. scam message check
    mark("check_tab")
    t.click_text(".tabs button", "Check")
    t.pump(1.2)
    t.click_text(".chips .chip", "Prize")
    t.pump(1.6)
    t.click_text(".actions .btn.primary", "Check message")
    mark("check_run")
    wait_view("!!document.querySelector('.riskbar')", 60)
    mark("check_result")
    t.pump(6.5)

    # 6. large amount: re-type before signing (Swahili, typed)
    t.click_text(".tabs button", "Send")
    t.pump(0.8)
    t.click("#langSeg button[data-lang='sw']")
    t.pump(1.0)
    t.click("#reqText")
    mark("big_type")
    t.type("Tuma USDT sitini kwa Wanjiru", 0.06)
    t.key("Enter", "Enter", 13)
    wait_view("!!document.querySelector('.retype input') || !!document.querySelector('.banner')", 60)
    mark("big_result")
    t.pump(3.0)
    t.click(".retype input")
    t.type("60", 0.25)
    t.pump(1.2)
    mark("big_retyped")
    t.click_text(".actions .btn.primary", "Thibitisha")
    wait_view("!!document.querySelector('.success')", 30)
    mark("big_signed")
    t.pump(3.0)

    # 7. back online: the separate, keyless sender broadcasts the outbox
    t.click_text(".tabs button", "Foleni")
    mark("outbox")
    t.pump(3.5)
    t.click_text(".actions .btn.primary", "Unganisha")
    mark("broadcast_start")
    t.pump(2.0)
    wait_view("(() => { const l = document.querySelector('.joblog .hd'); return l && !l.querySelector('.dot.run') })()", 300)
    mark("broadcast_done")
    t.pump(1.5)
    t.js("window.scrollTo({top: document.body.scrollHeight, behavior: 'smooth'}); true")
    t.pump(4.0)
    explorer = t.js("(document.querySelector('.ob a') || {}).href || null")
    mark("outbox_done")

    # 8. one payment on the public explorer (only for the public testnet)
    if explorer and a.network == "sepolia":
        # the explorer indexes a block some seconds after it is mined: reload until it shows the result (the
        # waiting is outside the marked span), then show the page
        t.goto(explorer, 3.0)
        for _ in range(12):
            if t.js("/\\bSuccess\\b/.test(document.body.innerText)"):
                break
            t.pump(5.0)
            t.goto(explorer, 3.0)
        t.pump(1.0)
        mark("explorer_open")
        t.pump(9.0)
        title = t.js("document.title")
        mark(f"explorer_done:{title[:60]}")
    t.call("Page.stopScreencast")
    t.pump(0.6)
finally:
    if t:
        t.close()
    c.stop()

if not frames:
    raise SystemExit("no frames")
end_ts = frames[-1][0] + 1.0
lst = os.path.join(OUT, "frames.txt")
with open(lst, "w") as f:
    f.write("ffconcat version 1.0\n")
    for i, (ts, path) in enumerate(frames):
        nxt = frames[i + 1][0] if i + 1 < len(frames) else end_ts
        f.write(f"file '{path}'\nduration {max(0.034, nxt - ts):.3f}\n")
    f.write(f"file '{frames[-1][1]}'\n")
subprocess.run(["/usr/bin/ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-vf", "format=yuv420p", "-r", "30",
                "-c:v", "libx264", "-crf", "18", "-preset", "medium", os.path.join(OUT, "ui.mp4")], check=True)
t0_wall = marks[0][0]
first_frame_wall = t0_wall  # screencast started ~0.5 s before "start"; offsets below are relative to the first frame
json.dump({"frames": len(frames), "duration": round(end_ts - frames[0][0], 2), "first_frame_ts": frames[0][0],
           "marks": {name: round(w - (frames[0][0]), 2) for (w, name) in marks}, "explorer": explorer},
          open(os.path.join(OUT, "marks.json"), "w"), indent=1)
print(json.dumps({"frames": len(frames), "seconds": round(end_ts - frames[0][0], 1), "out": os.path.join(a.out, "ui.mp4")}))
