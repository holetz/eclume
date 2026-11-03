"""The account vocabulary in the `transcribe` payload: deduplicated, limited, without blanks."""

from __future__ import annotations

from eclume_server.recordings import VOCABULARY_MAX_CHARS, VOCABULARY_MAX_TERMS, limit_vocabulary


def test_deduplicates_case_insensitively_and_drops_blanks():
    assert limit_vocabulary(["Ana  Souza", "ana souza", "", "  ", "Bia"]) == ["Ana Souza", "Bia"]


def test_limits_the_number_of_terms():
    assert len(limit_vocabulary([f"N{i}" for i in range(200)])) == VOCABULARY_MAX_TERMS


def test_limits_the_characters():
    terms = limit_vocabulary(["x" * 150, "y" * 150, "z" * 150])
    assert sum(len(term) + 1 for term in terms) <= VOCABULARY_MAX_CHARS
    assert terms == ["x" * 150, "y" * 150]


def test_a_name_that_does_not_fit_does_not_drop_the_following_ones():
    assert limit_vocabulary(["A" * VOCABULARY_MAX_CHARS, "Bia", "Caio"]) == ["Bia", "Caio"]
    assert limit_vocabulary(["x" * 300, "y" * 150, "Bia"]) == ["x" * 300, "Bia"]
