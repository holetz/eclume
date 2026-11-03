# ruff: noqa: INP001, S101, S603, S607, D102, D103, D107, PLR2004  # loose tests of the deploy scripts; deploy/ is not a Python package
"""Tests of `backup.sh`, `restore-backup.sh` and `staging.sh` with a fake `docker` on PATH.

The fake `docker` records each call in `calls.jsonl`, answers the `ps`, `inspect` and `exec` of the
`eclume` project and plays restic: `backup` and `copy` only record, `restore` writes into the folder
mounted as target a snapshot with the /eclume layout, and `sh -c` (the sha256 check) prints one line
per file. `FAKE_FAIL=<subcommand>` makes restic fail in that subcommand.
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import time
from pathlib import Path

import pytest

DEPLOY = Path(__file__).parent

FAKE_DOCKER = r"""#!/usr/bin/env python3
import json, os, re, sys
from pathlib import Path

args = sys.argv[1:]
base = Path(os.environ["FAKE_DIR"])
with open(base / "calls.jsonl", "a") as f:
    f.write(json.dumps(args) + "\n")
running = os.environ.get("FAKE_RUNNING", "postgres minio caddy server worker worker-gpu").split()
cmd = args[0] if args else ""
root = Path(os.environ["FAKE_ROOT_CRT"]).read_text() if os.environ.get("FAKE_ROOT_CRT") else "C"
if cmd == "compose":
    text = " ".join(args)
    if "cat /data/caddy/pki" in text:
        print(root, end="")
    elif "select audio_key" in text:
        print(os.environ.get("FAKE_BATCH", ""))
    sys.exit(int(os.environ.get("FAKE_COMPOSE_EXIT", "0")) if " build " in text else 0)
if cmd == "image" and args[1:2] == ["inspect"]:
    sys.exit(1 if args[2] in os.environ.get("FAKE_NO_IMAGE", "").split() else 0)
if cmd == "ps":
    filters = [args[i + 1] for i, a in enumerate(args) if a == "--filter"]
    service = next((x.rsplit("=", 1)[1] for x in filters if "compose.service=" in x), "")
    project = next((x.rsplit("=", 1)[1] for x in filters if "compose.project=" in x), "")
    if project == "eclume" and service in running:
        print(f"cid-{service}")
elif cmd == "stop":
    sys.exit(1 if os.environ.get("FAKE_STOP_FAIL") else 0)
elif cmd == "inspect":
    print("eclume_fila-gpu\neclume_dados" if "Networks" in " ".join(args) else "minio-img")
elif cmd == "exec":
    if "pg_dumpall" in args:
        print("CREATE ROLE eclume_app;")
    elif "pg_dump" in args:
        print("DUMP")
    elif "psql" in args:
        sys.stdin.read()
        if os.environ.get("FAKE_PSQL_FAIL") and os.environ["FAKE_PSQL_FAIL"] in " ".join(args):
            sys.exit(1)
        dbs_file = base / "databases"
        if not dbs_file.exists():
            dbs_file.write_text(os.environ.get("FAKE_DBS", "eclume").replace(" ", "\n"))
        dbs = set(dbs_file.read_text().split())
        failures = [x for x in os.environ.get("FAKE_SQL_FAIL", "").split("|") if x]
        for i, a in enumerate(args):
            if a != "-c":
                continue
            sql = args[i + 1].strip()
            if any(x in sql for x in failures):
                print(f"ERROR: simulated: {sql}", file=sys.stderr)
                sys.exit(1)
            if os.environ.get("FAKE_HANG_AT") and os.environ["FAKE_HANG_AT"] in sql:
                (base / "hung").write_text(sql)
                import time
                time.sleep(60)
            if m := re.match(r"create database (\w+)", sql):
                dbs.add(m[1])
            elif m := re.match(r"drop database if exists (\w+)", sql):
                dbs.discard(m[1])
            elif m := re.match(r"alter database (\w+) rename to (\w+)", sql):
                if m[1] not in dbs or m[2] in dbs:
                    print(f"ERROR: rename {sql}", file=sys.stderr)
                    sys.exit(1)
                dbs.discard(m[1])
                dbs.add(m[2])
            elif m := re.match(r"select 1 from pg_database where datname = '(\w+)'", sql):
                print(1 if m[1] in dbs else "", end="\n" if m[1] in dbs else "")
            elif "pg_terminate_backend" not in sql:
                print("recordings=1 summaries=0 transcripts=1 users=1")
            dbs_file.write_text("\n".join(sorted(dbs)))
        if "-c" not in args:
            print("recordings=1 summaries=0 transcripts=1 users=1")
    elif "pg_restore" in args:
        sys.stdin.read()
        bad = os.environ.get("FAKE_BAD_DUMP", "")
        if ("--list" in args and bad == "list") or ("--list" not in args and bad == "restore"):
            print("pg_restore: error: unexpected end of file", file=sys.stderr)
            sys.exit(1)
