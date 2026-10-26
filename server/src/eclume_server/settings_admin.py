"""Configuração em runtime da plataforma (`platform_settings`) e segredos cifrados (`platform_secrets`).

Regras em docs/standards/code/server-admin.md: o `PATCH` mescla campo a campo por bloco, valida o
estado resultante e vale para os próximos jobs; os segredos só entram, nunca saem pela API.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field
from sqlalchemy import select

from eclume_server.audio_retention import MAX_DAYS, MIN_DAYS
from eclume_server.db import tables as t
from eclume_server.pagination import iso
from eclume_server.problems import invalid_field
from eclume_server.voice import voice_settings

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

BLOCKS = ("asr", "diarization", "voice_identification", "preprocessing", "quotas", "retention")
# O `float16` puro é recusado: a série GTX 16xx dá NaN nele, e a engine o troca (worker-gpu.md).
COMPUTE_TYPES = ("int8_float16", "int8", "int8_float32", "float32")
# O único pipeline de diarização que a engine `whisperx-local` sabe carregar.
DIARIZATION_MODELS = ("pyannote/speaker-diarization-community-1",)
# Segredos que alguém lê: o token do HF vai ao worker GPU; a chave da Anthropic, ao provider sem chave.
HF_TOKEN = "hf_token"  # noqa: S105 — nome do segredo, não o valor
ANTHROPIC_API_KEY = "anthropic_api_key"
KNOWN_SECRETS = (HF_TOKEN, ANTHROPIC_API_KEY)
# Teto de locutores esperados: uma reunião institucional (comitê, conselho, assembleia) raramente passa de
# duas dezenas de vozes. Fica bem abaixo do `uint8` do `count` do pyannote (255), que estoura além de 255.
MAX_SPEAKERS = 30


def _http_url(value: str | None) -> str | None:
    if value is None:
        return None
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        msg = "precisa ser uma URL http(s) absoluta"
        raise ValueError(msg)
    return value


BaseUrl = Annotated[str | None, AfterValidator(_http_url)]


def _not_bool(value: object) -> object:
    if isinstance(value, bool):
        msg = "precisa ser um inteiro, não um booleano"
        raise ValueError(msg)  # noqa: TRY004 — o pydantic só vira 422 com ValueError
    return value


# The lax mode of pydantic turns `true` into `1` / `1.0`; these refuse it and keep every other coercion.
PlainInt = Annotated[int, BeforeValidator(_not_bool)]
PlainFloat = Annotated[float, BeforeValidator(_not_bool)]

SpeakerCount = Annotated[PlainInt, Field(ge=1, le=MAX_SPEAKERS)] | None


class _Block(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AsrPatch(_Block):
    """Bloco `asr` do `AdminSettingsPatch`."""

    engine: Literal["whisperx-local", "openai-compatible", "cpu"] | None = None
    model: str | None = Field(default=None, min_length=1)
    compute_type: Literal[COMPUTE_TYPES] | None = None  # type: ignore[valid-type]
    batch_size: PlainInt | None = Field(default=None, ge=1)
    # `auto`: a engine detecta o idioma de cada gravação.
    default_language: str | None = Field(default=None, pattern=r"^(auto|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$")
    fallback_model: str | None = Field(default=None, min_length=1)
    endpoint_url: BaseUrl = None


class DiarizationPatch(_Block):
    """Bloco `diarization` do `AdminSettingsPatch`."""

    enabled: bool | None = None
    model: Literal[DIARIZATION_MODELS] | None = None  # type: ignore[valid-type]
    min_speakers: SpeakerCount = None
    max_speakers: SpeakerCount = None


class DenoisePatch(_Block):
    """Etapa `denoise` do pré-processamento: RNNoise (ou `afftdn`) com a força de 0 a 1."""

    enabled: bool | None = None
    method: Literal["rnnoise", "afftdn"] | None = None
    strength: PlainFloat | None = Field(default=None, ge=0, le=1)


class LoudnormPatch(_Block):
    """Etapa `loudnorm` do pré-processamento: normalização de loudness EBU R128."""

    enabled: bool | None = None
    target_lufs: PlainFloat | None = Field(default=None, ge=-30, le=-10)
    true_peak_db: PlainFloat | None = Field(default=None, ge=-9, le=0)
    lra: PlainFloat | None = Field(default=None, ge=1, le=20)


class TrimSilencePatch(_Block):
    """Etapa `trim_silence` do pré-processamento: corta o silêncio do início e do fim."""

    enabled: bool | None = None
    min_silence_s: PlainFloat | None = Field(default=None, ge=1, le=30)
    threshold_db: PlainFloat | None = Field(default=None, ge=-80, le=-20)


class SplitChannelsPatch(_Block):
    """Etapa `split_channels` do pré-processamento: um canal por pessoa."""

    enabled: bool | None = None


class PreprocessingPatch(_Block):
    """Bloco `preprocessing` do `AdminSettingsPatch`: cada etapa é mesclada campo a campo.

    A conversão para 16 kHz mono não tem chave: é sempre feita.
    """

    denoise: DenoisePatch | None = None
    loudnorm: LoudnormPatch | None = None
    trim_silence: TrimSilencePatch | None = None
    split_channels: SplitChannelsPatch | None = None


class VoiceIdentificationPatch(_Block):
    """Bloco `voice_identification` do `AdminSettingsPatch`."""

    enabled: bool | None = None
    suggestion_threshold: PlainFloat | None = Field(default=None, ge=0, le=1)


class QuotasPatch(_Block):
    """Bloco `quotas` do `AdminSettingsPatch` e a sobreposição por conta: `null` é sem limite."""

    storage_bytes: PlainInt | None = Field(default=None, ge=0)
    file_bytes: PlainInt | None = Field(default=None, ge=0)
    open_uploads: PlainInt | None = Field(default=None, ge=0)
    gpu_minutes_24h: PlainInt | None = Field(default=None, ge=0)
    agent_requests_24h: PlainInt | None = Field(default=None, ge=0)


class RetentionPatch(_Block):
    """Bloco `retention` do `AdminSettingsPatch`: `audio_max_days` nulo é sem teto."""

    audio_max_days: PlainInt | None = Field(default=None, ge=MIN_DAYS, le=MAX_DAYS)


class AdminSettingsPatch(_Block):
    """Schema `AdminSettingsPatch`: cada bloco é mesclado campo a campo."""

    asr: AsrPatch | None = None
    diarization: DiarizationPatch | None = None
    voice_identification: VoiceIdentificationPatch | None = None
    preprocessing: PreprocessingPatch | None = None
    quotas: QuotasPatch | None = None
    retention: RetentionPatch | None = None


# Campos que o schema aceita como `null`; os demais, enviados como `null`, são 422.
_NULLABLE = {
    "asr": {"batch_size", "default_language", "fallback_model", "endpoint_url"},
    "diarization": {"min_speakers", "max_speakers"},
    "voice_identification": set(),
    "preprocessing": set(),
    "quotas": set(QuotasPatch.model_fields),
    "retention": set(RetentionPatch.model_fields),
}


def settings_json(row: Row, updated_by_name: str | None) -> dict[str, Any]:
    """Schema `AdminSettings`; `updated_by` é a conta de admin."""
    body: dict[str, Any] = {block: dict(row[block]) for block in BLOCKS}
    body["voice_identification"] = voice_settings(body["voice_identification"])
    body["updated_at"] = iso(row["updated_at"])
    body["updated_by"] = {"id": str(row["updated_by"]), "name": updated_by_name} if row["updated_by"] else None
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
            if block == "preprocessing":
                for name, step_value in value.items():
                    if step_value is None:
                        raise invalid_field(f"{block}.{field}.{name}", "não pode ser nulo")
    return sent


def merge(current: dict[str, Any], changes: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Configuração resultante: campo a campo por bloco, e por etapa no `preprocessing`."""
    merged = {block: {**current[block], **changes.get(block, {})} for block in BLOCKS}
    merged["preprocessing"] = {
        step: {**current["preprocessing"].get(step, {}), **changes.get("preprocessing", {}).get(step, {})}
        for step in {*current["preprocessing"], *changes.get("preprocessing", {})}
    }
    return merged


