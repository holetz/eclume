"""Serialização dos jobs do arq: JSON, pickle antigo sem globais e a recusa do pickle com código."""

from __future__ import annotations

import os
import pickle
from datetime import UTC, datetime

import pytest

from eclume_engines.fila import desserializar, serializar

TRANSCRIBE = {
    "t": 1,
    "f": "transcribe",
    "a": [
        "01928f3a-1c00-7a00-8000-000000000401",
        "users/u/recordings/r/audio",
        {"language": "pt", "min_speakers": None},
    ],
    "k": {},
    "et": 1727790000000,
}
INGEST = {
    "t": 2,
    "f": "ingest_transcript",
    "a": ["r", "recordings/r/r1/transcript.raw.json", None, {"engine": "whisperx-local", "warnings": []}],
    "k": {},
    "et": 1727790000000,
}


@pytest.mark.parametrize("job", [TRANSCRIBE, INGEST])
def test_ida_e_volta_em_json(job: dict) -> None:
    data = serializar(job)
    assert data.startswith(b"{")
    assert desserializar(data) == job


def test_resultado_que_nao_e_json_vira_texto_e_nao_falha() -> None:
    result = {"r": ValueError("boom"), "s": False, "st": datetime(2026, 10, 1, tzinfo=UTC)}
    back = desserializar(serializar(result))
    assert back == {"r": "boom", "s": False, "st": "2026-10-01 00:00:00+00:00"}


def test_pickle_antigo_de_primitivos_ainda_e_lido() -> None:
    # O pickle que o arq gravava até a fase B: só dicts, listas, textos e números.
    old = {**TRANSCRIBE, "a": tuple(TRANSCRIBE["a"])}
    assert desserializar(pickle.dumps(old)) == old


class _Exec:
    def __reduce__(self) -> tuple:
        return (os.system, ("echo pwned",))


@pytest.mark.parametrize("payload", [_Exec(), ValueError("x"), datetime(2026, 1, 1, tzinfo=UTC)])
def test_pickle_com_global_e_recusado(payload: object) -> None:
    with pytest.raises(pickle.UnpicklingError, match="global recusado"):
        desserializar(pickle.dumps({"r": payload}))
