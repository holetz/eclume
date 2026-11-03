# ruff: noqa: INP001, S101, S603, S607, D102, D103, D107, PLR2004  # loose tests of the deploy scripts; deploy/ is not a Python package
"""Tests of `watchdog.sh` with fake `docker`, `df`, `nvidia-smi` and `saude --json`."""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

import pytest

WATCHDOG = Path(__file__).with_name("watchdog.sh")

HEALTH_OK = {
    "summary": {"queued_over_2h": 0, "failed_last_24h": 0, "provider_auth_last_24h": 0, "services_down": []},
    "claude_token": {"status": "ok", "days_left": 200},
    "health": {"worker": {"engine": "whisperx"}},
}
CONTAINERS_OK = "server running Up 2 hours (healthy)\nmigrate exited Exited (0) 2 hours ago\n"


class Host:
    """A temporary ECLUME_DATA_DIR and the fake commands on PATH."""

    def __init__(self, tmp_path: Path) -> None:
        self.data = tmp_path / "srv"
        (self.data / "estado").mkdir(parents=True)
        (self.data / "backups").mkdir()
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        self.disk = 40
        self.health: dict | None = HEALTH_OK
        self.containers = CONTAINERS_OK
        self.nvidia_ok = True
        self.extra_env: dict[str, str] = {}
        self.backup_ok("state")

    def backup_ok(self, where: str, hours: float = 1) -> None:
        """Last backup with ok `hours` ago, in the json (#91) or only in the log."""
        json_path = self.data / "estado" / "backup.json"
        when = time.time() - hours * 3600
        if where == "state":
            json_path.write_text('{"ok": true}')
            os.utime(json_path, (when, when))
        else:
            json_path.unlink(missing_ok=True)
            stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(when))
            (self.data / "backups" / "backup.log").write_text(f"{stamp} ok: 1G of database, 3 files in the bucket\n")

    def _fake(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text("#!/usr/bin/env bash\n" + body)
        path.chmod(0o755)

    def run(self, *args: str) -> str:
        health = json.dumps(self.health) if self.health is not None else ""
        (self.bin / "saude.json").write_text(health)
        (self.bin / "ps-a.txt").write_text(self.containers)
        self._fake(
            "docker",
            f"""case "$1 $2" in
  "ps -q") echo cid-server ;;
  "ps -a") cat {self.bin}/ps-a.txt ;;
  "exec cid-server") [[ -s {self.bin}/saude.json ]] && cat {self.bin}/saude.json || exit 1 ;;
esac
""",
        )
        self._fake("df", f'printf "Use%%\\n {self.disk}%%\\n"\n')
        self._fake("nvidia-smi", "exit 0\n" if self.nvidia_ok else "exit 9\n")
        self._fake("logger", "exit 0\n")
        env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "ECLUME_DATA_DIR": str(self.data),
            **self.extra_env,
        }
        result = subprocess.run(["bash", str(WATCHDOG), *args], env=env, capture_output=True, text=True, check=True)
        return result.stdout

    def alerts(self) -> list[str]:
        log = self.data / "estado" / "vigia" / "alertas.log"
        return log.read_text().splitlines() if log.exists() else []


@pytest.fixture
def host(tmp_path: Path) -> Host:
    return Host(tmp_path)


def test_all_well_sends_nothing(host: Host) -> None:
    """Without an active condition, no message."""
    host.run()
    assert host.alerts() == []


def test_alerts_once_repeats_in_6h_and_notices_the_return(host: Host) -> None:
    """A full disk alerts once, repeats after 6 h and sends the back-to-normal notice."""
    host.disk = 91
    host.run()
    host.run()
    assert len(host.alerts()) == 1
    assert "ALERT disco" in host.alerts()[0]
    marker = host.data / "estado" / "vigia" / "disco.alerta"
    marker.write_text(str(int(time.time()) - 6 * 3600))
    host.run()
    assert len(host.alerts()) == 2
    host.disk = 50
    host.run()
    assert "normal disco" in host.alerts()[-1]
    assert not marker.exists()


def test_simulate_prints_without_sending_or_writing(host: Host) -> None:
    """`--simulate` shows the alerts and does not touch the state."""
    host.disk = 95
    output = host.run("--simulate")
    assert "[simulated]" in output
    assert "ALERT disco" in output
    assert not (host.data / "estado" / "vigia").exists()


