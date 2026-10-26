import subprocess
import sys

import pytest

import eclume_engines
import eclume_worker


def test_package_imports_and_sees_the_engine_interface():
    # The three Python parts are the "product" line and move together (deploy/versao.py).
    assert eclume_worker.__version__ == eclume_engines.__version__


def test_importing_the_worker_loads_neither_torch_nor_whisperx():
    code = (
        "import sys, eclume_worker.worker\n"
        "heavy = [m for m in ('torch', 'whisperx', 'faster_whisper', 'ctranslate2', 'pyannote') if m in sys.modules]\n"
        "assert not heavy, heavy\n"
    )
    subprocess.run([sys.executable, "-c", code], check=True)  # noqa: S603 — the test's own interpreter


def test_worker_settings_of_the_contract():
    from eclume_worker.worker import WorkerSettings  # noqa: PLC0415 — reads the environment on import

    assert WorkerSettings.queue_name == "eclume:gpu"
    assert WorkerSettings.max_jobs == 1
    assert WorkerSettings.max_tries == 1
    [job] = WorkerSettings.functions
    assert job.name == "transcribe"
    assert job.max_tries == 1
    # Phase A of the pickle-free queue: the worker reads JSON and the old pickle with no globals.
    from eclume_engines.queue_codec import deserialize  # noqa: PLC0415

    assert WorkerSettings.job_deserializer is deserialize
    # SIGTERM drains: it finishes the running job, up to its ceiling, before stopping.
    assert WorkerSettings.job_completion_wait == WorkerSettings.job_timeout > 0
    assert WorkerSettings.poll_delay == 2.0


class _Registry:
    """Minimal registry: `unload_if_idle` returns the agreed value and `busy` is fixed."""

    def __init__(self, *, unloads: bool = True, busy: bool = False) -> None:
        self.unloads = unloads
        self.busy = busy

    def unload_if_idle(self, _idle_seconds: float) -> bool:
        return self.unloads


def _idleness(registry: _Registry, *, recycle: bool) -> list[int]:
    import asyncio  # noqa: PLC0415

    from eclume_worker.worker import idle_unloader  # noqa: PLC0415

    signals: list[int] = []

    async def run() -> None:
        task = asyncio.create_task(
            idle_unloader(registry, 1.0, 0.0, recycle=recycle, terminate=lambda: signals.append(1))
        )
        await asyncio.sleep(0.05)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())
    return signals


def test_idle_recycle_exits_once_when_torch_was_imported(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setitem(sys.modules, "torch", object())

    assert _idleness(_Registry(), recycle=True) == [1]


def test_idle_recycle_does_not_fire_without_torch_when_off_with_a_job_or_without_unload(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    assert _idleness(_Registry(), recycle=True) == []  # light process: does not restart on every window

    monkeypatch.setitem(sys.modules, "torch", object())
    assert _idleness(_Registry(), recycle=False) == []  # ECLUME_RECYCLE_ON_IDLE=0
    assert _idleness(_Registry(busy=True), recycle=True) == []  # running job
    assert _idleness(_Registry(unloads=False), recycle=True) == []  # nothing was unloaded


def test_terminate_process_envia_sigterm_ao_proprio_processo(monkeypatch: pytest.MonkeyPatch):
    import os  # noqa: PLC0415
    import signal  # noqa: PLC0415

    from eclume_worker.worker import _terminate_process  # noqa: PLC0415

    calls: list[tuple[int, int]] = []
    monkeypatch.setattr(os, "kill", lambda pid, sig: calls.append((pid, sig)))

    _terminate_process()

    assert calls == [(os.getpid(), signal.SIGTERM)]


def test_idle_recycle_is_on_and_turns_off_through_the_environment():
    from eclume_worker.config import WorkerConfig  # noqa: PLC0415

    assert WorkerConfig.from_env({}).recycle_on_idle is True
    assert WorkerConfig.from_env({"ECLUME_RECYCLE_ON_IDLE": "0"}).recycle_on_idle is False
