---
okf_version: "0.1"
---

# `docs/` — OKF knowledge bundle

A árvore canônica de conhecimento do eclume, um bundle **Open Knowledge Format (OKF v0.1)**. Cada
**home** tem nome fixo e um único propósito. Este `index.md` é a porta de entrada do bundle (a
única listagem com frontmatter, e só `okf_version`). Nomes de pasta e chaves de frontmatter são
canônicos em inglês kebab-case; **a prosa segue o idioma do repositório (português)**.

## Homes

* [standards/](standards/index.md) — como **NÓS** fazemos (contratos e convenções atuais), por assunto; regra acordada mas não provada fica aqui como `authority: background`
* [vision/](vision/index.md) — direção por área, sem prazo
* [concepts/](concepts/index.md) — conhecimento genérico que sustentamos; inclui o [glossário](glossary.md)
* [how-to/](how-to/index.md) — receitas para qualquer instalação: auto-hospedar e desenvolver sem GPU
* [project/](project/index.md) — o manual deste repositório: referências de mercado e o runbook do host

## Fronteiras

- `standards/` = "como **NÓS** fazemos (atual)"; regra acordada mas não provada fica como `authority: background`.
- `concepts/` = "o que **entendemos**" (explicativo, não vinculante).
- A **caixa de tarefas** vive fora deste bundle, no workspace de specs gerido pelo Quenching (backend GitHub, `holetz/eclume`). A direção do produto está em [vision/](vision/index.md); o épico `holetz/eclume#1` é o registro da primeira construção.
- Homes ainda vazias — `catalog/`, `external/`, `tutorials/`, `explanation/` — são instaladas quando o primeiro doc chegar.

**Resolvendo um termo.** Palavra, sigla ou codinome desconhecido? Procure primeiro no
[glossário](glossary.md): `grep -i '<termo>' docs/glossary.md`.

O contrato completo (homes, tipos, conformidade) vive nas `references/` do plugin `quenching`; o
bundle é operado pelos comandos `quenching:knowledge:*` (`/quenching:knowledge:status` mostra o
estado atual).
