# contracts

Fonte da verdade do contrato entre o eclume e os seus clientes: o frontend web, o app desktop e
integrações por PAT, a começar pelo importador do lumea. As convenções e as regras de evolução
estão no standard [docs/standards/api/contrato-v1.md](../docs/standards/api/contrato-v1.md).

| Arquivo | O que é |
|---|---|
| `openapi-v1.yaml` | **Fonte.** OpenAPI 3.1 da API v1: autenticação, escopos, erros, paginação e todas as rotas. |
| `transcript.schema.json` | **Fonte.** JSON Schema 2020-12 da transcrição, referenciado pelo OpenAPI. É também a saída do worker GPU. |
| `fixtures/` | **Fonte.** Exemplos realistas em pt-BR, um arquivo por exemplo do OpenAPI (`externalValue`). |
| `openapi-v1.bundled.yaml` | **Gerado** por `tools/bundle.py`: arquivo único, sem refs externas, com as fixtures inlinadas. É o que o mock e os geradores de tipos leem. Não edite à mão. |
| `tools/bundle.py` | Gera o bundle; `--check` falha se ele estiver desatualizado. |
| `tests/` | Testes de contrato (pytest do workspace) e o smoke do mock. |

```bash
uv run python contracts/tools/bundle.py          # depois de mudar qualquer fonte
uv run pytest contracts/tests                    # OpenAPI, schema, fixtures, export .md, mapeamento lumea
docker compose -f deploy/docker-compose.mock.yml up -d --wait
bash contracts/tests/smoke-mock.sh
```

## Mock server

O Prism (`stoplight/prism:5.15.10`) serve o bundle em `http://127.0.0.1:4010`, em modo estático:
cada rota responde com o exemplo declarado, que vem de `fixtures/`.

- **Credencial.** Rotas protegidas exigem a *presença* da credencial: `Authorization: Bearer
  eclp_<qualquer coisa>` ou o cookie `eclume_session`. Sem ela, 401 com o problem de
  `fixtures/problem-unauthorized.json`. O mock **não** confere escopos. As rotas
  `/api/v1/admin/*` exigem o cookie `eclume_admin_session` da conta de admin; PAT ou sessão de
  usuário ali dão 401.
- **Validação.** O corpo e os parâmetros são validados contra o contrato; requisição inválida
  recebe 422.
- **Escolher a resposta.** `Prefer: code=<status>` escolhe o status e `Prefer: example=<nome>` o
  exemplo. Atenção: `POST /api/v1/uploads` responde por padrão com o **200** (`deduplicated`),
  porque o Prism escolhe o menor 2xx; mande `Prefer: code=201` para simular um upload novo.
- **Upload completo.** As URLs de parte do exemplo apontam para o próprio mock
  (`PUT /api/v1/uploads/{id}/parts/{n}`, que devolve `ETag`), então o fluxo create → partes →
  complete roda inteiro contra ele.
- **Porta.** Publicada só em `127.0.0.1` (`ECLUME_MOCK_PORT` muda a porta). Para um container
  do lumea na bridge padrão alcançar o mock, suba com `ECLUME_MOCK_BIND=172.17.0.1` e use
  `http://172.17.0.1:4010`, ou `extra_hosts: ["host.docker.internal:host-gateway"]` no serviço.

### Como o lumea usa (holetz/lumea#13)

1. Com um checkout do eclume ao lado (`~/Projetos/eclume`), suba o mock:
   `docker compose -f ~/Projetos/eclume/deploy/docker-compose.mock.yml up -d --wait`.
2. Aponte o importador para `http://127.0.0.1:4010` com qualquer PAT `eclp_...`.
3. `GET /api/v1/me` mostra a conta conectada e os escopos do PAT; `GET /api/v1/transcripts?since=`
   lista; `GET /api/v1/transcripts/{id}` traz a transcrição de 3 locutores.
4. Nos testes unitários do lumea, copie as fixtures necessárias (`transcript-3-locutores.json`,
   `transcript-page.json`) em vez de depender do mock; o teste de integração usa o mock.

### Como o desktop usa (holetz/eclume#13)

`POST /api/v1/uploads` (com `Prefer: code=201`), `PUT` de cada parte na `url` recebida,
`POST /api/v1/uploads/{id}/complete` e polling de `GET /api/v1/recordings/{id}` até `transcribed`
ou `failed`. Retomada: `GET /api/v1/uploads/{id}` e `POST /api/v1/uploads/{id}/part-urls`.

## Mapeamento para o `transcricao.md` do lumea

O JSON v1 gera o frontmatter de `transcricao.md` (`lumea/assets/meet/transcribe/store.py`,
`models.py`) sem perda. O teste `test_json_v1_gera_o_frontmatter_do_lumea_sem_perda` prova o
mapeamento com a fixture de 3 locutores.

| `transcricao.md` | JSON v1 |
|---|---|
| `quando` | `recorded_at` |
| `participantes[].nome` | `speakers[].person.name`; sem pessoa, `speakers[].label` |
| `participantes[].speaker_id` | `speakers[].id` |
| `participantes[].papel` | não existe no eclume: o importador decide (`desconhecido` por padrão) |
| `gaps[]` `speaker-identity` | um por locutor com `person: null`; `amostra` = texto do primeiro segmento dele |
| corpo `**Nome** [HH:MM:SS]: texto` | `segments[]`: nome do locutor, `start_ms` truncado para segundos, `text` |
| chave de dedup | `content_hash` (`sha256:` do áudio); reimportar é idempotente, `revision` diz se mudou |

Uma sugestão por voz (`speakers[].suggestions`) **não** é identidade: o locutor segue com gap até
alguém confirmar a pessoa no eclume.

## Regras de evolução

A v1 só recebe mudanças **aditivas**:

- **Permitido:** rota nova; parâmetro ou campo de requisição novo e **opcional**; campo de
  resposta novo; valor de enum novo em resposta; código de erro (`code`) novo; formato de export
  novo; escopo novo exigido só por rota nova.
- **Proibido na v1:** remover ou renomear rota, campo ou parâmetro; mudar tipo ou significado;
  tornar obrigatório um campo de requisição que era opcional; apertar a validação de uma entrada
  existente; exigir escopo ou papel a mais numa rota existente; trocar o status de sucesso.
- **Clientes:** ignoram propriedades desconhecidas e toleram valores de enum desconhecidos em
  respostas; decidem erros por `code`. Por isso os schemas de resposta não usam
  `additionalProperties: false` (os testes fecham os objetos só para pegar fixture errada).
- **Toda mudança** sobe `info.version` (minor; patch para texto) e, se tocar a transcrição,
  `schema_version`; atualiza as fixtures; regenera o bundle; e passa em `uv run pytest contracts/tests`.
- **Quebra de compatibilidade** vira `/api/v2` com `openapi-v2.yaml` próprio. A v1 continua servida
  durante a transição, anunciando o fim com os headers `Deprecation` e `Sunset`.
- **Exceção única: a 2.0.0.** O fim da organização (conta por usuário, admin com sessão própria)
  saiu sob `/api/v1`, porque o desktop e o lumea não usam nada do que mudou; o porquê está no
  standard.
