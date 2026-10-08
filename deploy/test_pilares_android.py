# ruff: noqa: INP001, S101, S603, S607, D103  # testes soltos dos scripts de deploy; deploy/ não é pacote Python
"""Limpeza e guarda do `build/` do registro do cargo no `pilar_android`: seguras com nomes arbitrários."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

PILARES = Path(__file__).with_name("pilares.sh")
FUNCOES = ("tauri_android_builds", "tauri_android_limpar_builds", "tauri_android_invasores")


def funcao(nome: str) -> str:
    texto = PILARES.read_text(encoding="utf-8")
    achado = re.search(rf"^{nome}\(\) \{{\n.*?^\}}\n", texto, re.DOTALL | re.MULTILINE)
    assert achado, nome
    return achado.group(0)


def bash(cargo_home: Path, corpo: str) -> subprocess.CompletedProcess[bytes]:
    roteiro = "set -euo pipefail\n" + "".join(funcao(n) for n in FUNCOES) + corpo
    return subprocess.run(
        ["bash", "-c", roteiro],
        env={"CARGO_HOME": str(cargo_home), "PATH": "/usr/bin:/bin"},
        capture_output=True,
        check=False,
    )


def registro(raiz: Path) -> Path:
    """Um registro falso com o crate verdadeiro e um irmão cujo nome tem LF, ambos com `build/`."""
    idx = raiz / "registry" / "src" / "idx"
    (idx / "tauri-2.12.1" / "mobile" / "android" / "src").mkdir(parents=True)
    (idx / "tauri-2.12.1" / "mobile" / "android" / "src" / "Fonte.kt").write_text("fonte", encoding="utf-8")
    (idx / "tauri-2.12.1\nx" / "mobile" / "android" / "build").mkdir(parents=True)
    (idx / "tauri-2.9.0" / "mobile" / "android" / "build").mkdir(parents=True)
    return idx


def test_limpeza_com_nome_com_lf_so_apaga_o_alvo(tmp_path: Path) -> None:
    idx = registro(tmp_path)
    r = bash(tmp_path, "tauri_android_limpar_builds\n")
    assert r.returncode == 0, r.stderr
    assert (idx / "tauri-2.12.1" / "mobile" / "android" / "src" / "Fonte.kt").is_file()
    assert not (idx / "tauri-2.12.1\nx" / "mobile" / "android" / "build").exists()
    assert not (idx / "tauri-2.9.0" / "mobile" / "android" / "build").exists()
    assert (idx / "tauri-2.9.0" / "mobile" / "android").is_dir()


def test_guarda_acusa_invasor_e_passa_sem_ele(tmp_path: Path) -> None:
    registro(tmp_path)
    assert bash(tmp_path, "tauri_android_invasores\n").returncode == 1
    assert bash(tmp_path, "tauri_android_limpar_builds\ntauri_android_invasores\n").returncode == 0


@pytest.mark.skipif(os.geteuid() == 0, reason="o root atravessa e lista qualquer diretório")
def test_limpeza_e_guarda_falham_quando_o_find_nao_le_o_registro(tmp_path: Path) -> None:
    idx = registro(tmp_path)
    idx.chmod(0o300)
    try:
        assert bash(tmp_path, "tauri_android_limpar_builds\n").returncode != 0
        assert bash(tmp_path, "tauri_android_invasores\n").returncode != 0
    finally:
        idx.chmod(0o700)
