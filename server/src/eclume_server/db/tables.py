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


users = Table(
    "users",
    metadata,
    _pk(),
    Column("email", Text),
    Column("name", Text),
    Column("password_hash", Text),
    Column("active", Boolean),
    _ts("created_at"),
    _ts("last_login_at"),
    Column("notice_version", Text),
    _ts("notice_accepted_at"),
    Column("voice_auto_assign", Boolean, server_default=FetchedValue()),
    Column("voice_auto_threshold", Float, server_default=FetchedValue()),
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
    _uuid("user_id"),
    Column("name", Text),
    Column("token_hash", Text),
    Column("prefix", Text),
    Column("scopes", ARRAY(Text)),
    _ts("created_at"),
    _ts("last_used_at"),
    _ts("expires_at"),
    _ts("revoked_at"),
    # 015_dispositivos_e_mcp
    Column("kind", Text, server_default=FetchedValue()),
    Column("platform", Text),
    _ts("mcp_last_used_at"),
)

pairing_codes = Table(
    "pairing_codes",
    metadata,
    _pk(),
    _uuid("user_id"),
    Column("code_hmac", Text),
    _ts("expires_at"),
    _ts("used_at"),
    _uuid("token_id"),
    _ts("created_at", server_default=FetchedValue()),
)

platform_settings = Table(
    "platform_settings",
    metadata,
    Column("id", Boolean, primary_key=True, server_default=FetchedValue()),
    Column("asr", JSONB),
    Column("diarization", JSONB),
    Column("voice_identification", JSONB),
    Column("preprocessing", JSONB),
    _ts("updated_at"),
    _uuid("updated_by"),
)

recordings = Table(
    "recordings",
    metadata,
    _uuid("id", primary_key=True),
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
    _uuid("agenda_type_id"),
    Column("agenda_type_origin", Text),
    Column("subject", Text),
    Column("kind", Text, server_default=FetchedValue()),
    Column("recorded_at_source", Text, server_default=FetchedValue()),
    _ts("created_at"),
    _ts("updated_at"),
)

uploads = Table(
    "uploads",
    metadata,
    _pk(),
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
    _uuid("owner_id"),
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
    _uuid("owner_id"),
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
    _uuid("owner_id"),
    Column("speaker_id", Text, primary_key=True),
    Column("position", Integer),
    Column("label", Text),
    _uuid("person_id"),
    Column("talk_ms", BigInteger),
    Column("auto_score", Float),
)

segments = Table(
    "segments",
    metadata,
    _uuid("transcript_id", primary_key=True),
    _uuid("owner_id"),
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
    Column("name", Text),
    Column("kind", Text),
    Column("base_url", Text),
    Column("model", Text),
    Column("api_key_encrypted", Text),
    Column("enabled", Boolean),
    Column("options", JSONB),
    Column("used_for", ARRAY(Text), server_default=FetchedValue()),
    _ts("created_at"),
    _ts("updated_at"),
)

# --- tipos de agenda (009_tipos_de_agenda) ------------------------------------------------------


def _agenda_type_columns() -> list[Column]:
    return [
        Column("name", Text),
        Column("position", Integer, server_default=FetchedValue()),
        Column("title_pattern", Text),
        Column("identify", Text, server_default=FetchedValue()),
        Column("default_tags", ARRAY(Text), server_default=FetchedValue()),
        Column("summary_instructions", Text),
        _ts("created_at", server_default=FetchedValue()),
        _ts("updated_at", server_default=FetchedValue()),
    ]


agenda_types = Table(
    "agenda_types",
    metadata,
    _pk(),
    _uuid("owner_id"),
    *_agenda_type_columns(),
    _uuid("from_default_id"),
)

default_agenda_types = Table(
    "default_agenda_types",
    metadata,
    _pk(),
    *_agenda_type_columns(),
    Column("include_for_new_users", Boolean, server_default=FetchedValue()),
)

# --- etapas do pipeline (012_etapas_do_pipeline) ---------------------------------------------------

pipeline_steps = Table(
    "pipeline_steps",
    metadata,
    _pk(),
    _uuid("owner_id"),
    _uuid("recording_id"),
    Column("revision", Integer),
    Column("step", Text),
    Column("state", Text),
    _ts("started_at"),
    _ts("finished_at"),
    Column("duration_ms", Integer, server_default=FetchedValue()),
    Column("error_code", Text),
    Column("error_message", Text),
    Column("detail", JSONB, server_default=FetchedValue()),
)

# --- campos e valores (010_campos_e_valores) ----------------------------------------------------

fields = Table(
    "fields",
    metadata,
    _pk(),
    _uuid("owner_id"),
    Column("key", Text),
    Column("name", Text),
    Column("kind", Text),
    Column("builtin", Text),
    Column("options", ARRAY(Text), server_default=FetchedValue()),
    Column("instructions", Text, server_default=FetchedValue()),
    Column("auto_fill", Boolean, server_default=FetchedValue()),
    Column("position", Integer, server_default=FetchedValue()),
    _ts("created_at", server_default=FetchedValue()),
    _ts("updated_at", server_default=FetchedValue()),
)

field_values = Table(
    "field_values",
    metadata,
    _uuid("recording_id", primary_key=True),
    _uuid("field_id", primary_key=True),
    _uuid("owner_id"),
    Column("value", JSONB(none_as_null=False)),
    Column("origin", Text),
    Column("transcript_revision", Integer),
    Column("provider_name", Text),
    Column("model", Text),
    _ts("updated_at", server_default=FetchedValue()),
)

