---
type: how-to
title: Desenvolver o eclume sem GPU
description: Do clone a uma gravação transcrita e resumida numa máquina Linux ou Windows sem GPU e sem o host de build — serviços do compose de dev, migrate, admin, API em HTTP, workers, worker de transcrição na engine cpu, web apontando para a API, e o equivalente local de cada remote-run (testes de navegador, E2E e build Android).
resource: deploy/docker-compose.dev.yml, deploy/.env.example, deploy/docker-compose.mock.yml, server/src/eclume_server/config.py, worker-gpu/src/eclume_worker/config.py, web/vite.config.ts
tags: [desenvolvimento, cpu, sem-gpu, dev]
timestamp: 2026-10-01
audience: both
source: holetz/eclume#126
maintainer: holetz
---

# Desenvolver o eclume sem GPU

O loop de desenvolvimento roda inteiro numa máquina comum: o worker de transcrição usa a engine
`cpu` (faster-whisper `small` int8, sem diarização), e o host de build do projeto
(`remote-run`, em [monorepo.md](../standards/code/monorepo.md)) é uma comodidade, não um
requisito. Os comandos de lint e teste de cada pilar estão em
[monorepo.md](../standards/code/monorepo.md); este guia leva do clone a uma gravação transcrita e
resumida.

## Pré-requisitos

- Git, Docker com o plugin Compose, [`uv`](https://docs.astral.sh/uv/), Node.js 22 e `ffmpeg` no
  `PATH` (o pré-processamento do worker o chama).
- **Windows:** Docker Desktop com WSL 2. O mais simples é rodar tudo dentro de uma distribuição
  WSL (Ubuntu), com os comandos abaixo sem mudança; no PowerShell nativo, troque `VAR=valor cmd`
  por `$env:VAR="valor"; cmd`.
- O desktop e o celular (Rust, Tauri, Android) só são necessários para mexer neles; as
  dependências de sistema estão em [monorepo.md](../standards/code/monorepo.md).

## 1. Clone e dependências

```bash
git clone https://github.com/holetz/eclume.git && cd eclume
uv sync --all-packages
npm --prefix web ci
```

## 2. Serviços

O compose de dev sobe Postgres (com pgvector), Redis e MinIO em `127.0.0.1`, com as senhas de dev
que o server já usa por padrão. O bucket nasce uma vez:

```bash
docker compose -f deploy/docker-compose.dev.yml up -d
docker compose -f deploy/docker-compose.dev.yml exec minio \
  sh -c 'mc alias set local http://127.0.0.1:9000 eclume eclume-dev-secret && mc mb --ignore-existing local/eclume'
```

Portas ocupadas mudam por `deploy/.env` (copie de `deploy/.env.example`); mudando uma, passe a
URL correspondente ao server e aos workers (`ECLUME_DATABASE_URL`, `ECLUME_REDIS_URL`,
`ECLUME_S3_ENDPOINT`).

## 3. Banco e admin

```bash
uv run eclume-server migrate
printf '%s' 'senha-do-admin-local' \
  | uv run eclume-server admin create --email admin@exemplo.com.br --name Admin --password-stdin
```

## 4. API e workers

Cada um num terminal. A API em HTTP puro precisa de `ECLUME_COOKIE_SECURE=false`, ou o cookie de
sessão não volta ao navegador:

```bash
ECLUME_COOKIE_SECURE=false uv run uvicorn eclume_server.app:create_app --factory
uv run arq eclume_server.worker.WorkerSettings          # fila eclume:default (ingestão, retomada)
uv run arq eclume_server.worker.AgentWorkerSettings     # fila eclume:agents (resumos)
```

O worker de transcrição, na engine `cpu`, com o extra `cpu` (faster-whisper; sem torch):

```bash
ECLUME_ENGINE=cpu ECLUME_DEVICE=cpu \
ECLUME_S3_ENDPOINT_URL=http://127.0.0.1:9000 ECLUME_S3_ACCESS_KEY=eclume ECLUME_S3_SECRET_KEY=eclume-dev-secret \
  uv run --package eclume-worker --extra cpu arq eclume_worker.worker.WorkerSettings
```

O primeiro job baixa o modelo `small` (~0,5 GB) para o cache do Hugging Face do usuário. A
transcrição sai com um locutor só: a engine `cpu` não diariza
([jobs-transcricao.md](../standards/api/jobs-transcricao.md#como-o-worker-cumpre-a-sua-parte)).

## 5. Web

```bash
ECLUME_API_URL=http://127.0.0.1:8000 npm --prefix web run dev
```

Abra `http://localhost:5173`, crie uma conta em **Criar conta** e envie uma gravação curta: ela
passa por `processing` até `done` com a transcrição. O microfone do navegador só funciona em
`localhost` ou HTTPS.

## 6. Resumo

Entre no painel em `http://localhost:5173/admin/entrar` com o admin do passo 3 e cadastre um
provider em **Admin → Agentes**: uma chave de API, ou um servidor compatível com a API da OpenAI na
sua rede (ex.: um modelo local). A matriz do que cada tipo exige está em
[server-agentes.md](../standards/code/server-agentes.md#o-que-cada-provider-exige). Com ele
cadastrado, a gravação transcrita ganha o resumo.

## Sem o host de build: o equivalente local de cada `remote-run`

Os `remote-run` de [monorepo.md](../standards/code/monorepo.md) sincronizam o checkout para o host
de build e rodam lá; localmente, o mesmo comando roda na raiz do checkout:

| `remote-run` | Local |
|---|---|
| `remote-run web '… npm run test:browser'` | `cd web && npx playwright install webkit firefox && npm run fixtures && npm run test:browser` |
| `remote-run . '… docker-compose.mock.yml … npm run test:e2e'` | `docker compose -p eclume-mock-web -f deploy/docker-compose.mock.yml up -d --wait && cd web && npx playwright install chromium && npm run test:e2e` |
| `remote-run . 'source ~/.config/eclume/android-env.sh && … android build …'` | instale o SDK uma vez com `bash mobile/scripts/android-sdk.sh` e rode `source ~/.config/eclume/android-env.sh && npm --prefix mobile ci && npm --prefix mobile run tauri -- android build --debug --apk --target x86_64` |
| `cargo …` dos pilares desktop e mobile | os mesmos comandos, com as dependências de sistema do Tauri instaladas |

Os testes de navegador precisam do Google Chrome instalado; o E2E usa a porta 4010 do mock (outra
por `ECLUME_MOCK_PORT` e `ECLUME_MOCK_URL`). O build Android ocupa ~8 GB de SDK, JDK e NDK em `~/`.
