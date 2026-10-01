# ruff: noqa: INP001, S101, S603, S607, D102, D103, D107, PLR2004  # testes soltos dos scripts de deploy; deploy/ não é pacote Python
"""Testes do `backup.sh` e do `restaurar-backup.sh` com um `docker` falso no PATH.

O `docker` falso registra cada chamada em `chamadas.jsonl`, responde ao `ps`, `inspect` e `exec`
do projeto `eclume` e faz de restic: `backup` e `copy` só registram, `restore` grava na pasta
montada como alvo um snapshot com o leiaute de /eclume, e `sh -c` (a conferência do sha256) imprime
uma linha por arquivo. `FAKE_FALHA=<subcomando>` faz o restic falhar nesse subcomando.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

DEPLOY = Path(__file__).parent

FAKE_DOCKER = r"""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

args = sys.argv[1:]
base = Path(os.environ["FAKE_DIR"])
with open(base / "chamadas.jsonl", "a") as f:
    f.write(json.dumps(args) + "\n")
running = os.environ.get("FAKE_RUNNING", "postgres minio caddy server worker-cpu worker-agents worker-gpu").split()
cmd = args[0] if args else ""
if cmd == "ps":
    filtros = [args[i + 1] for i, a in enumerate(args) if a == "--filter"]
    servico = next((x.rsplit("=", 1)[1] for x in filtros if "compose.service=" in x), "")
    projeto = next((x.rsplit("=", 1)[1] for x in filtros if "compose.project=" in x), "")
    if projeto == "eclume" and servico in running:
        print(f"cid-{servico}")
elif cmd == "inspect":
    print("eclume_fila-gpu\neclume_dados" if "Networks" in " ".join(args) else "minio-img")
elif cmd == "exec":
    if "pg_dumpall" in args:
        print("CREATE ROLE eclume_app;")
    elif "pg_dump" in args:
        print("DUMP")
    elif "psql" in args:
        sys.stdin.read()
        print("recordings=1 summaries=0 transcripts=1 users=1")
    elif "pg_restore" in args:
        sys.stdin.read()
elif cmd == "run":
    mounts = {}
    i = 1
    while i < len(args):
        if args[i] in ("-v", "--volume"):
            src, dst = args[i + 1].split(":")[:2]
            mounts[dst] = Path(src)
            i += 2
        elif args[i] in ("-e", "--env-file", "--network", "--user", "--entrypoint", "-w"):
            i += 2
        elif args[i].startswith("-"):
            i += 1
        else:
            break
    image, rest = args[i], args[i + 1:]
    if image == "minio-img":
        if "mirror" in rest and "/b/.espelho" in rest:
            (mounts["/b"] / ".espelho" / "rec").mkdir(parents=True, exist_ok=True)
            (mounts["/b"] / ".espelho" / "rec" / "audio.ogg").write_text("audio")
        elif "ls" in rest:
            print("[x] 5B audio.ogg")
        sys.exit(0)
    sub = rest[0] if rest else ""
    if sub == os.environ.get("FAKE_FALHA"):
        print(f"restic {sub}: falhou", file=sys.stderr)
        sys.exit(1)
    if sub == "-c":
        print("e3b0  secrets/env.prod\ne3b1  caddy/data/caddy/pki/authorities/local/root.key")
    elif sub == "snapshots":
        print(json.dumps([{"short_id": "aaaa1111", "time": "2026-09-30T03:30:00Z"},
                          {"short_id": "bbbb2222", "time": "2026-10-01T03:30:00Z"}]))
    elif "restore" in " ".join(rest):
        out = mounts["/out"]
        for rel, txt in {"eclume/pg/roles.sql": "R", "eclume/pg/eclume.dump": "D",
                         "eclume/minio/rec/audio.ogg": "audio",
                         "eclume/secrets/env.prod": "ECLUME_ENCRYPTION_KEY=k\n",
                         "eclume/caddy/data/caddy/pki/authorities/local/root.key": "K"}.items():
            p = out / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(txt)