summaries = Table(
    "summaries",
    metadata,
    _pk(),
    _uuid("owner_id"),
    _uuid("transcript_id"),
    Column("transcript_revision", Integer),
    _uuid("agenda_type_id"),
    Column("agenda_type_name", Text),
    Column("instructions", Text),
    Column("version", Integer),
    Column("origin", Text, server_default=FetchedValue()),
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
    _uuid("restored_from_id"),
    _uuid("chat_message_id"),
    _uuid("created_by"),
    _ts("created_at"),
    _ts("started_at"),
    _ts("completed_at"),
)

# --- gravação centrada no resumo (014_gravacao_resumo) --------------------------------------------

summary_chat_messages = Table(
    "summary_chat_messages",
    metadata,
    _pk(),
    _uuid("owner_id"),
    _uuid("recording_id"),
    _uuid("transcript_id"),
    Column("role", Text),
    Column("content", Text),
    Column("status", Text),
    _uuid("reply_to"),
    _uuid("base_summary_id"),
    _uuid("summary_id"),
    Column("reads", JSONB, server_default=FetchedValue()),
    _uuid("provider_id"),
    Column("provider_name", Text),
    Column("provider_kind", Text),
    Column("model", Text),
    Column("error_code", Text),
    Column("error_message", Text),
    Column("attempts", Integer, server_default=FetchedValue()),
    _uuid("created_by"),
    _ts("created_at", server_default=FetchedValue()),
    _ts("started_at"),
    _ts("completed_at"),
)

markers = Table(
    "markers",
    metadata,
    _pk(),
    _uuid("owner_id"),
    _uuid("recording_id"),
    _uuid("client_id"),
    Column("at_ms", BigInteger),
    Column("note", Text),
    Column("device_name", Text),
    _uuid("created_by"),
    _ts("created_at", server_default=FetchedValue()),
    _ts("updated_at", server_default=FetchedValue()),
)

# --- pessoas, coleções e impressões de voz (003_pessoas_e_busca) ---------------------------------

# `embedding` (pgvector) fica de fora: as consultas tipadas daqui nunca o leem.
speaker_embeddings = Table(
    "speaker_embeddings",
    metadata,
    _uuid("transcript_id", primary_key=True),
    _uuid("owner_id"),
    Column("speaker_id", Text, primary_key=True),
    Column("model", Text),
    _ts("created_at"),
)

people = Table(
    "people",
    metadata,
    _pk(),
    _uuid("owner_id"),
    Column("name", Text),
    Column("email", Text),
    Column("notes", Text),
    Column("sort_name", Text, server_default=FetchedValue()),
    # 020_pessoas_enriquecidas
    Column("organization", Text),
    Column("department", Text),
    Column("job_title", Text),
    Column("phone", Text),
    Column("tags", ARRAY(Text), server_default=FetchedValue()),
    _uuid("created_by"),
    _ts("created_at", server_default=FetchedValue()),
    _ts("updated_at", server_default=FetchedValue()),
)

collections = Table(
    "collections",
    metadata,
    _pk(),
    _uuid("owner_id"),
    Column("name", Text),
    Column("description", Text),
    _ts("created_at", server_default=FetchedValue()),
    _ts("updated_at", server_default=FetchedValue()),
)

platform_secrets = Table(
    "platform_secrets",
    metadata,
    Column("name", Text, primary_key=True),
    Column("value_encrypted", Text),
    _ts("updated_at"),
    _uuid("updated_by"),
)

# --- identificação por voz (005_identificacao_por_voz) -------------------------------------------

# `embedding` (pgvector) fica de fora, como em `speaker_embeddings`: lido e gravado por SQL explícito.
voice_samples = Table(
    "voice_samples",
    metadata,
    _uuid("transcript_id", primary_key=True),
    Column("speaker_id", Text, primary_key=True),
    _uuid("owner_id"),
    _uuid("person_id"),
    Column("model", Text),
    Column("talk_ms", BigInteger),
    _uuid("created_by"),
    _ts("created_at", server_default=FetchedValue()),
)

speaker_suggestions = Table(
    "speaker_suggestions",
    metadata,
    _uuid("transcript_id", primary_key=True),
    Column("speaker_id", Text, primary_key=True),
    _uuid("person_id", primary_key=True),
    _uuid("owner_id"),
    Column("score", Float),
    Column("status", Text, server_default=FetchedValue()),
    _uuid("decided_by"),
    _ts("decided_at"),
    _ts("created_at", server_default=FetchedValue()),
)

# --- contas de admin (008_conta_por_usuario) ---------------------------------------------------

admins = Table(
    "admins",
    metadata,
    _pk(),
    Column("email", Text),
    Column("name", Text),
    Column("password_hash", Text),
    Column("active", Boolean, server_default=FetchedValue()),
    _ts("created_at", server_default=FetchedValue()),
    _ts("last_login_at"),
)

admin_sessions = Table(
    "admin_sessions",
    metadata,
    _pk(),
    Column("token_hash", Text),
    Column("csrf_token", Text),
    _uuid("admin_id"),
    _ts("created_at", server_default=FetchedValue()),
    _ts("expires_at"),
)
