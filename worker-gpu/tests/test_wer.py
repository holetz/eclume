"""WER e CER com textos fixos."""

from __future__ import annotations

import random

import pytest

from eclume_worker.wer import cer, char_counts, edit_counts, normalize, wer, word_counts


def test_normalize_minusculas_pontuacao_e_espacos():
    assert normalize('  Olá,   MUNDO!\n"Tudo" bem? — sim… ') == "olá mundo tudo bem sim"


def test_normalize_preserva_acentos_e_hifen_interno():
    assert normalize("É o guarda-chuva; e o café.") == "é o guarda-chuva e o café"
    assert normalize("- sim -") == "sim"


def test_normalize_nfc_equivale_a_composto():
    assert normalize("café") == normalize("café")


def test_wer_identico_e_zero():
    assert wer("Era uma vez.", "era uma vez") == 0.0


def test_wer_conta_substituicao_remocao_insercao():
    contagens = word_counts("o gato subiu no telhado velho", "o gato desceu no telhado velho hoje")
    assert (contagens.substitutions, contagens.deletions, contagens.insertions) == (1, 0, 1)
    assert contagens.reference_len == 6
    assert contagens.rate == pytest.approx(2 / 6)
    remocao = word_counts("um dois tres", "um tres")
    assert (remocao.substitutions, remocao.deletions, remocao.insertions) == (0, 1, 0)


def test_acento_perdido_e_erro():
    assert wer("ele é bom", "ele e bom") == pytest.approx(1 / 3)


def test_wer_pode_passar_de_um():
    assert wer("oi", "oi oi oi") == 2.0


def test_referencia_vazia():
    assert wer("", "") == 0.0
    assert wer("", "algo") is None


def test_hipotese_vazia_e_tudo_remocao():
    assert wer("um dois", "") == 1.0


def test_cer_por_caractere_com_espaco():
    contagens = char_counts("casa azul", "caza azul")
    assert (contagens.substitutions, contagens.deletions, contagens.insertions) == (1, 0, 0)
    assert cer("casa azul", "caza azul") == pytest.approx(1 / 9)


def test_edit_counts_sequencias_genericas():
    contagens = edit_counts(list("kitten"), list("sitting"))
    assert contagens.errors == 3
    assert (contagens.substitutions, contagens.insertions) == (2, 1)


def _matriz_completa(reference: list[str], hypothesis: list[str]) -> int:
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


def test_edit_counts_igual_a_matriz_completa_em_entradas_aleatorias():
    rnd = random.Random(190)  # noqa: S311
    for _ in range(300):
        alfabeto = "abcd"[: rnd.randint(1, 4)]
        ref = [rnd.choice(alfabeto) for _ in range(rnd.randint(0, 40))]
        hip = [rnd.choice(alfabeto) for _ in range(rnd.randint(0, 40))]
        c = edit_counts(ref, hip)
        assert c.errors == _matriz_completa(ref, hip)
        assert c.deletions - c.insertions == len(ref) - len(hip)
        assert c.reference_len == len(ref)
        assert c.substitutions + c.deletions <= len(ref)


def test_edit_counts_texto_longo_com_poucos_erros():
    ref = list("abcdefghij" * 300)
    hip = ref.copy()
    hip[100] = "z"
    del hip[1500]
    hip.insert(2500, "y")
    c = edit_counts(ref, hip)
    assert (c.substitutions, c.deletions, c.insertions) == (1, 1, 1)
