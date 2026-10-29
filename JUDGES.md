# Sauti Pesa: one page for judges

**What it is.** A USDT wallet you talk to in Swahili or English. On-device QVAC AI (Whisper speech to text with a
Swahili fine-tune, Qwen3-1.7B for intent, OCR for screenshots) turns your words into a payment. Plain code checks it
for scams and look-alike addresses, and WDK signs it **offline**. **Only the broadcast of signed payments needs the
internet**, and until then a queued payment can still be cancelled (flagged ones wait 10 minutes: the undo window).
Test tokens only (Ethereum Sepolia or a local devnet), never real money.

Demo video (recorded with the internet off): [sauti-pesa-demo-v1.2.mp4](https://github.com/swiftbotlab/sauti-pesa/releases/download/v1.2/sauti-pesa-demo-v1.2.mp4) (3:05) · full details: [README](README.md)

## Run it with the internet off

Linux (x86-64 or arm64; tested on Ubuntu 26.04 aarch64, 6 cores, 8 GB RAM, no GPU). Needs bubblewrap, Node.js
≥ 22.17, curl, python3, about 4 GB of disk, and [Foundry's anvil](https://getfoundry.sh) for the local test chain
(`export SAUTI_ANVIL=/path/to/anvil` if it is not on your `PATH`). The sandbox that takes the network away is
bubblewrap, a Linux tool. **macOS, Windows, or no bubblewrap:** use the
[portable mode](#any-laptop-macos--windows--linux-without-bubblewrap) below.

Steps 1-2 need the internet **once** (downloads only). Then switch it off (Wi-Fi off, cable out) and run steps 3-5.

```bash
# 1. ONLINE: code + exact npm pins (install scripts forced off)
git clone https://github.com/swiftbotlab/sauti-pesa.git && cd sauti-pesa && ops/sandbox.sh setup npm ci
# 2. ONLINE: models, ~1.6 GB, each checked against a pinned size + sha256
scripts/fetch_models.sh QWEN3_1_7B_INST_Q4 WHISPER_SMALL_Q8_0 WHISPER_SMALL_SW_Q8_0 VAD_SILERO_5_1_2

# --- now turn the internet OFF; `curl -sS --head -m 5 https://huggingface.co` must fail ---

# 3. the sandbox has no network at all (bubblewrap, own empty network namespace)
ops/sandbox.sh offline node ops/sandbox_probe.mjs
# 4. the whole offline flow, about 1 min: voice + text payments signed offline, attacks blocked, local broadcast
test/e2e_offline.sh
# 5. the app (fresh clone): test wallet, 5 demo contacts, local chain with test USDT, then the UI
ops/sandbox.sh offline node bin/sauti.mjs wallet init && ops/sandbox.sh offline node bin/sauti.mjs contacts demo && ops/devnet.sh devnet-setup && ops/ui.sh
```

Expected output (shortened, from our run):

| Step | You should see |
|---|---|
| 2 | one `<MODEL>: ok sha256=…` (or `already present and verified`) line per model |
| 3 | one JSON line with `"direct_ip_1_1_1_1_443":false,"dns_resolves":false,"internet_https":"fail:EAI_AGAIN"` |
| 4 | `[network: OFF (verified: no route, no DNS) \| sandbox: offline]` before every step; `Imesainiwa kwenye kifaa (bila mtandao) na kuwekwa foleni.` (Swahili text payment); `Signed on this device (offline) and queued.` (English voice note); `BLOCK DANGER: this address looks like Amina's … address-poisoning trick.`; `HATARI KUBWA: usitume pesa.` (scam SMS); `Cancelled on this device: tx … will never be sent` (undo window); two `confirmed in block …` on the local devnet; last line **`E2E PASS`** |
| 5 | `Open this link (it holds this session's key; it changes at every start): http://127.0.0.1:8787/#k=…`. Open that exact link. After 10-25 s (the models load) the status pill reads **AI + signing: on device · Network: OFF (verified)** |

In the UI: tap the mic and say *"Tuma USDT ishirini kwa Amina"* (or type it), confirm, and the payment is signed and
queued offline. Paste the look-alike address from `data/demo-attack.json` to see it blocked. **Kagua / Check**: tap
"Prize", or "Check a screenshot" and pick `test/data/public/screens/sw_anwani_mpya.png` (OCR needs
`scripts/fetch_models.sh OCR_LATIN OCR_CRAFT` online first). **Foleni / Outbox**: "Go online and send" broadcasts to
the local devnet, which needs no internet either. To see the undo window, pay a first-time address (type
*"Tuma USDT 5 kwa 0x2222222222222222222222222222222222222222"*): the outbox shows "sends after …" and a **Ghairi**
(Cancel) button.

**Lite profile (optional, measured, not recommended):** `scripts/fetch_models.sh --lite` once online, then `SAUTI_PROFILE=lite ops/ui.sh` (any laptop: `node bin/portable.mjs --lite ui`) runs Qwen3-0.6B instead of Qwen3-1.7B for intent: about 2x faster and the whole app fits a 2.5 GB cap instead of 3 GB, but it understood 3 of 7 real USDT requests (default 7/7). Numbers: [evidence](evidence/README.md#evidence-lite-phone-class-profile-2026-10-29).

## Any laptop (macOS / Windows / Linux without bubblewrap)

Portable mode has **no sandbox**: you switch the network off, and the app proves it with the same live probe as the
sandbox path (TCP to 1.1.1.1:443 and to its IPv6 twin, DNS for huggingface.co and example.com) at startup, again right
before every signature, and in the engine before every AI request. While any of them gets through, or fails in a way
that does not mean "no network" (a refused connection means something answered), it refuses:
`the internet is reachable from this computer (…). Turn Wi-Fi/Ethernet off, then run again.` It never downloads at
runtime (a missing model stops with the exact download command) and never broadcasts: the signed test payments stay
in the outbox. Same test wallet, test tokens and labels. On Linux with bubblewrap, the sandbox above stays the default.

Needs Node.js ≥ 22.17, git, about 4 GB of disk and about 3 GB of free RAM. The commands are the same in Terminal,
PowerShell and cmd (we did not run them there; see below). Start it with plain `node`: the launcher refuses to run
when `NODE_OPTIONS` is set or node gets extra flags, and gives the app only a short, rebuilt environment.

```bash
# 1. ONLINE, once: code + exact npm pins (install scripts are off in .npmrc), then the models (~1.6 GB, size + sha256 checked)
git clone https://github.com/swiftbotlab/sauti-pesa.git
cd sauti-pesa
npm ci
npm run fetch-models

# 2. now switch the network OFF (Wi-Fi off, cable out)
node bin/portable.mjs probe
# 3. the whole offline flow, about 1 min, with a throwaway test wallet in tmp/portable-demo
node bin/portable.mjs demo
# 4. the app (your own test wallet, 5 demo contacts), then open the link it prints
node bin/portable.mjs wallet init
node bin/portable.mjs contacts demo
node bin/portable.mjs ui
```

`npm run portable -- <command>` and `ops/portable.sh <command>` are the same launcher (Windows PowerShell 5 can drop
the `--` of `npm run`; the `node` form always works). Single commands: `ask "Tuma USDT ishirini kwa Amina"`,
`say test/audio/sw_juma_15.wav`, `check "<message>"`, `queue`, `cancel <id>`.

| Step | You should see |
|---|---|
| 1 | `added … packages`, then one `<MODEL>: ok sha256=…` line per model and `All requested models are on disk and verified.` |
| 2 | `network: OFF (verified: tcp 1.1.1.1:443 ENETUNREACH, IPv6 ENETUNREACH, dns EAI_AGAIN / EAI_AGAIN). Portable mode can run.` (the error codes depend on the system). Still online: `network: ON. the internet is reachable from this computer (tcp 1.1.1.1:443 connected, dns huggingface.co resolved, dns example.com resolved). Turn Wi-Fi/Ethernet off, then run again.` |
| 3 | `[network: OFF (verified: no route, no DNS) \| sandbox: portable (…)]` before every CLI step; `Ukaguzi (6, plain code): Mpokeaji ok · Anwani ok · Kiasi ok · Vikomo ok · Salio WARN · Utapeli ok` (the balance is unknown offline) and `Imesainiwa kwenye kifaa (bila mtandao) na kuwekwa foleni.`; `Signed on this device (offline) and queued.` (English voice note); `BLOCK DANGER: this address looks like Amina's …`; `HATARI KUBWA: usitume pesa.`; `2 queued signature(s) checked …, 0 bad`; last line **`PORTABLE DEMO PASS`** |
| 4 | `Open this link (it holds this session's key; it changes at every start): http://127.0.0.1:8787/#k=…` (printed once the local server listens). In the page, the network-proof panel shows `sandbox: portable · no bwrap: network switched off, probed live`; "Go online and send" answers that portable mode never goes online |

**Tested, and not tested.** We ran portable mode on **Linux arm64 only** (the box above):
[`test/e2e_portable.sh`](test/e2e_portable.sh) starts the launcher in a network-less namespace (bubblewrap is used
there only to remove the network; the app sees `SAUTI_SANDBOX=portable`), and step 3 passes with both signatures
verified from the outbox; the same commands with the network on all refuse (negative control); when a network answer
appears mid-run, the CLI and the engine refuse to sign and the engine refuses AI requests; the running engine and
bridge are checked for the launcher's allowlisted environment and QVAC's worker socket in the private `tmp/pt`. **macOS and Windows were
not tested.** What we checked for them (2026-10-29, `npm view` + `package-lock.json`): at our pinned versions QVAC
publishes native builds for darwin-arm64, darwin-x64 and win32-x64: inside `@qvac/llm-llamacpp` 0.61.2 and
`@qvac/ocr-ggml` 0.29.1, as `@qvac/asr-ggml-<platform>` 0.10.0 and `@qvac/fabric-<platform>` 0.22.0, and the Bare
runtime of QVAC's worker as `bare-runtime-<platform>` 1.36.0; all are in our lockfile, so `npm ci` picks the right
ones. At these versions there are no QVAC builds for Windows on ARM. Screenshot OCR needs two files from QVAC's peer-to-peer registry, whose
downloader is Linux-only here, so on other systems typed and pasted messages are checked, not screenshots.

## Where QVAC and WDK are called

| What | Call | Where |
|---|---|---|
| Speech to text: load (Swahili fine-tune or multilingual Whisper, with Silero VAD) | `loadModel({ modelSrc, modelType: 'whispercpp-transcription', modelConfig: { language, vadModelSrc, … } })` | [`src/asr.js:143`](src/asr.js#L143) |
| Same file, other language (no second copy in RAM) | `loadModel({ modelId, modelConfig })` reload-config | [`src/asr.js:136`](src/asr.js#L136) |
| Other file for the new language: free the current Whisper first | `unloadModel({ modelId })` | [`src/asr.js:142`](src/asr.js#L142) |
| Transcribe a voice note | `transcribe({ modelId, audioChunk })` | [`src/asr.js:171`](src/asr.js#L171) |
| Intent and message model: load Qwen3-1.7B | `loadModel(…)` | [`src/llm.js:64`](src/llm.js#L64) |
| JSON intent, grammar-constrained, KV-cached prompt prefix | `completion({ responseFormat: { type: 'json_schema' }, kvCache, … })` | [`src/llm.js:98`](src/llm.js#L98) |
| Screenshot text (CRAFT detector + latin_g2) | `loadModel({ modelType: 'ggml-ocr', … })`, `ocr({ modelId, image })` | [`src/ocr.js:28`](src/ocr.js#L28), [`src/ocr.js:48`](src/ocr.js#L48) |
| Resident engine: speech model, LLM, prompt-cache warm-up | `new LocalASR`, `llm.load()`, `llm.warm()` | [`src/engine.js:484`](src/engine.js#L484), [`src/engine.js:498`](src/engine.js#L498) |
| Profiler (evidence only) | `profiler.enable`, `onRecord`, `exportJSON` | [`scripts/profile_qvac.mjs`](scripts/profile_qvac.mjs) |
| WDK wallet: seed, EVM account with **no provider** (offline signer) | `new WDK(seed).registerWallet(…, WalletManagerEvm, { chainId })` | [`src/wallet.js:76`](src/wallet.js#L76) |
| WDK transaction policy: allow ONE `signTransaction` for this token, recipient, amount, chain, fee cap | `registerPolicy({ … operation: 'signTransaction' … })` | [`src/wallet.js:78`](src/wallet.js#L78) |
| Sign offline; anything else is refused by WDK (`PolicyViolationError`) | `account.signTransaction(tx)` | [`src/wallet.js:117`](src/wallet.js#L117) |
| The person confirmed: sign, then queue in the outbox | `wallet.signTransfer(…)`, `store.add(…)` | [`src/pipeline.js:171`](src/pipeline.js#L171) |
| Tests of the policy, both directions (signs the confirmed transfer, refuses changes) | `node --test` | [`test/wallet.test.js`](test/wallet.test.js) |
| Undo window: cancel a queued payment that never left the device; the sender skips held and cancelled payments | `cancelEntry`, `isHeld`, atomic send/cancel claim | [`src/undo.js:71`](src/undo.js#L71), [`src/broadcast.js:61`](src/broadcast.js#L61), [`src/broadcast.js:102`](src/broadcast.js#L102) |

## What needs the internet, and how "off" is enforced

- **Needs the internet:** broadcasting payments that are already signed, and syncing nonce, fee data and balances
  for a public testnet. Both are [`bin/netsync.mjs`](bin/netsync.mjs), which holds no keys. Plus the one-time
  setup downloads (steps 1-2). The local devnet path needs no internet. Every endpoint: [`REMOTE_APIS.md`](REMOTE_APIS.md).
- **Everything else is offline:** speech to text, intent, scam and look-alike checks, OCR, confirmation, WDK signing,
  the outbox, the UI (127.0.0.1 only).
- **Enforced:** all AI and all signing run in `ops/sandbox.sh offline`: bubblewrap with `--unshare-net`
  ([`ops/sandbox.sh:79`](ops/sandbox.sh#L79)), so the process has its own empty network namespace (only `lo`).
  The CLI, the engine and the server refuse to start outside that sandbox or when the internet is reachable
  ([`bin/sauti.mjs:11`](bin/sauti.mjs#L11), [`bin/serve.mjs:11`](bin/serve.mjs#L11),
  [`src/engine.js:457`](src/engine.js#L457)), by a live probe: TCP to 1.1.1.1:443 and to its IPv6 twin, and two DNS lookups, must all fail with a "no network" error
  ([`src/offline.js:57`](src/offline.js#L57), gate: [`src/gate.js:44`](src/gate.js#L44)). The probe runs again right before every
  signature ([`src/engine.js:250`](src/engine.js#L250), [`src/cli.mjs:127`](src/cli.mjs#L127)). The only other mode is the explicit
  portable one ([`bin/portable.mjs`](bin/portable.mjs), above): no sandbox, the same probe at start, before every
  signature and before every engine request. Models load from local files only, never by registry name or URL.
- **Verified:** step 3 (the probe), the UI's status pill (the same live probe), [`test/sandbox.sh`](test/sandbox.sh)
  (22 isolation checks, each with a positive control), [`test/gate.test.js`](test/gate.test.js) (the gate both ways:
  an all-failed probe passes; any reachable leg, a probe error or no mode refuses), [`test/e2e_portable.sh`](test/e2e_portable.sh)
  (22 checks: portable mode with and without a network, and the network coming back mid-run), and the network state
  recorded before and after the QVAC profiler run ([`evidence/README.md`](evidence/README.md)).

## Known limits

- The sandbox is Linux only (bubblewrap). Portable mode (no sandbox; network switched off and probed) was tested on
  Linux arm64 only, not on macOS or Windows. Not run on a phone; the UI is a mobile-first local web page. The lite
  profile's lower memory floor (2.5 GB vs 3 GB) is measured on this Linux box, not on a phone.
- Payment voice clips in the tests are synthetic (neural TTS). Real voices are measured for speech to text only, on
  read speech (40 FLEURS clips): the Swahili fine-tune has WER 20.1% and CER 7.2% there (the multilingual Whisper
  small had 78.3% and 20.4%). Noisy street audio and phone microphones are not tested.
- Sheng *thao* (1,000) and *soo* (100) are read (since 2026-10-29) and count as shillings, so such a payment is blocked
  like every shilling amount; "2k"-style amounts are not read by the code's cross-check yet, so the app does not accept them.
- The 1.7B model's own scam opinion is noisy, so it can only add a low-level hint; the rules decide.
- Testnets only, not audited. The `online` sender shares the host's network namespace (it runs only our sender code).

## Built during AI Yako

All code in this repository was written during the event (from 2026-10-26). Reused, with versions and licences in
[`THIRD_PARTY.md`](THIRD_PARTY.md): the QVAC SDK and WDK packages, ethers, the model weights (Whisper small and its
Swahili fine-tune, Silero VAD, Qwen3-1.7B, Qwen3-0.6B for the lite profile, EasyOCR/CRAFT), bubblewrap, Foundry's anvil and the FLEURS test audio.

## DoraHacks form questions: where the answers are

| Form question | README section | On this page |
|---|---|---|
| How does your project use QVAC? | [QVAC integration](README.md#qvac-integration), [How it works](README.md#how-it-works) | [Where QVAC and WDK are called](#where-qvac-and-wdk-are-called) |
| Which model and device? | [QVAC integration](README.md#qvac-integration), [Measurements](README.md#measurements), [Real voices](README.md#real-voices-fleurs-swahili-native-speakers), [Runs in 3 GB](README.md#runs-in-3-gb) | [Run it with the internet off](#run-it-with-the-internet-off) (device) |
| How can judges run it offline? | [Run it](README.md#run-it) ("Reproduce with the internet disconnected") | [Run it with the internet off](#run-it-with-the-internet-off), [Any laptop](#any-laptop-macos--windows--linux-without-bubblewrap) |
| Which features still require internet? | [Offline vs network](README.md#offline-vs-network), [`REMOTE_APIS.md`](REMOTE_APIS.md) | [What needs the internet](#what-needs-the-internet-and-how-off-is-enforced) |
| What did you build during AI Yako and what was reused? | [Built during the event](README.md#built-during-the-event-and-third-party-work), [`THIRD_PARTY.md`](THIRD_PARTY.md) | [Built during AI Yako](#built-during-ai-yako) |
