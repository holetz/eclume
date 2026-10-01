"""Descritor público do servidor: nome, endereços, impressões digitais da CA raiz (e da próxima) e versões."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import TYPE_CHECKING, Any

from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding

from eclume_server import __version__
from eclume_server.routes.auth import CONTRACT_VERSION

if TYPE_CHECKING:
    from eclume_server.config import Settings

# Impressão digital por arquivo, válida enquanto o `mtime` não muda: no primeiro deploy a CA é
# publicada depois de o server subir, e o descritor passa a trazê-la sem restart.
_fingerprints: dict[Path, tuple[int, str | None]] = {}


def ca_sha256(ca_file: str | None) -> str | None:
    """SHA-256 (hex minúsculo) do DER do primeiro certificado do PEM; `None` sem arquivo válido."""
    if not ca_file:
        return None
    path = Path(ca_file)
    try:
        mtime = path.stat().st_mtime_ns
    except FileNotFoundError:
        return None
    cached = _fingerprints.get(path)
    if cached is not None and cached[0] == mtime:
        return cached[1]
    try:
        der = x509.load_pem_x509_certificate(path.read_bytes()).public_bytes(Encoding.DER)
        fingerprint: str | None = hashlib.sha256(der).hexdigest()
    except ValueError:
        fingerprint = None
    _fingerprints[path] = (mtime, fingerprint)
    return fingerprint


def server_info(settings: Settings, base_url: str) -> dict[str, Any]:
    """Schema `ServerInfo`; `base_url` vale quando `ECLUME_PUBLIC_URL` não está definida."""
    url = (settings.public_url or base_url).rstrip("/")
    return {
        "name": settings.server_name,
        "url": url,
        "mcp_url": f"{url}/mcp",
        "ca_sha256": ca_sha256(settings.ca_file),
        "ca_next_sha256": ca_sha256(settings.ca_next_file),
        "version": __version__,
        "contract_version": CONTRACT_VERSION,
    }
