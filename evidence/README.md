# Evidence: QVAC profiler run

[`qvac-profile.json`](qvac-profile.json) is the export of **one scripted, offline run** of the app's own AI code
paths, measured with the QVAC SDK's profiler ([docs](https://docs.qvac.tether.io/sdk/runtime/profiler)):
`profiler.enable({ mode: 'verbose', includeServerBreakdown: true, includeResourceGauges: true })`, every event
collected with `profiler.onRecord`, then `profiler.exportJSON()`, `exportTable()` and `exportSummary()`. Script:
[`scripts/profile_qvac.mjs`](../scripts/profile_qvac.mjs), run by [`scripts/profile_qvac.sh`](../scripts/profile_qvac.sh).

```bash
scripts/profile_qvac.sh     # about 1.5 min; stop ops/ui.sh first (RAM). Writes evidence/qvac-profile.json
```

| Run | |
|---|---|
| When | 2026-10-28 01:43 UTC, 86 s, 72 steps, 1,017 profiler events |
| Network | offline sandbox (`ops/sandbox.sh offline`): only `lo`; TCP to 1.1.1.1:443 and the IPv6 equivalent `ENETUNREACH`, DNS `EAI_AGAIN`, checked before and after the run (`sandbox.network_before/after`) |
| Hardware | Linux virtual machine (Apple Virtualization Generic Platform), 6 arm64 vCPUs (vendor Apple; the guest is not given a CPU model name), 7.9 GB RAM, **no GPU, CPU only** |
| Software | Ubuntu 26.04.1 LTS, Linux 7.0.0-38, Node.js v22.22.1, `@qvac/sdk` 0.22.0 |
| Conditions | our model files were dropped from the page cache first, so the first load of each model read its weights from disk; the machine also runs other services; one run, not an average |

## What ran
In the resident engine's order (`src/engine.js`), through the app's own modules, with the test files in this repository:

