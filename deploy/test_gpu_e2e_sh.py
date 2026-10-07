# ruff: noqa: INP001, S101, S603, PLR2004, D101, D102, D103  # testes soltos dos scripts de deploy; roda bash de verdade
"""O `deploy/gpu-e2e.sh` executado de verdade, com `docker` e `nvidia-smi` trocados por stubs no PATH.

Afirma só o que é estável: o `up`, o `down -v`, o que nunca é chamado (parar a produção) e o código
de saída; nunca o texto inteiro dos comandos do docker.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

DEPLOY = Path(__file__).parent
BASH = shutil.which("bash")
pytestmark = pytest.mark.skipif(
    BASH is None or sys.platform == "win32",
    reason="gpu-e2e.sh exige bash POSIX; o pilar windows não o exercita (aviso explícito, não silêncio)",
)

# `exec` responde o `busy` do Redis de produção; `run` é o pytest do contêiner eclume-gate.
DOCKER = """#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/docker.calls"
case "$1" in
  ps) echo cid ;;
  exec) cat "$STUB_DIR/busy" ;;
  run) exit "$(cat "$STUB_DIR/pytest.rc")" ;;
esac
exit 0
"""
NVIDIA_SMI = """#!/usr/bin/env bash
cat "$STUB_DIR/vram"
"""


@dataclass
class Caso:
    repo: Path
    stubs: Path
    env: dict[str, str]

    def rodar(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(BASH), "deploy/gpu-e2e.sh"],
            cwd=self.repo,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )

    def chamadas(self) -> list[str]:
        arquivo = self.stubs / "docker.calls"
        return arquivo.read_text(encoding="utf-8").splitlines() if arquivo.exists() else []

    def subiu(self) -> bool:
        return any(" up " in f" {c} " for c in self.chamadas() if c.startswith("compose"))

    def rodou_pytest(self) -> bool:
        return any(c.startswith("run ") for c in self.chamadas())

    def derrubou(self) -> list[str]:
        return [c for c in self.chamadas() if c.startswith("compose") and " down -v" in c]

    def parou_algo(self) -> bool:
        return any(c.split()[0] in {"stop", "kill", "rm", "restart"} or " stop" in c for c in self.chamadas())


def _caso(tmp_path: Path, *, busy: str = "0", vram: str = "6000", pytest_rc: int = 0) -> Caso:
    repo = tmp_path / "repo"
    stubs = tmp_path / "stubs"
    (repo / "deploy").mkdir(parents=True)
    stubs.mkdir()
    for nome in ("gpu-e2e.sh", "gpu-lib.sh"):
        shutil.copy(DEPLOY / nome, repo / "deploy" / nome)
    (stubs / "busy").write_text(busy + "\n", encoding="utf-8")
    (stubs / "vram").write_text(vram + "\n", encoding="utf-8")
    (stubs / "pytest.rc").write_text(str(pytest_rc), encoding="utf-8")
    for nome, corpo in (("docker", DOCKER), ("nvidia-smi", NVIDIA_SMI)):
        (stubs / nome).write_text(corpo, encoding="utf-8")
        (stubs / nome).chmod(0o755)
    env = {
        "PATH": f"{stubs}:/usr/bin:/bin",
        "HOME": str(tmp_path),
        "STUB_DIR": str(stubs),
        "ECLUME_GPU_E2E_ESPERA": "0",
        "ECLUME_GPU_E2E_INTERVALO": "0",
        "ECLUME_GATE_IMAGE": "eclume-gate:teste",
    }
    return Caso(repo=repo, stubs=stubs, env=env)


def test_gpu_livre_sobe_roda_e_derruba(tmp_path: Path) -> None:
    caso = _caso(tmp_path)
    resultado = caso.rodar()
    assert resultado.returncode == 0, resultado.stderr
    assert caso.subiu()
    assert caso.rodou_pytest()
    assert caso.derrubou(), "o down -v não rodou"
    assert " down -v" in caso.chamadas()[-1]


def test_teste_que_falha_ainda_derruba_e_propaga_o_codigo(tmp_path: Path) -> None:
    caso = _caso(tmp_path, pytest_rc=3)
    resultado = caso.rodar()
    assert resultado.returncode == 3, resultado.stderr
    assert caso.subiu()
    assert " down -v" in caso.chamadas()[-1]


def test_gpu_ocupada_alem_do_limite_sai_75_sem_subir_nem_parar(tmp_path: Path) -> None:
    caso = _caso(tmp_path, busy="1")
    resultado = caso.rodar()
    assert resultado.returncode == 75, resultado.stderr
    assert "inconclusivo" in resultado.stderr
    assert not caso.subiu()
    assert not caso.rodou_pytest()
    assert not caso.parou_algo()
    assert caso.derrubou(), "o down -v defensivo e o do trap rodam também aqui"


def test_vram_livre_abaixo_do_minimo_conta_como_ocupada(tmp_path: Path) -> None:
    caso = _caso(tmp_path, vram="2048")
    resultado = caso.rodar()
    assert resultado.returncode == 75, resultado.stderr
    assert "VRAM" in resultado.stderr
    assert not caso.subiu()
    assert not caso.parou_algo()


def test_gpu_que_libera_durante_a_espera_roda(tmp_path: Path) -> None:
    """Ocupada na primeira consulta e livre depois: espera e roda, em vez de sair 75."""
    caso = _caso(tmp_path, busy="1")
    docker = caso.stubs / "docker"
    docker.write_text(
        DOCKER.replace('exec) cat "$STUB_DIR/busy" ;;', 'exec) cat "$STUB_DIR/busy"; echo 0 > "$STUB_DIR/busy" ;;'),
        encoding="utf-8",
    )
    caso.env["ECLUME_GPU_E2E_ESPERA"] = "1"
    resultado = caso.rodar()
    assert resultado.returncode == 0, resultado.stderr
    assert "esperando" in resultado.stderr
    assert caso.subiu()
    assert caso.rodou_pytest()
