"""Resolution of the Hugging Face token, required by pyannote's gated models."""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping

DEFAULT_TOKEN_FILE = "/run/secrets/hf_token"  # noqa: S105 — file path, not the secret


def resolve_hf_token(env: Mapping[str, str] | None = None) -> str | None:
    """Return the token from `HF_TOKEN` or from the `ECLUME_HF_TOKEN_FILE` file, or `None` without a token.

    The default file is `/run/secrets/hf_token`, mounted from `/srv/eclume/secrets/hf_token` on the host.
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
