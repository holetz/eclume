"""Benchmark de uma engine num arquivo de áudio.

```bash
python -m eclume_worker.bench /data/bench.ogg --engine whisperx-local --no-diarize
```

Imprime um JSON com o fator de tempo real (processamento ÷ duração), os minutos de
processamento por hora de áudio e a VRAM de pico acima da linha de base. Com `--transcript`,
grava também o `transcript.raw.json` para inspeção.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from eclume_engines import EngineOptions, get_engine
from eclume_engines.hf_token import resolve_hf_token
from eclume_engines.vram import VramMonitor
from eclume_worker.storage import sha256_file
from eclume_worker.transcript import build_transcript

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from eclume_engines import Engine


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Argumentos do CLI."""
    parser = argparse.ArgumentParser(prog="python -m eclume_worker.bench", description=__doc__.splitlines()[0])
    parser.add_argument("audio", type=Path)
    parser.add_argument("--engine", default="whisperx-local")
    parser.add_argument("--model")
    parser.add_argument("--compute-type")
    parser.add_argument("--language", default="pt")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--batch-size", type=int, help="lote inicial fixo do ASR (padrão: pela VRAM livre)")
    parser.add_argument("--no-diarize", action="store_true")
    parser.add_argument("--no-embeddings", action="store_true")
    parser.add_argument("--transcript", type=Path, help="grava o transcript.raw.json neste caminho")
    return parser.parse_args(argv)


def run(args: argparse.Namespace, factory: Callable[..., Engine] = get_engine) -> dict[str, Any]:
    """Roda a engine uma vez e devolve as medidas."""
    kwargs: dict[str, Any] = {}
    if args.engine == "whisperx-local":
        kwargs = {"device": args.device, "hf_token": resolve_hf_token(), "batch_size": args.batch_size}
    engine = factory(args.engine, **kwargs)
    options = EngineOptions(
        language=args.language,
        model=args.model,
        compute_type=args.compute_type,
        diarize=not args.no_diarize,
        embeddings=not args.no_embeddings,
    )
    free_before = VramMonitor().free_mb()
    started = time.monotonic()
    result = engine.transcribe(args.audio, options)
    processing_s = time.monotonic() - started
    engine.unload()

    if args.transcript is not None:
        document = build_transcript(
            result,
            recording_id=str(uuid.uuid5(uuid.NAMESPACE_URL, str(args.audio))),
            revision=1,
            content_hash=sha256_file(args.audio),
            language=args.language,
            now=datetime.now(UTC),
        )
        args.transcript.write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")

    rtf = processing_s / result.duration_s if result.duration_s else None
    return {
        "audio": str(args.audio),
        "engine": result.engine,
        "model": result.model,
        "compute_type": result.compute_type,
        "batch_size": result.batch_size,
        "diarization": result.diarization_model is not None,
        "duration_s": round(result.duration_s, 2),
        "processing_s": round(processing_s, 2),
        "realtime_factor": None if rtf is None else round(rtf, 4),
        "minutes_per_audio_hour": None if rtf is None else round(rtf * 60, 2),
        "peak_vram_mb": result.peak_vram_mb,
        "free_vram_before_mb": free_before,
        "segments": len(result.segments),
        "words": sum(len(s.words) for s in result.segments),
        "speakers": len({s.speaker for s in result.segments if s.speaker is not None}),
        "warnings": result.warnings,
    }


def main(argv: Sequence[str] | None = None) -> int:
    """Ponto de entrada do CLI."""
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    report = run(parse_args(argv))
    sys.stdout.write(json.dumps(report, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
