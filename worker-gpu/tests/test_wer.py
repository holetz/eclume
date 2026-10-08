"""WER e CER com textos fixos."""

from __future__ import annotations

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
