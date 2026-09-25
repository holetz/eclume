---
type: standard
title: Contrato de API v1
description: As convenções da API v1 do eclume — autenticação por sessão e PAT com escopos, erros RFC 9457, paginação por cursor, upload multipart S3 com dedup por hash, transcrição em JSON Schema — e a regra de que a v1 só evolui de forma aditiva.
resource: contracts/**, deploy/docker-compose.mock.yml, server/**
tags: [api, contrato, openapi, pat, upload, evolucao]
timestamp: 2026-09-25
audience: both
authority: current
source: holetz/eclume#3, holetz/eclume#15
maintainer: holetz
---

# Contrato de API v1

O contrato fica em `contracts/`: `openapi-v1.yaml` e `transcript.schema.json` são a fonte da
verdade, `fixtures/` traz os exemplos e `openapi-v1.bundled.yaml` é o derivado de arquivo único
que o mock (Prism) e os geradores de tipos leem. O servidor **conforma** ao contrato; o contrato
nunca é gerado do código. O manual de uso (mock, lumea, desktop, mapeamento para
`transcricao.md`) está em [contracts/README.md](/contracts/README.md).

## Convenções

- **Prefixo e formatos.** Tudo sob `/api/v1`. Datas em RFC 3339 UTC, durações em milissegundos
  inteiros (`*_ms`), ids em UUID; locutores têm id `S<n>` único na transcrição.
- **Autenticação.** Dois esquemas. Sessão por cookie `eclume_session` (HttpOnly, Secure,
  SameSite=Lax) com CSRF por double-submit (`X-CSRF-Token` = cookie `eclume_csrf`) em método
  mutável. PAT pessoal em `Authorization: Bearer eclp_<segredo>`, guardado só como hash e
  mostrado uma vez.
- **Escopos do PAT:** `recordings:read`, `recordings:write`, `transcripts:read`,
  `transcripts:write`, `people:read`, `people:write`, `summaries:read`, `summaries:write`. Nenhum
  implica outro; a operação lista no requisito `pat: [...]` todos os que exige. Sessão tem todas as
  permissões do usuário.
- **Só sessão:** gestão de PATs, escrita de grupos, `/api/v1/admin/*` (que exige ainda o papel
  `admin`) e as rotas de voz (tag `voice`: consentimento, impressão, exportação e recusa de
  sugestão). Um PAT vazado não cria outro PAT, não mexe na organização e não lê nem apaga dado
  biométrico.
- **Erros** em `application/problem+json` (RFC 9457) com o campo estável `code`; o cliente decide
  por `code`, nunca por `title`. 404 não distingue "não existe" de "não é visível".
- **Paginação** por cursor opaco: `?cursor=&limit=` (1–200), resposta `{items, next_cursor}`,
  `next_cursor: null` na última página. Listagem incremental por `?since=` compara
  `updated_at >= since` (inclusivo) e o cliente deduplica por `id` + `revision`.
- **Upload** resumível em partes (multipart S3 orquestrado pela API): `POST /uploads` com o
  `sha256` do arquivo → partes por `PUT` em URLs opacas que expiram → `POST /uploads/{id}/complete`.
  Mesmo hash de uma gravação do usuário responde 200 `deduplicated` sem transferir nada. Retomar é
  `GET /uploads/{id}` mais `POST /uploads/{id}/part-urls`. O navegador sobe o áudio já convertido
  ([formato-audio-upload.md](../code/formato-audio-upload.md)): `audio/ogg; codecs=opus` e o
  `sha256` em hex minúsculo que a biblioteca de conversão devolve.
- **Transcrição** no schema de `contracts/transcript.schema.json`: segmentos
  `{id, speaker_id, start_ms, end_ms, text}` (palavras só com `?include=words`), locutores
  `{id, label, person, suggestions}`, `content_hash` do áudio e `revision`, que sobe a cada edição.
  Sugestão por voz nunca é identidade até alguém confirmar: aceitar é o `PATCH` do locutor com
  `person_id`, recusar é o `DELETE` da sugestão
  ([identificacao-por-voz.md](../code/identificacao-por-voz.md)).

## Evolução: a v1 só cresce

- **Permitido:** rota nova; campo ou parâmetro de requisição novo e opcional; campo de resposta
  novo; valor de enum novo em resposta; `code` de erro novo; formato de export novo.
- **Proibido:** remover ou renomear; mudar tipo ou significado; tornar obrigatório o que era
  opcional; apertar validação de entrada existente; exigir escopo ou papel a mais numa rota
  existente; trocar o status de sucesso.
- **Clientes toleram o desconhecido:** ignoram propriedades novas e valores de enum novos em
  respostas. Por isso nenhum schema de resposta fecha `additionalProperties`.
- **Cada mudança** sobe `info.version` (e `schema_version` se tocar a transcrição), atualiza as
  fixtures, regenera o bundle e passa em `uv run pytest contracts/tests`, que a CI roda no job
  `contracts` junto com o smoke do mock.
- **Quebra** vira `/api/v2` num `openapi-v2.yaml` próprio; a v1 segue servida na transição,
  anunciando o fim com `Deprecation` e `Sunset`.

## Por quê

O contrato existe antes do backend para que o servidor, o frontend, o desktop e o importador do
lumea desenvolvam em paralelo contra o mesmo mock. Isso só funciona se ninguém precisar acompanhar
mudanças do contrato: daí a regra aditiva e a tolerância obrigatória do cliente. O upload é
multipart S3 e não tus porque o MinIO já fala o protocolo, a API fica fora do caminho dos bytes e
o cliente Rust e o navegador só precisam de `PUT` HTTP.
