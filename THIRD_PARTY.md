# What was built during the event, and third-party work

## Built during AI Yako (from 2026-10-26)
All code in this repository was written for this hackathon by Swift Bot Labs:
- `src/`, `bin/`, `ops/`, `scripts/`, `ui/` and `test/` (the commissioned test set listed below is not included);
- `contracts/MockUSDT.sol` and `data/`.
No earlier code was reused.

## Third-party software (npm, exact versions in package-lock.json)
| Package | Version | Licence | Used for |
|---|---|---|---|
| @qvac/sdk (Tether) | 0.22.0 | Apache-2.0 | local speech-to-text and LLM inference |
| @tetherto/wdk (Tether) | 1.0.0-beta.22 | Apache-2.0 | wallet core + transaction policies |
| @tetherto/wdk-wallet-evm (Tether) | 1.0.0-beta.24 | Apache-2.0 | EVM accounts, offline signing |
| ethers | 6.17.0 | MIT | ABI encoding, address checksums, tx decoding |
| solc (dev only) | 0.8.28 | MIT | compiling the devnet test token |
| Foundry anvil (binary, not bundled) | 1.8.5 | MIT/Apache-2.0 | local test chain |

## Models (downloaded by scripts/fetch_models.sh, not committed)
| File | QVAC constant | Origin | Licence |
|---|---|---|---|
| Qwen3-1.7B-Q4_0.gguf | QWEN3_1_7B_INST_Q4 | unsloth/Qwen3-1.7B-GGUF (Qwen3-1.7B by Alibaba Qwen) | Apache-2.0 |
| ggml-small-q8_0.bin | WHISPER_SMALL_Q8_0 | ggerganov/whisper.cpp (OpenAI Whisper) | MIT |
| ggml-silero-v5.1.2.bin | VAD_SILERO_5_1_2 | ggml-org/whisper-vad (Silero VAD) | MIT |
| ggml-large-v3-turbo-q5_0.bin (optional) | (q5_0 of WHISPER_LARGE_V3_TURBO) | ggerganov/whisper.cpp | MIT |

## Test data
- `test/audio/*.wav` are synthetic recordings made with Microsoft Edge neural voices (sw-KE, sw-TZ, en-KE) at
  development time. They are test fixtures only.
- **Commissioned test set (private, not in this repository).** 30 everyday payment requests (16 standard Swahili,
  6 Sheng, 8 Swahili/English code-switched) and 5 scam messages, each with an English translation, amount,
  currency, register and scam signal: a commissioned test set written by an independent Swahili speaker. We use it as
  evaluation data only and do not redistribute it. `scripts/eval_sw_requests.sh` runs the evaluation when the file is
  placed in `test/data/private/`; the measured outcomes (no text from the set) are in
  `test/data/eval_sw_requests_results*.json` and the README.
- Demo contacts and addresses are random test addresses.
