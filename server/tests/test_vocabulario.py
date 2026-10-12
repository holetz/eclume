"""O vocabulário da conta no payload do `transcribe`: deduplicado, limitado, sem vazios."""

from __future__ import annotations

from eclume_server.recordings import VOCABULARY_MAX_CHARS, VOCABULARY_MAX_TERMS, limit_vocabulary


def test_deduplica_sem_olhar_caixa_e_descarta_vazios():
    assert limit_vocabulary(["Ana  Souza", "ana souza", "", "  ", "Bia"]) == ["Ana Souza", "Bia"]


def test_limita_a_quantidade_de_termos():
    assert len(limit_vocabulary([f"N{i}" for i in range(200)])) == VOCABULARY_MAX_TERMS


def test_limita_os_caracteres():
    terms = limit_vocabulary(["x" * 150, "y" * 150, "z" * 150])
    assert sum(len(term) + 1 for term in terms) <= VOCABULARY_MAX_CHARS
    assert terms == ["x" * 150, "y" * 150]


def test_nome_que_nao_cabe_nao_derruba_os_seguintes():
    assert limit_vocabulary(["A" * VOCABULARY_MAX_CHARS, "Bia", "Caio"]) == ["Bia", "Caio"]
    assert limit_vocabulary(["x" * 300, "y" * 150, "Bia"]) == ["x" * 300, "Bia"]
