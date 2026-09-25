"""Configuração do server, lida do ambiente (`ECLUME_*`)."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Variáveis de ambiente do server e do worker CPU."""

    model_config = SettingsConfigDict(env_prefix="ECLUME_", env_file=None)

    # O papel desta URL é o dono do schema (superusuário no dev): roda migrations e operações de
    # sistema. As requisições baixam para `eclume_app` por transação (docs/standards/code/server-nucleo.md).
    database_url: str = "postgresql+asyncpg://eclume:eclume@127.0.0.1:5432/eclume"
    redis_url: str = "redis://127.0.0.1:6379/0"

    s3_endpoint: str = "http://127.0.0.1:9000"
    s3_access_key: str = "eclume"
    s3_secret_key: str = "eclume-dev-secret"  # noqa: S105 — padrão de dev (deploy/.env.example)
    s3_bucket: str = "eclume"
    s3_region: str = "us-east-1"

    # Assina as URLs de parte do upload. Em produção, um segredo longo e aleatório.
    secret_key: str = "eclume-dev-insecure-secret"  # noqa: S105 — padrão de dev
    # Base absoluta das URLs devolvidas ao cliente (URL de parte). Sem valor, a da requisição.
    public_url: str | None = None
    # `false` só para dev em HTTP puro: o cookie Secure não volta por HTTP.
    cookie_secure: bool = True
    session_ttl_days: int = 14

    upload_part_size: int = 8 * 1024 * 1024
    upload_ttl_days: int = 7
    part_url_ttl_seconds: int = 3600


@lru_cache
def get_settings() -> Settings:
    """Configuração do processo, lida uma vez."""
    return Settings()
