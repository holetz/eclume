"""Runtime platform settings (`platform_settings`) and encrypted secrets (`platform_secrets`).

Rules in docs/standards/code/server-admin.md: the `PATCH` merges field by field per block, validates
the resulting state and applies to the next jobs; secrets only go in, never come out through the API.
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
# Plain `float16` is refused: the GTX 16xx series yields NaN on it, and the engine swaps it (worker-gpu.md).
COMPUTE_TYPES = ("int8_float16", "int8", "int8_float32", "float32")
# The only diarization pipeline the `whisperx-local` engine knows how to load.
DIARIZATION_MODELS = ("pyannote/speaker-diarization-community-1",)
# Secrets someone reads: the HF token goes to the GPU worker; the Anthropic key, to the provider with no key.
HF_TOKEN = "hf_token"  # noqa: S105 — the secret's name, not its value
ANTHROPIC_API_KEY = "anthropic_api_key"
KNOWN_SECRETS = (HF_TOKEN, ANTHROPIC_API_KEY)
# Ceiling of expected speakers: an institutional meeting (committee, board, assembly) rarely goes past
# two dozen voices. It stays well below the `uint8` of pyannote's `count` (255), which overflows past 255.
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
        raise ValueError(msg)  # noqa: TRY004 — pydantic only turns a ValueError into 422
    return value


# The lax mode of pydantic turns `true` into `1` / `1.0`; these refuse it and keep every other coercion.
PlainInt = Annotated[int, BeforeValidator(_not_bool)]
PlainFloat = Annotated[float, BeforeValidator(_not_bool)]

SpeakerCount = Annotated[PlainInt, Field(ge=1, le=MAX_SPEAKERS)] | None


class _Block(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AsrPatch(_Block):
    """Block `asr` of the `AdminSettingsPatch`."""

    engine: Literal["whisperx-local", "openai-compatible", "cpu"] | None = None
    model: str | None = Field(default=None, min_length=1)
    compute_type: Literal[COMPUTE_TYPES] | None = None  # type: ignore[valid-type]
    batch_size: PlainInt | None = Field(default=None, ge=1)
    # `auto`: the engine detects the language of each recording.
    default_language: str | None = Field(default=None, pattern=r"^(auto|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$")
    fallback_model: str | None = Field(default=None, min_length=1)
    endpoint_url: BaseUrl = None


class DiarizationPatch(_Block):
    """Block `diarization` of the `AdminSettingsPatch`."""

    enabled: bool | None = None
    model: Literal[DIARIZATION_MODELS] | None = None  # type: ignore[valid-type]
    min_speakers: SpeakerCount = None
    max_speakers: SpeakerCount = None


class DenoisePatch(_Block):
    """Preprocessing step `denoise`: RNNoise (or `afftdn`) with a strength from 0 to 1."""

    enabled: bool | None = None
    method: Literal["rnnoise", "afftdn"] | None = None
    strength: PlainFloat | None = Field(default=None, ge=0, le=1)


class LoudnormPatch(_Block):
    """Preprocessing step `loudnorm`: EBU R128 loudness normalization."""

    enabled: bool | None = None
    target_lufs: PlainFloat | None = Field(default=None, ge=-30, le=-10)
    true_peak_db: PlainFloat | None = Field(default=None, ge=-9, le=0)
    lra: PlainFloat | None = Field(default=None, ge=1, le=20)


class TrimSilencePatch(_Block):
    """Preprocessing step `trim_silence`: cuts the silence at the start and at the end."""

    enabled: bool | None = None
    min_silence_s: PlainFloat | None = Field(default=None, ge=1, le=30)
    threshold_db: PlainFloat | None = Field(default=None, ge=-80, le=-20)


class SplitChannelsPatch(_Block):
    """Preprocessing step `split_channels`: one channel per person."""

    enabled: bool | None = None


class PreprocessingPatch(_Block):
    """Block `preprocessing` of the `AdminSettingsPatch`: each step is merged field by field.

    The conversion to 16 kHz mono has no key: it is always done.
    """

    denoise: DenoisePatch | None = None
    loudnorm: LoudnormPatch | None = None
    trim_silence: TrimSilencePatch | None = None
    split_channels: SplitChannelsPatch | None = None


class VoiceIdentificationPatch(_Block):
    """Block `voice_identification` of the `AdminSettingsPatch`."""

    enabled: bool | None = None
    suggestion_threshold: PlainFloat | None = Field(default=None, ge=0, le=1)


class QuotasPatch(_Block):
    """Block `quotas` of the `AdminSettingsPatch` and the per-account override: `null` is no limit."""

    storage_bytes: PlainInt | None = Field(default=None, ge=0)
    file_bytes: PlainInt | None = Field(default=None, ge=0)
    open_uploads: PlainInt | None = Field(default=None, ge=0)
    gpu_minutes_24h: PlainInt | None = Field(default=None, ge=0)
    agent_requests_24h: PlainInt | None = Field(default=None, ge=0)


class RetentionPatch(_Block):
    """Block `retention` of the `AdminSettingsPatch`: a null `audio_max_days` is no ceiling."""

    audio_max_days: PlainInt | None = Field(default=None, ge=MIN_DAYS, le=MAX_DAYS)


class AdminSettingsPatch(_Block):
    """Schema `AdminSettingsPatch`: each block is merged field by field."""

    asr: AsrPatch | None = None
    diarization: DiarizationPatch | None = None
    voice_identification: VoiceIdentificationPatch | None = None
    preprocessing: PreprocessingPatch | None = None
    quotas: QuotasPatch | None = None
    retention: RetentionPatch | None = None


# Fields the schema accepts as `null`; the others, sent as `null`, are 422.
_NULLABLE = {
    "asr": {"batch_size", "default_language", "fallback_model", "endpoint_url"},
    "diarization": {"min_speakers", "max_speakers"},
    "voice_identification": set(),
    "preprocessing": set(),
    "quotas": set(QuotasPatch.model_fields),
    "retention": set(RetentionPatch.model_fields),
}


def settings_json(row: Row, updated_by_name: str | None) -> dict[str, Any]:
    """Schema `AdminSettings`; `updated_by` is the admin account."""
    body: dict[str, Any] = {block: dict(row[block]) for block in BLOCKS}
    body["voice_identification"] = voice_settings(body["voice_identification"])
    body["updated_at"] = iso(row["updated_at"])
    body["updated_by"] = {"id": str(row["updated_by"]), "name": updated_by_name} if row["updated_by"] else None
    return body


def changes_of(body: AdminSettingsPatch) -> dict[str, dict[str, Any]]:
    """The fields sent, per block, with UUIDs as text; refuse `null` where the schema does not accept it."""
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
    """Resulting settings: field by field per block, and per step in `preprocessing`."""
    merged = {block: {**current[block], **changes.get(block, {})} for block in BLOCKS}
    merged["preprocessing"] = {
        step: {**current["preprocessing"].get(step, {}), **changes.get("preprocessing", {}).get(step, {})}
        for step in {*current["preprocessing"], *changes.get("preprocessing", {})}
    }
    return merged


def validate_merged(merged: dict[str, dict[str, Any]], changes: dict[str, dict[str, Any]]) -> None:
    """Cross-field rules, over the resulting settings.

    The voice → speaker separation rule only applies when the `PATCH` touches one of the two blocks:
    an old state that breaks it does not lock the editing of another block.
    """
    asr, diarization = merged["asr"], merged["diarization"]
    if asr.get("engine") == "openai-compatible" and not asr.get("endpoint_url"):
        raise invalid_field("asr.endpoint_url", "obrigatória com a engine openai-compatible")
    low, high = diarization.get("min_speakers"), diarization.get("max_speakers")
    touches_voice = "voice_identification" in changes or "diarization" in changes
    if touches_voice and merged["voice_identification"].get("enabled") and not diarization.get("enabled"):
        # The voiceprint is per speaker: without the separation, there is nothing to compare.
        raise invalid_field("voice_identification.enabled", "exige a separação de locutores ligada")
    if low is not None and high is not None and low > high:
        raise invalid_field("diarization.min_speakers", "não pode passar de max_speakers")


async def secret_encrypted(conn: AsyncConnection, name: str) -> str | None:
    """Ciphertext of the platform secret, or `None`; read it with the connection role."""
    return (
        await conn.execute(select(t.platform_secrets.c.value_encrypted).where(t.platform_secrets.c.name == name))
    ).scalar()
