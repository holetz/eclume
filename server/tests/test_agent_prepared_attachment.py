"""The Agent attachment extraction runs before the transaction holding the conversation lock."""

from __future__ import annotations

import asyncio

from eclume_server.agent_files import MAX_INPUT_BYTES
from eclume_server.agent_sessions import prepare_input_file


def test_accepted_attachment_arrives_with_the_extracted_text():
    prepared = asyncio.run(prepare_input_file("ata.txt", "olá".encode()))
    assert prepared.rejection is None
    assert prepared.extracted is not None
    assert prepared.extracted.text == "olá"


def test_rejected_attachment_keeps_the_rejection_without_raising():
    prepared = asyncio.run(prepare_input_file("virus.exe", b"MZ"))
    assert prepared.extracted is None
    assert prepared.rejection is not None


def test_attachment_above_the_ceiling_spends_no_extraction():
    prepared = asyncio.run(prepare_input_file("grande.txt", b"x" * (MAX_INPUT_BYTES + 1)))
    assert prepared.extracted is None
    assert prepared.rejection is None
