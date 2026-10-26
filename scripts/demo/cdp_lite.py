"""Minimal CDP client for a SEPARATE headless Chrome used only for the Sauti Pesa demo/screenshots.

It never touches your normal browser: own throwaway profile (in your cache directory, outside the project, so no
sandbox can write to it), own DevTools port (127.0.0.1:9333), and it only loads the local UI (http://127.0.0.1:8787
with this launch's UI key from SAUTI_UI_TOKEN) plus, for the
video, one public explorer page. The fake microphone is Chrome's own test feature
(--use-file-for-fake-audio-capture), fed with one of the synthetic test clips in test/audio/.
"""
import base64, json, os, re, shutil, signal, subprocess, time, urllib.request
import websocket

PROD = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 9333
# Outside the project on purpose: tmp/ is writable from the offline sandbox, and a browser profile there could be
# changed by code in the sandbox before the host browser loads it.
STATE = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "sauti-pesa-demo")
PROFILE = os.path.join(STATE, "chrome-profile")
PIDFILE = os.path.join(STATE, "chrome.pid")


def ui_url(port):
    """The local UI with this launch's key in the #fragment (the key comes from SAUTI_UI_TOKEN, as for ops/ui.sh)."""
    key = os.environ.get("SAUTI_UI_TOKEN", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", key):
        raise SystemExit("set SAUTI_UI_TOKEN to the key the running bridge was started with")
    return f"http://127.0.0.1:{int(port)}/#k={key}"


def _get(path):
    return json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=5).read())


def running():
    try:
        _get("/json/version")
        return True
    except Exception:
        return False


def launch(fake_audio=None, width=1920, height=1080):
    """Start the demo Chrome (headless). fake_audio: path of a WAV under test/audio/ fed as the microphone."""
    if running():
        raise SystemExit("demo chrome already running on 9333 (stop() first)")
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    if os.path.isdir(PROFILE):
        shutil.rmtree(PROFILE)
    os.makedirs(PROFILE, mode=0o700)
    args = ["/usr/bin/google-chrome", "--headless=new", f"--user-data-dir={PROFILE}", f"--remote-debugging-port={PORT}",
            "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
            "--disable-sync", "--disable-background-networking", "--disable-component-update", "--metrics-recording-only",
            "--no-pings", "--hide-scrollbars", "--mute-audio", f"--window-size={width},{height}",
            "--use-fake-ui-for-media-stream", "--lang=en-US", "--force-color-profile=srgb",
            "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"]
    if fake_audio:
        real = os.path.realpath(fake_audio)
        if not real.startswith(os.path.join(PROD, "test", "audio") + "/") or not real.endswith(".wav"):
            raise SystemExit("fake audio must be a WAV under test/audio/")
        args += ["--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={real}%noloop"]
    p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    with open(PIDFILE, "w") as f:
        f.write(str(p.pid))
    for _ in range(100):
        if running():
            return p.pid
        time.sleep(0.1)
    raise SystemExit("demo chrome did not start")


def _is_demo_chrome(pid):
    """True only if pid is the demo Chrome this module started (its own DevTools port and profile)."""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            argv = f.read().split(b"\0")
    except OSError:
        return False
    return f"--remote-debugging-port={PORT}".encode() in argv and f"--user-data-dir={PROFILE}".encode() in argv


def stop():
    try:
        pid = int(open(PIDFILE).read().strip())
    except Exception:
        return
    # never signal a process group we did not start (a stale or edited pid file must not kill anything else)
    if pid > 1 and _is_demo_chrome(pid):
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(50):
            if not running():
                break
            time.sleep(0.1)
    try:
        os.remove(PIDFILE)
    except FileNotFoundError:
        pass


