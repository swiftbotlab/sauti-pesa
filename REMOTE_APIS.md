# Remote APIs

Every remote endpoint that code in this repository can contact, with the file and the phase in which it is used.
Found by searching `src/`, `bin/`, `ops/`, `scripts/`, `ui/`, `config.json`, `models.json` and `package-lock.json`
for URLs, host names and network calls (`fetch`, `connect`, `lookup`, `curl`, `npm`, Hyperswarm).

## The AI path makes no network calls
Speech to text (Whisper + Silero VAD, [`src/asr.js`](src/asr.js)), the intent and message model (Qwen3-1.7B,
[`src/llm.js`](src/llm.js)) and OCR ([`src/ocr.js`](src/ocr.js)) never contact any endpoint:

- They run only inside `ops/sandbox.sh offline`: bubblewrap with its **own empty network namespace** (only `lo`,
  no route anywhere). The CLI ([`bin/sauti.mjs`](bin/sauti.mjs)) and the engine ([`bin/serve.mjs`](bin/serve.mjs),
  [`src/engine.js`](src/engine.js)) refuse to start outside that sandbox or when the internet is reachable.
- Models are loaded from local files named in [`config.json`](config.json) (`models/...`), never by a registry name
  or URL, so the QVAC SDK has nothing to download at inference time.