elif cmd == "run":
    if "claude" in args and os.environ.get("FAKE_NO_CLAUDE"):
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
        if "mirror" in rest and os.environ.get("FAKE_MIRROR_FAIL"):
            sys.exit(1)
        if "mirror" in rest and "/b/.espelho" in rest:
            (mounts["/b"] / ".espelho" / "rec").mkdir(parents=True, exist_ok=True)
            (mounts["/b"] / ".espelho" / "rec" / "audio.ogg").write_text("audio")
        elif "ls" in rest:
            print("[x] 5B audio.ogg")
        sys.exit(0)
    text = " ".join(rest)
    sub = "restore" if "restic restore" in text else (rest[0] if rest else "")
    if sub == os.environ.get("FAKE_FAIL"):
        print(f"restic {sub}: failed", file=sys.stderr)
        sys.exit(1)
    if sub == "restore":
        out = mounts["/out"]
        for rel, txt in {"eclume/pg/roles.sql": "R", "eclume/pg/eclume.dump": "D",
                         "eclume/minio/rec/audio.ogg": "audio",
                         "eclume/secrets/env.prod": "ECLUME_ENCRYPTION_KEY=k\n",
                         "eclume/caddy/data/caddy/pki/authorities/local/root.key": "K",
                         "eclume/caddy/data/caddy/pki/authorities/local/root.crt": root}.items():
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
    """A temporary ECLUME_DATA_DIR with the fake `docker` on PATH."""

    def __init__(self, tmp_path: Path) -> None:
        self.data = tmp_path / "srv"
        self.secrets = self.data / "secrets"
        self.secrets.mkdir(parents=True)
        (self.secrets / "env.prod").write_text("ECLUME_MINIO_USER=u\nECLUME_MINIO_PASSWORD=p\n")
        (self.secrets / "restic-password").write_text("password\n")
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

    def run(self, script: str, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(DEPLOY / script), *args], env={**self.env, **env}, capture_output=True, text=True, check=False
        )

    def calls(self) -> list[list[str]]:
        log = self.bin / "calls.jsonl"
        return [json.loads(x) for x in log.read_text().splitlines()] if log.exists() else []

    def restic(self, sub: str) -> list[list[str]]:
        return [c for c in self.calls() if c[0] == "run" and sub in c and "minio-img" not in c]

    def state(self, stage: str) -> dict:
        return json.loads((self.data / "estado" / f"{stage}.json").read_text())


@pytest.fixture
def host(tmp_path: Path) -> Host:
    return Host(tmp_path)


def mounts(call: list[str]) -> list[str]:
    return [call[i + 1] for i, a in enumerate(call) if a == "-v"]


RCLONE_OFFSITE = "RESTIC_REPOSITORY=rclone:eclume-onedrive:eclume-restic\n"


def populations(host: Host) -> list[list[str]]:
    """The calls that fill the rclone binary volume (`--entrypoint true` on its image)."""
    return [
        c for c in host.calls() if c[0] == "run" and "--entrypoint" in c and c[c.index("--entrypoint") + 1] == "true"
    ]


def rclone_volume(host: Host) -> str:
    """The volume filled once, by the pinned rclone image, at its /usr/local/bin."""
    (populate,) = populations(host)
    assert populate[-1].startswith("rclone/rclone:")
    assert "@sha256:" in populate[-1]
    (mount,) = mounts(populate)
    volume, target = mount.split(":")
    assert volume.startswith("eclume-rclone-")
    assert target == "/usr/local/bin"
    return volume


def restic_image(call: list[str]) -> str:
    return next(a for a in call if a.startswith("restic/restic:"))


def assert_rclone_destination(call: list[str], volume: str, secrets: Path) -> None:
    """The off-host restic gets the rclone binary (read-only) and the writable configuration."""
    assert f"{volume}:/usr/local/bin:ro" in mounts(call)
    assert f"{secrets}/restic-rclone:/run/rclone" in mounts(call)
    assert "RCLONE_CONFIG=/run/rclone/rclone.conf" in call


def test_backup_encrypted_snapshot_with_nothing_in_clear(host: Host) -> None:
    legacy = host.data / "backups"
    for old in ("pg/eclume-2026-09-29.dump", "caddy/caddy-pki-2026-09-29.tgz", "minio/2026-09-29/x"):
        (legacy / old).parent.mkdir(parents=True, exist_ok=True)
        (legacy / old).write_text("old")

    r = host.run("backup.sh", ECLUME_BACKUP_DAY="7")

    assert r.returncode == 0, r.stderr + r.stdout
    (backup,) = host.restic("backup")
    assert backup[backup.index("--host") + 1] == "eclume"
    assert "/eclume/secrets/restic-*" in backup
    sources = mounts(backup)
    for target in (
        "/eclume/pg:ro",
        "/eclume/pre-deploy:ro",
        "/eclume/minio:ro",
        "/eclume/secrets:ro",
        "/eclume/caddy/data/caddy/pki:ro",
    ):
        assert any(m.endswith(target) for m in sources), target
    (forget,) = host.restic("forget")
    assert forget[forget.index("--keep-daily") + 1] == "7"
    assert "--prune" in forget
    # Nothing in clear after the snapshot: neither the run folder nor the old layout.
    leftovers = sorted(p.name for p in legacy.iterdir())
    assert leftovers == [".restic-cache", "minio", "pre-deploy", "restic"]
    assert [p.name for p in (legacy / "minio").iterdir()] == [".espelho"]
    state = host.state("backup")
    assert state["ok"] is True
    assert {"ok", "at", "detalhe"} <= state.keys()
    assert '"ok": true' in (host.data / "estado" / "backup.json").read_text()
    assert "secrets/env.prod" in (host.data / "estado" / "secrets.sha256").read_text()


def test_backup_without_offsite_destination_records_the_copy_failure(host: Host) -> None:
    r = host.run("backup.sh")

    assert r.returncode == 0
    assert host.restic("copy") == []
    assert host.state("fora")["ok"] is False
    assert "restic-fora.env" in host.state("fora")["detalhe"]