def validate_merged(merged: dict[str, dict[str, Any]], changes: dict[str, dict[str, Any]]) -> None:
    """Regras entre campos, sobre a configuração resultante.

    A regra voz → separação de locutores só vale quando o `PATCH` toca um dos dois blocos: um
    estado antigo que a quebra não trava a edição de outro bloco.
    """
    asr, diarization = merged["asr"], merged["diarization"]
    if asr.get("engine") == "openai-compatible" and not asr.get("endpoint_url"):
        raise invalid_field("asr.endpoint_url", "obrigatória com a engine openai-compatible")
    low, high = diarization.get("min_speakers"), diarization.get("max_speakers")
    touches_voice = "voice_identification" in changes or "diarization" in changes
    if touches_voice and merged["voice_identification"].get("enabled") and not diarization.get("enabled"):
        # A impressão de voz é por locutor: sem a separação, não há o que comparar.
        raise invalid_field("voice_identification.enabled", "exige a separação de locutores ligada")
    if low is not None and high is not None and low > high:
        raise invalid_field("diarization.min_speakers", "não pode passar de max_speakers")


async def secret_encrypted(conn: AsyncConnection, name: str) -> str | None:
    """Texto cifrado do segredo da plataforma, ou `None`; leia com o papel de conexão."""
    return (
        await conn.execute(select(t.platform_secrets.c.value_encrypted).where(t.platform_secrets.c.name == name))
    ).scalar()
