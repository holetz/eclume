# eclume-engines

Interface de engine de ASR do eclume (`eclume_engines`), compartilhada pelo server e pelo worker
pelo workspace uv: `Engine`, `EngineOptions`, `EngineResult` e a fábrica `get_engine(nome)`.

| Engine | Módulo | Extra | O que faz |
|---|---|---|---|
| `whisperx-local` (padrão) | `whisperx_local.py` | `whisperx` | WhisperX 3.8.6 na GPU: ASR `large-v3-turbo` `int8_float16`, alinhamento wav2vec2, diarização pyannote `community-1` e embeddings |
| `cpu` | `cpu.py` | `cpu` | faster-whisper `small` `int8`, para dev sem GPU; sem diarização |
| `openai-compatible` | `openai_compatible.py` | — | cliente de `POST /v1/audio/transcriptions` (speaches); sem diarização |

O núcleo não importa torch, WhisperX nem faster-whisper: cada engine pesada importa as próprias
dependências ao transcrever, e elas vêm dos extras, que `uv sync --all-packages` não instala. Os
testes rodam sem GPU, sobre módulos fake. Operação e medidas na GTX 1660:
[docs/project/worker-gpu.md](../docs/project/worker-gpu.md).
