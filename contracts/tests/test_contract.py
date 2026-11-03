"""v1 contract tests: OpenAPI and schema validity, fixtures and the mapping to lumea."""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
import yaml
from jsonschema import Draft202012Validator
from openapi_spec_validator import validate
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator
    from types import ModuleType

CONTRACTS = Path(__file__).resolve().parent.parent
FIXTURES = CONTRACTS / "fixtures"
BUNDLE_URI = "urn:eclume:contracts:v1:bundle"
HTTP_METHODS = {"get", "put", "post", "delete", "patch", "head", "options", "trace"}


def strictify(node: Any) -> Any:  # noqa: ANN401 — walks arbitrary YAML/JSON
    """Close every object schema to undeclared properties.

    The contract is open on purpose (the client ignores new properties), but a fixture with a
    property outside the schema is a typo, not evolution.
    """
    if isinstance(node, list):
        return [strictify(item) for item in node]
    if not isinstance(node, dict):
        return node
    result = {key: strictify(value) for key, value in node.items()}
    if isinstance(node.get("properties"), dict) and "additionalProperties" not in node:
        result["additionalProperties"] = False
    return result


@pytest.fixture(scope="session")
def bundle_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("eclume_contract_bundle", CONTRACTS / "tools" / "bundle.py")
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="session")
def source_spec() -> dict[str, Any]:
    return yaml.safe_load((CONTRACTS / "openapi-v1.yaml").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def bundle() -> dict[str, Any]:
    return yaml.safe_load((CONTRACTS / "openapi-v1.bundled.yaml").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def transcript_schema() -> dict[str, Any]:
    return json.loads((CONTRACTS / "transcript.schema.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def transcript() -> dict[str, Any]:
    return json.loads((FIXTURES / "transcript-3-locutores.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def strict_validator_for(bundle: dict[str, Any]) -> Callable[[str], Draft202012Validator]:
    """Factory of strict validators for a JSON pointer inside the bundle."""
    strict_bundle = strictify(bundle)
    registry = Registry().with_resource(BUNDLE_URI, Resource(contents=strict_bundle, specification=DRAFT202012))

    def make(pointer: str) -> Draft202012Validator:
        return Draft202012Validator(
            {"$ref": f"{BUNDLE_URI}#{pointer}"},
            registry=registry,
            format_checker=Draft202012Validator.FORMAT_CHECKER,
        )

    return make


def _pointer(*parts: str) -> str:
    return "/" + "/".join(part.replace("~", "~0").replace("/", "~1") for part in parts)


def _operations(spec: dict[str, Any]) -> Iterator[tuple[str, str, dict[str, Any]]]:
    for path, item in spec["paths"].items():
        for method, operation in item.items():
            if method in HTTP_METHODS:
                yield path, method, operation


def _media_examples(bundle: dict[str, Any]) -> Iterator[tuple[str, str, Any]]:
    """Each media type example of the bundle: (where, schema pointer, value)."""

    def from_content(content: dict[str, Any], *where: str) -> Iterator[tuple[str, str, Any]]:
        for media, media_obj in content.items():
            for name, example in media_obj.get("examples", {}).items():
                resolved = example
                if "$ref" in example:
                    resolved = bundle["components"]["examples"][example["$ref"].rsplit("/", 1)[-1]]
                label = " ".join((*where, media, name))
                yield label, _pointer(*where, "content", media, "schema"), resolved["value"]

    for path, method, operation in _operations(bundle):
        body = operation.get("requestBody", {})
        yield from from_content(body.get("content", {}), "paths", path, method, "requestBody")
        for status, response in operation["responses"].items():
            if "$ref" not in response:
                yield from from_content(response.get("content", {}), "paths", path, method, "responses", str(status))
    for name, response in bundle["components"]["responses"].items():
        yield from from_content(response.get("content", {}), "components", "responses", name)


# --- structural validity ---------------------------------------------------------------------


def test_source_openapi_is_valid(source_spec: dict[str, Any]) -> None:
    validate(source_spec, base_uri=(CONTRACTS / "openapi-v1.yaml").as_uri())


def test_bundle_is_valid_and_has_no_external_reference(bundle: dict[str, Any]) -> None:
    validate(bundle)
    text = (CONTRACTS / "openapi-v1.bundled.yaml").read_text(encoding="utf-8")
    assert "externalValue" not in text
    assert "transcript.schema.json#" not in text


def test_committed_bundle_is_up_to_date(bundle_module: ModuleType) -> None:
    committed = (CONTRACTS / "openapi-v1.bundled.yaml").read_text(encoding="utf-8")
    assert committed == bundle_module.build(), "run: uv run python contracts/tools/bundle.py"


def test_transcript_schema_is_valid_2020_12(transcript_schema: dict[str, Any]) -> None:
    assert transcript_schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    Draft202012Validator.check_schema(transcript_schema)


def test_contract_versions_are_v1(source_spec: dict[str, Any], transcript: dict[str, Any]) -> None:
    # The redesign's 2.x line stays under /api/v1; after it, the next break goes to /api/v2.
    assert re.fullmatch(r"2\.\d+\.\d+", source_spec["info"]["version"])
    assert transcript["schema_version"].startswith("1.")
    assert all(path.startswith("/api/v1/") for path in source_spec["paths"])


# --- fixtures and examples -------------------------------------------------------------------


def test_transcript_fixture_validates_strictly_against_the_schema(
    transcript_schema: dict[str, Any], transcript: dict[str, Any]
) -> None:
    validator = Draft202012Validator(strictify(transcript_schema), format_checker=Draft202012Validator.FORMAT_CHECKER)
    errors = [f"{list(e.absolute_path)}: {e.message}" for e in validator.iter_errors(transcript)]
    assert errors == []


def test_transcript_fixture_respects_the_invariants(transcript: dict[str, Any]) -> None:
    speaker_ids = [speaker["id"] for speaker in transcript["speakers"]]
    assert len(speaker_ids) == len(set(speaker_ids))
    segment_ids = [segment["id"] for segment in transcript["segments"]]
    assert len(segment_ids) == len(set(segment_ids))
    starts = [segment["start_ms"] for segment in transcript["segments"]]
    assert starts == sorted(starts)
    talk: dict[str, int] = {}
    for segment in transcript["segments"]:
        assert segment["speaker_id"] in speaker_ids
        assert segment["start_ms"] <= segment["end_ms"] <= transcript["duration_ms"]
        talk[segment["speaker_id"]] = talk.get(segment["speaker_id"], 0) + segment["end_ms"] - segment["start_ms"]
        for word in segment.get("words", []):
            if word["start_ms"] is not None:
                assert segment["start_ms"] <= word["start_ms"] <= word["end_ms"] <= segment["end_ms"]
        if "words" in segment:
            assert " ".join(word["text"] for word in segment["words"]) == segment["text"]
    assert {speaker["id"]: speaker["talk_ms"] for speaker in transcript["speakers"]} == talk


def test_fixture_has_three_speakers_one_linked_to_a_person(transcript: dict[str, Any]) -> None:
    speakers = transcript["speakers"]
    assert len(speakers) == 3  # noqa: PLR2004 — the case the epic asks for
    assert [speaker["person"] is not None for speaker in speakers].count(True) == 1


def test_every_example_validates_strictly_against_the_media_type_schema(
    bundle: dict[str, Any], strict_validator_for: Callable[[str], Draft202012Validator]
) -> None:
    failures: list[str] = []
    count = 0
    for label, schema_pointer, value in _media_examples(bundle):
        count += 1
        validator = strict_validator_for(schema_pointer)
        failures.extend(f"{label} {list(e.absolute_path)}: {e.message}" for e in validator.iter_errors(value))
    assert count >= 40  # noqa: PLR2004 — guards against a walk that finds nothing
    assert failures == []


def test_every_fixture_is_referenced_by_an_example(source_spec: dict[str, Any]) -> None:
    referenced = {Path(example["externalValue"]).name for example in source_spec["components"]["examples"].values()}
    on_disk = {path.name for path in FIXTURES.iterdir()}
    assert on_disk == referenced


def test_operations_declare_401_and_known_scopes(source_spec: dict[str, Any]) -> None:
    scopes = set(source_spec["components"]["schemas"]["Scope"]["enum"])
    default_security = source_spec["security"]
    for path, method, operation in _operations(source_spec):
        security = operation.get("security", default_security)
        if security:
            assert "401" in operation["responses"], f"{method.upper()} {path} without 401"
        for requirement in security:
            assert set(requirement.get("pat", [])) <= scopes, f"{method.upper()} {path}"
        if path == "/api/v1/admin/auth/login":
            assert security == [], f"{method.upper()} {path} must be public"
        elif path.startswith("/api/v1/admin/"):
            assert security == [{"adminSessionCookie": []}], (
                f"{method.upper()} {path} must accept only the admin session"
            )
        elif path.startswith("/api/v1/tokens"):
            assert security == [{"sessionCookie": []}], f"{method.upper()} {path} must accept only a session"
        else:
            assert {"adminSessionCookie": []} not in security, f"{method.upper()} {path} outside /admin/*"


# --- .md export ------------------------------------------------------------------------------


def _hms(ms: int) -> str:
    seconds = ms // 1000
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def _speaker_name(speaker: dict[str, Any]) -> str:
    return speaker["person"]["name"] if speaker["person"] else speaker["label"]


def render_markdown(transcript: dict[str, Any]) -> str:
    """Reference rendering of the `format=md` export (frontmatter values as JSON, which is YAML)."""

    def q(value: object) -> str:
        return json.dumps(value, ensure_ascii=False)

    names = {speaker["id"]: _speaker_name(speaker) for speaker in transcript["speakers"]}
    lines = ["---"]
    lines.extend(
        f"{key}: {q(transcript[key])}"
        for key in ("id", "title", "recorded_at", "language", "duration_ms", "source", "revision")
    )
    lines.append("speakers:")
    for speaker in transcript["speakers"]:
        lines.append(f"  - id: {q(speaker['id'])}")
        lines.append(f"    label: {q(speaker['label'])}")
        lines.append(f"    person: {q(speaker['person']['name'] if speaker['person'] else None)}")
    lines.append("---")
    for segment in transcript["segments"]:
        lines.extend(("", f"**{names[segment['speaker_id']]}** [{_hms(segment['start_ms'])}]: {segment['text']}"))
    return "\n".join(lines) + "\n"


def test_fixture_md_export_matches_the_reference_rendering(transcript: dict[str, Any]) -> None:
    expected = (FIXTURES / "transcript-3-locutores.md").read_text(encoding="utf-8")
    assert render_markdown(transcript) == expected


# --- mapping to lumea's transcricao.md -------------------------------------------------------

# Line format of `lumea/assets/meet/transcribe/store.py` (`_SEGMENT_RE`).
LUMEA_SEGMENT_RE = re.compile(r"^\*\*(?P<speaker>[^*]+)\*\*\s+\[(?P<timestamp>[^\]]+)\]:\s*(?P<text>.*)$")


def to_lumea_frontmatter(transcript: dict[str, Any]) -> dict[str, Any]:
    """Reference mapping from the v1 JSON to the frontmatter of `transcricao.md` (store.py:102-128)."""
    first_text: dict[str, str] = {}
    for segment in transcript["segments"]:
        first_text.setdefault(segment["speaker_id"], segment["text"])
    return {
        "quando": transcript["recorded_at"],
        "onde": "eclume",
        "como": "audio",
        "participantes": [
            {"nome": _speaker_name(speaker), "papel": "desconhecido", "speaker_id": speaker["id"]}
            for speaker in transcript["speakers"]
        ],
        "gaps": [
            {
                "campo": "speaker-identity",
                "descricao": f"Identidade de '{speaker['label']}' não confirmada no eclume.",
                "amostra": first_text.get(speaker["id"]),
            }
            for speaker in transcript["speakers"]
            if speaker["person"] is None
        ],
    }


def test_v1_json_produces_the_lumea_frontmatter_without_loss(transcript: dict[str, Any]) -> None:
    frontmatter = to_lumea_frontmatter(transcript)
    participants = frontmatter["participantes"]
    assert [p["speaker_id"] for p in participants] == ["S1", "S2", "S3"]
    assert participants[0]["nome"] == "Mariana Couto"
    gaps = frontmatter["gaps"]
    assert [g["campo"] for g in gaps] == ["speaker-identity", "speaker-identity"]
    assert all(g["amostra"] for g in gaps)

    body = (FIXTURES / "transcript-3-locutores.md").read_text(encoding="utf-8").split("---\n", 2)[2]
    declared = {p["nome"] for p in participants}
    lines = [line for line in body.splitlines() if line.strip()]
    assert len(lines) == len(transcript["segments"])
    for line, segment in zip(lines, transcript["segments"], strict=True):
        match = LUMEA_SEGMENT_RE.match(line)
        assert match, line
        assert match["speaker"] in declared
        assert match["timestamp"] == _hms(segment["start_ms"])
        assert match["text"] == segment["text"]


# Deprecated fields in v1: they stay required and filled until `/api/v2` (contrato-v1.md).
DEPRECATED_V1 = (
    ("Recording", "owner"),
    ("TranscriptSummary", "owner"),
    ("VoiceSample", "created_by"),
    ("Summary", "created_by"),
    ("SummaryChatMessage", "created_by"),
)


def test_deprecated_fields_stay_required_and_marked(
    source_spec: dict[str, Any], transcript_schema: dict[str, Any]
) -> None:
    schemas = source_spec["components"]["schemas"]
    for schema, field in DEPRECATED_V1:
        assert field in schemas[schema]["required"], f"{schema}.{field} left required: only v2 removes it"
        assert schemas[schema]["properties"][field].get("deprecated") is True, f"{schema}.{field} lost the mark"
    assert "owner" in transcript_schema["required"]
    assert transcript_schema["properties"]["owner"].get("deprecated") is True
