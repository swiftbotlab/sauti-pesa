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
   switched with reload-config. Load, the warm-up clip, then the 6 test voice notes (`test/audio/`).
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
