"""Crons do worker: o registro de `WorkerSettings` e as três tarefas que não tinham teste.

O registro é uma tabela literal, de propósito: tirar um cron ou mudar a agenda obriga a rever o teste.
"""

from __future__ import annotations

from eclume_server.config import Settings
from eclume_server.worker import (
    dispatch_transcriptions,
    drain_storage_deletions,
    expire_pairing_codes,
    expire_uploads,
    purge_expired,
    reap_stalled_jobs,
    reconcile_storage,
    resume_pipelines,
    worker_settings,
)

# (função, minuto, hora, dia da semana, segundo): o que o arq guarda em cada campo da agenda.
CRONS = [
    (expire_uploads, {0, 30}, None, None, 0),
    (expire_pairing_codes, 15, None, None, 0),
    (purge_expired, 40, 3, None, 0),
    (reap_stalled_jobs, None, None, None, 0),
    (dispatch_transcriptions, None, None, None, 15),
    (resume_pipelines, set(range(2, 60, 5)), None, None, 0),
    (drain_storage_deletions, None, None, None, 30),
    (reconcile_storage, 0, 4, "sun", 0),
]


def test_registro_dos_oito_crons_com_agenda_unique_e_sem_run_at_startup():
    registrados = worker_settings(Settings())["cron_jobs"]
    assert [job.coroutine for job in registrados] == [c[0] for c in CRONS]
    for job, (func, minute, hour, weekday, second) in zip(registrados, CRONS, strict=True):
        assert job.name == f"cron:{func.__name__}"
        assert (job.minute, job.hour, job.weekday, job.second) == (minute, hour, weekday, second), job.name
        assert (job.month, job.day, job.microsecond) == (None, None, 123456), job.name
        assert job.run_at_startup is False, job.name
        assert job.unique is True, job.name
