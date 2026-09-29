---
type: standard
title: Produção de design
description: O portão para produzir um artefato com a marca do eclume a partir de uma fonte única de tokens, em web, Typst e PDF.
resource: .design/genres/**, .design/media/**
tags: [design, production, accessibility]
timestamp: 2026-09-28
audience: both
authority: background
source: quenching design brand pack, traduzido para o eclume
maintainer: holetz
---

# Produção de design

Todo artefato cita este padrão antes de ser produzido, escolhe um contrato de gênero, importa o
adaptador gerado da sua mídia e confere o destino renderizado, não só a fonte.

## Do's and Don'ts

### Do

- **Do** manter toda declaração primitiva em `/.design/tokens.json` e regenerar os adaptadores.
- **Do** preservar pares de frente e fundo acessíveis e a ordem semântica dos títulos.
- **Do** inspecionar o HTML, o deck ou o PDF de verdade depois de renderizar.

### Don't

- **Don't** copiar cor, tamanho de tipo, raio ou espaçamento para uma primitiva de mídia.
- **Don't** usar um asset sem licença e papel registrados.
- **Don't** tratar a projeção com perdas do `DESIGN.md` como a fonte DTCG inteira.