1. **Speech to text + VAD** (`src/asr.js`): Whisper small q8_0 with Silero VAD as `vadModelSrc`, one instance, sw/en
   switched with reload-config. (This run used the multilingual Whisper small for both languages; since 2026-10-28
   the app uses a Swahili fine-tune of the same size for Swahili: see the [last section](#evidence-swahili-speech-model-2026-10-28).) Load, the warm-up clip, then the 6 test voice notes (`test/audio/`).
2. **Intent LLM** (`src/llm.js`, `src/pipeline.js`): Qwen3-1.7B Q4_0 with KV-cached prompts. Load, prompt-cache
   warm-up, then the 6 transcripts and the 12 test requests (`test/llm_cases.json`) through `analyzeRequest()`, and
   the 4 test scam messages through `analyzeMessage()`. No wallet is opened and nothing is signed.
3. **OCR** (`src/ocr.js`): the speech model is unloaded first, as in the engine. For each of the 4 test screenshots
   (`test/data/public/screens/`) QVAC OCR is loaded, reads the image, is unloaded, and the text is checked like
   pasted text.
4. **VAD comparison**: the same voice notes plus 3 s of digital silence (made by the script), once with the app's
   Whisper config and once with the same config without the VAD model.

## Model load and unload

| Model (QVAC constant) | Load: first, from disk | Later loads | Unload |
|---|---|---|---|
| Whisper small q8_0 + Silero VAD 5.1.2 (`WHISPER_SMALL_Q8_0`, `VAD_SILERO_5_1_2`) | **597 ms** | sw/en switch by reload-config: 10 ms and 1 ms | 23 ms |
| Qwen3-1.7B Q4_0 (`QWEN3_1_7B_INST_Q4`) | **1,092 ms**, then 5.8 s prompt-cache warm-up (2 completions: 3,528 and 2,206 ms) | | 43 ms |
| OCR: CRAFT detector + latin_g2 (`OCR_CRAFT`, `OCR_LATIN`) | **219 ms** | 162, 156, 151 ms (loaded for each screenshot, as the engine does) | 20 ms (19-25) |

Load = `loadModel` RPC phase `server.handlerExecution` (inside the QVAC worker); the client's `totalClientTime` is
0-5 ms more for a load (28 ms more for the first language switch). Unload = the `unloadModel` handler event.

## Inference calls
Median (min-max).

| Capability | Calls | Input size | Time per call | Time to first token | Tokens/s | Other fields the SDK reported |
|---|---|---|---|---|---|---|
| Speech to text (`transcribe`) | 6 voice notes | 3.65-7.34 s of audio (median 4.2 s) | **1,072 ms** (1,004-1,256) | not reported (one result per call) | 14.5 (12.1-29.2) | real-time factor **0.247** (0.149-0.295); encoder 882 ms of it, decoder 4 ms; 16 tokens (12-32) |
| Intent (`completion`, JSON schema) | 18 | 43 chars (15-78); prompt 708 tokens (682-811), of which **682 from the KV cache** and 26 computed | **874 ms** (699-1,802) | **173 ms** (93-321) | **53.3** (47.0-54.3) | 35 tokens generated (31-74); prompt processing 168 tokens/s |
| Scam second opinion (`completion`) | 9 | 128 chars (45-240); prompt 436 tokens (353-580), 367 cached, 62 computed | 1,420 ms (920-2,524) | 294 ms (167-741) | 53.6 (49.1-55.7) | 50 tokens generated (41-125) |
| OCR (`ocr`) | 4 screenshots | 720x700 PNG, 26-49 KB; 8-13 text blocks, 130-240 characters read | **2,720 ms** (2,432-2,840) | not reported | not reported (no tokens) | detection 2.14 s (2.13-2.21), recognition 0.57 s (0.30-0.62) |
| Voice activity detection | inside each `transcribe` call | | see below | not reported | not reported | no separate fields |

The 9 scam opinions are the 4 test scam messages, the 4 screenshot texts and the one voice note that a scam rule flagged.

### Voice activity detection (Silero VAD)
The SDK reports no separate VAD timing: VAD runs inside the Whisper `transcribe()` call. So the script ran the same
clips with and without the VAD model (otherwise the same config):

| Clip | Audio | With VAD (the app) | Without VAD |
|---|---|---|---|
| 6 test voice notes | 3.65-7.34 s | 1,048-1,217 ms; transcripts identical to the run without VAD except two (one word boundary, one punctuation mark) | 1,028-1,154 ms |
| 3 s of digital silence | 3.0 s | **16 ms, empty transcript** (0 tokens) | 2,252 ms, Whisper invents a word: "Aniwa," |

On short, clean voice notes VAD costs or saves nothing measurable. On a clip with no speech it skips Whisper
(16 ms instead of 2.3 s) and keeps it from inventing text, which the app then shows as "no speech heard".

### Memory
RSS of the QVAC worker process as the SDK's resource gauge reports it (`processUsedBytes`, one sample per profiled
operation, so not a high-water mark; RSS also counts the memory-mapped model weights):

| Models loaded in the QVAC worker | Highest sample |
|---|---|
| none (worker process only) | 551 MB |
| Whisper small + VAD | 765 MB |
| Whisper small + VAD + Qwen3-1.7B (the resident engine) | 3,086 MB |
| Qwen3-1.7B (speech unloaded while a screenshot is read) | 2,760 MB |
| Qwen3-1.7B + OCR (reading a screenshot) | 3,801 MB |

These are the SDK's own figures from this run; they are higher than the 2.2-2.8 GB engine RSS the main README gives
from an earlier `/proc` reading. Under a hard 3 GB memory cap the whole app still passes its end-to-end tests,
because the kernel can drop the file-backed pages of the weights: see the main README,
[Runs in 3 GB](../README.md#runs-in-3-gb).

## What the profiler did not report
Written from the events of this run (`notes` in the JSON), not assumed:

- **Model load:** for models loaded from a local file, no handler-level gauges (`totalLoadTime`,
  `modelInitializationTime`) were reported. The load times above are the RPC phases.
- **Speech to text:** the profiler records only time for `transcribe()`. Tokens, tokens/s, real-time factor and the
  encoder/decoder split come from the same call's own `transcribe().stats`. To read them, the script makes the same
  calls as `LocalASR.transcribe()` (content check, input gain, `transcribe()`), written out.
- **LLM:** the profiler's `completionStream` event has the time, `ttfb`, `modelExecutionTime` and the stream chunk
  count, but no `timeToFirstToken` or `tokensPerSecond` gauge. Time to first token, tokens/s and the prompt, cache
  and generated token counts come from the same call's completion stats (`completion().final.stats`, which
  `src/llm.js` keeps).
- **OCR:** no tokens and no time to first token (one result per call). The OCR addon reports `detectionTime`,
  `recognitionTime` and `totalTime` in **seconds**; `exportTable()` prints them as ms.
- **Units:** `transcribe().stats.totalTime` is in seconds on this build (it equals `totalWallMs / 1000`).
- **VAD:** no fields of its own (see above).

## Where things are in the JSON

| Key | Content |
|---|---|
| `summary` | the numbers above, computed by the script from the events and the SDK's per-call stats |
| `steps[]` | every step in order: input, result, wall clock, models loaded, its profiler handler events, main RPC phases and resource samples |
| `llm_completions[]` | one row per completion: profiler time/ttfb/chunks next to the SDK's TTFT, tokens/s and token counts |
| `profiler.events` | all 1,017 profiler events as recorded, each labelled with its step |
| `profiler.aggregates`, `profiler_table`, `profiler_summary` | `exportJSON().aggregates`, `exportTable()`, `exportSummary()` |
| `hardware`, `sandbox`, `models`, `app_config` | machine, network state before and after, model files (QVAC constant, bytes, sha256), threads and OCR settings |

# Evidence: Swahili speech model (2026-10-28)

[`asr-swahili-finetune.json`](asr-swahili-finetune.json): the measurements behind switching the app's **Swahili**
speech to text from the multilingual Whisper small to a Swahili fine-tune of it
([malinali-app/whisper-swahili-small-ggml](https://huggingface.co/malinali-app/whisper-swahili-small-ggml) at commit
`403b03e660aa3635823c42e4589c57a9b2c26fe5`, ggml q8_0 of
[PaschalK/whisper-swahili-small](https://huggingface.co/PaschalK/whisper-swahili-small), Apache-2.0, sha256
`5d89c6ee…2381a6` = the Hugging Face LFS oid at that commit). The weights load through the same QVAC call as every
other model here, `loadModel({ modelSrc: <local file>, modelType: 'whispercpp-transcription', modelConfig })`
([`src/asr.js`](../src/asr.js)); no code from the model's repository is used. Same box and offline sandbox as above.

| Measure (same app code and settings) | Multilingual Whisper small | Swahili fine-tune |
|---|---|---|
| FLEURS Swahili, 40 real voices: WER | 78.3% | **20.1%** |
| FLEURS: CER | 20.4% | **7.2%** |
| FLEURS: clips with a contact name copied from the prompt | 4 | 0 |
| FLEURS: time per clip, median (run 1 / run 2; shared box) | 1.5 s / 3.2 s | 1.9 s / 1.4 s |
| FLEURS: load (run 1 / run 2) | 1.5 s / 2.0 s | 2.2 s / 1.5 s |
| 6 synthetic voice notes to the right decision (`scripts/bench_e2e.mjs`) | 6/6 | 6/6 (Swahili clips; the 2 English clips use the multilingual model) |
| English test clip "Please send 40 USDT to Otieno for the rent." | heard right | "Please send for usdt tu otieno for the rent." (so English keeps the multilingual model) |
| 3 GB memory cap, `test/e2e_ui.sh` (max anonymous memory) | 2,942 / 2,948 MB (90/90) | 2,998 / 2,901 MB (93/93, with sw → en → sw swaps) |

Reproduce: `scripts/eval_fleurs_asr.sh all`, `ops/sandbox.sh offline node scripts/bench_e2e.mjs` and
`... bench_e2e.mjs --generic`, `scripts/mem_cap_run.sh 3G test/e2e_ui.sh`.

# Evidence: lite ("phone-class") profile (2026-10-29)

[`lite-profile.json`](lite-profile.json): the app's default profile against a **lite** one that swaps only the
intent and message model: **Qwen3-0.6B Q4_0** (QVAC registry constant `QWEN3_600M_INST_Q4`, 382 MB, sha256
`33bcc570…8f75cb` = QVAC's pin = the Hugging Face LFS oid at commit `50968a44…`) instead of Qwen3-1.7B Q4_0
(1.06 GB). Speech to text (Swahili fine-tune + Whisper small), Silero VAD, OCR and every code check are the same
files and the same code. Same Linux arm64 VM as above (6 vCPUs, 7.9 GB RAM, no GPU), offline sandbox, the
repository's own harnesses, one heavy run at a time, 2026-10-29 05:01-05:22 UTC. **Not run on a phone**: we have
no device, so the memory rows say what the whole app needs on this box under a hard cgroup cap.

**Verdict: measured, not recommended.** Lite halves the language step's time and lowers the memory the whole app
needs from 3 GB to 2.5 GB, and it stayed safe (no wrong payment reached "confirm" in any set), but on the
commissioned set of real requests it understood only **3 of the 7 USDT requests** (default 7/7). The default stays
Qwen3-1.7B; lite is there to answer "what about smaller phones?" with numbers.

```bash
scripts/fetch_models.sh --lite                 # once, online: Qwen3-0.6B (+ the same speech and VAD files), size + sha256 checked
SAUTI_PROFILE=lite ops/ui.sh                   # the app with the lite profile (default: unset = Qwen3-1.7B)
SAUTI_PROFILE=lite ops/sandbox.sh offline node bin/sauti.mjs ask "Tuma USDT ishirini kwa Amina"
node bin/portable.mjs --lite ui                # portable mode (any laptop); npm run fetch-models -- --lite
```

| Measure (same box, same day) | Default: Qwen3-1.7B | Lite: Qwen3-0.6B |
|---|---|---|
| Intent, tuned set (12 requests, `scripts/bench_llm.mjs`) | 12/12 | 11/12 |
| Intent, held-out set (12) | 11/12 | 10/12 |
| Model mistakes the code would still let reach "confirm" (both sets) | 0 | 0 |
| Commissioned set (private): USDT requests with action, amount, token and payee right (7) | 7/7 | **3/7** (4 came back as JSON the validator refused: "could not understand") |
| Commissioned: amounts read right (30) | 30/30 (28/30 before the Sheng change below) | 24/30 (22/30 before) |
| Commissioned: named recipient found (11) | 11/11 | 7/11 |
| Commissioned: payments that reached "confirm" with a wrong amount or person | 0 | 0 |
| Commissioned: message check, scams high / everyday requests high (rules decide) | 5/5 / 0/30 | 5/5 / 0/30 |
| Public set in this repo (10 requests + 3 scams): amounts / named recipients / scams high | 10/10 / 5/5 / 3/3 (amounts 9/10 before the Sheng change) | 10/10 / 4/5 / 3/3 (9/10 before) |
| 6 voice notes to the right decision (`scripts/bench_e2e.mjs`) | 6/6 | 6/6 |
| Warm engine, text request to checked payment, median of 12 (`scripts/bench_latency.sh`) | 974 ms | **480 ms** |
| Warm engine, voice note to checked payment, median of 6 | 4.1 s | **2.4 s** |
| Language step alone, median (bench_llm, tuned set) | 987 ms | 536 ms |
| Engine start to ready (load + warm-up) | 12.1 s | 8.2 s |
| QVAC worker RSS with only the language model loaded (bench_llm peak) | 2,612 MB | 1,379 MB |
| `test/e2e_ui.sh` under a hard **2.5 GB** cap (`scripts/mem_cap_run.sh 2560M`) | **OOM-killed** at the first screenshot (QVAC worker 2.43 GB anonymous); the 70 checks before it passed | **no OOM**: max anonymous 2,376 MB; 95 checks passed, 2 failed (below), then the test stopped (11 checks not run) |
| `test/e2e_ui.sh` under a hard **2 GB** cap | not run | **OOM-killed** at the first screenshot (QVAC worker 1.91 GB anonymous); 69 passed, 1 failed before it |
| `test/e2e_ui.sh` under 3 GB ([Runs in 3 GB](../README.md#runs-in-3-gb), 2026-10-28) | 108/108, max anonymous 2.90-3.02 GB | not run |

Timings are one run each on a shared VM (load average 2-3.6 during these runs; the default's 4.1 s voice median is
higher than the 2.6 s in the main README from a quieter run). An OOM kill stops the whole systemd scope, so for those
runs the kernel's own lines are in the JSON (`kernel_oom_events`) instead of the script's summary line.

**What went wrong with lite** (each reproduced with the CLI, `bin/sauti.mjs ask … --json`):
- It copies the prompt's first example: for *"Tuma USDT 2 kwa Amina"* it answered amount 20 and memo "kodi". The code
  blocked it (the amount 20 was never said), so it is a refusal, not a wrong payment; it is one of the two
  `test/e2e_ui.sh` failures.
- It invents placeholders: for the M-Pesa "wakala" scam request it wrote `"recipient_address": "0x..."`, so the
  validator refused the answer and the app said it could not understand (nothing to confirm), without the scam
  reasons the default shows. The second `test/e2e_ui.sh` failure.
- It invents amounts: *"nitumie Juma pesa"* (no amount) became 100; blocked by the code ("no amount was heard").
- As a scam second opinion it ticks 7-11 of the 11 warning signs on every message, also on a harmless one (the
  default: 2-4). The rules decide the risk, so the final risk was right 8/8 in both sets, but the hint is noise.

**Which phones** (an estimate, not a measurement): the RAM floor above (the cap under which `test/e2e_ui.sh` ran
without an OOM kill) plus about 1.5 GB that we assume Android and other apps keep for themselves. Default: 3 GB →
about 4.5 GB → 6 GB phones. Lite: 2.5 GB → about 4 GB → 4 GB phones, at the limit. The cap also held the local test
chain, the bridge and the test client, which a phone build would not run; the peaks come from reading a screenshot
(OCR + language model in memory, speech unloaded). A phone runtime (Bare/Pear) is not built.

**Sheng numbers (same day, after the runs above).** `src/amount.js` now reads the Sheng amounts *thao* (1,000) and
*soo* (100) like *elfu* and *mia* ("thao moja" = 1000, "soo tano" = 500), and `src/safety.js` treats them as
shilling words, so such a request is blocked as a local-currency amount like every shilling request (the app sends
USDT only). Only the commissioned and public sets contain them; both were run again with both profiles:
commissioned amounts 28/30 → **30/30** (default) and 22/30 → 24/30 (lite), Sheng rows 4/6 → 6/6 (default); every
other row and the message checks unchanged; public set 9/10 → 10/10 with both. All of these rows stay blocked:
they are shilling amounts (on one of them the default model now answers "balance" instead of "send"). "2k"-style amounts are still not read by the code's own cross-check. Outcomes only (no text from the
private set): [`test/data/eval_sw_requests_results.json`](../test/data/eval_sw_requests_results.json) and
[`…_lite.json`](../test/data/eval_sw_requests_results_lite.json).

**Harness fix found on the way:** `scripts/eval_sw_requests.mjs` compared the public set's numeric labels with string
amounts and so reported 0 amounts right for both models on the public set; it now normalises both (the commissioned
labels are strings and were not affected).

Reproduce: `LLM_CASES=test/llm_heldout.json ops/sandbox.sh offline node scripts/bench_llm.mjs models/Qwen3-0.6B-Q4_0.gguf`
(and `test/llm_cases.json`, and the 1.7B file), `SAUTI_PROFILE=lite ops/sandbox.sh offline node scripts/bench_e2e.mjs`,
`SAUTI_PROFILE=lite scripts/bench_latency.sh` (after `test/e2e_ui.sh`), `SAUTI_PROFILE=lite scripts/eval_sw_requests.sh`
(private set; the public one with the `SAUTI_EVAL_SET`/`SAUTI_EVAL_LABELS` line from the README),
`SAUTI_PROFILE=lite scripts/mem_cap_run.sh 2560M test/e2e_ui.sh`; each without `SAUTI_PROFILE` for the default.
