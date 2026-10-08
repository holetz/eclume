"""Benchmark de uma engine num arquivo de áudio.

```bash
python -m eclume_worker.bench /data/bench.ogg --engine whisperx-local --no-diarize
```

Imprime um JSON com o fator de tempo real (processamento ÷ duração), os minutos de
processamento por hora de áudio e a VRAM de pico acima da linha de base. Com `--transcript`,
grava também o `transcript.raw.json` para inspeção. `--repeat N` roda N jobs seguidos na mesma
engine (como o worker faz) e lista o tempo de cada um em `runs_s`: com o ASR residente, do segundo
em diante não há carga do modelo; `--single-slot` mede o comportamento antigo, um modelo por vez.
Com `--reference texto.txt`, o JSON traz também `quality`: WER e CER do texto reconhecido contra a
referência, com a normalização pt-BR de `eclume_worker.wer`.
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
from eclume_worker.wer import EditCounts, char_counts, word_counts

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
    parser.add_argument("--reference", type=Path, help="texto de referência (UTF-8) para medir WER e CER")
    parser.add_argument("--transcript", type=Path, help="grava o transcript.raw.json neste caminho")
    parser.add_argument("--repeat", type=int, default=1, help="jobs seguidos na mesma engine (padrão: 1)")
    parser.add_argument("--single-slot", action="store_true", help="um modelo por vez, sem o ASR residente")
    return parser.parse_args(argv)


def _quality(reference: str, hypothesis: str) -> dict[str, Any]:
    """WER e CER com as contagens que os explicam."""

    def block(counts: EditCounts) -> dict[str, Any]:
        return {
            "rate": None if counts.rate is None else round(counts.rate, 4),
            "reference_len": counts.reference_len,
            "substitutions": counts.substitutions,
            "deletions": counts.deletions,
            "insertions": counts.insertions,
        }

    return {"wer": block(word_counts(reference, hypothesis)), "cer": block(char_counts(reference, hypothesis))}


def run(args: argparse.Namespace, factory: Callable[..., Engine] = get_engine) -> dict[str, Any]:
    """Roda a engine uma vez e devolve as medidas."""
    kwargs: dict[str, Any] = {}
    if args.engine == "whisperx-local":
        kwargs = {
            "device": args.device,
            "hf_token": resolve_hf_token(),
            "batch_size": args.batch_size,
            "keep_asr_resident": not args.single_slot,
        }
    engine = factory(args.engine, **kwargs)
    options = EngineOptions(
        language=args.language,
        model=args.model,
        compute_type=args.compute_type,
        diarize=not args.no_diarize,
        embeddings=not args.no_embeddings,
    )
    free_before = VramMonitor().free_mb()
    runs_s = []
    for _ in range(max(1, args.repeat)):
        started = time.monotonic()
        result = engine.transcribe(args.audio, options)
        runs_s.append(round(time.monotonic() - started, 2))
    processing_s = runs_s[0]
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
    report = {
        "audio": str(args.audio),
        "engine": result.engine,
        "model": result.model,
        "compute_type": result.compute_type,
        "batch_size": result.batch_size,
        "diarization": result.diarization_model is not None,
        "duration_s": round(result.duration_s, 2),
        "processing_s": round(processing_s, 2),
        "runs_s": runs_s,
        "realtime_factor": None if rtf is None else round(rtf, 4),
        "minutes_per_audio_hour": None if rtf is None else round(rtf * 60, 2),
        "peak_vram_mb": result.peak_vram_mb,
        "free_vram_before_mb": free_before,
        "segments": len(result.segments),
        "words": sum(len(s.words) for s in result.segments),
        "speakers": len({s.speaker for s in result.segments if s.speaker is not None}),
        "warnings": result.warnings,
    }
    if args.reference is not None:
        hypothesis = " ".join(s.text for s in result.segments)
        report["quality"] = _quality(args.reference.read_text(encoding="utf-8"), hypothesis)
    return report


def main(argv: Sequence[str] | None = None) -> int:
    """Ponto de entrada do CLI."""
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    report = run(parse_args(argv))
    sys.stdout.write(json.dumps(report, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