def test_backup_copies_offsite_with_the_same_retention(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text("RESTIC_REPOSITORY=s3:https://b2.example/eclume\n")

    r = host.run("backup.sh", ECLUME_BACKUP_DAY="3")

    assert r.returncode == 0, r.stderr
    (copy,) = host.restic("copy")
    assert copy[copy.index("--env-file") + 1].endswith("secrets/restic-fora.env")
    assert copy[copy.index("--from-repo") + 1] == "/repo"
    assert len(host.restic("forget")) == 2
    assert all("--prune" not in f for f in host.restic("forget"))
    assert host.state("fora")["ok"] is True
    # S3 destination: no rclone.
    assert populations(host) == []
    assert "RCLONE_CONFIG=/run/rclone/rclone.conf" not in copy


def test_backup_copies_to_an_rclone_destination(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text(RCLONE_OFFSITE)

    r = host.run("backup.sh", ECLUME_BACKUP_DAY="3")

    assert r.returncode == 0, r.stderr
    volume = rclone_volume(host)
    offsite = [c for c in host.calls() if c[0] == "run" and "--env-file" in c]
    assert [c[c.index(restic_image(c)) + 1] for c in offsite] == ["copy", "forget"]
    for call in offsite:
        assert_rclone_destination(call, volume, host.secrets)
    # The local repository does not go through rclone.
    (backup,) = host.restic("backup")
    assert "RCLONE_CONFIG=/run/rclone/rclone.conf" not in backup
    assert host.state("fora")["ok"] is True


def test_backup_secrets_check_leaves_out_what_the_snapshot_excludes(host: Host, tmp_path: Path) -> None:
    """The sha256 of secrets/ ignores the restic-* (the rclone folder included), like the snapshot's --exclude."""
    r = host.run("backup.sh")

    assert r.returncode == 0, r.stderr
    (check,) = [c for c in host.restic("-c") if "sha256sum" in c[-1]]
    root = tmp_path / "eclume"
    for rel in (
        "secrets/env.prod",
        "secrets/restic-password",
        "secrets/restic-fora.env",
        "secrets/restic-rclone/rclone.conf",
        "caddy/data/caddy/pki/authorities/local/root.key",
    ):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(rel)
    script = check[-1].replace("cd /eclume", f"cd {root}")
    output = subprocess.run(["sh", "-c", script], capture_output=True, text=True, check=True).stdout
    assert [line.split()[1] for line in output.splitlines()] == [
        "caddy/data/caddy/pki/authorities/local/root.key",
        "secrets/env.prod",
    ]


def test_backup_restic_failure_leaves_ok_false(host: Host) -> None:
    r = host.run("backup.sh", FAKE_FAIL="backup")

    assert r.returncode != 0
    assert host.state("backup")["ok"] is False
    assert not list((host.data / "backups").glob(".run.*"))


def test_backup_without_postgres_fails_with_a_reason(host: Host) -> None:
    r = host.run("backup.sh", FAKE_RUNNING="minio")

    assert r.returncode != 0
    assert "postgres" in host.state("backup")["detalhe"]


def test_backup_without_an_initialized_repository_fails(host: Host) -> None:
    (host.data / "backups" / "restic" / "config").unlink()

    r = host.run("backup.sh")

    assert r.returncode != 0
    assert "deploy.sh" in host.state("backup")["detalhe"]


def test_restore_test_reads_the_snapshot_and_deletes_the_copy_in_clear(host: Host) -> None:
    r = host.run("restore-backup.sh", "--test")

    assert r.returncode == 0, r.stderr + r.stdout
    assert "OK: restore" in r.stdout
    (restore,) = host.restic("sh")
    assert "latest" in restore
    assert "RESTIC_REPOSITORY=/repo" in restore
    assert any(c[:2] == ["exec", "-i"] and "pg_restore" in c for c in host.calls())
    assert not list((host.data / "backups").glob(".restore.*"))


def sql_calls(host: Host) -> list[str]:
    return [" ".join(c) for c in host.calls() if c[:2] == ["exec", "-i"] and "psql" in c]


def index_of(calls: list[str], fragment: str) -> int:
    return next(i for i, c in enumerate(calls) if fragment in c)


@pytest.fixture
def dump_pre_deploy(host: Host) -> Path:
    dump = host.data / "backups" / "pre-deploy" / "x.dump"
    dump.parent.mkdir(parents=True)
    dump.write_text("PGDMP")
    return dump


def test_restore_database_validates_and_restores_into_the_temporary_one_before_stopping(
    host: Host, dump_pre_deploy: Path
) -> None:
    r = host.run("restore-backup.sh", "--database", str(dump_pre_deploy), "--confirm")

    assert r.returncode == 0, r.stderr + r.stdout
    calls = [" ".join(c) for c in host.calls()]
    listing = index_of(calls, "pg_restore --list")
    temporary = index_of(calls, "pg_restore -U eclume -d eclume_restore_novo")
    stop = index_of(calls, "stop ")
    swap = index_of(calls, "rename to eclume_antes")
    assert listing < temporary < stop < swap
    assert not any("drop database eclume" in c.replace("if exists ", "") and "eclume_" not in c for c in calls)
    assert [c for c in host.calls() if c[0] == "start"]


@pytest.mark.parametrize("bad", ["list", "restore"])
@pytest.mark.parametrize("mode", ["database", "apply"])
def test_restore_truncated_dump_touches_neither_the_services_nor_the_database(
    host: Host, dump_pre_deploy: Path, mode: str, bad: str
) -> None:
    args = ("--database", str(dump_pre_deploy)) if mode == "database" else ("--apply", "latest")

    r = host.run("restore-backup.sh", *args, "--confirm", FAKE_BAD_DUMP=bad)

    assert r.returncode != 0
    assert "FAILURE" in r.stderr
    assert [c for c in host.calls() if c[0] in ("stop", "start")] == []
    sql = sql_calls(host)
    assert not any("rename" in c or "pg_terminate_backend" in c for c in sql)
    assert not any("drop database eclume " in c or c.endswith("drop database eclume") for c in sql)
    assert not any("mirror" in c for c in [" ".join(c) for c in host.calls()])


def test_restore_failure_in_the_swap_returns_the_database_and_starts_the_services(
    host: Host, dump_pre_deploy: Path
) -> None:
    r = host.run(
        "restore-backup.sh", "--database", str(dump_pre_deploy), "--confirm", FAKE_PSQL_FAIL="rename to eclume_antes"
    )

    assert r.returncode != 0
    calls = host.calls()
    assert [c for c in calls if c[0] == "stop"]
    assert [c for c in calls if c[0] == "start"]
    assert "rename to eclume_antes" in " ".join(sql_calls(host))


def databases(host: Host) -> set[str]:
    return set((host.bin / "databases").read_text().split())


def restarted(host: Host) -> bool:
    return any(c[0] == "start" for c in host.calls())


TWO_RENAMES = "alter database eclume_restore_novo rename to eclume|alter database eclume_antes rename to eclume"


def test_restore_undo_that_cannot_return_deletes_nothing_nor_claims_it_returned(
    host: Host, dump_pre_deploy: Path
) -> None:
    r = host.run("restore-backup.sh", "--database", str(dump_pre_deploy), "--confirm", FAKE_SQL_FAIL=TWO_RENAMES)

    assert r.returncode != 0
    assert databases(host) == {"eclume_antes", "eclume_restore_novo"}
    assert "NO database is called eclume" in r.stderr
    assert "was returned" not in r.stderr
    assert "eclume_antes=yes" in r.stderr
    assert "eclume_restore_novo=yes" in r.stderr
    assert restarted(host)


def test_restore_undo_returns_the_old_one_and_only_then_drops_the_temporary_one(
    host: Host, dump_pre_deploy: Path
) -> None:
    r = host.run(
        "restore-backup.sh",
        "--database",
        str(dump_pre_deploy),
        "--confirm",
        FAKE_SQL_FAIL="alter database eclume_restore_novo rename to eclume",
    )

    assert r.returncode != 0
    assert databases(host) == {"eclume"}
    assert "eclume=yes eclume_antes=no eclume_restore_novo=no" in r.stderr
    assert restarted(host)


def test_restore_without_eclume_promotes_the_restored_one_and_only_drops_antes_afterwards(
    host: Host, dump_pre_deploy: Path
) -> None:
    r = host.run("restore-backup.sh", "--database", str(dump_pre_deploy), "--confirm", FAKE_DBS="eclume_antes")

    assert r.returncode == 0, r.stderr
    assert databases(host) == {"eclume"}
    assert "the eclume database does not exist" in r.stderr
    calls = sql_calls(host)
    promotion = index_of(calls, "rename to eclume")
    assert not any("drop database if exists eclume_antes" in c for c in calls[:promotion])
    assert restarted(host)


def test_restore_with_eclume_antes_from_a_previous_attempt_drops_it_with_a_guarantee(
    host: Host, dump_pre_deploy: Path
) -> None:
    r = host.run("restore-backup.sh", "--database", str(dump_pre_deploy), "--confirm", FAKE_DBS="eclume eclume_antes")

    assert r.returncode == 0, r.stderr
    assert databases(host) == {"eclume"}


def test_restore_unreadable_pg_database_neither_drops_nor_stops(host: Host, dump_pre_deploy: Path) -> None:
    r = host.run(
        "restore-backup.sh",
        "--database",
        str(dump_pre_deploy),
        "--confirm",
        FAKE_DBS="eclume eclume_restore_novo",
        FAKE_SQL_FAIL="from pg_database",
    )

    assert r.returncode != 0
    assert databases(host) == {"eclume", "eclume_restore_novo"}
    assert [c for c in host.calls() if c[0] in ("stop", "start")] == []


def test_restore_failing_docker_stop_restarts_and_removes_the_temporary_one(host: Host, dump_pre_deploy: Path) -> None:
    r = host.run("restore-backup.sh", "--database", str(dump_pre_deploy), "--confirm", FAKE_STOP_FAIL="1")

    assert r.returncode != 0
    assert "docker stop failed" in r.stderr
    assert restarted(host)
    assert databases(host) == {"eclume"}


def test_restore_apply_with_a_failing_mirror_restarts_the_services(host: Host) -> None:
    r = host.run("restore-backup.sh", "--apply", "latest", "--confirm", FAKE_MIRROR_FAIL="1")

    assert r.returncode != 0
    assert "mirroring the bucket failed" in r.stderr
    calls = host.calls()
    assert [c for c in calls if c[0] == "stop"]
    assert restarted(host)
    assert databases(host) == {"eclume"}
    assert not list((host.data / "backups").glob(".restore.*"))


def test_restore_success_leaves_only_eclume(host: Host, dump_pre_deploy: Path) -> None:
    r = host.run("restore-backup.sh", "--database", str(dump_pre_deploy), "--confirm")

    assert r.returncode == 0, r.stderr
    assert databases(host) == {"eclume"}
    assert restarted(host)


def test_restore_apply_requires_confirmation(host: Host) -> None:
    r = host.run("restore-backup.sh", "--apply", "latest")

    assert r.returncode == 2
    assert host.calls() == []


def test_restore_apply_by_date_from_the_offsite_repository(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text("RESTIC_REPOSITORY=s3:https://b2.example/eclume\n")

    r = host.run("restore-backup.sh", "--repository", "offsite", "--apply", "2026-10-01", "--confirm")

    assert r.returncode == 0, r.stderr + r.stdout
    (restore,) = host.restic("sh")
    assert "bbbb2222" in restore
    assert "--env-file" in restore
    stops = [c for c in host.calls() if c[0] == "stop"]
    assert stops
    assert [c for c in host.calls() if c[0] == "start"]
    assert "snapshot bbbb2222" in r.stdout


def test_restore_from_the_rclone_destination(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text(RCLONE_OFFSITE)

    r = host.run("restore-backup.sh", "--repository", "offsite", "--apply", "2026-10-01", "--confirm")

    assert r.returncode == 0, r.stderr + r.stdout
    volume = rclone_volume(host)
    (snapshots,) = host.restic("snapshots")
    (restore,) = host.restic("sh")
    for call in (snapshots, restore):
        assert_rclone_destination(call, volume, host.secrets)


def test_restore_from_the_local_repository_ignores_rclone(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text(RCLONE_OFFSITE)

    r = host.run("restore-backup.sh", "--apply", "2026-10-01", "--confirm")

    assert r.returncode == 0, r.stderr + r.stdout
    assert populations(host) == []
    (restore,) = host.restic("sh")
    assert "RCLONE_CONFIG=/run/rclone/rclone.conf" not in restore


def test_restore_invalid_repository(host: Host) -> None:
    r = host.run("restore-backup.sh", "--repository", "cloud", "--test")

    assert r.returncode == 2


def test_restore_new_host_returns_secrets_and_pki(tmp_path: Path, host: Host) -> None:
    folder = tmp_path / "new"
    (folder / "secrets").mkdir(parents=True)
    (folder / "secrets" / "restic-password").write_text("password\n")
    (folder / "secrets" / "restic-fora.env").write_text("RESTIC_REPOSITORY=s3:https://b2.example/eclume\n")

    r = host.run("restore-backup.sh", "--new-host", str(folder), FAKE_RUNNING="")

    assert r.returncode == 0, r.stderr + r.stdout
    assert (folder / "secrets" / "env.prod").read_text().startswith("ECLUME_ENCRYPTION_KEY=")
    assert (folder / "secrets" / "restic-password").read_text() == "password\n"
    assert (folder / "caddy" / "data" / "caddy" / "pki" / "authorities" / "local" / "root.key").exists()
    assert sorted(p.name for p in folder.iterdir()) == ["caddy", "secrets"]
    (restore,) = host.restic("sh")
    assert "--env-file" in restore
    assert str(folder / "secrets" / "restic-fora.env") in restore


def test_restore_new_host_without_the_destination_credential(tmp_path: Path, host: Host) -> None:
    folder = tmp_path / "new"
    (folder / "secrets").mkdir(parents=True)
    (folder / "secrets" / "restic-password").write_text("password\n")

    r = host.run("restore-backup.sh", "--new-host", str(folder))

    assert r.returncode == 1
    assert "restic-fora.env" in r.stderr


AUDIO_HASH = "sha256:" + hashlib.sha256(b"audio").hexdigest()


@pytest.fixture
def staging(tmp_path: Path, host: Host) -> Host:
    """The host with the offsite destination, the last backup state, the published root and a fake main tree."""
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
            "/CN=test",
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
    state_dir = host.data / "estado"
    state_dir.mkdir()
    lines = [
        f"{hashlib.sha256(b'ECLUME_ENCRYPTION_KEY=k\n').hexdigest()}  secrets/env.prod",
        f"{hashlib.sha256(b'K').hexdigest()}  caddy/data/caddy/pki/authorities/local/root.key",
    ]
    (state_dir / "secrets.sha256").write_text("\n".join(lines) + "\n")
    src = tmp_path / "main"
    (src / "deploy").mkdir(parents=True)
    (src / "deploy" / "docker-compose.staging.yml").write_text("")
    (src / "deploy" / "smoke_prod.py").write_text(
        # A `main` after the English rename: its smoke_prod.py knows `--read-only`.
        f"# --read-only\nimport sys\nopen({str(host.bin / 'smoke.args')!r}, 'w').write(' '.join(sys.argv[1:]))\nprint('OK')\n"
    )
    for name, body in {
        "df": 'printf "Use%%\\n %s%%\\n" "${FAKE_DISK:-40}"\n',
        "curl": 'for a; do [[ "$a" == -d ]] && exit 0; done; echo \'{"open": true, "notice": {"version": "3"}}\'\n',
    }.items():
        (host.bin / name).write_text("#!/usr/bin/env bash\n" + body)
        (host.bin / name).chmod(0o755)
    host.env |= {
        "ECLUME_STAGING_SRC": str(src),
        "STAGING_DIR": str(tmp_path / "home" / "eclume-staging"),
        "FAKE_ROOT_CRT": str(crt),
        "FAKE_BATCH": f"rec/audio.ogg|{AUDIO_HASH}",
        # Sunday: the full rehearsal, the usual one in these tests.
        "ECLUME_REHEARSAL_DAY": "7",
    }
    return host


def compose_calls(host: Host) -> list[str]:
    return [" ".join(c) for c in host.calls() if c[0] == "compose"]


def test_rehearsal_restores_from_the_offsite_repository_checks_and_tears_down(staging: Host) -> None:
    r = staging.run("staging.sh", "rehearse")

    assert r.returncode == 0, r.stderr + r.stdout
    state = staging.state("ensaio")
    assert state["ok"] is True, state
    assert "1 audio files" in state["detalhe"]
    (restore,) = staging.restic("sh")
    assert "--env-file" in restore
    assert "latest" in " ".join(restore)
    (check,) = staging.restic("check")
    assert "--read-data-subset" in check
    calls = compose_calls(staging)
    assert all("-p eclume-staging" in c for c in calls)
    assert any(" run --rm migrate" in c for c in calls)
    assert "down -v" in calls[-1]
    smoke = (staging.bin / "smoke.args").read_text()
    assert "--url https://127.0.0.1:18444" in smoke
    # Nothing restored stays in clear after the rehearsal.
    assert not Path(staging.env["STAGING_DIR"], "restored").exists()


def test_rehearsal_reads_the_rclone_destination(staging: Host) -> None:
    (staging.secrets / "restic-fora.env").write_text(RCLONE_OFFSITE)

    r = staging.run("staging.sh", "rehearse")

    assert r.returncode == 0, r.stderr + r.stdout
    assert staging.state("ensaio")["ok"] is True
    volume = rclone_volume(staging)
    (restore,) = staging.restic("sh")
    (check,) = staging.restic("check")
    for call in (restore, check):
        assert_rclone_destination(call, volume, staging.secrets)


def test_rehearsal_diverging_content_hash_fails(staging: Host) -> None:
    r = staging.run("staging.sh", "rehearse", FAKE_BATCH="rec/audio.ogg|sha256:00")

    assert r.returncode != 0
    state = staging.state("ensaio")
    assert state["ok"] is False
    assert "content_hash" in state["detalhe"]
    assert "down -v" in compose_calls(staging)[-1]


def test_rehearsal_diverging_secrets_fails(staging: Host) -> None:
    (staging.data / "estado" / "secrets.sha256").write_text(f"{'0' * 64}  secrets/env.prod\n")

    r = staging.run("staging.sh", "rehearse")

    assert r.returncode != 0
    assert "sha256" in staging.state("ensaio")["detalhe"]


def test_rehearsal_restic_check_fails(staging: Host) -> None:
    r = staging.run("staging.sh", "rehearse", FAKE_FAIL="check")

    assert r.returncode != 0
    assert "restic check" in staging.state("ensaio")["detalhe"]


def test_rehearsal_refuses_a_full_disk(staging: Host) -> None:
    r = staging.run("staging.sh", "rehearse", FAKE_DISK="91")

    assert r.returncode == 3
    assert "disk" in staging.state("ensaio")["detalhe"]
    assert staging.restic("sh") == []


def test_rehearsal_without_offsite_destination_fails(staging: Host) -> None:
    (staging.secrets / "restic-fora.env").unlink()

    r = staging.run("staging.sh", "rehearse")

    assert r.returncode != 0
    assert "restic-fora.env" in staging.state("ensaio")["detalhe"]


def test_up_leaves_the_stack_and_the_account_without_state(staging: Host) -> None:
    r = staging.run("staging.sh", "up")

    assert r.returncode == 0, r.stderr + r.stdout
    account = Path(staging.env["STAGING_DIR"], "conta").read_text()
    assert "ECLUME_URL=https://127.0.0.1:18444" in account
    assert not any("down" in c for c in compose_calls(staging))
    assert not (staging.data / "estado" / "ensaio.json").exists()


# --- proportional rehearsal: kept images, partial on weekdays and full on Sunday ----------------------

SHA = "a" * 40


def docker_run(host: Host, *fragments: str) -> list[str]:
    """The `docker run` calls that contain every fragment."""
    return [" ".join(c) for c in host.calls() if c[0] == "run" and all(t in c or t in " ".join(c) for t in fragments)]


def test_rehearsal_reuses_the_kept_images_of_the_sha_without_build(staging: Host) -> None:
    r = staging.run("staging.sh", "rehearse", ECLUME_STAGING_SHA=SHA)

    assert r.returncode == 0, r.stderr + r.stdout
    calls = staging.calls()
    assert ["tag", f"eclume-server:{SHA}", "eclume-server:staging"] in calls
    assert ["tag", f"eclume-web:{SHA}", "eclume-web:staging"] in calls
    assert not any(" build " in c for c in compose_calls(staging))


def test_rehearsal_accepts_the_kept_image_named_edge(staging: Host) -> None:
    r = staging.run("staging.sh", "rehearse", ECLUME_STAGING_SHA=SHA, FAKE_NO_IMAGE=f"eclume-web:{SHA}")

    assert r.returncode == 0, r.stderr + r.stdout
    assert ["tag", f"eclume-edge:{SHA}", "eclume-web:staging"] in staging.calls()
    assert not any(" build " in c for c in compose_calls(staging))


def test_rehearsal_builds_only_what_was_not_kept(staging: Host) -> None:
    missing = f"eclume-server:{SHA} eclume-web:{SHA} eclume-edge:{SHA}"
    r = staging.run("staging.sh", "rehearse", ECLUME_STAGING_SHA=SHA, FAKE_NO_IMAGE=missing)

    assert r.returncode == 0, r.stderr + r.stdout
    (build,) = [c for c in compose_calls(staging) if " build " in c]
    assert build.endswith("build server web")
    assert not any(c[0] == "tag" for c in staging.calls())


def _real_staging_compose(staging: Host) -> None:
    """The fake `main` tree with this checkout's staging compose (the edge with the SPA)."""
    real = (DEPLOY / "docker-compose.staging.yml").read_text(encoding="utf-8")
    (staging.data.parent / "main" / "deploy" / "docker-compose.staging.yml").write_text(real)


def test_rehearsal_with_the_edge_reuses_the_kept_edge_and_starts_the_whole_compose(staging: Host) -> None:
    _real_staging_compose(staging)
    r = staging.run("staging.sh", "rehearse", ECLUME_STAGING_SHA=SHA, FAKE_NO_IMAGE=f"eclume-web:{SHA}")

    assert r.returncode == 0, r.stderr + r.stdout
    assert ["tag", f"eclume-edge:{SHA}", "eclume-edge:staging"] in staging.calls()
    assert not any(" build " in c for c in compose_calls(staging))
    # No service list: no `web` or `worker-agents` to wait for.
    (start,) = [c for c in compose_calls(staging) if "--wait-timeout 300" in c]
    assert start.endswith("up -d --wait --wait-timeout 300")


def test_rehearsal_with_the_edge_and_nothing_kept_builds_caddy(staging: Host) -> None:
    _real_staging_compose(staging)
    missing = f"eclume-server:{SHA} eclume-web:{SHA} eclume-edge:{SHA}"
    r = staging.run("staging.sh", "rehearse", ECLUME_STAGING_SHA=SHA, FAKE_NO_IMAGE=missing)

    assert r.returncode == 0, r.stderr + r.stdout
    (build,) = [c for c in compose_calls(staging) if " build " in c]
    assert build.endswith("build server caddy")
    yml = Path(staging.env["STAGING_DIR"], "cpu-shares.yml").read_text()
    assert "  caddy:\n" in yml
    assert "web" not in yml


def test_full_rehearsal_rebuilds_the_kept_server_without_claude(staging: Host) -> None:
    r = staging.run("staging.sh", "rehearse", ECLUME_STAGING_SHA=SHA, FAKE_NO_CLAUDE="1")

    assert r.returncode == 0, r.stderr + r.stdout
    (build,) = [c for c in compose_calls(staging) if " build " in c]
    assert build.endswith("build server")
    assert ["tag", f"eclume-web:{SHA}", "eclume-web:staging"] in staging.calls()


def test_rehearsal_without_a_known_sha_builds_everything(staging: Host) -> None:
    r = staging.run("staging.sh", "rehearse")

    assert r.returncode == 0, r.stderr + r.stdout
    assert any(c.endswith("build server web") for c in compose_calls(staging))


def test_sunday_rehearsal_restores_the_whole_snapshot_and_runs_the_full_smoke(staging: Host) -> None:
    r = staging.run("staging.sh", "rehearse", ECLUME_REHEARSAL_DAY="7")

    assert r.returncode == 0, r.stderr + r.stdout
    (restore,) = staging.restic("sh")
    assert "--include" not in restore
    assert "--read-only" not in (staging.bin / "smoke.args").read_text()
    assert "partial" not in staging.state("ensaio")["detalhe"]


@pytest.mark.parametrize("day", ["1", "3", "6"])
def test_weekday_rehearsal_restores_only_database_secrets_caddy_and_the_audio_sample(staging: Host, day: str) -> None:
    r = staging.run("staging.sh", "rehearse", ECLUME_REHEARSAL_DAY=day, ECLUME_STAGING_SHA=SHA, FAKE_NO_CLAUDE="1")

    assert r.returncode == 0, r.stderr + r.stdout
    first, second = staging.restic("sh")
    for path in ("/eclume/pg", "/eclume/secrets", "/eclume/caddy"):
        assert path in first
    assert "/eclume/minio" not in " ".join(first)
    assert "/eclume/minio/rec/audio.ogg" in second
    # The summary and chat smoke waits for Sunday, and the kept server works without `claude`.
    assert "--read-only" in (staging.bin / "smoke.args").read_text()
    assert not any(" build " in c for c in compose_calls(staging))
    state = staging.state("ensaio")
    assert state["ok"] is True, state
    assert "partial" in state["detalhe"]
    assert "1 audio files" in state["detalhe"]
    # The `restic check` slice goes on every night, otherwise Sunday would always look at the same one.
    assert len(staging.restic("check")) == 1


def test_partial_rehearsal_still_fails_with_a_diverging_content_hash(staging: Host) -> None:
    r = staging.run("staging.sh", "rehearse", ECLUME_REHEARSAL_DAY="2", FAKE_BATCH="rec/audio.ogg|sha256:00")

    assert r.returncode != 0
    assert "content_hash" in staging.state("ensaio")["detalhe"]


def test_up_is_always_the_full_restore(staging: Host) -> None:
    r = staging.run("staging.sh", "up", ECLUME_REHEARSAL_DAY="3")

    assert r.returncode == 0, r.stderr + r.stdout
    (restore,) = staging.restic("sh")
    assert "--include" not in restore


def test_staging_uses_cpu_shares_and_gomaxprocs_in_the_containers(staging: Host) -> None:
    (staging.data.parent / "main" / "deploy" / "docker-compose.staging.yml").write_text(
        "x-anchor: &a\n  restart: no\n\nservices:\n  caddy:\n    image: c\n  edge:\n    image: eclume-edge:staging\n"
    )

    r = staging.run("staging.sh", "rehearse")

    assert r.returncode == 0, r.stderr + r.stdout
    for call in docker_run(staging, "restic"):
        assert "--cpu-shares 256" in call
        assert "GOMAXPROCS=1" in call
    yml = Path(staging.env["STAGING_DIR"], "cpu-shares.yml").read_text()
    assert yml == "services:\n  caddy:\n    cpu_shares: 256\n  edge:\n    cpu_shares: 256\n"
    assert all(f"-f {staging.env['STAGING_DIR']}/cpu-shares.yml" in c for c in compose_calls(staging))


# --- proportional backup: limits, Sunday prune and log rotation -----------------------------------


def test_sunday_backup_prunes_both_repositories(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text("RESTIC_REPOSITORY=s3:https://b2.example/eclume\n")

    r = host.run("backup.sh", ECLUME_BACKUP_DAY="7")

    assert r.returncode == 0, r.stderr
    forgets = host.restic("forget")
    assert len(forgets) == 2
    assert all("--prune" in f for f in forgets)


def test_weekday_backup_only_forgets_without_prune(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text("RESTIC_REPOSITORY=s3:https://b2.example/eclume\n")

    for day in ("1", "4", "6"):
        r = host.run("backup.sh", ECLUME_BACKUP_DAY=day)
        assert r.returncode == 0, r.stderr
    forgets = host.restic("forget")
    assert len(forgets) == 6
    assert all("--prune" not in f and "--keep-daily" in f for f in forgets)


def test_backup_runs_every_container_with_cpu_shares_and_one_go_core(host: Host) -> None:
    (host.secrets / "restic-fora.env").write_text("RESTIC_REPOSITORY=s3:https://b2.example/eclume\n")

    r = host.run("backup.sh", ECLUME_BACKUP_DAY="2")

    assert r.returncode == 0, r.stderr
    runs = [c for c in host.calls() if c[0] == "run"]
    assert len(runs) >= 5  # mc, backup, forget, sha256, copy, forget
    for c in runs:
        assert c[c.index("--cpu-shares") + 1] == "256", c
        assert "GOMAXPROCS=1" in c, c
    (backup,) = host.restic("backup")
    assert backup[backup.index("--read-concurrency") + 1] == "1"


def test_backup_rotates_the_big_logs_and_leaves_the_small_ones(host: Host) -> None:
    dest = host.data / "backups"
    (dest / "backup.log").write_text("x" * 3000)
    (dest / "ensaio.log").write_text("y" * 10)

    r = host.run("backup.sh", ECLUME_LOG_MAX_KB="2", ECLUME_BACKUP_DAY="2")

    assert r.returncode == 0, r.stderr
    assert (dest / "backup.log.1").read_text() == "x" * 3000
    assert not (dest / "backup.log").exists()
    assert (dest / "ensaio.log").read_text() == "y" * 10
    assert not (dest / "ensaio.log.1").exists()


def test_releases_run_the_containers_with_cpu_shares_and_prune_dist() -> None:
    for name in ("release-desktop.sh", "release-mobile.sh"):
        text = (DEPLOY / name).read_text(encoding="utf-8")
        assert "--cpus 2 --cpu-shares 256" in text, name
        assert "ls -dt dist-* 2>/dev/null | tail -n +4 | xargs -r rm -rf" in text, name
        # Each release `docker run` carries the weight, directly or through the `common` array.
        for line in text.splitlines():
            if line.strip().startswith("docker run ") and "common" not in line:
                assert "--cpu-shares 256" in line, (name, line)


@pytest.mark.parametrize("mode", ["database", "apply"])
def test_restore_does_not_delete_the_work_inherited_from_the_environment(
    host: Host, dump_pre_deploy: Path, tmp_path: Path, mode: str
) -> None:
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / "x").write_text("x")
    if mode == "database":
        r = host.run("restore-backup.sh", "--database", str(dump_pre_deploy), "--confirm", work=str(victim))
    else:
        r = host.run("restore-backup.sh", "--apply", "latest", "--confirm", work=str(victim), FAKE_RUNNING="postgres")

    assert (r.returncode == 0) == (mode == "database"), r.stderr
    assert (victim / "x").exists()


def interrupt_at(host: Host, dump: Path, fragment: str) -> subprocess.CompletedProcess[str]:
    proc = subprocess.Popen(
        ["bash", str(DEPLOY / "restore-backup.sh"), "--database", str(dump), "--confirm"],
        env={**host.env, "FAKE_HANG_AT": fragment},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + 20
        while not (host.bin / "hung").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert (host.bin / "hung").exists(), "the fake docker did not reach the expected SQL"
        os.killpg(proc.pid, signal.SIGINT)
        out, err = proc.communicate(timeout=20)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
    return subprocess.CompletedProcess(proc.args, proc.returncode, out, err)


def test_restore_sigint_at_the_second_rename_without_eclume_does_not_restart_and_says_how_to_recover(
    host: Host, dump_pre_deploy: Path
) -> None:
    r = interrupt_at(host, dump_pre_deploy, "alter database eclume_restore_novo rename to eclume")

    assert r.returncode != 0
    assert databases(host) == {"eclume_antes", "eclume_restore_novo"}
    assert not restarted(host)
    assert "measured state" in r.stderr
    assert "eclume_antes=yes" in r.stderr
    assert "eclume_restore_novo=yes" in r.stderr
    assert "rename to eclume" in r.stderr


def test_restore_sigint_with_eclume_present_restarts_the_services(host: Host, dump_pre_deploy: Path) -> None:
    r = interrupt_at(host, dump_pre_deploy, "alter database eclume rename to eclume_antes")

    assert r.returncode != 0
    assert "eclume" in databases(host)
    assert restarted(host)


# --- deprecated pt-BR names: still read, the English one wins ----------------------------------------


@pytest.mark.parametrize(
    ("env", "pruned"),
    [({"ECLUME_BACKUP_DIA": "7"}, True), ({"ECLUME_BACKUP_DAY": "3", "ECLUME_BACKUP_DIA": "7"}, False)],
)
def test_backup_day_reads_the_deprecated_name_and_the_new_one_wins(
    host: Host, env: dict[str, str], *, pruned: bool
) -> None:
    r = host.run("backup.sh", **env)

    assert r.returncode == 0, r.stderr
    (forget,) = host.restic("forget")
    assert ("--prune" in forget) is pruned


@pytest.mark.parametrize(("env", "kept"), [({"MANTER": "4"}, "4"), ({"KEEP": "5", "MANTER": "4"}, "5")])
def test_backup_retention_reads_keep_and_the_deprecated_manter(host: Host, env: dict[str, str], kept: str) -> None:
    r = host.run("backup.sh", **env)

    assert r.returncode == 0, r.stderr
    (forget,) = host.restic("forget")
    assert forget[forget.index("--keep-daily") + 1] == kept


def test_rehearsal_day_reads_the_deprecated_name(staging: Host) -> None:
    del staging.env["ECLUME_REHEARSAL_DAY"]
    r = staging.run("staging.sh", "rehearse", ECLUME_ENSAIO_DIA="3")

    assert r.returncode == 0, r.stderr + r.stdout
    assert "partial" in staging.state("ensaio")["detalhe"]


@pytest.mark.parametrize("name", ["ECLUME_STAGING_BATCH", "ECLUME_STAGING_LOTE"])
def test_rehearsal_batch_size_reads_the_new_and_the_deprecated_name(staging: Host, name: str) -> None:
    r = staging.run("staging.sh", "rehearse", **{name: "5"})

    assert r.returncode == 0, r.stderr + r.stdout
    assert any("limit 5" in c for c in compose_calls(staging))


def test_partial_rehearsal_on_a_main_before_the_rename_passes_the_pt_br_read_only_flag(staging: Host) -> None:
    """A `main` whose smoke_prod.py only knows `--somente-leitura` still gets the flag it speaks."""
    smoke = staging.data.parent / "main" / "deploy" / "smoke_prod.py"
    smoke.write_text(smoke.read_text().replace("# --read-only\n", ""))

    r = staging.run("staging.sh", "rehearse", ECLUME_REHEARSAL_DAY="2")

    assert r.returncode == 0, r.stderr + r.stdout
    assert "--somente-leitura" in (staging.bin / "smoke.args").read_text()
