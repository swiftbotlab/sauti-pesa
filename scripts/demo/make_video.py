#!/usr/bin/env -S python3 -I
"""Assemble the Sauti Pesa demo video from REAL recordings: the terminal clip (termcast.py) and the UI run
(record_ui.py), plus an English voice-over and captions from scripts/demo/narration.json.

  make_video.py --term tmp/demo/final/term --ui tmp/demo/final/ui --out media/sauti-pesa-demo.mp4

- Each narration scene maps to a span between two recorded markers. Its sentences become captions (one per
  sentence, shown while it is spoken). If the voice-over is longer than the span, the span's LAST frame is held
  (freeze frame). Nothing is sped up, re-ordered inside a span, or drawn on top of the app.
- The silent 1920x1080 video is built by our storyboard renderer (title/section/end cards, caption bar; not part
  of this repo, path in SAUTI_VIDEO_TOOL), then the voice-over is mixed in at the exact segment times. Also writes
  an .srt subtitle file and a thumbnail frame.
- Voice-over: neural TTS through our edge-tts compatible client module "tts" (folder in SAUTI_TTS_DIR).
"""
import argparse, hashlib, json, os, re, subprocess, sys, time

PROD = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FPS = 30
for _v in ("SAUTI_TTS_DIR", "SAUTI_VIDEO_TOOL"):
    if not os.environ.get(_v):
        raise SystemExit(f"set {_v} (see the docstring)")
VIDEO_TOOL = os.environ["SAUTI_VIDEO_TOOL"]
sys.path.insert(0, os.environ["SAUTI_TTS_DIR"])
import tts  # noqa: E402

tts.ALLOWED_VOICES.update({"en-US-AvaNeural", "en-US-AriaNeural", "en-US-JennyNeural", "en-GB-SoniaNeural", "en-KE-AsiliaNeural"})

