"""Serialização dos jobs e resultados do arq, comum ao server e ao worker GPU, sem `pickle` irrestrito.

`serializar` grava JSON (`default=str`: nunca falha, porque um resultado que não serializa vira
`s=False` no arq e o reaper leria `worker_lost`). `desserializar` lê JSON e, durante a transição, um
payload ainda em pickle (o marcador de protocolo `0x80`) por um unpickler sem globais: recusa
qualquer objeto que precise importar uma classe ou função (o caminho de execução de código do
pickle). A troca é em duas fases (expandir/contrair): primeiro todo leitor ganha `desserializar`,
depois os produtores passam a `serializar`. Contrato em docs/standards/api/jobs-transcricao.md.
"""

from __future__ import annotations

import io
import json
import pickle
from typing import Any

_PICKLE = 0x80


class _SemGlobais(pickle.Unpickler):
    """Unpickler que só monta tipos primitivos (dict, list, str, números, bytes, None, bool)."""

    def find_class(self, module: str, name: str) -> Any:  # noqa: ANN401 — assinatura do Unpickler
        """Recusa toda classe ou função global."""
        msg = f"global recusado no payload da fila: {module}.{name}"
        raise pickle.UnpicklingError(msg)


def serializar(obj: dict[str, Any]) -> bytes:
    """O job ou resultado do arq em JSON UTF-8; o que não é JSON vira texto."""
    return json.dumps(obj, default=str, ensure_ascii=False, separators=(",", ":")).encode()


def desserializar(data: bytes) -> dict[str, Any]:
    """Lê o JSON de `serializar` ou, na transição, o pickle antigo sem globais."""
    if data[:1] == bytes([_PICKLE]):
        return _SemGlobais(io.BytesIO(data)).load()
    return json.loads(data)
