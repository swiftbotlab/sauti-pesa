# Sauti Pesa: one page for judges

**What it is.** A USDT wallet you talk to in Swahili or English. On-device QVAC AI (Whisper speech to text with a
Swahili fine-tune, Qwen3-1.7B for intent, OCR for screenshots) turns your words into a payment. Plain code checks it
for scams and look-alike addresses, and WDK signs it **offline**. **Only the broadcast of signed payments needs the
internet.** Test tokens only (Ethereum Sepolia or a local devnet), never real money.

Demo video (recorded with the internet off): [sauti-pesa-demo-v1.2.mp4](https://github.com/swiftbotlab/sauti-pesa/releases/download/v1.2/sauti-pesa-demo-v1.2.mp4) (3:05) · full details: [README](README.md)

## Run it with the internet off

Linux only (x86-64 or arm64; tested on Ubuntu 26.04 aarch64, 6 cores, 8 GB RAM, no GPU). Needs bubblewrap, Node.js
≥ 22.17, curl, python3, about 4 GB of disk, and [Foundry's anvil](https://getfoundry.sh) for the local test chain
(`export SAUTI_ANVIL=/path/to/anvil` if it is not on your `PATH`). macOS and Windows are not supported: the sandbox
that takes the network away is bubblewrap, a Linux tool.

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
| 4 | `[network: OFF (verified: no route, no DNS) \| sandbox: offline]` before every step; `Imesainiwa kwenye kifaa (bila mtandao) na kuwekwa foleni.` (Swahili text payment); `Signed on this device (offline) and queued.` (English voice note); `BLOCK DANGER: this address looks like Amina's … address-poisoning trick.`; `HATARI KUBWA: usitume pesa.` (scam SMS); two `confirmed in block …` on the local devnet; last line **`E2E PASS`** |
| 5 | `Open this link (it holds this session's key; it changes at every start): http://127.0.0.1:8787/#k=…`. Open that exact link. After 10-25 s (the models load) the status pill reads **AI + signing: on device · Network: OFF (verified)** |

In the UI: tap the mic and say *"Tuma USDT ishirini kwa Amina"* (or type it), confirm, and the payment is signed and
queued offline. Paste the look-alike address from `data/demo-attack.json` to see it blocked. **Kagua / Check**: tap
"Prize", or "Check a screenshot" and pick `test/data/public/screens/sw_anwani_mpya.png` (OCR needs
`scripts/fetch_models.sh OCR_LATIN OCR_CRAFT` online first). **Foleni / Outbox**: "Go online and send" broadcasts to
the local devnet, which needs no internet either.

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
| Resident engine: speech model, LLM, prompt-cache warm-up | `new LocalASR`, `llm.load()`, `llm.warm()` | [`src/engine.js:443`](src/engine.js#L443), [`src/engine.js:456`](src/engine.js#L456) |
| Profiler (evidence only) | `profiler.enable`, `onRecord`, `exportJSON` | [`scripts/profile_qvac.mjs`](scripts/profile_qvac.mjs) |
| WDK wallet: seed, EVM account with **no provider** (offline signer) | `new WDK(seed).registerWallet(…, WalletManagerEvm, { chainId })` | [`src/wallet.js:48`](src/wallet.js#L48) |
| WDK transaction policy: allow ONE `signTransaction` for this token, recipient, amount, chain, fee cap | `registerPolicy({ … operation: 'signTransaction' … })` | [`src/wallet.js:50`](src/wallet.js#L50) |
| Sign offline; anything else is refused by WDK (`PolicyViolationError`) | `account.signTransaction(tx)` | [`src/wallet.js:89`](src/wallet.js#L89) |
| The person confirmed: sign, then queue in the outbox | `wallet.signTransfer(…)`, `store.add(…)` | [`src/pipeline.js:169`](src/pipeline.js#L169) |
| Tests of the policy, both directions (signs the confirmed transfer, refuses changes) | `node --test` | [`test/wallet.test.js`](test/wallet.test.js) |

## What needs the internet, and how "off" is enforced

- **Needs the internet:** broadcasting payments that are already signed, and syncing nonce, fee data and balances
  for a public testnet. Both are [`bin/netsync.mjs`](bin/netsync.mjs), which holds no keys. Plus the one-time
  setup downloads (steps 1-2). The local devnet path needs no internet. Every endpoint: [`REMOTE_APIS.md`](REMOTE_APIS.md).
- **Everything else is offline:** speech to text, intent, scam and look-alike checks, OCR, confirmation, WDK signing,
  the outbox, the UI (127.0.0.1 only).
- **Enforced:** all AI and all signing run in `ops/sandbox.sh offline`: bubblewrap with `--unshare-net`
  ([`ops/sandbox.sh:79`](ops/sandbox.sh#L79)), so the process has its own empty network namespace (only `lo`).
  The CLI, the engine and the server refuse to start outside that sandbox or when the internet is reachable
  ([`bin/sauti.mjs:9`](bin/sauti.mjs#L9), [`bin/serve.mjs:10`](bin/serve.mjs#L10),
  [`src/engine.js:419`](src/engine.js#L419)), by a live probe: TCP to 1.1.1.1:443 and to its IPv6 twin, and a DNS lookup, must all fail
  ([`src/offline.js:27`](src/offline.js#L27)). Models load from local files only, never by registry name or URL.
- **Verified:** step 3 (the probe), the UI's status pill (the same live probe), [`test/sandbox.sh`](test/sandbox.sh)
  (22 isolation checks, each with a positive control), and the network state recorded before and after the QVAC
  profiler run ([`evidence/README.md`](evidence/README.md)).

## Known limits

- Linux only (bubblewrap); not run on a phone. The UI is a mobile-first local web page.
- Payment voice clips in the tests are synthetic (neural TTS). Real voices are measured for speech to text only, on
  read speech (40 FLEURS clips): the Swahili fine-tune has WER 20.1% and CER 7.2% there (the multilingual Whisper
  small had 78.3% and 20.4%). Noisy street audio and phone microphones are not tested.
- Sheng amounts (*thao*, *soo*) are not turned into numbers yet; the app then asks for the amount instead of guessing.
- The 1.7B model's own scam opinion is noisy, so it can only add a low-level hint; the rules decide.
- Testnets only, not audited. The `online` sender shares the host's network namespace (it runs only our sender code).

## Built during AI Yako

All code in this repository was written during the event (from 2026-10-26). Reused, with versions and licences in
[`THIRD_PARTY.md`](THIRD_PARTY.md): the QVAC SDK and WDK packages, ethers, the model weights (Whisper small and its
Swahili fine-tune, Silero VAD, Qwen3-1.7B, EasyOCR/CRAFT), bubblewrap, Foundry's anvil and the FLEURS test audio.

## DoraHacks form questions: where the answers are

| Form question | README section | On this page |
|---|---|---|
| How does your project use QVAC? | [QVAC integration](README.md#qvac-integration), [How it works](README.md#how-it-works) | [Where QVAC and WDK are called](#where-qvac-and-wdk-are-called) |
| Which model and device? | [QVAC integration](README.md#qvac-integration), [Measurements](README.md#measurements), [Real voices](README.md#real-voices-fleurs-swahili-native-speakers), [Runs in 3 GB](README.md#runs-in-3-gb) | [Run it with the internet off](#run-it-with-the-internet-off) (device) |
| How can judges run it offline? | [Run it](README.md#run-it) ("Reproduce with the internet disconnected") | [Run it with the internet off](#run-it-with-the-internet-off) |
| Which features still require internet? | [Offline vs network](README.md#offline-vs-network), [`REMOTE_APIS.md`](REMOTE_APIS.md) | [What needs the internet](#what-needs-the-internet-and-how-off-is-enforced) |
| What did you build during AI Yako and what was reused? | [Built during the event](README.md#built-during-the-event-and-third-party-work), [`THIRD_PARTY.md`](THIRD_PARTY.md) | [Built during AI Yako](#built-during-ai-yako) |
