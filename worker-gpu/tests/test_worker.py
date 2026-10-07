import subprocess
import sys

import pytest

import eclume_engines
import eclume_worker


def test_pacote_importa_e_enxerga_a_interface_de_engine():
    # As três partes Python são a linha "produto" e andam juntas (deploy/versao.py).
    assert eclume_worker.__version__ == eclume_engines.__version__


def test_importar_o_worker_nao_carrega_torch_nem_whisperx():
    codigo = (
        "import sys, eclume_worker.worker\n"
        "pesados = [m for m in ('torch', 'whisperx', 'faster_whisper', 'ctranslate2', 'pyannote') if m in sys.modules]\n"
        "assert not pesados, pesados\n"
    )
    subprocess.run([sys.executable, "-c", codigo], check=True)  # noqa: S603 — interpretador do próprio teste


def test_worker_settings_do_contrato():
    from eclume_worker.worker import WorkerSettings  # noqa: PLC0415 — lê o ambiente ao importar

    assert WorkerSettings.queue_name == "eclume:gpu"
    assert WorkerSettings.max_jobs == 1
    assert WorkerSettings.max_tries == 1
    [job] = WorkerSettings.functions
    assert job.name == "transcribe"
    assert job.max_tries == 1
    # Fase A da fila sem pickle: o worker lê JSON e o pickle antigo sem globais.
    from eclume_engines.fila import desserializar  # noqa: PLC0415

    assert WorkerSettings.job_deserializer is desserializar
    # SIGTERM drena: termina o job em curso, até o teto dele, antes de parar.
    assert WorkerSettings.job_completion_wait == WorkerSettings.job_timeout > 0


class _Registro:
    """Registro mínimo: `unload_if_idle` devolve o combinado e `busy` é fixo."""

    def __init__(self, *, descarrega: bool = True, busy: bool = False) -> None:
        self.descarrega = descarrega
        self.busy = busy

    def unload_if_idle(self, _idle_seconds: float) -> bool:
        return self.descarrega


def _ociosidade(registro: _Registro, *, recycle: bool) -> list[int]:
    import asyncio  # noqa: PLC0415

    from eclume_worker.worker import idle_unloader  # noqa: PLC0415

    sinais: list[int] = []

    async def rodar() -> None:
        tarefa = asyncio.create_task(
            idle_unloader(registro, 1.0, 0.0, recycle=recycle, terminate=lambda: sinais.append(1))
        )
        await asyncio.sleep(0.05)
        tarefa.cancel()
        await asyncio.gather(tarefa, return_exceptions=True)

    asyncio.run(rodar())
    return sinais


def test_reciclo_ocioso_encerra_uma_vez_quando_o_torch_foi_importado(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setitem(sys.modules, "torch", object())

    assert _ociosidade(_Registro(), recycle=True) == [1]


def test_reciclo_ocioso_nao_dispara_sem_torch_desligado_com_job_ou_sem_descarga(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    assert _ociosidade(_Registro(), recycle=True) == []  # processo leve: não reinicia a cada janela

    monkeypatch.setitem(sys.modules, "torch", object())
    assert _ociosidade(_Registro(), recycle=False) == []  # ECLUME_RECYCLE_ON_IDLE=0
    assert _ociosidade(_Registro(busy=True), recycle=True) == []  # job em curso
    assert _ociosidade(_Registro(descarrega=False), recycle=True) == []  # nada foi descarregado


def test_encerrar_processo_envia_sigterm_ao_proprio_processo(monkeypatch: pytest.MonkeyPatch):
    import os  # noqa: PLC0415
    import signal  # noqa: PLC0415

    from eclume_worker.worker import _encerrar_processo  # noqa: PLC0415

    chamadas: list[tuple[int, int]] = []
    monkeypatch.setattr(os, "kill", lambda pid, sig: chamadas.append((pid, sig)))

    _encerrar_processo()

    assert chamadas == [(os.getpid(), signal.SIGTERM)]


def test_reciclo_ocioso_vem_ligado_e_desliga_pelo_ambiente():
    from eclume_worker.config import WorkerConfig  # noqa: PLC0415

    assert WorkerConfig.from_env({}).recycle_on_idle is True
    assert WorkerConfig.from_env({"ECLUME_RECYCLE_ON_IDLE": "0"}).recycle_on_idle is False
