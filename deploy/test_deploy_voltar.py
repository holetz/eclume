# ruff: noqa: INP001, S101, S603, PLR2004, D101, D102  # testes soltos dos scripts de deploy; roda bash e git de verdade
"""O `deploy.sh --voltar` executado de verdade, com `docker`, `ssh` e `gh` trocados por stubs no PATH.

`deploy_lib.py voltar` já tem teste de unidade; aqui é o shell que o chama (flag, desvio do gate,
plano e recusa) que roda, num repositório descartável. Afirma códigos de saída e marcas estáveis da
saída, nunca o texto dos comandos do script.
"""

from __future__ import annotations

import json
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
    reason="deploy.sh exige bash POSIX; o pilar windows não o exercita (aviso explícito, não silêncio)",
)

IMAGENS = ("server", "web", "worker-gpu")
# O `compose config --format json` de um compose anterior ao #151, no mínimo que a topologia lê.
COMPOSE = {
    "services": {
        "caddy": {"image": "caddy:2"},
        "postgres": {"image": "pgvector/pgvector:pg16"},
        "redis": {"image": "redis:7-alpine"},
        "server": {"image": "eclume-server:prod", "build": {"context": "."}},
        "web": {"image": "eclume-web:prod", "build": {"context": "."}},
        "worker-gpu": {"image": "eclume-worker-gpu:prod", "build": {"context": "."}},
    }
}
ENV_PROD = "\n".join(
    [
        "ECLUME_DATA_DIR=/srv/eclume",
        "ECLUME_PUBLIC_URL=https://exemplo.test",
        "ECLUME_CLAUDE_CLI=1",
        *(
            f"{chave}=x"
            for chave in (
                "ECLUME_RUNTIME_PG_PASSWORD",
                "ECLUME_MINIO_SERVER_PASSWORD",
                "ECLUME_MINIO_GPU_PASSWORD",
                "ECLUME_REDIS_SERVER_PASSWORD",
                "ECLUME_REDIS_GPU_PASSWORD",
            )
        ),
    ]
)

DOCKER = """#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/docker.calls"
case "$1 $2" in
  "context inspect") echo "ssh://teste@host" ;;
  "compose version") echo "2.30.0" ;;
  "image inspect") grep -qxF "${3#eclume-}" "$STUB_DIR/imagens" || exit 1 ;;
  "ps -q") echo cid ;;
  "exec cid")
    if [[ "$*" == *psql* ]]; then cat "$STUB_DIR/banco"; else echo 0; fi ;;
  *) [[ "$*" == *"config --format json"* ]] && cat "$STUB_DIR/compose.json" ;;
esac
exit 0
"""
SSH = """#!/usr/bin/env bash
cmd="${*: -1}"
case "$cmd" in
  "cat '"*deploys.log*) cat "$STUB_DIR/deploys.log" ;;
  "test -s"*) exit 1 ;;
  "df "*) echo 42 ;;
esac
exit 0
"""
GH = """#!/usr/bin/env bash
echo "gh $*" >> "$STUB_DIR/gh.calls"
exit 1
"""


@dataclass
class Caso:
    repo: Path
    stubs: Path
    retido: str
    env: dict[str, str]

    def rodar(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(BASH), "deploy/deploy.sh", "--context", "teste", *args],
            cwd=self.repo,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )

    def docker(self) -> list[str]:
        arquivo = self.stubs / "docker.calls"
        return arquivo.read_text(encoding="utf-8").splitlines() if arquivo.exists() else []

    def escreveu(self) -> bool:
        """Alguma chamada do docker que constrói ou sobe (`build`, `compose ... up`)."""
        return any(
            c.split()[:1] == ["build"] or " build" in c or c.endswith((" up", " up -d")) or " up " in c
            for c in self.docker()
        )

    def gate_consultado(self) -> bool:
        return (self.stubs / "gh.calls").exists()