ap = argparse.ArgumentParser()
ap.add_argument("--term", required=True)
ap.add_argument("--ui", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--work", default="tmp/demo/video")
ap.add_argument("--script", default="scripts/demo/narration.json")
ap.add_argument("--dry-run", action="store_true")
ap.add_argument("--explorer", default=None, help="dir from record_explorer.py: use that capture for the explorer scene")
a = ap.parse_args()


def P(p):
    full = os.path.realpath(os.path.join(PROD, p))
    if not full.startswith(PROD + "/"):
        raise SystemExit(f"path outside the project: {p}")
    return full


TERM, UI, OUT, WORK = P(a.term), P(a.ui), P(a.out), P(a.work)
os.makedirs(os.path.join(WORK, "freeze"), exist_ok=True)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
S = json.load(open(P(a.script), encoding="utf-8"))
q = lambda t: round(t * FPS) / FPS  # noqa: E731  (frame grid, so the renderer's frame counts are exact)


def probe_dur(path):
    r = subprocess.run(["/usr/bin/ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


TTS_CACHE = os.path.join(PROD, "tmp", "demo", "tts_cache")  # shared by all takes: same voice + rate + text = same file
os.makedirs(TTS_CACHE, exist_ok=True)


def say(text):
    key = hashlib.sha256(json.dumps([S["voice"], S["rate"], text]).encode()).hexdigest()[:16]
    out = os.path.join(TTS_CACHE, key + ".mp3")
    if not os.path.exists(out):
        for attempt in range(5):
            try:
                tts.synth(text, out, voice=S["voice"], rate=S["rate"])
                break
            except (Exception, SystemExit) as e:  # noqa: BLE001
                print("tts retry", repr(e)[:80], file=sys.stderr)
                time.sleep(5 * (attempt + 1))
        else:
            raise SystemExit("tts failed")
        time.sleep(0.8)  # be gentle with the service
    return out, probe_dur(out)


# ---- sources and their markers
term_mp4 = os.path.join(TERM, "term.mp4")
ui_mp4 = os.path.join(UI, "ui.mp4")
ui_marks = json.load(open(os.path.join(UI, "marks.json")))
SRC = {
    "term": {"path": term_mp4, "marks": {"start": 0.0, "end": probe_dur(term_mp4)}},
    "ui": {"path": ui_mp4, "marks": {**{k.split(":")[0]: v for k, v in ui_marks["marks"].items()}, "start": 0.0, "end": probe_dur(ui_mp4)}},
}
if a.explorer:
    ex_mp4 = os.path.join(P(a.explorer), "explorer.mp4")
    SRC["explorer"] = {"path": ex_mp4, "marks": {"start": 0.0, "end": probe_dur(ex_mp4)}}
    for sc in S["scenes"]:
        if sc.get("src") == "ui" and sc.get("from") == "explorer_open":
            # a separate capture of the explorer page (it was still indexing during the take): say so
            sc.update({"src": "explorer", "from": "start", "to": "end", "lines": sc.get("later_lines", sc["lines"])})
SECTION_S = float(S.get("section_seconds", 2.2))

LEAD, GAP, TAIL, MINP = 0.3, 0.35, 0.6, 0.6
segments, voice, srt, cmap = [], [], [], []  # cmap: (src, src_t0, src_t1, final_t0)
title_say = [say(t) for t in S["title"]["lines"]]
title_s = q(max(5.0, 0.6 + sum(d for _, d in title_say) + 0.6))
clock = title_s
t = 0.6
for (f, d), text in zip(title_say, S["title"]["lines"]):
    voice.append((t, f)); srt.append((t, t + d, text)); t += d + GAP

for si, sc in enumerate(S["scenes"]):
    if "section" in sc:
        segments.append({"section": sc["section"], "subtitle": sc.get("subtitle", ""), "seconds": SECTION_S})
        clock += SECTION_S
        continue
    src = SRC[sc["src"]]
    if sc["from"] not in src["marks"] or sc["to"] not in src["marks"]:
        if sc.get("optional"):
            print(f"skip optional scene {sc['from']}->{sc['to']} (marker missing)")
            continue
        raise SystemExit(f"marker missing: {sc['from']} / {sc['to']}")
    a0, a1 = q(src["marks"][sc["from"]]), q(src["marks"][sc["to"]])

    def mark_t(spec):
        m = re.match(r"^([a-z_]+)([+-][0-9.]+)?$", spec)
        if not m or m.group(1) not in src["marks"]:
            raise KeyError(spec)
        return src["marks"][m.group(1)] + float(m.group(2) or 0)

    # Optional fast-forward window (e.g. waiting for testnet blocks): shown at k x speed with its own caption that
    # says so. Everything else plays at real speed.
    ff = None
    if sc.get("speedup"):
        su = sc["speedup"]
        try:
            s0, s1, k = q(mark_t(su["from"])), q(mark_t(su["to"])), int(su.get("speed", 4))
            if a0 < s0 and s1 < a1 and s1 - s0 >= 3.0 and k >= 2:
                ff = (s0, s1, k, su["caption"])
        except KeyError:
            pass

    def out_t(tt):  # source time -> time on this scene's output timeline
        if not ff or tt <= ff[0]:
            return tt - a0
        if tt <= ff[1]:
            return (ff[0] - a0) + (tt - ff[0]) / ff[2]
        return (ff[0] - a0) + (ff[1] - ff[0]) / ff[2] + (tt - ff[1])

    def src_t(x):  # inverse of out_t
        if not ff or x <= ff[0] - a0:
            return a0 + x
        x2 = (ff[0] - a0) + (ff[1] - ff[0]) / ff[2]
        if x <= x2:
            return ff[0] + (x - (ff[0] - a0)) * ff[2]
        return ff[1] + (x - x2)

    span = q(out_t(a1))
    lines = [x if isinstance(x, dict) else {"text": x} for x in sc["lines"]]
    said_all = [say(x["text"]) for x in lines]

    def anchor(ln):
        try:
            return out_t(mark_t(ln["at"])) if ln.get("at") else None
        except KeyError:
            raise SystemExit(f"bad anchor {ln['at']}")

    kept, said, offs, o = [], [], [], LEAD
    for i, ((f, d), ln) in enumerate(zip(said_all, lines)):
        # optional anchor "mark", "mark+1.5" or "mark-2": the sentence starts no earlier than that moment,
        # so the voice-over describes what is on screen even when a request took longer than usual
        an = anchor(ln)
        if an is not None:
            o = max(o, an)
        if ln.get("fill"):
            # a "fill" sentence is only spoken when it fits in the silence before the next anchored sentence
            nxt = next((anchor(x) for x in lines[i + 1:] if x.get("at")), None)
            if nxt is None or nxt - o < d + GAP + 0.5:
                continue
        kept.append(ln["text"]); said.append((f, d)); offs.append(o); o += d + GAP
    sc["lines"] = kept
    need = o - GAP + TAIL
    total = q(max(span, need))
    if span < total < span + MINP:
        total = q(span + MINP)
    # caption pieces on the scene's output timeline [0, total]: the span end (clip -> freeze) and the fast-forward
    # window are fixed cuts; sentence starts are added when every piece stays >= MINP (segments must be >= 0.5 s)
    ffo = (q(out_t(ff[0])), q(out_t(ff[1]))) if ff else None
    cuts = sorted({0.0, total} | ({span} if total > span else set()) | (set(ffo) if ffo else set()))
    for c in sorted(q(x) for x in offs[1:]):
        if all(abs(c - k) >= MINP for k in cuts):
            cuts = sorted(cuts + [c])
    for i in range(len(cuts) - 1):
        x0, x1 = cuts[i], cuts[i + 1]
        idx = max([k for k, ofs in enumerate(offs) if q(ofs) <= x0 + 1e-6] or [0])
        cap = sc["lines"][idx]
        if x1 <= span + 1e-6:
            in_ff = bool(ffo) and x0 >= ffo[0] - 1e-6 and x1 <= ffo[1] + 1e-6
            t0s, t1s = src_t(x0), src_t(x1)
            seg = {"clip": src["path"], "start": round(t0s, 4), "end": round(min(t1s, a1), 4), "caption": ff[3] if in_ff else cap}
            if in_ff:
                seg["speed"] = ff[2]
            segments.append(seg)
            cmap.append((sc["src"], t0s, t1s, clock + x0))
        else:
            fr = os.path.join(WORK, "freeze", f"s{si:02d}_{int(x0 * 1000)}.png")
            if not os.path.exists(fr):
                subprocess.run(["/usr/bin/ffmpeg", "-v", "error", "-y", "-ss", f"{max(0, a1 - 0.07):.3f}", "-i", src["path"], "-frames:v", "1", fr], check=True)
            segments.append({"image": fr, "seconds": round(max(MINP, x1 - x0), 4), "caption": cap, "pan": False})
    for (f, d), ofs, text in zip(said, offs, sc["lines"]):
        voice.append((clock + ofs, f)); srt.append((clock + ofs, clock + ofs + d, text))
    clock += total

end_say = [say(x) for x in S["end"]["say"]]
end_s = q(max(6.0, 0.5 + sum(d for _, d in end_say) + 1.0))
t = clock + 0.5
for (f, d), text in zip(end_say, S["end"]["say"]):
    voice.append((t, f)); srt.append((t, t + d, text)); t += d + GAP
clock += end_s

sb = {
    "out": os.path.join(WORK, "silent.mp4"),
    "title": S["title"]["title"], "subtitle": S["title"]["subtitle"], "kicker": S["title"]["kicker"],
    "end_title": S["end"]["title"], "end_lines": S["end"]["lines"], "brand": "Swift Bot Labs",
    "segments": segments, "crossfade": 0, "caption_size": 36, "title_seconds": title_s, "end_seconds": end_s,
    "audio": "silent", "background": "#08201A", "background2": "#0E3B2E", "accent": "#22B07D",
}
sbp = os.path.join(WORK, "storyboard.json")
json.dump(sb, open(sbp, "w"), indent=1)
print(f"plan: {len(segments)} segments, {len(voice)} voice lines, {clock:.1f} s")
if a.dry_run:
    subprocess.run(["/usr/bin/python3", VIDEO_TOOL, sbp, "--dry-run"], check=True)
    raise SystemExit(0)
subprocess.run(["/usr/bin/python3", VIDEO_TOOL, sbp, "--overwrite", "--jobs", "2"], check=True)

# ---- mix the voice-over in at the planned times
vdur = probe_dur(sb["out"])
cmd = ["/usr/bin/ffmpeg", "-v", "error", "-y", "-i", sb["out"]]
fil = []
for i, (ts, f) in enumerate(voice):
    cmd += ["-i", f]
    ms = int(round(ts * 1000))
    fil.append(f"[{i + 1}:a]aresample=48000,adelay={ms}:all=1[v{i}]")
fil.append("".join(f"[v{i}]" for i in range(len(voice))) + f"amix=inputs={len(voice)}:normalize=0:dropout_transition=0,"
           f"loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=0:{vdur:.3f}[aout]")
cmd += ["-filter_complex", ";".join(fil), "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
        "-ar", "48000", "-movflags", "+faststart", "-t", f"{vdur:.3f}", OUT]
subprocess.run(cmd, check=True)


def ts_srt(x):
    h, r = divmod(x, 3600); m, s = divmod(r, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int(round((s - int(s)) * 1000)):03d}"


with open(os.path.splitext(OUT)[0] + ".srt", "w", encoding="utf-8") as f:
    for i, (t0, t1, text) in enumerate(srt, 1):
        f.write(f"{i}\n{ts_srt(t0)} --> {ts_srt(t1)}\n{text}\n\n")

# thumbnail: the Swahili voice payment's confirmation card, as it appears in the video
thumb_t = None
vr = SRC["ui"]["marks"].get("voice_result")
if vr is not None:
    for (src, s0, s1, f0) in cmap:
        if src == "ui" and s0 <= vr + 2.0 <= s1:
            thumb_t = f0 + (vr + 2.0 - s0)
if thumb_t is not None:
    subprocess.run(["/usr/bin/ffmpeg", "-v", "error", "-y", "-ss", f"{thumb_t:.3f}", "-i", OUT, "-frames:v", "1",
                    os.path.splitext(OUT)[0] + "-frame.png"], check=True)
json.dump({"out": OUT, "seconds": round(vdur, 2), "voice_lines": len(voice), "segments": len(segments), "thumb_t": thumb_t,
           "map": cmap}, open(os.path.join(WORK, "result.json"), "w"), indent=1)
print(json.dumps({"out": os.path.relpath(OUT, PROD), "seconds": round(vdur, 2), "thumb_t": thumb_t}))
