---
type: standard
title: Versionamento e CHANGELOG
description: As três linhas de versão SemVer do eclume — o produto (server, worker GPU, engines e web, que sobem no mesmo deploy), o app desktop e o app do celular — com o contrato na linha própria; onde cada versão vive e o deploy/versao.py que as move juntas e as confere; quando cada linha sobe (MAJOR, MINOR, PATCH e a regra do 0.x); o formato Keep a Changelog em pt-BR com o bloco Para quem hospeda; as notas dos releases dos apps tiradas do CHANGELOG; a tag v<versão> no primeiro deploy; e o que o conclude de cada spec anexa ao merge.
resource: deploy/versao.py, deploy/test_versao.py, CHANGELOG.md, desktop/CHANGELOG.md, mobile/CHANGELOG.md, deploy/deploy.sh, deploy/release-desktop.sh, deploy/release-movel.sh, .github/workflows/desktop-release.yml
tags: [code, versao, changelog, release, deploy, semver]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#128
maintainer: holetz
---

# Versionamento e CHANGELOG

O eclume tem **três linhas de versão**, porque tem três canais de entrega. O **produto** — server,
worker GPU, engines e web — sobe inteiro num deploy (`deploy/deploy.sh`), então é uma versão só. O
**app desktop** e o **app do celular** têm updater, release e tag próprios e falam com servidores de
versões diferentes pelo contrato, então seguem a própria linha. O **contrato** (`info.version` da
v1) segue na linha dele, com a regra de [contrato-v1.md](../api/contrato-v1.md); cada entrada do
produto cita a versão do contrato que leva.

Uma versão para tudo faria cada correção do desktop subir o servidor e vice-versa; uma por pilar
separaria server e web, que nunca sobem separados.

## Onde cada versão vive

| Linha | Campos (andam juntos) | CHANGELOG | Tag |
|---|---|---|---|
| `produto` | `version` de `server/`, `engines/` e `worker-gpu/pyproject.toml`; `web/package.json`; `web/package-lock.json` (raiz e `packages[""]`); os três membros no `uv.lock` | `CHANGELOG.md` | `v<versão>`, no primeiro deploy |
| `desktop` | `desktop/src-tauri/tauri.conf.json`; `[workspace.package]` de `desktop/Cargo.toml`; os crates dele em `desktop/Cargo.lock` e `mobile/Cargo.lock` | `desktop/CHANGELOG.md` | `desktop-v<versão>`, no release ([desktop-distribuicao.md](desktop-distribuicao.md)) |
| `movel` | `mobile/src-tauri/tauri.conf.json`; `[workspace.package]` de `mobile/Cargo.toml`; os crates dele em `mobile/Cargo.lock` | `mobile/CHANGELOG.md` | `mobile-v<versão>`, no release ([mobile-distribuicao.md](mobile-distribuicao.md)) |

- O `__version__` do server, do worker e das engines vem de `importlib.metadata.version(...)`: não
  há literal para esquecer. O `/health`, o `GET /api/v1/server` e o `worker_version` do heartbeat o
  leem.
- `python3 deploy/versao.py definir <linha> <versão>` grava a versão em todos os campos da linha,
  por expressão e sem reformatar os arquivos (os locks inclusive, sem rede); `atual <linha>` a lê.
- `python3 deploy/versao.py conferir` falha quando um campo diverge, quando a versão atual de uma
  linha não tem seção no CHANGELOG dela, quando o CHANGELOG não abre por `[Não lançado]`, quando o
  `__version__` volta a ser literal ou quando uma migration de
  `server/src/eclume_server/db/migrations/` não é citada (pelo nome, `NNN_assunto`) no
  `CHANGELOG.md`. O `deploy/test_versao.py` roda o `conferir` sobre a árvore real, no pilar `python`.

## Quando sobe

SemVer pelo olhar de quem hospeda e de quem usa o app:

- **MAJOR** — quem hospeda precisa agir para não quebrar (migration que pede intervenção, variável
  removida ou renomeada, corte para `/api/v2`), ou um app já instalado deixa de funcionar.
