"""A extração do anexo do Agente roda antes da transação com trava da conversa."""

from __future__ import annotations

import asyncio

from eclume_server.agent_files import MAX_INPUT_BYTES
from eclume_server.agent_sessions import prepare_input_file


def test_anexo_aceito_chega_com_o_texto_extraido():
    prepared = asyncio.run(prepare_input_file("ata.txt", "olá".encode()))
    assert prepared.rejection is None
    assert prepared.extracted is not None
    assert prepared.extracted.text == "olá"


def test_anexo_recusado_guarda_a_recusa_sem_levantar():
    prepared = asyncio.run(prepare_input_file("virus.exe", b"MZ"))
    assert prepared.extracted is None
    assert prepared.rejection is not None


def test_anexo_acima_do_teto_nao_gasta_extracao():
    prepared = asyncio.run(prepare_input_file("grande.txt", b"x" * (MAX_INPUT_BYTES + 1)))
    assert prepared.extracted is None
    assert prepared.rejection is None
