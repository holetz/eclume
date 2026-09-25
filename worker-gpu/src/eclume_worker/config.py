"""Configuração do worker, lida do ambiente."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Mapping

GPU_QUEUE = "eclume:gpu"
DEFAULT_QUEUE = "eclume:default"


@dataclass(frozen=True)
class WorkerConfig:
    """Variáveis `ECLUME_*` do worker GPU."""

    redis_url: str = "redis://localhost:6379/0"
    s3_bucket: str = "eclume"
    s3_endpoint_url: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_region: str = "us-east-1"
    # Engine forçada no processo (dev sem GPU: `cpu`); vazia, vale `options.engine` do job.
    engine: str | None = None
    device: str = "cuda"
    # Lote inicial fixo do ASR; vazio, a engine o escolhe pela VRAM livre.
    batch_size: int | None = None
    model_idle_seconds: float = 300.0
    job_timeout_seconds: int = 6 * 3600
    work_dir: Path = Path("/tmp/eclume-work")  # noqa: S108 — diretório de trabalho do container
    remote_base_url: str | None = None
    remote_api_key: str | None = None
    remote_model: str | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> WorkerConfig:
        """Lê o ambiente; ausências usam os padrões acima."""
        env = os.environ if env is None else env
        defaults = cls()

        def get(name: str, default: Any = None) -> Any:  # noqa: ANN401
            value = env.get(name)
            return default if value in {None, ""} else value

        return cls(
            redis_url=get("ECLUME_REDIS_URL", defaults.redis_url),
            s3_bucket=get("ECLUME_S3_BUCKET", defaults.s3_bucket),
            s3_endpoint_url=get("ECLUME_S3_ENDPOINT_URL"),
            s3_access_key=get("ECLUME_S3_ACCESS_KEY"),
            s3_secret_key=get("ECLUME_S3_SECRET_KEY"),
            s3_region=get("ECLUME_S3_REGION", defaults.s3_region),
            engine=get("ECLUME_ENGINE"),
            device=get("ECLUME_DEVICE", defaults.device),
            batch_size=int(get("ECLUME_BATCH_SIZE")) if get("ECLUME_BATCH_SIZE") else None,
            model_idle_seconds=float(get("ECLUME_MODEL_IDLE_SECONDS", defaults.model_idle_seconds)),
            job_timeout_seconds=int(get("ECLUME_JOB_TIMEOUT_SECONDS", defaults.job_timeout_seconds)),
            work_dir=Path(get("ECLUME_WORK_DIR", defaults.work_dir)),
            remote_base_url=get("ECLUME_REMOTE_BASE_URL"),
            remote_api_key=get("ECLUME_REMOTE_API_KEY"),
            remote_model=get("ECLUME_REMOTE_MODEL"),
        )
