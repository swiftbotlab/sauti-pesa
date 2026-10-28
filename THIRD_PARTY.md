# What was built during the event, and third-party work

## Built during AI Yako (from 2026-10-26)
All code in this repository was written for this hackathon by Swift Bot Labs:
- `src/`, `bin/`, `ops/`, `scripts/`, `ui/` and `test/` (the commissioned test set listed below is not included);
- `contracts/MockUSDT.sol` and `data/`.
No earlier code was reused.

## Third-party software (npm, exact versions in package-lock.json)
| Package | Version | Licence | Used for |
|---|---|---|---|
| @qvac/sdk (Tether) | 0.22.0 | Apache-2.0 | local speech-to-text, LLM inference and OCR; its registry client downloads the OCR weights |
| @tetherto/wdk (Tether) | 1.0.0-beta.22 | Apache-2.0 | wallet core + transaction policies |
| @tetherto/wdk-wallet-evm (Tether) | 1.0.0-beta.24 | Apache-2.0 | EVM accounts, offline signing |
| ethers | 6.17.0 | MIT | ABI encoding, address checksums, tx decoding |
| solc (dev only) | 0.8.28 | MIT | compiling the devnet test token |
| Foundry anvil (binary, not bundled) | 1.8.5 | MIT/Apache-2.0 | local test chain |
| pasta from passt (system package, not bundled) | 0.0~git20260120 | GPL-2.0-or-later | network fence for the one-time OCR model download |

## Models (downloaded by scripts/fetch_models.sh, not committed)
| File | QVAC constant | Origin | Licence |
|---|---|---|---|
| Qwen3-1.7B-Q4_0.gguf | QWEN3_1_7B_INST_Q4 | unsloth/Qwen3-1.7B-GGUF (Qwen3-1.7B by Alibaba Qwen) | Apache-2.0 |
| ggml-small-q8_0.bin | WHISPER_SMALL_Q8_0 | ggerganov/whisper.cpp (OpenAI Whisper); English speech | MIT |
| ggml-whisper-swahili-small-q8_0.bin (Swahili speech) | none (`WHISPER_SMALL_SW_Q8_0` in models.json; loaded from a local path) | [malinali-app/whisper-swahili-small-ggml](https://huggingface.co/malinali-app/whisper-swahili-small-ggml) at commit `403b03e660aa3635823c42e4589c57a9b2c26fe5`, file `ggml-model-q8_0.bin`, sha256 `5d89c6ee07592a0c43fa560d592949635e7154cd716debda8d40919a772381a6` (Hugging Face LFS oid): a ggml q8_0 conversion by malinali-app of [PaschalK/whisper-swahili-small](https://huggingface.co/PaschalK/whisper-swahili-small), a Swahili fine-tune of OpenAI Whisper small on Common Voice 11. Weights only: no code from either repository is used | Apache-2.0 |
| ggml-silero-v5.1.2.bin | VAD_SILERO_5_1_2 | ggml-org/whisper-vad (Silero VAD) | MIT |
| ggml-large-v3-turbo-q5_0.bin (optional) | (q5_0 of WHISPER_LARGE_V3_TURBO) | ggerganov/whisper.cpp | MIT |
| latin_g2.gguf | OCR_LATIN | QVAC model registry (EasyOCR latin_g2 recognizer by JaidedAI, GGUF by QVAC) | Apache-2.0 |
| craft_mlt_25k.gguf | OCR_CRAFT | QVAC model registry (CRAFT text detector by NAVER Clova AI, as used by EasyOCR, GGUF by QVAC) | MIT |

## Test data
- `test/audio/*.wav` are synthetic recordings made with Microsoft Edge neural voices (sw-KE, sw-TZ, en-KE) at
  development time. They are test fixtures only.
- **Commissioned test set (private, not in this repository).** 30 everyday payment requests (16 standard Swahili,
  6 Sheng, 8 Swahili/English code-switched) and 5 scam messages, each with an English translation, amount,
  currency, register and scam signal: a commissioned test set written by an independent Swahili speaker. We use it as
  evaluation data only and do not redistribute it. `scripts/eval_sw_requests.sh` runs the evaluation when the file is
  placed in `test/data/private/`; the measured outcomes (no text from the set) are in
  `test/data/eval_sw_requests_results*.json` and the README.
- `test/data/public/screens/*.png` are screenshots we rendered in code (`scripts/make_test_screens.py`, DejaVu Sans)
  from our own wording; no real people, phone numbers or brand artwork. `ocr_blocks.json` next to them is recorded
  QVAC OCR output for them (`scripts/record_ocr_blocks.mjs`).
- **FLEURS** (Google; Conneau et al. 2022, arXiv:2205.12446), Swahili (Kenya) test split, licence CC-BY 4.0,
  https://huggingface.co/datasets/google/fleurs: `scripts/eval_fleurs_asr.sh` downloads it at a pinned commit to
  measure speech to text on 40 real recordings. No audio is committed; `test/data/public/fleurs_results.json` contains
  the FLEURS reference transcriptions of those 40 sentences next to our model's output.
- Demo contacts and addresses are random test addresses.
