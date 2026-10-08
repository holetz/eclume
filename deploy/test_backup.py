# ruff: noqa: INP001, S101, S603, S607, D102, D103, D107, PLR2004  # testes soltos dos scripts de deploy; deploy/ não é pacote Python
"""Testes do `backup.sh` e do `restaurar-backup.sh` com um `docker` falso no PATH.

O `docker` falso registra cada chamada em `chamadas.jsonl`, responde ao `ps`, `inspect` e `exec`
do projeto `eclume` e faz de restic: `backup` e `copy` só registram, `restore` grava na pasta
montada como alvo um snapshot com o leiaute de /eclume, e `sh -c` (a conferência do sha256) imprime
uma linha por arquivo. `FAKE_FALHA=<subcomando>` faz o restic falhar nesse subcomando.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

DEPLOY = Path(__file__).parent

FAKE_DOCKER = r"""#!/usr/bin/env python3
import json, os, re, sys
from pathlib import Path

args = sys.argv[1:]
base = Path(os.environ["FAKE_DIR"])
with open(base / "chamadas.jsonl", "a") as f:
    f.write(json.dumps(args) + "\n")
running = os.environ.get("FAKE_RUNNING", "postgres minio caddy server worker worker-gpu").split()
cmd = args[0] if args else ""
raiz = Path(os.environ["FAKE_ROOT_CRT"]).read_text() if os.environ.get("FAKE_ROOT_CRT") else "C"
if cmd == "compose":
    texto = " ".join(args)
    if "cat /data/caddy/pki" in texto:
        print(raiz, end="")
    elif "select audio_key" in texto:
        print(os.environ.get("FAKE_LOTE", ""))
    sys.exit(int(os.environ.get("FAKE_COMPOSE_SAIDA", "0")) if " build " in texto else 0)
if cmd == "image" and args[1:2] == ["inspect"]:
    sys.exit(1 if args[2] in os.environ.get("FAKE_SEM_IMAGEM", "").split() else 0)
if cmd == "ps":
    filtros = [args[i + 1] for i, a in enumerate(args) if a == "--filter"]
    servico = next((x.rsplit("=", 1)[1] for x in filtros if "compose.service=" in x), "")
    projeto = next((x.rsplit("=", 1)[1] for x in filtros if "compose.project=" in x), "")
    if projeto == "eclume" and servico in running:
        print(f"cid-{servico}")
elif cmd == "stop":
    sys.exit(1 if os.environ.get("FAKE_STOP_FALHA") else 0)
elif cmd == "inspect":
    print("eclume_fila-gpu\neclume_dados" if "Networks" in " ".join(args) else "minio-img")
elif cmd == "exec":
    if "pg_dumpall" in args:
        print("CREATE ROLE eclume_app;")
    elif "pg_dump" in args:
        print("DUMP")
    elif "psql" in args:
        sys.stdin.read()
        if os.environ.get("FAKE_PSQL_FALHA") and os.environ["FAKE_PSQL_FALHA"] in " ".join(args):
            sys.exit(1)
        arquivo = base / "bancos"
        if not arquivo.exists():
            arquivo.write_text(os.environ.get("FAKE_DBS", "eclume").replace(" ", "\n"))
        bancos = set(arquivo.read_text().split())
        falhas = [x for x in os.environ.get("FAKE_SQL_FALHA", "").split("|") if x]
        for i, a in enumerate(args):
            if a != "-c":
                continue
            sql = args[i + 1].strip()
            if any(x in sql for x in falhas):
                print(f"ERROR: simulado: {sql}", file=sys.stderr)
                sys.exit(1)
            if m := re.match(r"create database (\w+)", sql):
                bancos.add(m[1])
            elif m := re.match(r"drop database if exists (\w+)", sql):
                bancos.discard(m[1])
            elif m := re.match(r"alter database (\w+) rename to (\w+)", sql):
                if m[1] not in bancos or m[2] in bancos:
                    print(f"ERROR: rename {sql}", file=sys.stderr)
                    sys.exit(1)
                bancos.discard(m[1])
                bancos.add(m[2])
            elif m := re.match(r"select 1 from pg_database where datname = '(\w+)'", sql):
                print(1 if m[1] in bancos else "", end="\n" if m[1] in bancos else "")
            elif "pg_terminate_backend" not in sql:
                print("recordings=1 summaries=0 transcripts=1 users=1")
            arquivo.write_text("\n".join(sorted(bancos)))
        if "-c" not in args:
            print("recordings=1 summaries=0 transcripts=1 users=1")
    elif "pg_restore" in args:
        sys.stdin.read()
        ruim = os.environ.get("FAKE_DUMP_RUIM", "")
        if ("--list" in args and ruim == "lista") or ("--list" not in args and ruim == "restaura"):
            print("pg_restore: error: unexpected end of file", file=sys.stderr)
            sys.exit(1)
