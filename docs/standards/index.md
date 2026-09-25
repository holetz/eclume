# `standards/` — contratos atuais do eclume

O **padrão/contrato** atual — "como deve ser e por quê", a fonte da verdade compartilhada. Um
padrão por arquivo; subpastas por **assunto**. Cada doc tem `type: standard` e um `resource:`
derivado (o escopo do repositório que ele governa).

**Fronteira:** `standards/` = "como **NÓS** fazemos (atual)". Direção vive em
[vision/](../vision/index.md). Uma regra **acordada mas não provada** fica aqui como
`authority: background` e passa a `current` quando provada.

## Subtopics

* [agents/](agents/index.md) — o idioma declarado e o contrato de conduta dos agentes
* [code/](code/index.md) — layout do monorepo, toolchains e comandos de cada pilar

## Current docs

<!-- BEGIN GENERATED: rebuilt from disk by `quenching-align`/`quenching-insert` — DO NOT edit by hand.
     Scans standards/**/*.md, reads title/description/timestamp/type, grouped by subject subfolder. -->
### agents/
| Doc | Covers |
| --- | --- |
| [communication.md](agents/communication.md) | The language a repo declares for the prose its agents author — one BCP-47 tag on the root harness line, governing artifact and conversation alike — and the conduct contract that holds in every repo whether or not a language is declared |

### code/
| Doc | Covers |
| --- | --- |
| [monorepo.md](code/monorepo.md) | Cada pilar do eclume fica na raiz com a própria toolchain — workspace uv (server, worker-gpu, engines), npm em web/ e workspace cargo em desktop/ — e estes são os comandos de build, lint e teste que a CI e as specs usam. |
<!-- END GENERATED -->
