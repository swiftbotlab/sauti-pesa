#!/usr/bin/env -S python3 -I
"""README screenshots of the REAL app (engine + bridge must be running): a separate headless Chrome, a fake
microphone fed with a synthetic test clip for the voice card, real clicks and key events. Nothing is confirmed
or signed, so it can run against the real test wallet.

  screenshots.py --port 8787 --network sepolia --out docs
Writes ui-mobile-home.png, ui-mobile-confirm.png, ui-mobile-blocked.png, ui-mobile-check.png,
ui-mobile-outbox.png (390 px wide CSS, 2x) and ui-desktop.png (1440x900).
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp_lite as c  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=8787)
ap.add_argument("--network", choices=["devnet", "sepolia"], required=True)
ap.add_argument("--out", default="docs")
ap.add_argument("--clip", default=os.path.join(c.PROD, "test/audio/sw_juma_15.wav"))
a = ap.parse_args()
OUT = os.path.realpath(os.path.join(c.PROD, a.out))
if not OUT.startswith(c.PROD + "/"):
    raise SystemExit("--out must be inside the project")
os.makedirs(OUT, exist_ok=True)
URL = c.ui_url(a.port)  # with this launch's UI key in the #fragment
POISON = json.load(open(os.path.join(c.PROD, "data/demo-attack.json")))["poisoned_amina"]
READY = ("document.querySelector('.pill') && !document.querySelector('.pill.loading') && !document.querySelector('.pill.down')"
         " && document.querySelectorAll('.person').length > 0")
RESULT = "!!document.querySelector('.amount-big') || !!document.querySelector('.banner')"


def fresh(t, lang):
    # the page drops the key from the address bar, so going to URL again would only change the #fragment (no
    # reload): pass through about:blank to load the app from scratch each time
    t.goto("about:blank", 0.3)
    t.goto(URL, 1.0)
    t.js(f"localStorage.setItem('sauti.network', '{a.network}'); localStorage.setItem('sauti.lang', '{lang}'); true")
    t.goto("about:blank", 0.3)
    t.goto(URL, 1.5)
    t.wait_js(READY, 90)
    t.pump(0.8)


def shot(t, name, full=True):
    t.js("window.scrollTo(0, 0); true")
    t.pump(0.6)
    if full and MOBILE[0]:
        # a tall phone-shaped viewport instead of a full-page capture, so the fixed bottom tab bar sits at the
        # bottom (a full-page capture draws it in the middle of the content)
        hgt = int(t.js("Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))") or 844)
        t.viewport(390, max(844, min(hgt, 3000)), 2, True)
        t.pump(0.8)
        p = t.shot(os.path.join(OUT, name), full=False)
        t.viewport(390, 844, 2, True)
        t.pump(0.4)
    else:
        p = t.shot(os.path.join(OUT, name), full=full)
    print("wrote", os.path.relpath(p, c.PROD), flush=True)


MOBILE = [False]


def typed(t, text):
    t.click("#reqText")
    t.type(text, 0.01)
    t.key("Enter", "Enter", 13)
    t.wait_js(RESULT, 90)
    t.pump(1.2)


c.launch(fake_audio=a.clip, width=1440, height=900)
try:
    t = c.Tab()
    t.call("Emulation.setTimezoneOverride", timezoneId="Africa/Nairobi")
    # ---- mobile, 390 px
    t.viewport(390, 844, 2, True)
    MOBILE[0] = True
    fresh(t, "sw")
    shot(t, "ui-mobile-home.png", full=False)
    t.click(".mic")
    t.pump(6.2)
    t.click(".mic")
    t.wait_js(RESULT, 90)
    t.pump(1.5)
    shot(t, "ui-mobile-confirm.png")
    fresh(t, "en")
    typed(t, f"Send 10 USDT to {POISON} for rent")
    shot(t, "ui-mobile-blocked.png")
    fresh(t, "sw")
    t.click_text(".tabs button", "Kagua")
    t.pump(1.0)
    t.click_text(".chips .chip", "Zawadi")
    t.pump(0.6)
    t.click_text(".actions .btn.primary", "Kagua")
    t.wait_js("!!document.querySelector('.riskbar')", 90)
    t.pump(1.0)
    shot(t, "ui-mobile-check.png")
    fresh(t, "en")
    t.click_text(".tabs button", "Outbox")
    t.pump(2.0)
    shot(t, "ui-mobile-outbox.png")
    # ---- desktop: an English typed payment, with the on-device steps and the live proof beside it
    MOBILE[0] = False
    t.viewport(1440, 900, 1, False)
    fresh(t, "en")
    typed(t, "Send 40 USDT to Otieno for rent")
    shot(t, "ui-desktop.png", full=False)
    t.close()
finally:
    c.stop()
