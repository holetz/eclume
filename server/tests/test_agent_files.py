"""Arquivos do Agente: a extração do texto dos anexos, os limites e os arquivos gerados."""

from __future__ import annotations

import zipfile
from io import BytesIO
from uuid import UUID

import pytest
from docx import Document

from eclume_server.agent_files import (
    MAX_TEXT_CHARS,
    FileRejectedError,
    clean_name,
    extract_text,
    file_key,
    output_name,
    render_output,
)


def _pdf(text: str) -> bytes:
    """Um PDF mínimo de uma página com `text` em Helvetica (ASCII)."""
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        out.write(f"{offset:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


def _docx(*paragraphs: str) -> bytes:
    doc = Document()
    for paragraph in paragraphs:
        doc.add_paragraph(paragraph)
    table = doc.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "Cliente"
    table.rows[0].cells[1].text = "Acme"
    buffer = BytesIO()
    doc.save(buffer)
    return buffer.getvalue()


def test_texto_em_utf8_e_latin1():
    assert extract_text("notas.txt", "Ação combinada".encode()).text == "Ação combinada"
    assert extract_text("notas.TXT", "Ação combinada".encode("latin-1")).text == "Ação combinada"
    assert extract_text("bom.md", "﻿# Título\r\nlinha".encode()).text == "# Título\nlinha"


def test_csv_vira_texto_com_o_tipo():
    extracted = extract_text("vendas.csv", b"nome,valor\nA,1\n")
    assert extracted.text == "nome,valor\nA,1"
    assert extracted.media_type.startswith("text/csv")


def test_pdf_extrai_o_texto_da_pagina():
    extracted = extract_text("ata.pdf", _pdf("Prazo combinado: sexta"))
    assert "Prazo combinado: sexta" in extracted.text
    assert extracted.media_type == "application/pdf"


def test_docx_extrai_paragrafos_e_tabelas():
    text = extract_text("proposta.docx", _docx("Primeiro parágrafo", "Segundo")).text
    assert "Primeiro parágrafo\nSegundo" in text
    assert "Cliente | Acme" in text


def test_texto_longo_e_cortado_no_teto():
    extracted = extract_text("grande.txt", b"a" * (MAX_TEXT_CHARS + 10))
    assert len(extracted.text) == MAX_TEXT_CHARS
    assert extracted.truncated


@pytest.mark.parametrize(
    ("name", "data"),
    [
        ("planilha.xlsx", b"PK\x03\x04"),
        ("foto.png", b"\x89PNG"),
        ("sem-extensao", b"texto"),
        ("falso.pdf", b"nao sou pdf"),
        ("falso.docx", b"nao sou zip"),
        ("binario.txt", b"\x00\x01\x02"),
    ],
)
def test_recusa_tipo_fora_da_lista_ou_conteudo_que_nao_bate(name: str, data: bytes):
    with pytest.raises(FileRejectedError):
        extract_text(name, data)


def test_docx_sem_documento_e_recusado():
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("outro.xml", "<x/>")
    with pytest.raises(FileRejectedError):
        extract_text("vazio.docx", buffer.getvalue())


def test_nomes_sem_caminho_e_com_a_extensao_do_formato():
    assert clean_name("../../etc/passwd") == "passwd"
    assert clean_name("") == "arquivo"
    assert output_name("relatório.md", "md") == "relatório.md"
    assert output_name("tabela", "csv") == "tabela.csv"
    assert output_name("a/b:c", "txt") == "b-c.txt"


def test_gera_markdown_csv_e_docx():
    md = render_output("resumo", "md", "# Semana\n- item")
    assert (md.name, md.data) == ("resumo.md", b"# Semana\n- item")
    csv = render_output("dados", "csv", "a,b\n1,2")
    assert csv.media_type.startswith("text/csv")
    docx = render_output("relatorio", "docx", "# Título\n\nTexto **forte**.\n- um\n- dois")
    doc = Document(BytesIO(docx.data))
    assert [p.text for p in doc.paragraphs if p.text] == ["Título", "Texto forte.", "um", "dois"]


def test_formato_fora_da_lista_e_recusado():
    with pytest.raises(ValueError, match="xlsx"):
        render_output("x", "xlsx", "a")


def test_chave_do_arquivo_fica_sob_o_dono():
    owner, session, file = (UUID(int=1), UUID(int=2), UUID(int=3))
    assert file_key(owner, session, file) == f"users/{owner}/agent/{session}/{file}"