elif cmd == "run":
    if "claude" in args and os.environ.get("FAKE_SEM_CLAUDE"):
        sys.exit(127)
    mounts = {}
    i = 1
    while i < len(args):
        if args[i] in ("-v", "--volume"):
            src, dst = args[i + 1].split(":")[:2]
            mounts[dst] = Path(src)
            i += 2
        elif args[i] in ("-e", "--env-file", "--network", "--user", "--entrypoint", "-w", "--cpu-shares"):
            i += 2
        elif args[i].startswith("-"):
            i += 1
        else:
            break
    image, rest = args[i], args[i + 1:]
    if image == "minio-img":
        if "mirror" in rest and os.environ.get("FAKE_MIRROR_FALHA"):
            sys.exit(1)
        if "mirror" in rest and "/b/.espelho" in rest:
            (mounts["/b"] / ".espelho" / "rec").mkdir(parents=True, exist_ok=True)
            (mounts["/b"] / ".espelho" / "rec" / "audio.ogg").write_text("audio")
        elif "ls" in rest:
            print("[x] 5B audio.ogg")
        sys.exit(0)
    texto = " ".join(rest)
    sub = "restore" if "restic restore" in texto else (rest[0] if rest else "")
    if sub == os.environ.get("FAKE_FALHA"):
        print(f"restic {sub}: falhou", file=sys.stderr)
        sys.exit(1)
    if sub == "restore":
        out = mounts["/out"]
        for rel, txt in {"eclume/pg/roles.sql": "R", "eclume/pg/eclume.dump": "D",
                         "eclume/minio/rec/audio.ogg": "audio",
                         "eclume/secrets/env.prod": "ECLUME_ENCRYPTION_KEY=k\n",
                         "eclume/caddy/data/caddy/pki/authorities/local/root.key": "K",
                         "eclume/caddy/data/caddy/pki/authorities/local/root.crt": raiz}.items():
            p = out / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(txt)
    elif sub == "-c":
        print("e3b0  secrets/env.prod\ne3b1  caddy/data/caddy/pki/authorities/local/root.key")
    elif sub == "snapshots":
        print(json.dumps([{"short_id": "aaaa1111", "time": "2026-09-30T03:30:00Z"},
                          {"short_id": "bbbb2222", "time": "2026-10-01T03:30:00Z"}]))
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


RCLONE_FORA = "RESTIC_REPOSITORY=rclone:eclume-onedrive:eclume-restic\n"


def populacoes(host: Host) -> list[list[str]]:
    """As chamadas que preenchem o volume do binário do rclone (`--entrypoint true` na imagem dele)."""
    return [
        c for c in host.chamadas() if c[0] == "run" and "--entrypoint" in c and c[c.index("--entrypoint") + 1] == "true"
    ]


def volume_do_rclone(host: Host) -> str:
    """O volume preenchido uma vez, pela imagem fixada do rclone, no /usr/local/bin dela."""
    (popular,) = populacoes(host)
    assert popular[-1].startswith("rclone/rclone:")
    assert "@sha256:" in popular[-1]
    (montagem,) = montagens(popular)
    volume, destino = montagem.split(":")
    assert volume.startswith("eclume-rclone-")
    assert destino == "/usr/local/bin"
    return volume


def imagem_restic(chamada: list[str]) -> str:
    return next(a for a in chamada if a.startswith("restic/restic:"))


def assert_destino_rclone(chamada: list[str], volume: str, secrets: Path) -> None:
    """O restic do destino fora recebe o binário do rclone (só leitura) e a configuração gravável."""
    assert f"{volume}:/usr/local/bin:ro" in montagens(chamada)
    assert f"{secrets}/restic-rclone:/run/rclone" in montagens(chamada)
    assert "RCLONE_CONFIG=/run/rclone/rclone.conf" in chamada


def test_backup_snapshot_cifrado_sem_nada_em_claro(host: Host) -> None:
    legado = host.data / "backups"
    for velho in ("pg/eclume-2026-09-29.dump", "caddy/caddy-pki-2026-09-29.tgz", "minio/2026-09-29/x"):
        (legado / velho).parent.mkdir(parents=True, exist_ok=True)
        (legado / velho).write_text("velho")

    r = host.rodar("backup.sh", ECLUME_BACKUP_DIA="7")

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

    r = host.rodar("backup.sh", ECLUME_BACKUP_DIA="3")

    assert r.returncode == 0, r.stderr
    (copia,) = host.restic("copy")
    assert copia[copia.index("--env-file") + 1].endswith("secrets/restic-fora.env")
    assert copia[copia.index("--from-repo") + 1] == "/repo"
    assert len(host.restic("forget")) == 2
    assert all("--prune" not in f for f in host.restic("forget"))
    assert host.estado("fora")["ok"] is True
    # Destino S3: nada de rclone.
    assert populacoes(host) == []
    assert "RCLONE_CONFIG=/run/rclone/rclone.conf" not in copia


