"""Serialization of arq jobs: JSON, old pickle with no globals and the refusal of pickle carrying code."""

from __future__ import annotations

import os
import pickle
from datetime import UTC, datetime

import pytest

from eclume_engines.queue_codec import deserialize, serialize

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
def test_round_trip_in_json(job: dict) -> None:
    data = serialize(job)
    assert data.startswith(b"{")
    assert deserialize(data) == job


def test_result_that_is_not_json_becomes_text_and_does_not_fail() -> None:
    result = {"r": ValueError("boom"), "s": False, "st": datetime(2026, 10, 1, tzinfo=UTC)}
    back = deserialize(serialize(result))
    assert back == {"r": "boom", "s": False, "st": "2026-10-01 00:00:00+00:00"}


def test_old_pickle_of_primitives_is_still_read() -> None:
    # The pickle arq wrote until phase B: only dicts, lists, strings and numbers.
    old = {**TRANSCRIBE, "a": tuple(TRANSCRIBE["a"])}
    assert deserialize(pickle.dumps(old)) == old


class _Exec:
    def __reduce__(self) -> tuple:
        return (os.system, ("echo pwned",))


@pytest.mark.parametrize("payload", [_Exec(), ValueError("x"), datetime(2026, 1, 1, tzinfo=UTC)])
def test_pickle_with_a_global_is_refused(payload: object) -> None:
    with pytest.raises(pickle.UnpicklingError, match="global recusado"):
        deserialize(pickle.dumps({"r": payload}))
