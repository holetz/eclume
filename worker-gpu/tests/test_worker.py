import subprocess
import sys

import eclume_engines
import eclume_worker


def test_pacote_importa_e_enxerga_a_interface_de_engine():
    assert eclume_worker.__version__ == "0.1.0"
    assert eclume_engines.__version__ == "0.1.0"


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
