#!/usr/bin/env -S python3 -I
"""Record a REAL terminal session and render it as a video clip (like asciinema, rendered with PIL + ffmpeg).

  termcast.py steps.json out.mp4 [--events out.json]

steps.json: [{"cmd": "shown command", "argv": [...], "hold": 1.5},
             {"cmd": "ops/ui.sh", "bg": "tmp/demo/ui.log", "argv": [...], "until": "ready:", "pidfile": "tmp/demo/ui.pid"}]
Every command really runs (cwd = the project). Output lines are shown at the time they really arrived.
Waits longer than 2.5 s are shortened to 1.2 s and a "fast-forward N s" badge is shown, so nothing is hidden.
A "bg" step is started in the background (its output goes to the given log file) and stays running after
the recording (used to start the engine that the UI recording then talks to).
"""
import json, os, re, subprocess, sys, threading, time
from PIL import Image, ImageDraw, ImageFont

PROD = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W, H, FPS = 1920, 940, 15
FONT = ImageFont.truetype("/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf", 29)
FONTB = ImageFont.truetype("/usr/share/fonts/truetype/noto/NotoSansMono-Bold.ttf", 29)
FONT_UI = ImageFont.truetype("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf", 22)
FONT_UIB = ImageFont.truetype("/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf", 22)
BG, FG, DIM, GREEN, RED, YEL = (13, 20, 18), (222, 235, 230), (120, 140, 133), (102, 224, 170), (255, 128, 118), (241, 196, 90)
LINE_H, PAD_X, TOP = 42, 40, 92
COLS = 100
MAXGAP, SHORTGAP, TYPE_CPS = 2.5, 1.2, 30


def run_steps(steps):
    events = []  # (t, kind, text)
    t0 = time.time()
    for st in steps:
        if "comment" in st:
            events.append((time.time() - t0, "comment", st["comment"]))
            events.append((time.time() - t0, "hold", str(st.get("hold", 0.6))))
            continue
        events.append((time.time() - t0, "cmd", st["cmd"]))
        if st.get("bg"):
            log = os.path.join(PROD, st["bg"])
            os.makedirs(os.path.dirname(log), exist_ok=True)
            f = open(log, "w")
            bgp = subprocess.Popen(st["argv"], cwd=PROD, stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
            if st.get("pidfile"):  # its own process group: the caller stops it with kill -TERM -- -PID
                with open(os.path.join(PROD, st["pidfile"]), "w") as pf:
                    pf.write(str(bgp.pid))
            pos = 0
            deadline = time.time() + st.get("timeout", 120)
            done = False
            while time.time() < deadline and not done:
                time.sleep(0.1)
                with open(log) as r:
                    r.seek(pos)
                    chunk = r.read()
                    pos = r.tell()
                for line in chunk.splitlines():
                    events.append((time.time() - t0, "out", line))
                    if re.search(st["until"], line):
                        done = True
            if not done:
                raise SystemExit(f"timeout waiting for {st['until']}")
        else:
            p = subprocess.Popen(st["argv"], cwd=PROD, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True, env=st.get("env"))
            for line in p.stdout:
                events.append((time.time() - t0, "out", line.rstrip("\n")))
            p.wait()
        events.append((time.time() - t0, "hold", str(st.get("hold", 1.2))))
    return events


def timeline(events):
    """Map real times to video times: typing takes len/TYPE_CPS, long gaps are shortened (and flagged)."""
    out, vt, last_real = [], 0.6, None
    for (t, kind, text) in events:
        if kind == "cmd":
            out.append((vt, "cmd", text))
            vt += len(text) / TYPE_CPS + 0.35
            last_real = t
        elif kind == "out":
            gap = t - last_real if last_real is not None else 0
            if gap > MAXGAP:
                out.append((vt, "ff", f"{gap:.1f}"))
                vt += SHORTGAP
            else:
                vt += max(gap, 0.03)
            out.append((vt, "out", text))
            last_real = t
        elif kind == "comment":
            out.append((vt, "comment", text))
            last_real = t
        elif kind == "hold":
            vt += float(text)
            last_real = t
    return out, vt + 0.8


def wrap(text, cols=COLS):
    text = text.replace("\t", "    ")
    return [text[i:i + cols] for i in range(0, max(len(text), 1), cols)] or [""]


def color_for(line):
    l = line.lower()
    if re.search(r"could not resolve|unreachable|failed|refusing|enetunreach|eai_again|error|\bfalse\b", l):
        return RED
    if re.search(r"ready|\b200\b|listening|network: off|\btrue\b", l):
        return GREEN
    return FG


def render(tl, total, out_mp4, title):
    rows_fit = (H - TOP - 30) // LINE_H
    ff = subprocess.Popen(["/usr/bin/ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                           "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", out_mp4], stdin=subprocess.PIPE)
    nframes = int(total * FPS)
    for fi in range(nframes):
        now = fi / FPS
        lines = []  # (text, color, is_cmd)
        badge = None
        for (vt, kind, text) in tl:
            if vt > now:
                break
            if kind == "cmd":
                typed = int((now - vt) * TYPE_CPS)
                lines.append(("$ " + text[:typed], FG, True, typed < len(text)))
            elif kind == "out":
                for w in wrap(text):
                    lines.append((w, color_for(text), False, False))
            elif kind == "comment":
                lines.append(("# " + text, DIM, False, False))
            elif kind == "ff" and now - vt < SHORTGAP + 0.4:
                badge = f"fast-forward {text} s"
        img = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, W, 58], fill=(24, 36, 32))
        for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
            d.ellipse([24 + i * 30, 20, 40 + i * 30, 36], fill=c)
        d.text((130, 15), title, font=FONT_UIB, fill=(200, 220, 212))
        if badge:
            bw = d.textlength(badge, font=FONT_UIB) + 36
            d.rounded_rectangle([W - bw - 24, 11, W - 24, 47], radius=18, fill=(60, 50, 20))
            d.text((W - bw - 6, 15), badge, font=FONT_UIB, fill=YEL)
        shown = lines[-rows_fit:]
        y = TOP
        for (text, col, is_cmd, typing) in shown:
            if is_cmd:
                d.text((PAD_X, y), "$", font=FONTB, fill=GREEN)
                d.text((PAD_X + 30, y), text[2:], font=FONTB, fill=(240, 248, 245))
                if typing or (text is shown[-1][0] and int(now * 2) % 2 == 0):
                    cx = PAD_X + 30 + d.textlength(text[2:], font=FONTB)
                    d.rectangle([cx + 2, y + 4, cx + 15, y + 30], fill=GREEN)
            else:
                d.text((PAD_X, y), text, font=FONT, fill=col)
            y += LINE_H
        ff.stdin.write(img.tobytes())
    ff.stdin.close()
    ff.wait()
    if ff.returncode:
        raise SystemExit("ffmpeg failed")


def main():
    steps = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    ev_out = sys.argv[sys.argv.index("--events") + 1] if "--events" in sys.argv else None
    title = "Terminal · Linux aarch64 · CPU only (no GPU) · Sauti Pesa"
    events = run_steps(steps)
    tl, total = timeline(events)
    if ev_out:
        json.dump({"real": events, "video": tl, "duration": total}, open(ev_out, "w"), indent=1)
    render(tl, total, out, title)
    print(json.dumps({"out": out, "seconds": round(total, 2), "events": len(events)}))


if __name__ == "__main__":
    main()
