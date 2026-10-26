"""Serialization of arq jobs and results, shared by the server and the GPU worker, without unrestricted `pickle`.

`serialize` writes JSON (`default=str`: it never fails, because a result that does not serialize
becomes `s=False` in arq and the reaper would read `worker_lost`). `deserialize` reads JSON and,
during the transition, a payload still in pickle (protocol marker `0x80`) through an unpickler with
no globals: it refuses any object that needs to import a class or function (the pickle code
execution path). The switch happens in two phases (expand/contract): first every reader gains
`deserialize`, then the producers move to `serialize`. Contract in docs/standards/api/jobs-transcricao.md.
"""

from __future__ import annotations

import io
import json
import pickle
from typing import Any

_PICKLE = 0x80


class _NoGlobals(pickle.Unpickler):
    """Unpickler that only builds primitive types (dict, list, str, numbers, bytes, None, bool)."""

    def find_class(self, module: str, name: str) -> Any:  # noqa: ANN401 — Unpickler signature
        """Refuse every global class or function."""
        msg = f"global refused in the queue payload: {module}.{name}"
        raise pickle.UnpicklingError(msg)


def serialize(obj: dict[str, Any]) -> bytes:
    """The arq job or result as UTF-8 JSON; whatever is not JSON becomes text."""
    return json.dumps(obj, default=str, ensure_ascii=False, separators=(",", ":")).encode()


def deserialize(data: bytes) -> dict[str, Any]:
    """Read the JSON from `serialize` or, in the transition, the old pickle with no globals."""
    if data[:1] == bytes([_PICKLE]):
        return _NoGlobals(io.BytesIO(data)).load()
    return json.loads(data)