@pytest.mark.parametrize("name", ["WATCHDOG_DISK_PCT", "VIGIA_DISCO_PCT"])
def test_disk_limit_reads_the_new_name_and_the_deprecated_one(host: Host, name: str) -> None:
    """The disk limit comes from WATCHDOG_DISK_PCT, or from the deprecated VIGIA_DISCO_PCT."""
    host.disk = 60
    assert "ALERT disco" not in host.run("--simulate")
    host.extra_env = {name: "50"}
    assert "ALERT disco" in host.run("--simulate")


def test_the_new_name_wins_over_the_deprecated_one(host: Host) -> None:
    """With both set, WATCHDOG_DISK_PCT holds."""
    host.disk = 60
    host.extra_env = {"WATCHDOG_DISK_PCT": "90", "VIGIA_DISCO_PCT": "50"}
    assert "ALERT disco" not in host.run("--simulate")


def test_old_backup_by_the_json_and_by_the_log(host: Host) -> None:
    """A backup without ok for more than 26 h alerts, read from #91's json or, without it, from backup.log."""
    host.backup_ok("state", hours=30)
    assert "ALERT backup" in host.run("--simulate")
    host.backup_ok("log", hours=30)
    assert "ALERT backup" in host.run("--simulate")
    host.backup_ok("log", hours=2)
    assert "backup" not in host.run("--simulate")


def test_backup_with_ok_false_alerts(host: Host) -> None:
    """A run that finished without ok alerts at once."""
    (host.data / "estado" / "backup.json").write_text('{"ok": false, "detalhe": "pg_dump"}')
    assert "without ok" in host.run("--simulate")


def test_container_only_alerts_on_the_second_run(host: Host) -> None:
    """An unhealthy container only alerts in two runs in a row; a one-shot does not count."""
    host.containers = "server running Up 1 hour (unhealthy)\nminio-init exited Exited (0) 1 hour ago\n"
    host.run()
    assert host.alerts() == []
    host.run()
    assert "ALERT conteiner" in host.alerts()[0]
    assert "server(running)" in host.alerts()[0]
    assert "minio-init" not in host.alerts()[0]


def test_application_numbers(host: Host) -> None:
    """Old queue, failures, provider_auth, expiring token and GPU worker without heartbeat."""
    host.health = {
        "summary": {"queued_over_2h": 1, "failed_last_24h": 1, "provider_auth_last_24h": 1, "services_down": []},
        "claude_token": {"status": "ok", "days_left": 12},
        "health": {"worker": None},
    }
    output = host.run("--simulate")
    for key in ("ALERT fila", "ALERT falhas", "ALERT token", "ALERT gpu"):
        assert key in output
    assert "12 day" in output


def test_clean_restart_of_the_gpu_worker_does_not_alert(host: Host) -> None:
    """The idle recycle (#149) deletes the heartbeat for seconds: one run without it does not alert, two do."""
    host.containers = "worker-gpu restarting Restarting (0) 2 seconds ago\n" + CONTAINERS_OK
    host.health = {**HEALTH_OK, "health": {"worker": None}}
    host.run()
    assert host.alerts() == []
    host.health = HEALTH_OK
    host.containers = "worker-gpu running Up 3 seconds (health: starting)\n" + CONTAINERS_OK
    host.run()
    host.health = {**HEALTH_OK, "health": {"worker": None}}
    host.run()
    assert host.alerts() == []
    host.run()
    assert "ALERT gpu" in host.alerts()[0]
    assert "no GPU worker heartbeat" in host.alerts()[0]


def test_token_without_a_date_warns_once(host: Host) -> None:
    """Token only in the env: the unknown-expiry notice goes only once."""
    host.health = {**HEALTH_OK, "claude_token": {"status": "unknown", "days_left": None}}
    host.run()
    host.run()
    assert [line for line in host.alerts() if "unknown" in line] == [host.alerts()[0]]


def test_failing_nvidia_smi_and_server_down(host: Host) -> None:
    """`nvidia-smi` with an error alerts the GPU; without `saude --json`, it alerts the server."""
    host.nvidia_ok = False
    assert "nvidia-smi failed" in host.run("--simulate")
    host.health = None
    assert "ALERT saude" in host.run("--simulate")