class Tab:
    def __init__(self, url="about:blank"):
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?{url}", method="PUT")
        t = json.loads(urllib.request.urlopen(req, timeout=10).read())
        self.id = t["id"]
        self.ws = websocket.create_connection(t["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
        self.n = 0
        self.events = []
        self.on_event = None  # callback(msg) for CDP events (screencast frames)
        self.call("Page.enable")
        self.call("Runtime.enable")

    def call(self, method, **params):
        self.n += 1
        my = self.n
        self.ws.send(json.dumps({"id": my, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == my:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m.get("result", {})
            if "method" in m:
                self._event(m)

    def _event(self, m):
        if self.on_event:
            self.on_event(m)
        else:
            self.events.append(m)
            del self.events[:-200]

    def send_nowait(self, method, **params):
        """Fire and forget (the reply is read and dropped by the next call/pump)."""
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))

    def pump(self, seconds):
        """Read events for a while (keeps screencast frames flowing)."""
        end = time.time() + seconds
        while time.time() < end:
            self.ws.settimeout(max(0.05, end - time.time()))
            try:
                m = json.loads(self.ws.recv())
                if "method" in m:
                    self._event(m)
            except websocket.WebSocketTimeoutException:
                pass
        self.ws.settimeout(60)

    def viewport(self, w, h, scale=1, mobile=False):
        self.call("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=scale, mobile=mobile)
        if mobile:
            self.call("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)

    def goto(self, url, wait=1.0):
        self.call("Page.navigate", url=url)
        self.pump(wait)

    def js(self, expr):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if "exceptionDetails" in r:
            raise RuntimeError(f"js: {r['exceptionDetails'].get('text')} {r['exceptionDetails'].get('exception', {}).get('description', '')[:300]}")
        return r.get("result", {}).get("value")

    def wait_js(self, expr, timeout=30, every=0.2):
        end = time.time() + timeout
        while time.time() < end:
            v = self.js(expr)
            if v:
                return v
            self.pump(every)
        raise TimeoutError(f"timeout waiting for: {expr}")

    def click(self, selector):
        """Real mouse click at the element's centre (so :active styles and focus behave like a person)."""
        box = self.js(f"(() => {{ const e = document.querySelector({json.dumps(selector)}); if (!e) return null; e.scrollIntoView({{block:'center'}}); const r = e.getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2] }})()")
        if not box:
            raise RuntimeError(f"no element {selector}")
        x, y = box
        self.call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y)
        self.call("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y, button="left", clickCount=1)
        self.pump(0.08)
        self.call("Input.dispatchMouseEvent", type="mouseReleased", x=x, y=y, button="left", clickCount=1)

    def click_text(self, selector, text):
        js = (f"(() => {{ const t = {json.dumps(text)}; const e = [...document.querySelectorAll({json.dumps(selector)})].find(x => x.textContent.trim().includes(t)); "
              "if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2] })()")
        box = self.js(js)
        if not box:
            raise RuntimeError(f"no {selector} with text {text}")
        x, y = box
        self.call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y)
        self.call("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y, button="left", clickCount=1)
        self.pump(0.08)
        self.call("Input.dispatchMouseEvent", type="mouseReleased", x=x, y=y, button="left", clickCount=1)

    def type(self, text, delay=0.045):
        """Real key events, one character at a time (looks like typing in the recording)."""
        for ch in text:
            self.call("Input.dispatchKeyEvent", type="keyDown", text=ch, unmodifiedText=ch, key=ch)
            self.call("Input.dispatchKeyEvent", type="keyUp", key=ch)
            self.pump(delay)

    def key(self, key, code=None, vk=None):
        self.call("Input.dispatchKeyEvent", type="keyDown", key=key, code=code or key, windowsVirtualKeyCode=vk or 0)
        self.call("Input.dispatchKeyEvent", type="keyUp", key=key, code=code or key, windowsVirtualKeyCode=vk or 0)

    def shot(self, out, full=False):
        params = {"format": "png", "captureBeyondViewport": bool(full)}
        if full:
            m = self.call("Page.getLayoutMetrics")
            cs = m["cssContentSize"]
            params["clip"] = {"x": 0, "y": 0, "width": cs["width"], "height": cs["height"], "scale": 1}
        d = self.call("Page.captureScreenshot", **params)
        with open(out, "wb") as f:
            f.write(base64.b64decode(d["data"]))
        return out

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/close/{self.id}", timeout=5).read()
        except Exception:
            pass
