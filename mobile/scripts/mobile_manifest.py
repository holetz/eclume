# ruff: noqa: INP001  # loose script, run by the release workflow; mobile/ is not a Python package
"""Assemble the `movel.json` and the `SHA256SUMS` of an eclume mobile app release.

Reads the release folder (the signed APK and `INSTALACAO.md`) and writes into it:

- `movel.json` — the manifest that the web's `/app-movel` screen (holetz/eclume#38) and the app
  itself consume: `versao`, `publicado_em`, `notas`, `apk {arquivo, url, tamanho, sha256}`,
  `min_android`, `certificado_sha256` and `instalacao` (the wire keys keep their names);
- `SHA256SUMS` — the hash of every file in the folder, checked on publishing to the host.

The URLs are absolute paths on the server (`/downloads/movel/<version>/<file>`), where
`deploy/publish-mobile.sh` puts the files: they serve any address of the server, and the app
resolves them against the paired server.

Usage:
    python3 mobile/scripts/mobile_manifest.py --dir dist --version 0.1.0 \
        --certificate <sha256 of the signing certificate> [--notes "text"]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

MANIFEST = "movel.json"
SUMS = "SHA256SUMS"
INSTALLATION = "INSTALACAO.md"
BASE = "/downloads/movel"
MIN_ANDROID = "8.0"
VERSION = re.compile(r"^\d+\.\d+\.\d+$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def sha256(path: Path) -> str:
    """SHA-256 of the file, in lowercase hex, read in blocks."""
    h = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def normalize_certificate(text: str) -> str:
    """The certificate's SHA-256 as `apksigner` prints it (with or without `:`), in lowercase hex."""
    value = text.strip().replace(":", "").lower()
    if not SHA256.match(value):
        msg = f"invalid certificate: {text!r} (expected the SHA-256 in 64 hex digits)"
        raise ValueError(msg)
    return value


def build(folder: Path, version: str, certificate: str, notes: str, now: datetime) -> dict:
    """The folder's manifest: exactly one APK, named `eclume-<version>.apk`."""
    if not VERSION.match(version):
        msg = f"invalid version: {version!r}"
        raise ValueError(msg)
    apks = sorted(folder.glob("*.apk"))
    if len(apks) != 1:
        msg = f"expected one APK in {folder}, found {len(apks)}"
        raise ValueError(msg)
    apk = apks[0]
    expected = f"eclume-{version}.apk"
    if apk.name != expected:
        msg = f"the APK is named {apk.name}, expected {expected}"
        raise ValueError(msg)
    if not (folder / INSTALLATION).is_file():
        msg = f"{INSTALLATION} is missing from {folder}"
        raise ValueError(msg)
    return {
        "versao": version,
        "publicado_em": now.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "notas": notes,
        "apk": {
            "arquivo": apk.name,
            "url": f"{BASE}/{version}/{apk.name}",
            "tamanho": apk.stat().st_size,
            "sha256": sha256(apk),
        },
        "min_android": MIN_ANDROID,
        "certificado_sha256": normalize_certificate(certificate),
        "instalacao": f"{BASE}/{INSTALLATION}",
    }


def write(folder: Path, manifest: dict) -> None:
    """Write the `movel.json` and the `SHA256SUMS` of every file in the folder."""
    (folder / MANIFEST).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [f"{sha256(f)}  {f.name}" for f in sorted(folder.iterdir()) if f.is_file() and f.name != SUMS]
    (folder / SUMS).write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    """Build and write the manifests; return the exit code."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dir", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--certificate", required=True)
    parser.add_argument("--notes", default="")
    args = parser.parse_args(argv)
    try:
        manifest = build(args.dir, args.version, args.certificate, args.notes, datetime.now(UTC))
    except ValueError as error:
        sys.stderr.write(f"{error}\n")
        return 1
    write(args.dir, manifest)
    sys.stdout.write(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