def test_backup_copia_para_destino_rclone(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text(RCLONE_FORA)

    r = host.rodar("backup.sh", ECLUME_BACKUP_DIA="3")

    assert r.returncode == 0, r.stderr
    volume = volume_do_rclone(host)
    fora = [c for c in host.chamadas() if c[0] == "run" and "--env-file" in c]
    assert [c[c.index(imagem_restic(c)) + 1] for c in fora] == ["copy", "forget"]
    for chamada in fora:
        assert_destino_rclone(chamada, volume, host.secrets)
    # O repositório local não passa pelo rclone.
    (backup,) = host.restic("backup")
    assert "RCLONE_CONFIG=/run/rclone/rclone.conf" not in backup
    assert host.estado("fora")["ok"] is True


def test_backup_conferencia_de_secrets_deixa_de_fora_o_que_o_snapshot_exclui(host: Host, tmp_path: Path) -> None:
    """O sha256 de secrets/ ignora os restic-* (inclusive a pasta do rclone), como o --exclude do snapshot."""
    r = host.rodar("backup.sh")

    assert r.returncode == 0, r.stderr
    (conferencia,) = [c for c in host.restic("-c") if "sha256sum" in c[-1]]
    raiz = tmp_path / "eclume"
    for rel in (
        "secrets/env.prod",
        "secrets/restic-password",
        "secrets/restic-fora.env",
        "secrets/restic-rclone/rclone.conf",
        "caddy/data/caddy/pki/authorities/local/root.key",
    ):
        (raiz / rel).parent.mkdir(parents=True, exist_ok=True)
        (raiz / rel).write_text(rel)
    script = conferencia[-1].replace("cd /eclume", f"cd {raiz}")
    saida = subprocess.run(["sh", "-c", script], capture_output=True, text=True, check=True).stdout
    assert [linha.split()[1] for linha in saida.splitlines()] == [
        "caddy/data/caddy/pki/authorities/local/root.key",
        "secrets/env.prod",
    ]


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


def test_restaurar_teste_le_o_snapshot_e_apaga_a_copia_em_claro(host: Host) -> None:
    r = host.rodar("restaurar-backup.sh", "--teste")

    assert r.returncode == 0, r.stderr + r.stdout
    assert "OK: restauração" in r.stdout
    (restore,) = host.restic("sh")
    assert "latest" in restore
    assert "RESTIC_REPOSITORY=/repo" in restore
    assert any(c[:2] == ["exec", "-i"] and "pg_restore" in c for c in host.chamadas())
    assert not list((host.data / "backups").glob(".restaurar.*"))


def sql_chamadas(host: Host) -> list[str]:
    return [" ".join(c) for c in host.chamadas() if c[:2] == ["exec", "-i"] and "psql" in c]


def indice(chamadas: list[str], trecho: str) -> int:
    return next(i for i, c in enumerate(chamadas) if trecho in c)


@pytest.fixture
def dump_pre_deploy(host: Host) -> Path:
    dump = host.data / "backups" / "pre-deploy" / "x.dump"
    dump.parent.mkdir(parents=True)
    dump.write_text("PGDMP")
    return dump


def test_restaurar_banco_valida_e_restaura_no_temporario_antes_de_parar(host: Host, dump_pre_deploy: Path) -> None:
    r = host.rodar("restaurar-backup.sh", "--banco", str(dump_pre_deploy), "--confirmo")

    assert r.returncode == 0, r.stderr + r.stdout
    chamadas = [" ".join(c) for c in host.chamadas()]
    lista = indice(chamadas, "pg_restore --list")
    temporario = indice(chamadas, "pg_restore -U eclume -d eclume_restore_novo")
    parada = indice(chamadas, "stop ")
    troca = indice(chamadas, "rename to eclume_antes")
    assert lista < temporario < parada < troca
    assert not any("drop database eclume" in c.replace("if exists ", "") and "eclume_" not in c for c in chamadas)
    assert [c for c in host.chamadas() if c[0] == "start"]


@pytest.mark.parametrize("ruim", ["lista", "restaura"])
@pytest.mark.parametrize("modo", ["banco", "aplicar"])
def test_restaurar_dump_truncado_nao_toca_nos_servicos_nem_no_banco(
    host: Host, dump_pre_deploy: Path, modo: str, ruim: str
) -> None:
    args = ("--banco", str(dump_pre_deploy)) if modo == "banco" else ("--aplicar", "latest")

    r = host.rodar("restaurar-backup.sh", *args, "--confirmo", FAKE_DUMP_RUIM=ruim)

    assert r.returncode != 0
    assert "FALHA" in r.stderr
    assert [c for c in host.chamadas() if c[0] in ("stop", "start")] == []
    sql = sql_chamadas(host)
    assert not any("rename" in c or "pg_terminate_backend" in c for c in sql)
    assert not any("drop database eclume " in c or c.endswith("drop database eclume") for c in sql)
    assert not any("mirror" in c for c in [" ".join(c) for c in host.chamadas()])


def test_restaurar_falha_na_troca_devolve_o_banco_e_sobe_os_servicos(host: Host, dump_pre_deploy: Path) -> None:
    r = host.rodar(
        "restaurar-backup.sh", "--banco", str(dump_pre_deploy), "--confirmo", FAKE_PSQL_FALHA="rename to eclume_antes"
    )

    assert r.returncode != 0
    chamadas = host.chamadas()
    assert [c for c in chamadas if c[0] == "stop"]
    assert [c for c in chamadas if c[0] == "start"]
    assert "rename to eclume_antes" in " ".join(sql_chamadas(host))


def bancos(host: Host) -> set[str]:
    return set((host.bin / "bancos").read_text().split())


def religou(host: Host) -> bool:
    return any(c[0] == "start" for c in host.chamadas())


DUAS_RENAMES = "alter database eclume_restore_novo rename to eclume|alter database eclume_antes rename to eclume"


def test_restaurar_desfazer_que_nao_consegue_devolver_nao_apaga_nada_nem_diz_que_devolveu(
    host: Host, dump_pre_deploy: Path
) -> None:
    r = host.rodar("restaurar-backup.sh", "--banco", str(dump_pre_deploy), "--confirmo", FAKE_SQL_FALHA=DUAS_RENAMES)

    assert r.returncode != 0
    assert bancos(host) == {"eclume_antes", "eclume_restore_novo"}
    assert "NENHUM banco se chama eclume" in r.stderr
    assert "foi devolvido" not in r.stderr
    assert "eclume_antes=sim" in r.stderr
    assert "eclume_restore_novo=sim" in r.stderr
    assert religou(host)


def test_restaurar_desfazer_devolve_o_antigo_e_so_entao_apaga_o_temporario(host: Host, dump_pre_deploy: Path) -> None:
    r = host.rodar(
        "restaurar-backup.sh",
        "--banco",
        str(dump_pre_deploy),
        "--confirmo",
        FAKE_SQL_FALHA="alter database eclume_restore_novo rename to eclume",
    )

    assert r.returncode != 0
    assert bancos(host) == {"eclume"}
    assert "eclume=sim eclume_antes=não eclume_restore_novo=não" in r.stderr
    assert religou(host)


def test_restaurar_sem_eclume_promove_o_restaurado_e_so_apaga_o_antes_depois(host: Host, dump_pre_deploy: Path) -> None:
    r = host.rodar("restaurar-backup.sh", "--banco", str(dump_pre_deploy), "--confirmo", FAKE_DBS="eclume_antes")

    assert r.returncode == 0, r.stderr
    assert bancos(host) == {"eclume"}
    assert "não existe o banco eclume" in r.stderr
    chamadas = sql_chamadas(host)
    promocao = indice(chamadas, "rename to eclume")
    assert not any("drop database if exists eclume_antes" in c for c in chamadas[:promocao])
    assert religou(host)


def test_restaurar_com_eclume_antes_de_tentativa_anterior_o_apaga_com_garantia(
    host: Host, dump_pre_deploy: Path
) -> None:
    r = host.rodar("restaurar-backup.sh", "--banco", str(dump_pre_deploy), "--confirmo", FAKE_DBS="eclume eclume_antes")

    assert r.returncode == 0, r.stderr
    assert bancos(host) == {"eclume"}


def test_restaurar_pg_database_ilegivel_nao_apaga_nem_para(host: Host, dump_pre_deploy: Path) -> None:
    r = host.rodar(
        "restaurar-backup.sh",
        "--banco",
        str(dump_pre_deploy),
        "--confirmo",
        FAKE_DBS="eclume eclume_restore_novo",
        FAKE_SQL_FALHA="from pg_database",
    )

    assert r.returncode != 0
    assert bancos(host) == {"eclume", "eclume_restore_novo"}
    assert [c for c in host.chamadas() if c[0] in ("stop", "start")] == []


def test_restaurar_docker_stop_falhando_religa_e_remove_o_temporario(host: Host, dump_pre_deploy: Path) -> None:
    r = host.rodar("restaurar-backup.sh", "--banco", str(dump_pre_deploy), "--confirmo", FAKE_STOP_FALHA="1")

    assert r.returncode != 0
    assert "docker stop falhou" in r.stderr
    assert religou(host)
    assert bancos(host) == {"eclume"}


def test_restaurar_aplicar_com_mirror_falhando_religa_os_servicos(host: Host) -> None:
    r = host.rodar("restaurar-backup.sh", "--aplicar", "latest", "--confirmo", FAKE_MIRROR_FALHA="1")

    assert r.returncode != 0
    assert "espelhamento do bucket falhou" in r.stderr
    chamadas = host.chamadas()
    assert [c for c in chamadas if c[0] == "stop"]
    assert religou(host)
    assert bancos(host) == {"eclume"}
    assert not list((host.data / "backups").glob(".restaurar.*"))


def test_restaurar_sucesso_deixa_so_o_eclume(host: Host, dump_pre_deploy: Path) -> None:
    r = host.rodar("restaurar-backup.sh", "--banco", str(dump_pre_deploy), "--confirmo")

    assert r.returncode == 0, r.stderr
    assert bancos(host) == {"eclume"}
    assert religou(host)


def test_restaurar_aplicar_exige_confirmacao(host: Host) -> None:
    r = host.rodar("restaurar-backup.sh", "--aplicar", "latest")

    assert r.returncode == 2
    assert host.chamadas() == []


def test_restaurar_aplicar_por_data_do_repositorio_fora(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text("RESTIC_REPOSITORY=s3:https://b2.example/eclume\n")

    r = host.rodar("restaurar-backup.sh", "--repositorio", "fora", "--aplicar", "2026-10-01", "--confirmo")

    assert r.returncode == 0, r.stderr + r.stdout
    (restore,) = host.restic("sh")
    assert "bbbb2222" in restore
    assert "--env-file" in restore
    paradas = [c for c in host.chamadas() if c[0] == "stop"]
    assert paradas
    assert [c for c in host.chamadas() if c[0] == "start"]
    assert "snapshot bbbb2222" in r.stdout


def test_restaurar_do_destino_rclone(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text(RCLONE_FORA)

    r = host.rodar("restaurar-backup.sh", "--repositorio", "fora", "--aplicar", "2026-10-01", "--confirmo")

    assert r.returncode == 0, r.stderr + r.stdout
    volume = volume_do_rclone(host)
    (snapshots,) = host.restic("snapshots")
    (restore,) = host.restic("sh")
    for chamada in (snapshots, restore):
        assert_destino_rclone(chamada, volume, host.secrets)


def test_restaurar_do_repositorio_local_ignora_o_rclone(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text(RCLONE_FORA)

    r = host.rodar("restaurar-backup.sh", "--aplicar", "2026-10-01", "--confirmo")

    assert r.returncode == 0, r.stderr + r.stdout
    assert populacoes(host) == []
    (restore,) = host.restic("sh")
    assert "RCLONE_CONFIG=/run/rclone/rclone.conf" not in restore


def test_restaurar_repositorio_invalido(host: Host) -> None:
    r = host.rodar("restaurar-backup.sh", "--repositorio", "nuvem", "--teste")

    assert r.returncode == 2


def test_restaurar_host_novo_devolve_secrets_e_pki(tmp_path: Path, host: Host) -> None:
    pasta = tmp_path / "novo"
    (pasta / "secrets").mkdir(parents=True)
    (pasta / "secrets" / "restic-password").write_text("senha\n")
    (pasta / "secrets" / "restic-fora.env").write_text("RESTIC_REPOSITORY=s3:https://b2.example/eclume\n")

    r = host.rodar("restaurar-backup.sh", "--host-novo", str(pasta), FAKE_RUNNING="")

    assert r.returncode == 0, r.stderr + r.stdout
    assert (pasta / "secrets" / "env.prod").read_text().startswith("ECLUME_ENCRYPTION_KEY=")
    assert (pasta / "secrets" / "restic-password").read_text() == "senha\n"
    assert (pasta / "caddy" / "data" / "caddy" / "pki" / "authorities" / "local" / "root.key").exists()
    assert sorted(p.name for p in pasta.iterdir()) == ["caddy", "secrets"]
    (restore,) = host.restic("sh")
    assert "--env-file" in restore
    assert str(pasta / "secrets" / "restic-fora.env") in restore


def test_restaurar_host_novo_sem_credencial_do_destino(tmp_path: Path, host: Host) -> None:
    pasta = tmp_path / "novo"
    (pasta / "secrets").mkdir(parents=True)
    (pasta / "secrets" / "restic-password").write_text("senha\n")

    r = host.rodar("restaurar-backup.sh", "--host-novo", str(pasta))

    assert r.returncode == 1
    assert "restic-fora.env" in r.stderr


AUDIO_HASH = "sha256:" + hashlib.sha256(b"audio").hexdigest()


@pytest.fixture
def staging(tmp_path: Path, host: Host) -> Host:
    """O host com o destino fora, o estado do último backup, a raiz publicada e uma árvore do main falsa."""
    (host.secrets / "restic-fora.env").write_text("RESTIC_REPOSITORY=s3:https://b2.example/eclume\n")
    crt = tmp_path / "root.crt"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-subj",
            "/CN=teste",
            "-days",
            "1",
            "-keyout",
            str(tmp_path / "root.key"),
            "-out",
            str(crt),
        ],
        check=True,
        capture_output=True,
    )
    (host.data / "downloads").mkdir()
    (host.data / "downloads" / "eclume-root.crt").write_text(crt.read_text())
    estado = host.data / "estado"
    estado.mkdir()
    linhas = [
        f"{hashlib.sha256(b'ECLUME_ENCRYPTION_KEY=k\n').hexdigest()}  secrets/env.prod",
        f"{hashlib.sha256(b'K').hexdigest()}  caddy/data/caddy/pki/authorities/local/root.key",
    ]
    (estado / "secrets.sha256").write_text("\n".join(linhas) + "\n")
    src = tmp_path / "main"
    (src / "deploy").mkdir(parents=True)
    (src / "deploy" / "docker-compose.staging.yml").write_text("")
    (src / "deploy" / "smoke_prod.py").write_text(
        f"import sys\nopen({str(host.bin / 'smoke.args')!r}, 'w').write(' '.join(sys.argv[1:]))\nprint('OK')\n"
    )
    for nome, corpo in {
        "df": 'printf "Use%%\\n %s%%\\n" "${FAKE_DISCO:-40}"\n',
        "curl": 'for a; do [[ "$a" == -d ]] && exit 0; done; echo \'{"open": true, "notice": {"version": "3"}}\'\n',
    }.items():
        (host.bin / nome).write_text("#!/usr/bin/env bash\n" + corpo)
        (host.bin / nome).chmod(0o755)
    host.env |= {
        "ECLUME_STAGING_SRC": str(src),
        "STAGING_DIR": str(tmp_path / "home" / "eclume-staging"),
        "FAKE_ROOT_CRT": str(crt),
        "FAKE_LOTE": f"rec/audio.ogg|{AUDIO_HASH}",
        # Domingo: o ensaio completo, o de sempre nestes testes.
        "ECLUME_ENSAIO_DIA": "7",
    }
    return host


def compose_chamadas(host: Host) -> list[str]:
    return [" ".join(c) for c in host.chamadas() if c[0] == "compose"]


def test_ensaio_restaura_do_repositorio_fora_confere_e_derruba(staging: Host) -> None:
    r = staging.rodar("staging.sh", "ensaio")

    assert r.returncode == 0, r.stderr + r.stdout
    estado = staging.estado("ensaio")
    assert estado["ok"] is True, estado
    assert "1 áudios" in estado["detalhe"]
    (restore,) = staging.restic("sh")
    assert "--env-file" in restore
    assert "latest" in " ".join(restore)
    (check,) = staging.restic("check")
    assert "--read-data-subset" in check
    chamadas = compose_chamadas(staging)
    assert all("-p eclume-staging" in c for c in chamadas)
    assert any(" run --rm migrate" in c for c in chamadas)
    assert "down -v" in chamadas[-1]
    smoke = (staging.bin / "smoke.args").read_text()
    assert "--url https://127.0.0.1:18444" in smoke
    # Nada restaurado fica em claro depois do ensaio.
    assert not Path(staging.env["STAGING_DIR"], "restaurado").exists()


def test_ensaio_le_o_destino_rclone(staging: Host) -> None:
    (staging.secrets / "restic-fora.env").write_text(RCLONE_FORA)

    r = staging.rodar("staging.sh", "ensaio")

    assert r.returncode == 0, r.stderr + r.stdout
    assert staging.estado("ensaio")["ok"] is True
    volume = volume_do_rclone(staging)
    (restore,) = staging.restic("sh")
    (check,) = staging.restic("check")
    for chamada in (restore, check):
        assert_destino_rclone(chamada, volume, staging.secrets)


def test_ensaio_content_hash_divergente_falha(staging: Host) -> None:
    r = staging.rodar("staging.sh", "ensaio", FAKE_LOTE="rec/audio.ogg|sha256:00")

    assert r.returncode != 0
    estado = staging.estado("ensaio")
    assert estado["ok"] is False
    assert "content_hash" in estado["detalhe"]
    assert "down -v" in compose_chamadas(staging)[-1]


def test_ensaio_secrets_divergentes_falha(staging: Host) -> None:
    (staging.data / "estado" / "secrets.sha256").write_text(f"{'0' * 64}  secrets/env.prod\n")

    r = staging.rodar("staging.sh", "ensaio")

    assert r.returncode != 0
    assert "sha256" in staging.estado("ensaio")["detalhe"]


def test_ensaio_check_do_restic_falha(staging: Host) -> None:
    r = staging.rodar("staging.sh", "ensaio", FAKE_FALHA="check")

    assert r.returncode != 0
    assert "restic check" in staging.estado("ensaio")["detalhe"]


def test_ensaio_recusa_disco_cheio(staging: Host) -> None:
    r = staging.rodar("staging.sh", "ensaio", FAKE_DISCO="91")

    assert r.returncode == 3
    assert "disco" in staging.estado("ensaio")["detalhe"]
    assert staging.restic("sh") == []


def test_ensaio_sem_destino_fora_falha(staging: Host) -> None:
    (staging.secrets / "restic-fora.env").unlink()

    r = staging.rodar("staging.sh", "ensaio")

    assert r.returncode != 0
    assert "restic-fora.env" in staging.estado("ensaio")["detalhe"]


def test_subir_deixa_o_stack_e_a_conta_sem_estado(staging: Host) -> None:
    r = staging.rodar("staging.sh", "subir")

    assert r.returncode == 0, r.stderr + r.stdout
    conta = Path(staging.env["STAGING_DIR"], "conta").read_text()
    assert "ECLUME_URL=https://127.0.0.1:18444" in conta
    assert not any("down" in c for c in compose_chamadas(staging))
    assert not (staging.data / "estado" / "ensaio.json").exists()


# --- ensaio proporcional: imagens retidas, parcial na semana e completo no domingo ------------------

SHA = "a" * 40


def docker_run(host: Host, *trechos: str) -> list[str]:
    """As chamadas `docker run` que contêm todos os trechos."""
    return [" ".join(c) for c in host.chamadas() if c[0] == "run" and all(t in c or t in " ".join(c) for t in trechos)]


def test_ensaio_reaproveita_as_imagens_retidas_do_sha_sem_build(staging: Host) -> None:
    r = staging.rodar("staging.sh", "ensaio", ECLUME_STAGING_SHA=SHA)

    assert r.returncode == 0, r.stderr + r.stdout
    chamadas = staging.chamadas()
    assert ["tag", f"eclume-server:{SHA}", "eclume-server:staging"] in chamadas
    assert ["tag", f"eclume-web:{SHA}", "eclume-web:staging"] in chamadas
    assert not any(" build " in c for c in compose_chamadas(staging))


def test_ensaio_aceita_a_imagem_retida_com_o_nome_edge(staging: Host) -> None:
    r = staging.rodar("staging.sh", "ensaio", ECLUME_STAGING_SHA=SHA, FAKE_SEM_IMAGEM=f"eclume-web:{SHA}")

    assert r.returncode == 0, r.stderr + r.stdout
    assert ["tag", f"eclume-edge:{SHA}", "eclume-web:staging"] in staging.chamadas()
    assert not any(" build " in c for c in compose_chamadas(staging))


def test_ensaio_constroi_so_o_que_nao_foi_retido(staging: Host) -> None:
    sem = f"eclume-server:{SHA} eclume-web:{SHA} eclume-edge:{SHA}"
    r = staging.rodar("staging.sh", "ensaio", ECLUME_STAGING_SHA=SHA, FAKE_SEM_IMAGEM=sem)

    assert r.returncode == 0, r.stderr + r.stdout
    (build,) = [c for c in compose_chamadas(staging) if " build " in c]
    assert build.endswith("build server web")
    assert not any(c[0] == "tag" for c in staging.chamadas())


def _compose_staging_real(staging: Host) -> None:
    """A árvore falsa do `main` com o compose de staging deste checkout (a borda com o SPA)."""
    real = (DEPLOY / "docker-compose.staging.yml").read_text(encoding="utf-8")
    (staging.data.parent / "main" / "deploy" / "docker-compose.staging.yml").write_text(real)


def test_ensaio_com_a_borda_reaproveita_a_edge_retida_e_sobe_o_compose_inteiro(staging: Host) -> None:
    _compose_staging_real(staging)
    r = staging.rodar("staging.sh", "ensaio", ECLUME_STAGING_SHA=SHA, FAKE_SEM_IMAGEM=f"eclume-web:{SHA}")

    assert r.returncode == 0, r.stderr + r.stdout
    assert ["tag", f"eclume-edge:{SHA}", "eclume-edge:staging"] in staging.chamadas()
    assert not any(" build " in c for c in compose_chamadas(staging))
    # Sem lista de serviços: nada de `web` nem de `worker-agents` a esperar.
    (subida,) = [c for c in compose_chamadas(staging) if "--wait-timeout 300" in c]
    assert subida.endswith("up -d --wait --wait-timeout 300")


def test_ensaio_com_a_borda_sem_retida_constroi_o_caddy(staging: Host) -> None:
    _compose_staging_real(staging)
    sem = f"eclume-server:{SHA} eclume-web:{SHA} eclume-edge:{SHA}"
    r = staging.rodar("staging.sh", "ensaio", ECLUME_STAGING_SHA=SHA, FAKE_SEM_IMAGEM=sem)

    assert r.returncode == 0, r.stderr + r.stdout
    (build,) = [c for c in compose_chamadas(staging) if " build " in c]
    assert build.endswith("build server caddy")
    yml = Path(staging.env["STAGING_DIR"], "cpu-shares.yml").read_text()
    assert "  caddy:\n" in yml
    assert "web" not in yml


def test_ensaio_completo_reconstroi_o_server_retido_sem_claude(staging: Host) -> None:
    r = staging.rodar("staging.sh", "ensaio", ECLUME_STAGING_SHA=SHA, FAKE_SEM_CLAUDE="1")

    assert r.returncode == 0, r.stderr + r.stdout
    (build,) = [c for c in compose_chamadas(staging) if " build " in c]
    assert build.endswith("build server")
    assert ["tag", f"eclume-web:{SHA}", "eclume-web:staging"] in staging.chamadas()


def test_ensaio_sem_sha_conhecido_constroi_tudo(staging: Host) -> None:
    r = staging.rodar("staging.sh", "ensaio")

    assert r.returncode == 0, r.stderr + r.stdout
    assert any(c.endswith("build server web") for c in compose_chamadas(staging))


def test_ensaio_de_domingo_restaura_o_snapshot_inteiro_e_roda_o_smoke_completo(staging: Host) -> None:
    r = staging.rodar("staging.sh", "ensaio", ECLUME_ENSAIO_DIA="7")

    assert r.returncode == 0, r.stderr + r.stdout
    (restore,) = staging.restic("sh")
    assert "--include" not in restore
    assert "--somente-leitura" not in (staging.bin / "smoke.args").read_text()
    assert "parcial" not in staging.estado("ensaio")["detalhe"]


@pytest.mark.parametrize("dia", ["1", "3", "6"])
def test_ensaio_dos_outros_dias_restaura_so_banco_secrets_caddy_e_a_amostra_de_audios(staging: Host, dia: str) -> None:
    r = staging.rodar("staging.sh", "ensaio", ECLUME_ENSAIO_DIA=dia, ECLUME_STAGING_SHA=SHA, FAKE_SEM_CLAUDE="1")

    assert r.returncode == 0, r.stderr + r.stdout
    primeira, segunda = staging.restic("sh")
    for caminho in ("/eclume/pg", "/eclume/secrets", "/eclume/caddy"):
        assert caminho in primeira
    assert "/eclume/minio" not in " ".join(primeira)
    assert "/eclume/minio/rec/audio.ogg" in segunda
    # O smoke de resumo e chat fica para o domingo, e a retida do server serve sem o `claude`.
    assert "--somente-leitura" in (staging.bin / "smoke.args").read_text()
    assert not any(" build " in c for c in compose_chamadas(staging))
    estado = staging.estado("ensaio")
    assert estado["ok"] is True, estado
    assert "parcial" in estado["detalhe"]
    assert "1 áudios" in estado["detalhe"]
    # A fatia do `restic check` continua toda noite, senão o domingo olharia sempre a mesma.
    assert len(staging.restic("check")) == 1


def test_ensaio_parcial_ainda_falha_com_content_hash_divergente(staging: Host) -> None:
    r = staging.rodar("staging.sh", "ensaio", ECLUME_ENSAIO_DIA="2", FAKE_LOTE="rec/audio.ogg|sha256:00")

    assert r.returncode != 0
    assert "content_hash" in staging.estado("ensaio")["detalhe"]


def test_subir_e_sempre_a_restauracao_completa(staging: Host) -> None:
    r = staging.rodar("staging.sh", "subir", ECLUME_ENSAIO_DIA="3")

    assert r.returncode == 0, r.stderr + r.stdout
    (restore,) = staging.restic("sh")
    assert "--include" not in restore


def test_staging_usa_cpu_shares_e_gomaxprocs_nos_conteineres(staging: Host) -> None:
    (staging.data.parent / "main" / "deploy" / "docker-compose.staging.yml").write_text(
        "x-ancora: &a\n  restart: no\n\nservices:\n  caddy:\n    image: c\n  edge:\n    image: eclume-edge:staging\n"
    )

    r = staging.rodar("staging.sh", "ensaio")

    assert r.returncode == 0, r.stderr + r.stdout
    for chamada in docker_run(staging, "restic"):
        assert "--cpu-shares 256" in chamada
        assert "GOMAXPROCS=1" in chamada
    yml = Path(staging.env["STAGING_DIR"], "cpu-shares.yml").read_text()
    assert yml == "services:\n  caddy:\n    cpu_shares: 256\n  edge:\n    cpu_shares: 256\n"
    assert all(f"-f {staging.env['STAGING_DIR']}/cpu-shares.yml" in c for c in compose_chamadas(staging))


# --- backup proporcional: limites, prune dominical e rotação dos logs -----------------------------


def test_backup_de_domingo_poda_os_dois_repositorios(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text("RESTIC_REPOSITORY=s3:https://b2.example/eclume\n")

    r = host.rodar("backup.sh", ECLUME_BACKUP_DIA="7")

    assert r.returncode == 0, r.stderr
    forgets = host.restic("forget")
    assert len(forgets) == 2
    assert all("--prune" in f for f in forgets)


def test_backup_dos_outros_dias_so_esquece_sem_prune(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text("RESTIC_REPOSITORY=s3:https://b2.example/eclume\n")

    for dia in ("1", "4", "6"):
        r = host.rodar("backup.sh", ECLUME_BACKUP_DIA=dia)
        assert r.returncode == 0, r.stderr
    forgets = host.restic("forget")
    assert len(forgets) == 6
    assert all("--prune" not in f and "--keep-daily" in f for f in forgets)


def test_backup_roda_todo_conteiner_com_cpu_shares_e_um_nucleo_do_go(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text("RESTIC_REPOSITORY=s3:https://b2.example/eclume\n")

    r = host.rodar("backup.sh", ECLUME_BACKUP_DIA="2")

    assert r.returncode == 0, r.stderr
    execucoes = [c for c in host.chamadas() if c[0] == "run"]
    assert len(execucoes) >= 5  # mc, backup, forget, sha256, copy, forget
    for c in execucoes:
        assert c[c.index("--cpu-shares") + 1] == "256", c
        assert "GOMAXPROCS=1" in c, c
    (backup,) = host.restic("backup")
    assert backup[backup.index("--read-concurrency") + 1] == "1"


def test_backup_rotaciona_os_logs_grandes_e_deixa_os_pequenos(host: Host) -> None:
    dest = host.data / "backups"
    (dest / "backup.log").write_text("x" * 3000)
    (dest / "ensaio.log").write_text("y" * 10)

    r = host.rodar("backup.sh", ECLUME_LOG_MAX_KB="2", ECLUME_BACKUP_DIA="2")

    assert r.returncode == 0, r.stderr
    assert (dest / "backup.log.1").read_text() == "x" * 3000
    assert not (dest / "backup.log").exists()
    assert (dest / "ensaio.log").read_text() == "y" * 10
    assert not (dest / "ensaio.log.1").exists()


def test_releases_rodam_os_conteineres_com_cpu_shares_e_podam_o_dist() -> None:
    for nome in ("release-desktop.sh", "release-movel.sh"):
        texto = (DEPLOY / nome).read_text(encoding="utf-8")
        assert "--cpus 2 --cpu-shares 256" in texto, nome
        assert "ls -dt dist-* 2>/dev/null | tail -n +4 | xargs -r rm -rf" in texto, nome
        # Cada `docker run` do release leva o peso, direto ou pelo array `comum`.
        for linha in texto.splitlines():
            if linha.strip().startswith("docker run ") and "comum" not in linha:
                assert "--cpu-shares 256" in linha, (nome, linha)
