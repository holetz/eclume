# ruff: noqa: INP001, S101, S603, S607, D102, D103, D107, PLR2004  # testes soltos dos scripts de deploy; deploy/ não é pacote Python
"""Testes do `vigia.sh` com `docker`, `df`, `nvidia-smi` e `saude --json` falsos."""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

import pytest

VIGIA = Path(__file__).with_name("vigia.sh")

SAUDE_OK = {
    "summary": {"queued_over_2h": 0, "failed_last_24h": 0, "provider_auth_last_24h": 0, "services_down": []},
    "claude_token": {"status": "ok", "days_left": 200},
    "health": {"worker": {"engine": "whisperx"}},
}
CONTEINERES_OK = "server running Up 2 hours (healthy)\nmigrate exited Exited (0) 2 hours ago\n"


class Host:
    """Um ECLUME_DATA_DIR temporário e os comandos falsos no PATH."""

    def __init__(self, tmp_path: Path) -> None:
        self.data = tmp_path / "srv"
        (self.data / "estado").mkdir(parents=True)
        (self.data / "backups").mkdir()
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        self.disco = 40
        self.saude: dict | None = SAUDE_OK
        self.conteineres = CONTEINERES_OK
        self.nvidia_ok = True
        self.backup_ok("estado")

    def backup_ok(self, onde: str, horas: float = 1) -> None:
        """Último backup com ok há `horas`, no json (#91) ou só no log."""
        json_path = self.data / "estado" / "backup.json"
        quando = time.time() - horas * 3600
        if onde == "estado":
            json_path.write_text('{"ok": true}')
            os.utime(json_path, (quando, quando))
        else:
            json_path.unlink(missing_ok=True)
            stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(quando))
            (self.data / "backups" / "backup.log").write_text(f"{stamp} ok: 1G de banco, 3 arquivos no bucket\n")

    def _fake(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text("#!/usr/bin/env bash\n" + body)
        path.chmod(0o755)

    def rodar(self, *args: str) -> str:
        saude = json.dumps(self.saude) if self.saude is not None else ""
        (self.bin / "saude.json").write_text(saude)
        (self.bin / "ps-a.txt").write_text(self.conteineres)
        self._fake(
            "docker",
            f"""case "$1 $2" in
  "ps -q") echo cid-server ;;
  "ps -a") cat {self.bin}/ps-a.txt ;;
  "exec cid-server") [[ -s {self.bin}/saude.json ]] && cat {self.bin}/saude.json || exit 1 ;;
esac
""",
        )
        self._fake("df", f'printf "Use%%\\n {self.disco}%%\\n"\n')
        self._fake("nvidia-smi", "exit 0\n" if self.nvidia_ok else "exit 9\n")
        self._fake("logger", "exit 0\n")
        env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", "ECLUME_DATA_DIR": str(self.data)}
        result = subprocess.run(["bash", str(VIGIA), *args], env=env, capture_output=True, text=True, check=True)
        return result.stdout

    def alertas(self) -> list[str]:
        log = self.data / "estado" / "vigia" / "alertas.log"
        return log.read_text().splitlines() if log.exists() else []


@pytest.fixture
def host(tmp_path: Path) -> Host:
    return Host(tmp_path)


def test_tudo_bem_nao_manda_nada(host: Host) -> None:
    """Sem condição ativa, nenhuma mensagem."""
    host.rodar()
    assert host.alertas() == []


def test_alerta_uma_vez_repete_em_6h_e_avisa_a_volta(host: Host) -> None:
    """O disco cheio alerta uma vez, repete depois de 6 h e manda o aviso de volta ao normal."""
    host.disco = 91
    host.rodar()
    host.rodar()
    assert len(host.alertas()) == 1
    assert "ALERTA disco" in host.alertas()[0]
    marca = host.data / "estado" / "vigia" / "disco.alerta"
    marca.write_text(str(int(time.time()) - 6 * 3600))
    host.rodar()
    assert len(host.alertas()) == 2
    host.disco = 50
    host.rodar()
    assert "normal disco" in host.alertas()[-1]
    assert not marca.exists()


def test_simular_imprime_sem_mandar_nem_gravar(host: Host) -> None:
    """`--simular` mostra os alertas e não toca no estado."""
    host.disco = 95
    saida = host.rodar("--simular")
    assert "[simulado]" in saida
    assert "ALERTA disco" in saida
    assert not (host.data / "estado" / "vigia").exists()


def test_backup_velho_pelo_json_e_pelo_log(host: Host) -> None:
    """Backup sem ok há mais de 26 h alerta, lido do json da #91 ou, sem ele, do backup.log."""
    host.backup_ok("estado", horas=30)
    assert "ALERTA backup" in host.rodar("--simular")
    host.backup_ok("log", horas=30)
    assert "ALERTA backup" in host.rodar("--simular")
    host.backup_ok("log", horas=2)
    assert "backup" not in host.rodar("--simular")


def test_backup_com_ok_false_alerta(host: Host) -> None:
    """Rodada que terminou sem ok alerta na hora."""
    (host.data / "estado" / "backup.json").write_text('{"ok": false, "motivo": "pg_dump"}')
    assert "sem ok" in host.rodar("--simular")


def test_conteiner_so_alerta_na_segunda_rodada(host: Host) -> None:
    """Contêiner unhealthy só alerta em duas rodadas seguidas; o de uma execução só não conta."""
    host.conteineres = "server running Up 1 hour (unhealthy)\nminio-init exited Exited (0) 1 hour ago\n"
    host.rodar()
    assert host.alertas() == []
    host.rodar()
    assert "ALERTA conteiner" in host.alertas()[0]
    assert "server(running)" in host.alertas()[0]
    assert "minio-init" not in host.alertas()[0]


def test_numeros_da_aplicacao(host: Host) -> None:
    """Fila velha, falhas, provider_auth, token vencendo e worker GPU sem heartbeat."""
    host.saude = {
        "summary": {"queued_over_2h": 1, "failed_last_24h": 1, "provider_auth_last_24h": 1, "services_down": []},
        "claude_token": {"status": "ok", "days_left": 12},
        "health": {"worker": None},
    }
    saida = host.rodar("--simular")
    for chave in ("ALERTA fila", "ALERTA falhas", "ALERTA token", "ALERTA gpu"):
        assert chave in saida
    assert "12 dia" in saida


def test_token_sem_data_avisa_uma_vez(host: Host) -> None:
    """Token só no env: aviso de validade desconhecida uma vez só."""
    host.saude = {**SAUDE_OK, "claude_token": {"status": "unknown", "days_left": None}}
    host.rodar()
    host.rodar()
    assert [linha for linha in host.alertas() if "desconhecida" in linha] == [host.alertas()[0]]


def test_nvidia_smi_falhando_e_server_fora(host: Host) -> None:
    """`nvidia-smi` com erro alerta a GPU; sem `saude --json`, alerta o server."""
    host.nvidia_ok = False
    assert "nvidia-smi falhou" in host.rodar("--simular")
    host.saude = None
    assert "ALERTA saude" in host.rodar("--simular")
