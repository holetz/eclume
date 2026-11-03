"""WER and CER with fixed texts."""

from __future__ import annotations

import random

import pytest

from eclume_worker.wer import cer, char_counts, edit_counts, normalize, wer, word_counts


def test_normalize_lowercase_punctuation_and_spaces():
    assert normalize('  Olá,   MUNDO!\n"Tudo" bem? — sim… ') == "olá mundo tudo bem sim"


def test_normalize_preserves_accents_and_inner_hyphen():
    assert normalize("É o guarda-chuva; e o café.") == "é o guarda-chuva e o café"
    assert normalize("- sim -") == "sim"


def test_normalize_nfc_equals_composed():
    assert normalize("café") == normalize("café")


def test_wer_identical_is_zero():
    assert wer("Era uma vez.", "era uma vez") == 0.0


def test_wer_counts_substitution_deletion_insertion():
    counts = word_counts("o gato subiu no telhado velho", "o gato desceu no telhado velho hoje")
    assert (counts.substitutions, counts.deletions, counts.insertions) == (1, 0, 1)
    assert counts.reference_len == 6
    assert counts.rate == pytest.approx(2 / 6)
    deletion = word_counts("um dois tres", "um tres")
    assert (deletion.substitutions, deletion.deletions, deletion.insertions) == (0, 1, 0)


def test_lost_accent_is_an_error():
    assert wer("ele é bom", "ele e bom") == pytest.approx(1 / 3)


def test_wer_can_exceed_one():
    assert wer("oi", "oi oi oi") == 2.0


def test_empty_reference():
    assert wer("", "") == 0.0
    assert wer("", "algo") is None


def test_empty_hypothesis_is_all_deletion():
    assert wer("um dois", "") == 1.0


def test_cer_per_character_with_space():
    counts = char_counts("casa azul", "caza azul")
    assert (counts.substitutions, counts.deletions, counts.insertions) == (1, 0, 0)
    assert cer("casa azul", "caza azul") == pytest.approx(1 / 9)


def test_edit_counts_generic_sequences():
    counts = edit_counts(list("kitten"), list("sitting"))
    assert counts.errors == 3
    assert (counts.substitutions, counts.insertions) == (2, 1)


def _full_matrix(reference: list[str], hypothesis: list[str]) -> int:
    rows, cols = len(reference), len(hypothesis)
    cost = [[0] * (cols + 1) for _ in range(rows + 1)]
    for i in range(rows + 1):
        cost[i][0] = i
    for j in range(cols + 1):
        cost[0][j] = j
    for i in range(1, rows + 1):
        for j in range(1, cols + 1):
            diagonal = cost[i - 1][j - 1] + (reference[i - 1] != hypothesis[j - 1])
            cost[i][j] = min(diagonal, cost[i - 1][j] + 1, cost[i][j - 1] + 1)
    return cost[rows][cols]


def test_edit_counts_equals_the_full_matrix_on_random_inputs():
    rnd = random.Random(190)  # noqa: S311
    for _ in range(300):
        alphabet = "abcd"[: rnd.randint(1, 4)]
        ref = [rnd.choice(alphabet) for _ in range(rnd.randint(0, 40))]
        hyp = [rnd.choice(alphabet) for _ in range(rnd.randint(0, 40))]
        c = edit_counts(ref, hyp)
        assert c.errors == _full_matrix(ref, hyp)
        assert c.deletions - c.insertions == len(ref) - len(hyp)
        assert c.reference_len == len(ref)
        assert c.substitutions + c.deletions <= len(ref)


def test_edit_counts_long_text_with_few_errors():
    ref = list("abcdefghij" * 300)
    hyp = ref.copy()
    hyp[100] = "z"
    del hyp[1500]
    hyp.insert(2500, "y")
    c = edit_counts(ref, hyp)
    assert (c.substitutions, c.deletions, c.insertions) == (1, 1, 1)
