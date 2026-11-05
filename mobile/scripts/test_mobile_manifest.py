# ruff: noqa: INP001, S101  # loose tests of the release script; mobile/ is not a Python package
"""Tests of `mobile_manifest.py`: the `movel.json` contract with #38 and with the installed app."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("mobile_manifest", Path(__file__).with_name("mobile_manifest.py"))
assert _spec is not None
assert _spec.loader is not None
mobile_manifest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mobile_manifest)

CERT = "AB:CD:" + ":".join(["0F"] * 30)
NOW = datetime(2026, 9, 27, 18, 30, 5, 123000, tzinfo=UTC)


def release(folder: Path, apk: str = "eclume-0.1.0.apk") -> Path:
    """A release folder with the APK and INSTALACAO.md."""
    folder.mkdir(exist_ok=True)
    (folder / apk).write_bytes(b"PK\x03\x04 test apk")
    (folder / "INSTALACAO.md").write_text("# Install\n", encoding="utf-8")
    return folder


def test_manifest_follows_the_contract(tmp_path: Path) -> None:
    """The `movel.json` has the fields that #38 and the app read."""
    folder = release(tmp_path / "dist")
    assert (
        mobile_manifest.main(
            ["--dir", str(folder), "--version", "0.1.0", "--certificate", CERT, "--notes", "First version"]
        )
        == 0
    )

    manifest = json.loads((folder / "movel.json").read_text(encoding="utf-8"))
    content = b"PK\x03\x04 test apk"
    assert manifest["versao"] == "0.1.0"
    assert manifest["notas"] == "First version"
    assert manifest["apk"] == {
        "arquivo": "eclume-0.1.0.apk",
        "url": "/downloads/movel/0.1.0/eclume-0.1.0.apk",
        "tamanho": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
    }
    assert manifest["min_android"] == "8.0"
    assert manifest["certificado_sha256"] == "abcd" + "0f" * 30
    assert manifest["instalacao"] == "/downloads/movel/INSTALACAO.md"
    assert manifest["publicado_em"].endswith("Z")


def test_sha256sums_covers_every_file(tmp_path: Path) -> None:
    """The `SHA256SUMS` checks each published file, the manifest itself included."""
    folder = release(tmp_path / "dist")
    manifest = mobile_manifest.build(folder, "0.1.0", CERT, "", NOW)
    mobile_manifest.write(folder, manifest)
    assert manifest["publicado_em"] == "2026-09-27T18:30:05Z"
    lines = (folder / "SHA256SUMS").read_text(encoding="utf-8").splitlines()
    names = sorted(line.split("  ", 1)[1] for line in lines)
    assert names == ["INSTALACAO.md", "eclume-0.1.0.apk", "movel.json"]
    for line in lines:
        digest, name = line.split("  ", 1)
        assert digest == hashlib.sha256((folder / name).read_bytes()).hexdigest()


@pytest.mark.parametrize(
    ("apk", "version", "certificate", "reason"),
    [
        ("eclume-0.1.0.apk", "0.1", CERT, "invalid version"),
        ("eclume-0.2.0.apk", "0.1.0", CERT, "expected eclume-0.1.0.apk"),
        ("eclume-0.1.0.apk", "0.1.0", "xyz", "invalid certificate"),
    ],
)
def test_invalid_release_is_refused(tmp_path: Path, apk: str, version: str, certificate: str, reason: str) -> None:
    """A version, APK name or certificate outside the contract stops the release."""
    folder = release(tmp_path / "dist", apk)
    with pytest.raises(ValueError, match=reason):
        mobile_manifest.build(folder, version, certificate, "", NOW)


def test_no_apk_or_two_is_refused(tmp_path: Path) -> None:
    """Exactly one APK per release."""
    folder = release(tmp_path / "dist")
    (folder / "eclume-0.1.0-other.apk").write_bytes(b"x")
    with pytest.raises(ValueError, match="found 2"):
        mobile_manifest.build(folder, "0.1.0", CERT, "", NOW)
    empty = tmp_path / "empty"
    empty.mkdir()
    assert mobile_manifest.main(["--dir", str(empty), "--version", "0.1.0", "--certificate", CERT]) == 1
