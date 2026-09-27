# ruff: noqa: INP001, S101  # testes soltos do script de release; mobile/ não é pacote Python
"""Testes do `manifesto_movel.py`: o contrato do `movel.json` com a #38 e com o app instalado."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("manifesto_movel", Path(__file__).with_name("manifesto_movel.py"))
assert _spec is not None
assert _spec.loader is not None
manifesto_movel = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(manifesto_movel)

CERT = "AB:CD:" + ":".join(["0F"] * 30)
AGORA = datetime(2026, 9, 27, 18, 30, 5, 123000, tzinfo=UTC)


def release(pasta: Path, apk: str = "eclume-0.1.0.apk") -> Path:
    """Uma pasta de release com o APK e o INSTALACAO.md."""
    pasta.mkdir(exist_ok=True)
    (pasta / apk).write_bytes(b"PK\x03\x04 apk de teste")
    (pasta / "INSTALACAO.md").write_text("# Instalar\n", encoding="utf-8")
    return pasta


def test_manifesto_segue_o_contrato(tmp_path: Path) -> None:
    """O `movel.json` tem os campos que a #38 e o app leem."""
    pasta = release(tmp_path / "dist")
    assert (
        manifesto_movel.main(
            ["--pasta", str(pasta), "--versao", "0.1.0", "--certificado", CERT, "--notas", "Primeira versão"]
        )
        == 0
    )

    manifesto = json.loads((pasta / "movel.json").read_text(encoding="utf-8"))
    conteudo = b"PK\x03\x04 apk de teste"
    assert manifesto["versao"] == "0.1.0"
    assert manifesto["notas"] == "Primeira versão"
    assert manifesto["apk"] == {
        "arquivo": "eclume-0.1.0.apk",
        "url": "/downloads/movel/0.1.0/eclume-0.1.0.apk",
        "tamanho": len(conteudo),
        "sha256": hashlib.sha256(conteudo).hexdigest(),
    }
    assert manifesto["min_android"] == "8.0"
    assert manifesto["certificado_sha256"] == "abcd" + "0f" * 30
    assert manifesto["instalacao"] == "/downloads/movel/INSTALACAO.md"
    assert manifesto["publicado_em"].endswith("Z")


def test_sha256sums_cobre_todos_os_arquivos(tmp_path: Path) -> None:
    """O `SHA256SUMS` confere cada arquivo publicado, inclusive o próprio manifesto."""
    pasta = release(tmp_path / "dist")
    manifesto = manifesto_movel.montar(pasta, "0.1.0", CERT, "", AGORA)
    manifesto_movel.gravar(pasta, manifesto)
    assert manifesto["publicado_em"] == "2026-09-27T18:30:05Z"
    linhas = (pasta / "SHA256SUMS").read_text(encoding="utf-8").splitlines()
    nomes = sorted(linha.split("  ", 1)[1] for linha in linhas)
    assert nomes == ["INSTALACAO.md", "eclume-0.1.0.apk", "movel.json"]
    for linha in linhas:
        hexa, nome = linha.split("  ", 1)
        assert hexa == hashlib.sha256((pasta / nome).read_bytes()).hexdigest()


@pytest.mark.parametrize(
    ("apk", "versao", "certificado", "motivo"),
    [
        ("eclume-0.1.0.apk", "0.1", CERT, "versão inválida"),
        ("eclume-0.2.0.apk", "0.1.0", CERT, "esperado eclume-0.1.0.apk"),
        ("eclume-0.1.0.apk", "0.1.0", "xyz", "certificado inválido"),
    ],
)
def test_release_invalido_e_recusado(tmp_path: Path, apk: str, versao: str, certificado: str, motivo: str) -> None:
    """Versão, nome do APK ou certificado fora do contrato param o release."""
    pasta = release(tmp_path / "dist", apk)
    with pytest.raises(ValueError, match=motivo):
        manifesto_movel.montar(pasta, versao, certificado, "", AGORA)


def test_sem_apk_ou_com_dois_e_recusado(tmp_path: Path) -> None:
    """Exatamente um APK por release."""
    pasta = release(tmp_path / "dist")
    (pasta / "eclume-0.1.0-outro.apk").write_bytes(b"x")
    with pytest.raises(ValueError, match="achei 2"):
        manifesto_movel.montar(pasta, "0.1.0", CERT, "", AGORA)
    vazia = tmp_path / "vazia"
    vazia.mkdir()
    assert manifesto_movel.main(["--pasta", str(vazia), "--versao", "0.1.0", "--certificado", CERT]) == 1
