"""Server configuration, read from the environment (`ECLUME_*`)."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment variables of the server and of the CPU worker."""

    model_config = SettingsConfigDict(env_prefix="ECLUME_", env_file=None)

    # In production, this URL's role is `eclume_server` (no superuser, DML only); only the one-shot
    # `migrate` uses the schema owner. In dev, the superuser serves both. Requests drop down to
    # `eclume_app` per transaction (`docs/standards/code/server-nucleo.md` `§Papéis do banco`).
    database_url: str = "postgresql+asyncpg://eclume:eclume@127.0.0.1:5432/eclume"
    # When set, `eclume-server migrate` enables LOGIN for `eclume_server` with this password.
    runtime_db_password: str | None = None
    # Connection pool of the process (`ECLUME_DB_POOL_SIZE`, `ECLUME_DB_MAX_OVERFLOW`); when unset,
    # 5/5 in the API and 3/2 in the worker (`db.session.make_runtime_engine`).
    db_pool_size: int | None = None
    db_max_overflow: int | None = None
    redis_url: str = "redis://127.0.0.1:6379/0"

    s3_endpoint: str = "http://127.0.0.1:9000"
    s3_access_key: str = "eclume"
    s3_secret_key: str = "eclume-dev-secret"  # noqa: S105 — dev default (deploy/.env.example)
    s3_bucket: str = "eclume"
    s3_region: str = "us-east-1"

    # Signs the upload part URLs. In production, a long random secret.
    secret_key: str = "eclume-dev-insecure-secret"  # noqa: S105 — dev default
    # Absolute base of the URLs returned to the client (part URL). When unset, the request's own.
    public_url: str | None = None
    # Server name in the descriptor (`GET /api/v1/server`) and the instance announced over mDNS.
    server_name: str = "eclume"
    # PEM of the root CA the apps pin (in production, the one published at /downloads/eclume-root.crt).
    ca_file: str | None = None
    # PEM of the next root during rotation (in production, /downloads/eclume-root-proxima.crt); the
    # descriptor announces it in `ca_next_sha256` over the connection already pinned to the current root.
    ca_next_file: str | None = None
    # `false` only for plain-HTTP dev: the Secure cookie does not come back over HTTP.
    cookie_secure: bool = True
    session_ttl_days: int = 14
    # The admin session is shorter: the panel changes the whole platform.
    admin_session_ttl_hours: int = 12
    # Attempts per minute and per IP on the routes that check a credential (login, signup, admin
    # login, `/devices/*`); one more gets 429 `rate_limited`.
    credential_attempts_per_minute: int = 10
    # Login failures per (account, IP) pair in 15 min; beyond them, 429 until the window expires. Success resets.
    login_failures_per_pair: int = 10
    # Login failures of the account in 1 h, across IPs; beyond them, only an IP with a good login in 30 days gets in.
    login_failures_per_account: int = 100
    # Open signup (`POST /auth/signup`); `false` closes it without a code deploy.
    signup_open: bool = True
    # Signups created per IP in a sliding 24 h window (`ECLUME_SIGNUPS_PER_IP_PER_DAY`); the next one
    # gets 429 `rate_limited`. Only a created signup counts.
    signups_per_ip_per_day: int = 5

    # Cipher for the providers' API keys (base64 of 32 bytes). When unset, derived from
    # `secret_key` by HKDF: changing `secret_key` without this variable invalidates the stored keys.
    encryption_key: str | None = None
    # Claude Code CLI executable used by the `claude-cli` provider.
    claude_bin: str = "claude"

    # Dead transcription job (docs/standards/api/jobs-transcricao.md §Job morto): the suspicion only
    # becomes a failure after lasting the grace period; progress stalled beyond the ceiling is a failure even with a live worker.
    # Git SHA of the image (`ECLUME_COMMIT`, written by the deploy at build time); empty outside it.
    commit: str = ""

    job_grace_seconds: float = 120
    job_stall_seconds: float = 30 * 60

    # Slots of the agent worker (`eclume:agents`): how many agent calls run together.
    agent_max_jobs: int = 4

    upload_part_size: int = 8 * 1024 * 1024
    upload_ttl_days: int = 7
    part_url_ttl_seconds: int = 3600


@lru_cache
def get_settings() -> Settings:
    """Process configuration, read once."""
    return Settings()
