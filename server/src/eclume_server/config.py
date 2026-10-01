"""Configuração do server, lida do ambiente (`ECLUME_*`)."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Variáveis de ambiente do server e do worker CPU."""

    model_config = SettingsConfigDict(env_prefix="ECLUME_", env_file=None)

    # Em produção, o papel desta URL é `eclume_server` (sem superusuário, só DML); só o one-shot
    # `migrate` usa o dono do schema. No dev, o superusuário serve aos dois. As requisições baixam
    # para `eclume_app` por transação (docs/standards/code/server-nucleo.md §Papéis do banco).
    database_url: str = "postgresql+asyncpg://eclume:eclume@127.0.0.1:5432/eclume"
    # Com valor, `eclume-server migrate` liga o LOGIN de `eclume_server` com esta senha.
    runtime_db_password: str | None = None
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
    # Nome do servidor no descritor (`GET /api/v1/server`) e a instância anunciada no mDNS.
    server_name: str = "eclume"
    # PEM da CA raiz que os apps fixam (em produção, a publicada em /downloads/eclume-root.crt).
    ca_file: str | None = None
    # `false` só para dev em HTTP puro: o cookie Secure não volta por HTTP.
    cookie_secure: bool = True
    session_ttl_days: int = 14
    # A sessão de admin é mais curta: o painel muda a plataforma inteira.
    admin_session_ttl_hours: int = 12
    # Tentativas por minuto e por IP nas rotas que conferem credencial (login, cadastro, login de
    # admin, `/devices/*`); a mais recebe 429 `rate_limited`.
    credential_attempts_per_minute: int = 10
    # Cadastro aberto (`POST /auth/signup`); `false` o fecha sem deploy de código.
    signup_open: bool = True

    # Cifra das chaves de API dos providers (base64 de 32 bytes). Sem valor, derivada de
    # `secret_key` por HKDF: trocar `secret_key` sem esta variável invalida as chaves guardadas.
    encryption_key: str | None = None
    # Executável da CLI do Claude Code usado pelo provider `claude-cli`.
    claude_bin: str = "claude"

    # Job de transcrição morto (docs/standards/api/jobs-transcricao.md §Job morto): a suspeita só
    # vira falha depois de durar a graça; progresso parado além do teto é falha mesmo com worker vivo.
    # SHA do git da imagem (`ECLUME_COMMIT`, gravado pelo deploy no build); vazio fora dela.
    commit: str = ""

    job_grace_seconds: float = 120
    job_stall_seconds: float = 30 * 60

    # Vagas do worker de agentes (`eclume:agents`): quantas chamadas a agente rodam juntas.
    agent_max_jobs: int = 4

    upload_part_size: int = 8 * 1024 * 1024
    upload_ttl_days: int = 7
    part_url_ttl_seconds: int = 3600


@lru_cache
def get_settings() -> Settings:
    """Configuração do processo, lida uma vez."""
    return Settings()
