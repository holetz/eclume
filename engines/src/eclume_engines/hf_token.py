"""Resolução do token do Hugging Face, exigido pelos modelos gated do pyannote."""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping

DEFAULT_TOKEN_FILE = "/run/secrets/hf_token"  # noqa: S105 — caminho do arquivo, não o segredo


def resolve_hf_token(env: Mapping[str, str] | None = None) -> str | None:
    """Devolve o token de `HF_TOKEN` ou do arquivo `ECLUME_HF_TOKEN_FILE`, ou `None` sem token.

    O arquivo padrão é `/run/secrets/hf_token`, montado de `/srv/eclume/secrets/hf_token` no host.
    """
    env = os.environ if env is None else env
    token = (env.get("HF_TOKEN") or "").strip()
    if token:
        return token
    path = Path(env.get("ECLUME_HF_TOKEN_FILE") or DEFAULT_TOKEN_FILE)
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None
