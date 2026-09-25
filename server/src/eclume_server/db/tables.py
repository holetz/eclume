"""Tabelas do núcleo em SQLAlchemy Core, para consultas tipadas.

O DDL vive nas migrations SQL (`migrations/NNN_*.sql`); estas definições só dão tipos às colunas
(jsonb, arrays, uuid) e nunca criam nada.
"""

from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    FetchedValue,
    Float,
    Integer,
    MetaData,
    Table,
    Text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

metadata = MetaData()


def _uuid(name: str, **kwargs: object) -> Column:
    return Column(name, UUID(as_uuid=True), **kwargs)


def _pk() -> Column:
    """`id` gerado pelo banco (`DEFAULT gen_random_uuid()`)."""
    return _uuid("id", primary_key=True, server_default=FetchedValue())


def _ts(name: str, **kwargs: object) -> Column:
    return Column(name, DateTime(timezone=True), **kwargs)


organizations = Table(
    "organizations",
    metadata,
    _pk(),
    Column("name", Text),
    _ts("created_at"),
)

users = Table(
    "users",
    metadata,
    _pk(),
    _uuid("org_id"),
    Column("email", Text),
    Column("name", Text),
    Column("password_hash", Text),
    Column("role", Text),
    Column("active", Boolean),
    _ts("created_at"),
    _ts("last_login_at"),
)

sessions = Table(
    "sessions",
    metadata,
    _pk(),
    Column("token_hash", Text),
    Column("csrf_token", Text),
    _uuid("user_id"),
    _ts("created_at"),
    _ts("expires_at"),
)

api_tokens = Table(
    "api_tokens",
    metadata,
    _pk(),
    _uuid("org_id"),
    _uuid("user_id"),
    Column("name", Text),
    Column("token_hash", Text),
    Column("prefix", Text),
    Column("scopes", ARRAY(Text)),
    _ts("created_at"),
    _ts("last_used_at"),
    _ts("expires_at"),
    _ts("revoked_at"),
)

groups = Table(
    "groups",
    metadata,
    _pk(),
    _uuid("org_id"),
    Column("name", Text),
    Column("description", Text),
    _ts("created_at"),
)

group_members = Table(
    "group_members",
    metadata,
    _uuid("group_id", primary_key=True),
    _uuid("user_id", primary_key=True),
    _uuid("org_id"),
)

org_settings = Table(
    "org_settings",
    metadata,
    _uuid("org_id", primary_key=True),
    Column("asr", JSONB),
    Column("diarization", JSONB),
    Column("summarization", JSONB),
    Column("voice_identification", JSONB),
    _ts("updated_at"),
    _uuid("updated_by"),
)

recordings = Table(
    "recordings",
    metadata,
    _uuid("id", primary_key=True),
    _uuid("org_id"),
    _uuid("owner_id"),
    Column("title", Text),
    Column("status", Text),
    Column("source", Text),
    _ts("recorded_at"),
    Column("duration_ms", BigInteger),
    Column("language", Text),
    Column("size_bytes", BigInteger),
    Column("content_type", Text),
    Column("content_hash", Text),
    Column("audio_key", Text),
    Column("tags", ARRAY(Text)),
    Column("collection_ids", ARRAY(UUID(as_uuid=True))),
    Column("metadata", JSONB),
    Column("capture", JSONB),
    _ts("created_at"),
    _ts("updated_at"),
)

recording_shares = Table(
    "recording_shares",
    metadata,
    _pk(),
    _uuid("org_id"),
    _uuid("recording_id"),
    Column("target_type", Text),
    _uuid("group_id"),
    _uuid("created_by"),
    _ts("created_at"),
)

uploads = Table(
    "uploads",
    metadata,
    _pk(),
    _uuid("org_id"),
    _uuid("owner_id"),
    Column("status", Text),
    Column("filename", Text),
    Column("content_type", Text),
    Column("size_bytes", BigInteger),
    Column("sha256", Text),
    Column("part_size", BigInteger),
    Column("part_count", Integer),
    _uuid("new_recording_id"),
    _uuid("recording_id"),
    Column("audio_key", Text),
    Column("s3_upload_id", Text),
    Column("request", JSONB),
    _ts("expires_at"),
    _ts("created_at"),
    _ts("completed_at"),
)

