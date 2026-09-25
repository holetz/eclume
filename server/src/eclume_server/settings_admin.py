"""Configuração em runtime da organização (`org_settings`) e segredos cifrados (`org_secrets`).

Regras em docs/standards/code/server-admin.md: o `PATCH` mescla campo a campo por bloco, valida o
estado resultante e vale para os próximos jobs; os segredos só entram, nunca saem pela API.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any, Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from sqlalchemy import select

from eclume_server.db import tables as t
from eclume_server.pagination import iso
from eclume_server.problems import invalid_field
from eclume_server.serialize import user_ref

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

BLOCKS = ("asr", "diarization", "summarization", "voice_identification")
# O `float16` puro é recusado: a série GTX 16xx dá NaN nele, e a engine o troca (worker-gpu.md).
COMPUTE_TYPES = ("int8_float16", "int8", "int8_float32", "float32")
# O único pipeline de diarização que a engine `whisperx-local` sabe carregar.
DIARIZATION_MODELS = ("pyannote/speaker-diarization-community-1",)
# Segredos que alguém lê: o token do HF vai ao worker GPU; a chave da Anthropic, ao provider sem chave.
HF_TOKEN = "hf_token"  # noqa: S105 — nome do segredo, não o valor
ANTHROPIC_API_KEY = "anthropic_api_key"
KNOWN_SECRETS = (HF_TOKEN, ANTHROPIC_API_KEY)


def _http_url(value: str | None) -> str | None:
    if value is None:
        return None
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        msg = "precisa ser uma URL http(s) absoluta"
        raise ValueError(msg)
    return value


class _Block(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AsrPatch(_Block):
    """Bloco `asr` do `AdminSettingsPatch`."""

    engine: Literal["whisperx-local", "openai-compatible", "cpu"] | None = None
    model: str | None = Field(default=None, min_length=1)
    compute_type: Literal[COMPUTE_TYPES] | None = None  # type: ignore[valid-type]
    batch_size: int | None = Field(default=None, ge=1)
    default_language: str | None = Field(default=None, pattern=r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$")
    fallback_model: str | None = Field(default=None, min_length=1)
    endpoint_url: Annotated[str | None, AfterValidator(_http_url)] = None


class DiarizationPatch(_Block):
    """Bloco `diarization` do `AdminSettingsPatch`."""

    enabled: bool | None = None
    model: Literal[DIARIZATION_MODELS] | None = None  # type: ignore[valid-type]
    min_speakers: int | None = Field(default=None, ge=1)
    max_speakers: int | None = Field(default=None, ge=1)


class SummarizationPatch(_Block):
    """Bloco `summarization` do `AdminSettingsPatch`."""

    default_provider_id: UUID | None = None
    auto_summarize: bool | None = None
    default_template_id: UUID | None = None


class VoiceIdentificationPatch(_Block):
    """Bloco `voice_identification` do `AdminSettingsPatch`."""

    enabled: bool | None = None
    suggestion_threshold: float | None = Field(default=None, ge=0, le=1)


class AdminSettingsPatch(_Block):
    """Schema `AdminSettingsPatch`: cada bloco é mesclado campo a campo."""

    asr: AsrPatch | None = None
    diarization: DiarizationPatch | None = None
    summarization: SummarizationPatch | None = None
    voice_identification: VoiceIdentificationPatch | None = None


# Campos que o schema aceita como `null`; os demais, enviados como `null`, são 422.
_NULLABLE = {
    "asr": {"batch_size", "default_language", "fallback_model", "endpoint_url"},
    "diarization": {"min_speakers", "max_speakers"},
    "summarization": {"default_provider_id", "default_template_id"},
    "voice_identification": set(),
}


def settings_json(row: Row, updated_by_name: str | None) -> dict[str, Any]:
    """Schema `AdminSettings`."""
    body: dict[str, Any] = {block: dict(row[block]) for block in BLOCKS}
    body["updated_at"] = iso(row["updated_at"])
    body["updated_by"] = user_ref(row["updated_by"], updated_by_name) if row["updated_by"] else None
    return body


def changes_of(body: AdminSettingsPatch) -> dict[str, dict[str, Any]]:
    """Os campos enviados, por bloco, com UUIDs em texto; recusa `null` onde o schema não aceita."""
    sent = body.model_dump(exclude_unset=True, mode="json")
    if not any(sent.get(block) for block in BLOCKS):
        raise invalid_field("body", "informe ao menos um campo")
    for block, fields in sent.items():
        if fields is None:
            raise invalid_field(block, "não pode ser nulo")
        for field, value in fields.items():
            if value is None and field not in _NULLABLE[block]:
                raise invalid_field(f"{block}.{field}", "não pode ser nulo")
    return sent


async def validate_merged(conn: AsyncConnection, merged: dict[str, dict[str, Any]]) -> None:
    """Regras entre campos e referências, sobre a configuração resultante (sob a RLS do admin)."""
    asr, diarization, summarization = merged["asr"], merged["diarization"], merged["summarization"]
    if asr.get("engine") == "openai-compatible" and not asr.get("endpoint_url"):
        raise invalid_field("asr.endpoint_url", "obrigatória com a engine openai-compatible")
    low, high = diarization.get("min_speakers"), diarization.get("max_speakers")
    if low is not None and high is not None and low > high:
        raise invalid_field("diarization.min_speakers", "não pode passar de max_speakers")
    provider_id = summarization.get("default_provider_id")
    if provider_id is not None:
        enabled = (
            await conn.execute(select(t.agent_providers.c.enabled).where(t.agent_providers.c.id == UUID(provider_id)))
        ).scalar()
        if not enabled:
            raise invalid_field("summarization.default_provider_id", "precisa ser um provider habilitado")
    template_id = summarization.get("default_template_id")
    if template_id is not None:
        owner = (
            await conn.execute(
                select(t.summary_templates.c.id).where(
                    t.summary_templates.c.id == UUID(template_id), t.summary_templates.c.owner_id.is_(None)
                )
            )
        ).scalar()
        if owner is None:
            raise invalid_field("summarization.default_template_id", "precisa ser um template da organização")


async def secret_encrypted(conn: AsyncConnection, org_id: UUID, name: str) -> str | None:
    """Texto cifrado do segredo da organização, ou `None`; leia com o papel de sistema."""
    return (
        await conn.execute(
            select(t.org_secrets.c.value_encrypted).where(
                t.org_secrets.c.org_id == org_id, t.org_secrets.c.name == name
            )
        )
    ).scalar()
