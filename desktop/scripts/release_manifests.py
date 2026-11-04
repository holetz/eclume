# ruff: noqa: INP001  # standalone script, run by the release workflow; desktop/ is not a Python package
"""Builds the manifests of an eclume desktop app release.

Reads the folder with the artifacts the `desktop-release.yml` matrix produced (installers, updater
packages and their `.sig` signatures) and writes into it:

- `latest.json` — the Tauri updater manifest, with absolute URLs under the public base
  (the eclume server, because the GitHub assets are private);
- `instaladores.json` — the list the download page reads;
- `SHA256SUMS` — the hash of every file in the folder, verified on publication on the host.

The URLs are `<base>/<version>/<file>`, which is where `deploy/publish-desktop.sh` puts them.
`instaladores.json` and its pt-BR keys are a published format the web download page
(`web/src/features/desktop/installers.ts`) and the installed apps' download links read: they stay.

Usage:
    python3 desktop/scripts/release_manifests.py --artifacts <folder> --version 0.1.0 \
        --base-url https://<server>:8443/downloads [--notes "text"]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

SUMS = "SHA256SUMS"
LATEST = "latest.json"
INSTALLERS = "instaladores.json"
MACOS_ARCHES = ("aarch64", "x86_64")


@dataclass(frozen=True)
class Kind:
    """An artifact kind recognized by the file name suffix."""

    platform: str  # windows | linux | macos
    kind: str  # nsis | msi | appimage | deb | dmg | app
    suffix: re.Pattern[str]
    installer: bool  # shown on the download page
    recommended: bool  # the platform's default installer
    updater_default: bool  # also serves the `<os>-<arch>` key with no installer


KINDS = (
    Kind("windows", "nsis", re.compile(r"-setup\.exe$"), installer=True, recommended=True, updater_default=True),
    Kind("windows", "msi", re.compile(r"\.msi$"), installer=True, recommended=False, updater_default=False),
    Kind("linux", "appimage", re.compile(r"\.AppImage$"), installer=True, recommended=True, updater_default=True),
    Kind("linux", "deb", re.compile(r"\.deb$"), installer=True, recommended=False, updater_default=False),
    Kind("macos", "dmg", re.compile(r"\.dmg$"), installer=True, recommended=True, updater_default=False),
    Kind("macos", "app", re.compile(r"\.app\.tar\.gz$"), installer=False, recommended=False, updater_default=True),
)


def architecture(name: str) -> str:
    """The architecture, from the name the Tauri CLI gives the file."""
    if "universal" in name:
        return "universal"
    if re.search(r"aarch64|arm64", name):
        return "aarch64"
    if re.search(r"x64|x86_64|amd64", name):
        return "x86_64"
    msg = f"unrecognized architecture in {name}"
    raise ValueError(msg)


def updater_os(platform: str) -> str:
    """The Tauri updater calls macOS `darwin`."""
    return "darwin" if platform == "macos" else platform


def updater_arches(arch: str) -> tuple[str, ...]:
    """A universal package serves both macOS architectures."""
    return MACOS_ARCHES if arch == "universal" else (arch,)


def sha256(path: Path) -> str:
    """SHA-256 hash of the file, in hexadecimal."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def build(folder: Path, version: str, base_url: str, notes: str) -> tuple[dict, dict]:
    """Returns `(latest, installers)` from the folder's artifacts."""
    base = f"{base_url.rstrip('/')}/{version}"
    now = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    platforms: dict[str, dict[str, str]] = {}
    installers: list[dict] = []
    for file in sorted(p for p in folder.iterdir() if p.is_file()):
        kind = next((k for k in KINDS if k.suffix.search(file.name)), None)
        if kind is None:
            continue
        arch = architecture(file.name)
        url = f"{base}/{file.name}"
        if kind.installer:
            installers.append(
                {
                    "plataforma": kind.platform,
                    "arquitetura": arch,
                    "tipo": kind.kind,
                    "arquivo": file.name,
                    "url": url,
                    "tamanho": file.stat().st_size,
                    "sha256": sha256(file),
                    "recomendado": kind.recommended,
                }
            )
        signature = file.with_name(file.name + ".sig")
        if not signature.is_file():
            continue
        entry = {"signature": signature.read_text().strip(), "url": url}
        for a in updater_arches(arch):
            key = f"{updater_os(kind.platform)}-{a}"
            platforms[f"{key}-{kind.kind}"] = entry
            if kind.updater_default:
                platforms[key] = entry
    latest = {"version": version, "notes": notes, "pub_date": now, "platforms": dict(sorted(platforms.items()))}
    listing = {
        "versao": version,
        "publicado_em": now,
        "notas": notes,
        "instalacao": f"{base_url.rstrip('/')}/INSTALACAO.md",
        "instaladores": installers,
    }
    return latest, listing


def write_sums(folder: Path) -> None:
    """Writes `SHA256SUMS` in the `sha256sum -c` format."""
    lines = [f"{sha256(p)}  {p.name}\n" for p in sorted(folder.iterdir()) if p.is_file() and p.name != SUMS]
    (folder / SUMS).write_text("".join(lines))


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--artifacts", type=Path, required=True, help="folder with the matrix artifacts")
    parser.add_argument("--version", required=True, help="release version, without the desktop-v prefix")
    parser.add_argument("--base-url", required=True, help="public URL of /downloads")
    parser.add_argument("--notes", default="", help="release notes")
    args = parser.parse_args(argv)

    latest, listing = build(args.artifacts, args.version, args.base_url, args.notes)
    missing = [
        c for c in ("windows-x86_64", "linux-x86_64", "darwin-aarch64", "darwin-x86_64") if c not in latest["platforms"]
    ]
    if missing:
        sys.stderr.write(f"warning: latest.json without {', '.join(missing)}\n")
    (args.artifacts / LATEST).write_text(json.dumps(latest, indent=2, ensure_ascii=False) + "\n")
    (args.artifacts / INSTALLERS).write_text(json.dumps(listing, indent=2, ensure_ascii=False) + "\n")
    write_sums(args.artifacts)
    sys.stdout.write(
        f"{LATEST}: {', '.join(latest['platforms'])}\n{INSTALLERS}: {len(listing['instaladores'])} installers\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