def _git(repo: Path, *args: str) -> str:
    cmd = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", *args]
    return subprocess.run(cmd, cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


def _caso(tmp_path: Path, *, banco: str, imagens_retidas: bool, deploys: int = 2) -> Caso:
    repo = tmp_path / "repo"
    stubs = tmp_path / "stubs"
    migracoes = repo / "server/src/eclume_server/db/migrations"
    (repo / "deploy").mkdir(parents=True)
    migracoes.mkdir(parents=True)
    stubs.mkdir()
    for nome in ("deploy.sh", "deploy_lib.py", "gpu-lib.sh"):
        shutil.copy(DEPLOY / nome, repo / "deploy" / nome)
    (repo / "deploy/docker-compose.prod.yml").write_text("services: {}\n", encoding="utf-8")
    (repo / "deploy/.env.prod").write_text(ENV_PROD + "\n", encoding="utf-8")
    (migracoes / "001_base.sql").write_text("select 1;\n", encoding="utf-8")
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", "-A", "-f")
    _git(repo, "commit", "-q", "-m", "retido")
    retido = _git(repo, "rev-parse", "HEAD")
    (migracoes / "002_nova.sql").write_text("select 2;\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "atual")
    atual = _git(repo, "rev-parse", "HEAD")

    # O log: o retido, (deploys - 2) deploys intermediários e o atual por último.
    intermediarios = ["c" * 40] * (deploys - 2)
    shas = [retido, *intermediarios, atual]
    linhas = [f"2026-10-0{i + 1}T12:00:00Z\t{sha}\t-\t-\t-\t-" for i, sha in enumerate(shas)]
    (stubs / "deploys.log").write_text("\n".join(linhas) + "\n", encoding="utf-8")
    (stubs / "banco").write_text(banco, encoding="utf-8")
    (stubs / "compose.json").write_text(json.dumps(COMPOSE), encoding="utf-8")
    (stubs / "imagens").write_text(
        "".join(f"{i}:{retido}\n" for i in IMAGENS) if imagens_retidas else "", encoding="utf-8"
    )
    for nome, corpo in (("docker", DOCKER), ("ssh", SSH), ("gh", GH)):
        (stubs / nome).write_text(corpo, encoding="utf-8")
        (stubs / nome).chmod(0o755)
    env = {
        "PATH": f"{stubs}:/usr/bin:/bin",
        "HOME": str(tmp_path),
        "STUB_DIR": str(stubs),
    }
    return Caso(repo=repo, stubs=stubs, retido=retido, env=env)


def test_plan_voltar_um_passo_atras_nao_consulta_o_gate_nem_escreve(tmp_path: Path) -> None:
    """Caso feliz: sai 0, imprime o plano do retorno e não constrói nem sobe nada."""
    caso = _caso(tmp_path, banco="001_base\n002_nova\n", imagens_retidas=True)
    resultado = caso.rodar("--plan", "--voltar", caso.retido)
    assert resultado.returncode == 0, resultado.stderr
    assert "Voltar:" in resultado.stderr
    assert "um passo atrás" in resultado.stderr
    assert "--voltar recusado" not in resultado.stderr
    assert "falta a imagem retida" not in resultado.stderr
    assert "gate: não se aplica" in resultado.stderr
    assert "Construir: nada" in resultado.stderr
    assert not caso.gate_consultado()
    assert caso.docker(), "os stubs do docker não foram chamados"
    assert not caso.escreveu()


def test_voltar_dois_passos_com_migration_desconhecida_recusa(tmp_path: Path) -> None:
    """O banco tem a 002, que o alvo não conhece, e o alvo está dois deploys atrás: sai 2."""
    caso = _caso(tmp_path, banco="001_base\n002_nova\n", imagens_retidas=True, deploys=3)
    resultado = caso.rodar("--voltar", caso.retido)
    assert resultado.returncode == 2, resultado.stderr
    assert "--voltar recusado" in resultado.stderr
    assert "mais de um passo atrás" in resultado.stderr
    assert not caso.gate_consultado()
    assert not caso.escreveu()


def test_voltar_sem_a_imagem_retida_recusa(tmp_path: Path) -> None:
    """Sem o trio `eclume-<imagem>:<sha>` no host, o retorno sai 2 antes de escrever."""
    caso = _caso(tmp_path, banco="001_base\n", imagens_retidas=False)
    resultado = caso.rodar("--voltar", caso.retido)
    assert resultado.returncode == 2, resultado.stderr
    assert "falta a imagem retida" in resultado.stderr
    assert not caso.escreveu()