transcription_jobs = Table(
    "transcription_jobs",
    metadata,
    _pk(),
    _uuid("org_id"),
    _uuid("recording_id"),
    Column("revision", Integer),
    Column("state", Text),
    Column("attempts", Integer),
    Column("error_code", Text),
    Column("error_message", Text),
    Column("options", JSONB),
    Column("engine_info", JSONB),
    _ts("queued_at"),
    _ts("started_at"),
    _ts("finished_at"),
)

transcripts = Table(
    "transcripts",
    metadata,
    _pk(),
    _uuid("org_id"),
    _uuid("recording_id"),
    Column("revision", Integer),
    Column("language", Text),
    Column("duration_ms", BigInteger),
    Column("engine", JSONB),
    _ts("created_at"),
    _ts("updated_at"),
)

speakers = Table(
    "speakers",
    metadata,
    _uuid("transcript_id", primary_key=True),
    _uuid("org_id"),
    Column("speaker_id", Text, primary_key=True),
    Column("position", Integer),
    Column("label", Text),
    _uuid("person_id"),
    Column("talk_ms", BigInteger),
)

segments = Table(
    "segments",
    metadata,
    _uuid("transcript_id", primary_key=True),
    _uuid("org_id"),
    Column("segment_id", Text, primary_key=True),
    Column("position", Integer),
    Column("speaker_id", Text),
    Column("start_ms", BigInteger),
    Column("end_ms", BigInteger),
    Column("text", Text),
    Column("confidence", Float),
    Column("words", JSONB),
)

# --- agentes de sumarização (002_agentes) ------------------------------------------------------

agent_providers = Table(
    "agent_providers",
    metadata,
    _pk(),
    _uuid("org_id"),
    Column("name", Text),
    Column("kind", Text),
    Column("base_url", Text),
    Column("model", Text),
    Column("api_key_encrypted", Text),
    Column("enabled", Boolean),
    Column("options", JSONB),
    _ts("created_at"),
    _ts("updated_at"),
)

summary_templates = Table(
    "summary_templates",
    metadata,
    _pk(),
    _uuid("org_id"),
    _uuid("owner_id"),
    Column("name", Text),
    Column("description", Text),
    Column("instructions", Text),
    Column("is_default", Boolean),
    _ts("created_at"),
    _ts("updated_at"),
)

summaries = Table(
    "summaries",
    metadata,
    _pk(),
    _uuid("org_id"),
    _uuid("transcript_id"),
    Column("transcript_revision", Integer),
    _uuid("template_id"),
    Column("template_name", Text),
    Column("instructions", Text),
    Column("version", Integer),
    Column("status", Text),
    Column("trigger", Text),
    _uuid("provider_id"),
    Column("provider_name", Text),
    Column("provider_kind", Text),
    Column("model", Text),
    Column("content_md", Text),
    Column("error_code", Text),
    Column("error_message", Text),
    Column("attempts", Integer),
    _uuid("created_by"),
    _ts("created_at"),
    _ts("started_at"),
    _ts("completed_at"),
)

invitations = Table(
    "invitations",
    metadata,
    _pk(),
    _uuid("org_id"),
    Column("email", Text),
    Column("role", Text),
    Column("group_ids", ARRAY(UUID(as_uuid=True))),
    Column("token_hash", Text),
    _ts("expires_at"),
    _ts("accepted_at"),
    _uuid("accepted_user_id"),
    _uuid("created_by"),
    _ts("created_at"),
)

org_secrets = Table(
    "org_secrets",
    metadata,
    _uuid("org_id", primary_key=True),
    Column("name", Text, primary_key=True),
    Column("value_encrypted", Text),
    _ts("updated_at"),
    _uuid("updated_by"),
)
