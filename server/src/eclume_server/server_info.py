"""Public server descriptor: name, addresses, root CA fingerprints (and the next one's) and versions."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import TYPE_CHECKING, Any

from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding

from eclume_server import __version__
from eclume_server.contract import CONTRACT_VERSION

if TYPE_CHECKING:
    from eclume_server.config import Settings

# Fingerprint per file, valid while the `mtime` does not change: on the first deploy the CA is
# published after the server starts, and the descriptor starts carrying it without a restart.
_fingerprints: dict[Path, tuple[int, str | None]] = {}


def ca_sha256(ca_file: str | None) -> str | None:
    """SHA-256 (lowercase hex) of the DER of the PEM's first certificate; `None` without a valid file."""
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
    """Schema `ServerInfo`; `base_url` applies when `ECLUME_PUBLIC_URL` is not set."""
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