- **MINOR** — recurso novo, migration nova, variável nova ou contrato MINOR.
- **PATCH** — correção sem migration nem mudança de contrato.
- **Enquanto a linha estiver em `0.x`, a quebra sobe o MINOR.**
- Mudança que não altera o que é entregue (só docs, CI, specs, testes) não sobe versão nem ganha
  entrada.

## Quem sobe: o conclude de cada spec

Subir a versão e escrever a entrada é do **conclude** da spec, no mesmo merge do código, nunca de uma
tarefa em `## Tasks`: como tarefa, o número seria decidido antes de o trabalho existir, e dois ramos
subiriam do mesmo número para o mesmo número. O conclude lê o diff inteiro da spec e, para cada linha
que ele muda no que é entregue:

1. Decide o nível pela seção acima.
2. Se a versão atual da linha **já foi publicada** (a tag dela existe; no produto, também a 0.1.0,
   em produção antes das tags), roda `deploy/versao.py definir <linha> <próxima>` e abre a seção da
   nova versão, com a data do merge. Se **ainda não foi publicada**, a entrada vai para a seção da
   versão atual, que só sobe de novo se o nível pedir mais (uma quebra numa versão PATCH ainda não
   publicada, por exemplo).
3. Escreve as entradas e, no produto, o bloco Para quem hospeda.
4. Roda `uv run pytest deploy/test_versao.py`.

Specs mescladas em paralelo escolhem o número **dentro da trava de merge**, olhando `main`
atualizado, como as migrations e o `info.version`.

`## [Não lançado]` fica no topo de todo CHANGELOG para nada se perder entre merges: guarda o que
entrou sem número (o acumulado do produto antes desta norma, holetz/eclume#89 a #130). O conclude que
cortar a próxima versão da linha move essas entradas para a seção dela. Enquanto o `[Não lançado]` do
produto tiver entradas, o deploy não cria a tag.

## Formato do CHANGELOG

[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) em pt-BR:

- Uma seção por versão, a mais nova em cima, `## [X.Y.Z] - AAAA-MM-DD` (a data do merge que cortou a
  versão); abaixo do `## [Não lançado]`.
- Grupos `### Adicionado`, `### Mudado`, `### Corrigido` e `### Removido`, só os que tiverem
  entrada; cada entrada diz o efeito para quem usa, numa frase, e cita a spec (`holetz/eclume#N`) no
  produto.
- No produto, **`### Para quem hospeda`**, obrigatório quando houver migration ou variável nova:
  - as **migrations** que rodam, pelo nome; a **destrutiva** vem marcada e pede o backup antes
    ([deploy-producao.md](../../project/deploy-producao.md));
  - as **variáveis de ambiente** novas, mudadas ou removidas, e se o deploy as gera ou recusa sem
    elas;
  - a **versão do contrato** que a versão leva;
  - as **versões de app compatíveis**.
- Nos apps, as entradas falam com quem usa o app: a seção da versão é a nota do release.

## Notas dos releases dos apps

As notas do `latest.json` (desktop) e do `movel.json` (celular) são a seção da versão no CHANGELOG da
linha, lida por `python3 deploy/versao.py notas <linha> <versão>` no `deploy/release-desktop.sh`, no
workflow `desktop-release` e no `deploy/release-movel.sh`. É o texto que o desktop mostra no aviso
"Atualizado para X" e o celular em "Nova versão disponível". `--notas` explícito continua vencendo;
sem ele, uma versão sem seção (ou com a seção vazia) recusa o release.

## Tag no deploy

O `deploy/deploy.sh` lê a versão do produto na árvore do commit alvo e a mostra no `--plan`. O
primeiro deploy de uma versão, depois do gate e da conferência do `/health` e do descritor, cria a
tag anotada `v<versão>` no SHA publicado e a envia ao `origin`. Não cria no `--voltar`, quando a tag
já existe nem com entradas em `[Não lançado]`; uma falha ao criar ou enviar a tag só avisa, porque o
deploy já está no ar.

## O que o conclude anexa ao merge

- A versão de cada linha que a spec muda no que é entregue, pela seção "Quem sobe", com a entrada no
  CHANGELOG da linha.
- No produto, o bloco Para quem hospeda com as migrations novas, as variáveis e o `info.version`.
- O `deploy/test_versao.py` verde.
