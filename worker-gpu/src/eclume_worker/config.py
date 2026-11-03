"""Worker configuration, read from the environment."""

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
    """`ECLUME_*` variables of the GPU worker."""

    redis_url: str = "redis://localhost:6379/0"
    s3_bucket: str = "eclume"
    s3_endpoint_url: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_region: str = "us-east-1"
    # Engine forced on the process (dev without a GPU: `cpu`); when empty, the job's `options.engine` applies.
    engine: str | None = None
    device: str = "cuda"
    # Fixed initial ASR batch; when empty, the engine picks it from the free VRAM.
    batch_size: int | None = None
    model_idle_seconds: float = 300.0
    # ASR resident between jobs (whisperx-local engine) while this much VRAM is free with it
    # loaded; `ECLUME_KEEP_ASR_RESIDENT=0` goes back to one model at a time.
    keep_asr_resident: bool = True
    resident_min_free_mb: int = 2500
    # After the idle unload, exit the process if torch was imported: torch, CTranslate2 and the
    # glibc arenas do not give the RAM back, and the container comes up again without them.
    # `ECLUME_RECYCLE_ON_IDLE=0` keeps the process.
    recycle_on_idle: bool = True
    job_timeout_seconds: int = 6 * 3600
    work_dir: Path = Path("/tmp/eclume-work")  # noqa: S108 — container working directory
    remote_base_url: str | None = None
    remote_api_key: str | None = None
    remote_model: str | None = None
    # The same as the server's: they open the HF token that arrives encrypted in the job `options`.
    encryption_key: str | None = None
    secret_key: str | None = None
    # RNNoise model (`arnndn`) for preprocessing; without it, noise reduction uses `afftdn`.
    rnnoise_model: str | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> WorkerConfig:
        """Read the environment; missing values use the defaults above."""
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
            keep_asr_resident=str(get("ECLUME_KEEP_ASR_RESIDENT", "1")).lower() not in {"0", "false", "no", "nao"},
            resident_min_free_mb=int(get("ECLUME_RESIDENT_MIN_FREE_MB", defaults.resident_min_free_mb)),
            recycle_on_idle=str(get("ECLUME_RECYCLE_ON_IDLE", "1")).lower() not in {"0", "false", "no", "nao"},
            job_timeout_seconds=int(get("ECLUME_JOB_TIMEOUT_SECONDS", defaults.job_timeout_seconds)),
            work_dir=Path(get("ECLUME_WORK_DIR", defaults.work_dir)),
            remote_base_url=get("ECLUME_REMOTE_BASE_URL"),
            remote_api_key=get("ECLUME_REMOTE_API_KEY"),
            remote_model=get("ECLUME_REMOTE_MODEL"),
            encryption_key=get("ECLUME_ENCRYPTION_KEY"),
            secret_key=get("ECLUME_SECRET_KEY"),
            rnnoise_model=get("ECLUME_RNNOISE_MODEL"),
        )