"""


class Host:
    """Um ECLUME_DATA_DIR temporário com o `docker` falso no PATH."""

    def __init__(self, tmp_path: Path) -> None:
        self.data = tmp_path / "srv"
        self.secrets = self.data / "secrets"
        self.secrets.mkdir(parents=True)
        (self.secrets / "env.prod").write_text("ECLUME_MINIO_USER=u\nECLUME_MINIO_PASSWORD=p\n")
        (self.secrets / "restic-password").write_text("senha\n")
        (self.data / "backups" / "restic").mkdir(parents=True)
        (self.data / "backups" / "restic" / "config").write_text("x")
        (self.data / "caddy" / "data" / "caddy" / "pki").mkdir(parents=True)
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        docker = self.bin / "docker"
        docker.write_text(FAKE_DOCKER)
        docker.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "ECLUME_DATA_DIR": str(self.data),
            "FAKE_DIR": str(self.bin),
        }

    def rodar(self, script: str, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(DEPLOY / script), *args], env={**self.env, **env}, capture_output=True, text=True, check=False
        )

    def chamadas(self) -> list[list[str]]:
        log = self.bin / "chamadas.jsonl"
        return [json.loads(x) for x in log.read_text().splitlines()] if log.exists() else []

    def restic(self, sub: str) -> list[list[str]]:
        return [c for c in self.chamadas() if c[0] == "run" and sub in c and "minio-img" not in c]

    def estado(self, etapa: str) -> dict:
        return json.loads((self.data / "estado" / f"{etapa}.json").read_text())


@pytest.fixture
def host(tmp_path: Path) -> Host:
    return Host(tmp_path)


def montagens(chamada: list[str]) -> list[str]:
    return [chamada[i + 1] for i, a in enumerate(chamada) if a == "-v"]


def test_backup_snapshot_cifrado_sem_nada_em_claro(host: Host) -> None:
    legado = host.data / "backups"
    for velho in ("pg/eclume-2026-09-29.dump", "caddy/caddy-pki-2026-09-29.tgz", "minio/2026-09-29/x"):
        (legado / velho).parent.mkdir(parents=True, exist_ok=True)
        (legado / velho).write_text("velho")

    r = host.rodar("backup.sh")

    assert r.returncode == 0, r.stderr + r.stdout
    (backup,) = host.restic("backup")
    assert backup[backup.index("--host") + 1] == "eclume"
    assert "/eclume/secrets/restic-*" in backup
    fontes = montagens(backup)
    for destino in (
        "/eclume/pg:ro",
        "/eclume/pre-deploy:ro",
        "/eclume/minio:ro",
        "/eclume/secrets:ro",
        "/eclume/caddy/data/caddy/pki:ro",
    ):
        assert any(m.endswith(destino) for m in fontes), destino
    (forget,) = host.restic("forget")
    assert forget[forget.index("--keep-daily") + 1] == "7"
    assert "--prune" in forget
    # Nada em claro depois do snapshot: nem a pasta da rodada, nem o leiaute antigo.
    restos = sorted(p.name for p in legado.iterdir())
    assert restos == [".restic-cache", "minio", "pre-deploy", "restic"]
    assert [p.name for p in (legado / "minio").iterdir()] == [".espelho"]
    estado = host.estado("backup")
    assert estado["ok"] is True
    assert {"ok", "at", "detalhe"} <= estado.keys()
    assert '"ok": true' in (host.data / "estado" / "backup.json").read_text()
    assert "secrets/env.prod" in (host.data / "estado" / "secrets.sha256").read_text()


def test_backup_sem_destino_fora_registra_falha_da_copia(host: Host) -> None:
    r = host.rodar("backup.sh")

    assert r.returncode == 0
    assert host.restic("copy") == []
    assert host.estado("fora")["ok"] is False
    assert "restic-fora.env" in host.estado("fora")["detalhe"]


def test_backup_copia_para_fora_com_a_mesma_retencao(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text("RESTIC_REPOSITORY=s3:https://b2.example/eclume\n")

    r = host.rodar("backup.sh")

    assert r.returncode == 0, r.stderr
    (copia,) = host.restic("copy")
    assert copia[copia.index("--env-file") + 1].endswith("secrets/restic-fora.env")
    assert copia[copia.index("--from-repo") + 1] == "/repo"
    assert len(host.restic("forget")) == 2
    assert host.estado("fora")["ok"] is True


def test_backup_falha_do_restic_deixa_ok_false(host: Host) -> None:
    r = host.rodar("backup.sh", FAKE_FALHA="backup")

    assert r.returncode != 0
    assert host.estado("backup")["ok"] is False
    assert not list((host.data / "backups").glob(".rodada.*"))


def test_backup_sem_postgres_falha_com_motivo(host: Host) -> None:
    r = host.rodar("backup.sh", FAKE_RUNNING="minio")

    assert r.returncode != 0
    assert "postgres" in host.estado("backup")["detalhe"]


def test_backup_sem_repositorio_inicializado_falha(host: Host) -> None:
    (host.data / "backups" / "restic" / "config").unlink()

    r = host.rodar("backup.sh")

    assert r.returncode != 0
    assert "deploy.sh" in host.estado("backup")["detalhe"]
