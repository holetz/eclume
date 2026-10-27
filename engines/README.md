# eclume-engines

eclume's ASR engine interface (`eclume_engines`), shared by the server and the worker through the
uv workspace: `Engine`, `EngineOptions`, `EngineResult` and the `get_engine(nome)` factory.

| Engine | Module | Extra | What it does |
|---|---|---|---|
| `whisperx-local` (default) | `whisperx_local.py` | `whisperx` | WhisperX 3.8.6 on the GPU: ASR `large-v3-turbo` `int8_float16`, wav2vec2 alignment, pyannote `community-1` diarization and embeddings |
| `cpu` | `cpu.py` | `cpu` | faster-whisper `small` `int8`, for dev without a GPU; no diarization |
| `openai-compatible` | `openai_compatible.py` | — | client of `POST /v1/audio/transcriptions` (speaches); no diarization |

The core does not import torch, WhisperX or faster-whisper: each heavy engine imports its own
dependencies when it transcribes, and they come from the extras, which `uv sync --all-packages`
does not install. The tests run without a GPU, over fake modules. Operation and measurements on the
GTX 1660: [docs/project/worker-gpu.md](../docs/project/worker-gpu.md).