- Offline signing with WDK ([`src/wallet.js`](src/wallet.js)) runs in the same sandbox.
- Proof: [`test/sandbox.sh`](test/sandbox.sh) checks the isolation with positive controls (probe table in the
  [README](README.md#security-model)), and [`evidence/qvac-profile.json`](evidence/qvac-profile.json) records the
  network state (TCP `ENETUNREACH`, DNS `EAI_AGAIN`, only `lo`) before and after one profiled run of all four
  capabilities.

## When the app runs

| Endpoint | What for | File | Phase | What is sent |
|---|---|---|---|---|
| `https://ethereum-sepolia-rpc.publicnode.com`, then `https://sepolia.drpc.org` (fallback) | Ethereum Sepolia JSON-RPC: chain id, nonce, fee data, USDT and gas balances, receipts; broadcast of already signed payments | [`src/networks.js`](src/networks.js), client [`src/net/rpc.js`](src/net/rpc.js) (https only, no credentials in URLs, 1 MB response cap), used by [`bin/netsync.mjs`](bin/netsync.mjs) and [`src/broadcast.js`](src/broadcast.js) | **Wallet sync and broadcast** only: `ops/sandbox.sh online node bin/netsync.mjs sync\|broadcast --network sepolia`, from the CLI or the UI's "Go online and send" ([`bin/bridge.mjs`](bin/bridge.mjs) starts that command) | the wallet's public address and signed raw transactions; this process holds no keys |
| `http://127.0.0.1:8545` | the local test chain (Foundry anvil) | [`src/networks.js`](src/networks.js), [`ops/devnet.sh`](ops/devnet.sh) | devnet sync and broadcast, in the devnet sandbox (private loopback, no internet) | as above, to a local process |
| `https://eth-sepolia.blockscout.com/tx/<hash>` | block-explorer **link** for a broadcast payment | [`src/networks.js`](src/networks.js), shown by [`src/view.js`](src/view.js) and [`ui/app.js`](ui/app.js), printed by [`src/broadcast.js`](src/broadcast.js) and [`bin/netsync.mjs`](bin/netsync.mjs) | after a broadcast. The page never fetches it (its CSP allows `connect-src 'self'` only); the browser opens it only when the person taps the link | nothing, unless the person opens it |
| TCP connect to `1.1.1.1:443` and `[2606:4700:4700::1111]:443`, DNS lookup of `huggingface.co` | the network-off probe: it must **fail** | [`src/offline.js`](src/offline.js), used by [`bin/sauti.mjs`](bin/sauti.mjs), [`bin/serve.mjs`](bin/serve.mjs), [`src/engine.js`](src/engine.js) (UI status pill) | at every CLI start and engine start, and for the status pill. In the offline sandbox each attempt fails at once (`ENETUNREACH`, `EAI_AGAIN`); if one succeeded, the CLI and the engine would refuse to start | a TCP handshake only, closed at once; no data |
| `http://127.0.0.1:8787` | the local web UI and its bridge | [`bin/bridge.mjs`](bin/bridge.mjs), [`ops/ui.sh`](ops/ui.sh) | while the UI runs; binds 127.0.0.1 only | local only |

## Setup (once, with the internet on, before going offline)

| Endpoint | What for | File | Phase |
|---|---|---|---|
| `https://huggingface.co/` (`unsloth/Qwen3-1.7B-GGUF`, `ggerganov/whisper.cpp`, `malinali-app/whisper-swahili-small-ggml`, `ggml-org/whisper-vad`, each at a pinned commit; Hugging Face may redirect to its download CDN, https only) | model weights: Qwen3-1.7B, Whisper small, the Swahili fine-tune of Whisper small, Silero VAD (and the optional models in `models.json`) | [`models.json`](models.json), [`scripts/fetch_models.sh`](scripts/fetch_models.sh): curl in `ops/sandbox.sh setup`, then size + sha256 check | **setup** |
| QVAC's model registry over Hyperswarm: the DHT bootstrap nodes `node1.hyperdht.org`, `node2.hyperdht.org`, `node3.hyperdht.org` (UDP 49737, the `hyperdht` defaults), then peer-to-peer connections to the registry peers found there | the OCR weights (`OCR_LATIN`, `OCR_CRAFT`), which exist only in that registry | [`scripts/fetch_registry_model.sh`](scripts/fetch_registry_model.sh) + [`scripts/registry_fetch.cjs`](scripts/registry_fetch.cjs) (`@qvac/registry-client`), inside a network fence (pasta + bubblewrap: internet only; host loopback, gateway and private ranges refused), then size + sha256 check on the host | **setup** only; also `--fit` (QVAC's advisory `assessModelFit` with registry access) |
| `https://registry.npmjs.org` | npm packages (all 289 entries in `package-lock.json` resolve there) | [`package-lock.json`](package-lock.json), `ops/sandbox.sh setup npm ci` (install scripts off) | **setup** |
| `https://registry.npmjs.org/-/ping` and a DNS lookup of `registry.npmjs.org` | connectivity check of the registry fence | [`scripts/fetch_registry_model.sh`](scripts/fetch_registry_model.sh) `--probe` | setup check |

## Developer, evaluation and demo tools (not needed to run or test the app)

| Endpoint | What for | File |
|---|---|---|
| `https://registry.npmjs.org` (signing keys, package metadata) | registry signature check of the lockfile | [`scripts/verify_sigs.mjs`](scripts/verify_sigs.mjs) |
| `https://registry.npmjs.org` (`npm view`, `npm pack`) | vetting a package before it is installed | [`scripts/vet.py`](scripts/vet.py) |
| `https://huggingface.co/datasets/google/fleurs` (pinned revision) | 333 MB of FLEURS Swahili test audio; the evaluation itself then runs offline | [`scripts/eval_fleurs_asr.sh`](scripts/eval_fleurs_asr.sh) |
| Microsoft's Edge text-to-speech service, through an external client that is not part of this repository (`SAUTI_TTS_DIR`) | made the synthetic test voice notes in `test/audio/` | [`scripts/make_test_audio.py`](scripts/make_test_audio.py) |
| the Sepolia RPC endpoints above, Aave test faucet contract `0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D` | test USDT for the test wallet (the mint is signed offline, then broadcast) | [`scripts/sepolia_faucet_sign.mjs`](scripts/sepolia_faucet_sign.mjs), `bin/netsync.mjs faucet-mint` |
| `1.1.1.1:443`, DNS `registry.npmjs.org`, `https://registry.npmjs.org/-/ping`, `https://ethereum-sepolia-rpc.publicnode.com`, a local port | isolation probe: what each sandbox mode can reach (must fail in `offline` and `devnet`) | [`ops/sandbox_probe.mjs`](ops/sandbox_probe.mjs), run by [`test/sandbox.sh`](test/sandbox.sh) |
| `https://eth-sepolia.blockscout.com/tx/...` in a separate headless browser; that browser's DevTools on `127.0.0.1:9333` | recording the demo video (the local UI and one explorer page) | [`scripts/demo/record_explorer.py`](scripts/demo/record_explorer.py), [`scripts/demo/cdp_lite.py`](scripts/demo/cdp_lite.py) |
| `https://huggingface.co`, `https://1.1.1.1` | the terminal part of the demo shows `curl` to them failing inside the offline sandbox | [`scripts/demo/term_steps.json`](scripts/demo/term_steps.json) |

Not network access: `http://www.w3.org/2000/svg` (the SVG namespace in `ui/`), `https://evil.example` (an Origin
header value in `test/e2e_ui.mjs`, never contacted), and documentation links in comments.

Check it yourself: `grep -rnE "https?://" src bin ops scripts ui config.json models.json`, and
`ops/sandbox.sh offline node ops/sandbox_probe.mjs` (no internet, no host services) next to
`node ops/sandbox_probe.mjs` on the host (the positive control).
