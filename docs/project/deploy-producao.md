---
type: project
title: Deploy de produção no host GPU
description: Como o eclume roda em produção no host 192.168.15.199 — compose do projeto eclume com Caddy na 8443, build no daemon do host pelo contexto Docker, segredos em deploy/.env.prod, conta de admin separada e cadastro aberto, CA interna nos clientes, backup diário por cron com restauração testada, operação e coexistência com o lumea.
resource: deploy/docker-compose.prod.yml, deploy/deploy.sh, deploy/deploy_lib.py, deploy/.env.prod.example, deploy/server.Dockerfile, deploy/web.Dockerfile, deploy/web.Caddyfile, deploy/bootstrap-admin.sh, deploy/backup.sh, deploy/restaurar-backup.sh, deploy/staging.sh, deploy/docker-compose.staging.yml, deploy/smoke_prod.py, deploy/smoke_mcp.py, deploy/prova-web-prod.sh, deploy/release-desktop.sh, deploy/test_compose_prod.py, deploy/prova-ca-restrita.sh
tags: [deploy, producao, host, caddy, backup, runbook]
timestamp: 2026-10-08
audience: both
authority: current
source: holetz/eclume#14, holetz/eclume#26, holetz/eclume#28, holetz/eclume#29, holetz/eclume#32, holetz/eclume#33, holetz/eclume#35, holetz/eclume#39, holetz/eclume#60, holetz/eclume#110, holetz/eclume#92, holetz/eclume#101, holetz/eclume#151
maintainer: holetz
---

# Deploy de produção no host GPU

Este é o runbook **desta** produção: o eclume desta instituição roda no host `192.168.15.199`,
preparado pelo [runbook do host](host-setup.md), e responde em **`https://192.168.15.199:8443`**.
O caminho genérico, para qualquer servidor com ou sem GPU, está em
[auto-hospedar.md](../how-to/auto-hospedar.md); aqui ficam os valores e as escolhas deste host. O host é
compartilhado com o lumea (443) e com os serviços pessoais do usuário, que o deploy nunca toca.

```
LAN ──► :8443 caddy (tls internal) ─┬─ /api/*, /media/*, /mcp ──► server:8000 (uvicorn)
        eclume-edge                 ├─ /downloads/*           ──► /srv/eclume/downloads (somente leitura)
                                    └─ resto                  ──► /srv/web (SPA na própria imagem)
server ──► postgres · redis · minio ◄── worker (eclume:default e eclume:agents, claude -p)
                         redis ◄──────── worker-gpu (eclume:gpu, WhisperX na GTX 1660 SUPER)
```

## Stack

`deploy/docker-compose.prod.yml`, projeto **`eclume`** (containers `eclume-<serviço>-1`), com oito
serviços de longa duração (eram dez antes do holetz/eclume#151, com o `web` e dois workers CPU):

| Serviço | Imagem | Papel |
|---|---|---|
| `caddy` | `eclume-edge:prod` (`deploy/web.Dockerfile`) | a borda: Caddy 2.11 com o build do SPA em `/srv/web` e as regras dele (`deploy/web.Caddyfile`, em `/etc/caddy/spa.caddy`); TLS interno na 8443, a **única porta publicada** |
| `server` | `eclume-server:prod` (`deploy/server.Dockerfile`) | API (`uvicorn`) e o servidor MCP em `/mcp`, com healthcheck em `/api/v1/health/ready`; lê a CA publicada (`/srv/downloads`, read-only) para o descritor `/api/v1/server` |
| `mdns` | `eclume-server:prod` | `eclume-server announce` (leve: só o anunciador, sem a app): anuncia `_eclume._tcp` na LAN com o endereço público e a impressão digital da CA; `network_mode: host`, sem porta publicada ([server-mcp-e-dispositivos.md](../standards/code/server-mcp-e-dispositivos.md#descoberta-na-rede-mdns)) |
| `worker` | `eclume-server:prod` | `eclume-server worker`: as filas `eclume:default` (ingestão, purgas, reaper, retomada e expiração de uploads) e `eclume:agents` (tipo de agenda, campos, resumos, chats e pré-visualizações, com `ECLUME_AGENT_MAX_JOBS` vagas, padrão 2, e o `claude -p`) num processo só |
| `worker-gpu` | `eclume-worker-gpu:prod` (`worker-gpu/Dockerfile`, ~8 GB) | ASR e diarização, `max_jobs=1`; sai sozinho (código 0) depois da descarga ociosa e o `restart` o traz de volta ([worker-gpu.md](worker-gpu.md)) |
| `postgres` | `pgvector/pgvector:pg16` | banco; server e worker CPU conectam como `eclume_server` (sem superusuário, só DML) e as requisições baixam para `eclume_app`; o superusuário `eclume` fica para o `migrate`, o bootstrap e o backup ([server-nucleo.md](../standards/code/server-nucleo.md#papéis-do-banco)) |
| `redis` | `redis:7-alpine` | filas e progresso, com `appendonly` |
| `minio` | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | áudio e artefatos (a MinIO parou de publicar imagens); `MINIO_API_STALE_UPLOADS_EXPIRY=192h` guarda o multipart incompleto 8 dias, acima dos 7 do upload, para a retomada valer de verdade |

One-shots do perfil `tools`, rodados por `compose run --rm`: `minio-init` (bucket, usuários e políticas por serviço), `migrate`
(`eclume-server migrate`, como o superusuário, que também liga o `LOGIN` de `eclume_server` com `ECLUME_RUNTIME_PG_PASSWORD`) e `publish-ca` (copia a CA para `/downloads/`).

- **Só o Caddy publica porta.** O Docker publica por fora do ufw, então Postgres, Redis, MinIO e
  server não têm `ports:`. Para depurar, use `compose exec`.
- **Premissa do IP do cliente.** O server roda com `--proxy-headers --forwarded-allow-ips "*"`
  (`deploy/server.Dockerfile`) e `ratelimit.client_ip` usa o `X-Forwarded-For` que chega. Isso só é
  seguro porque o Caddy, sem `trusted_proxies`, sobrescreve o cabeçalho e porque só ele publica porta.
  Dar `ports:` ao server, ou fazer o Caddy confiar num proxy à frente, deixa qualquer um forjar o IP e
  zera os limites por IP de login, pareamento e cadastro. `deploy/test_compose_prod.py` falha nos três casos.
- **Rotas do Caddy.** `/api/*`, `/media/*` e `/mcp` (rota exata) vão ao server sem cortar o prefixo. `/downloads/*` é a
  pasta dos instaladores ([desktop-distribuicao.md](../standards/code/desktop-distribuicao.md)),
  com `Cache-Control: no-cache` nos manifestos e arquivos ocultos escondidos. O resto é o SPA, da
  própria imagem: o Caddyfile do compose termina com `import /etc/caddy/spa.caddy`, o `handle` sem
  matcher que só pega o que sobrou. Nenhuma rota do SPA pode começar com `/api`, `/media`, `/mcp`
  ou `/downloads`.
- **As regras do SPA viajam com a imagem** (`deploy/web.Caddyfile`), e o mesmo arquivo serve à
  produção, ao staging e ao e2e: a CSP do SPA, a da referência da API (`/referencia-api.html`, com
  `style-src` próprio), o cache longo dos assets do Vite só para o arquivo que existe, o `no-cache`
  do `index.html` e o `no-store` das respostas de erro ([frontend-web.md](../standards/code/frontend-web.md)).
  Sozinha, a imagem serve o SPA na porta 80, sem TLS.
- **O `mdns` é recriado depois do `publish-ca`**, e a conferência do deploy exige que
  `/api/v1/server` traga a impressão digital da CA publicada. O multicast (5353/udp na rede do
  host) depende da regra do ufw do [host-setup.md](host-setup.md#6-firewall).
- **O Caddyfile é um `configs.content` inline.** Com o daemon remoto, um `file:` viraria bind
  mount de um caminho da estação.
- **As imagens do server e da borda ficam em `deploy/`,** com `<Dockerfile>.dockerignore` ao lado
  filtrando o contexto da raiz. Uma imagem de server serve à API, ao worker CPU, ao `mdns`, às
  migrations e ao CLI. Ela roda como uid 1000 (`HOME=/home/app`). O binário nativo da CLI `claude`, de versão
  fixada, só entra com `ECLUME_CLAUDE_CLI=1` no `deploy/.env.prod` (build arg; o padrão da imagem é
  sem a CLI, [server-agentes.md](../standards/code/server-agentes.md#deploy)). Esta produção usa
  `ECLUME_CLAUDE_CLI=1`; o `deploy.sh` recusa um env que não declare 0 ou 1.
- **Redes por papel** (holetz/eclume#94): `borda` (caddy, server); `dados`, interna
  (postgres, redis, minio, server, worker, `minio-init`, `migrate`); `fila-gpu`,
  interna (redis, minio, worker-gpu); `saida` (worker e worker-gpu, que falam
  com providers, Claude e Hugging Face). O worker GPU não alcança Postgres, server nem a borda.
  `publish-ca` roda com `network_mode: none`; `mdns`, na rede do host.
- **Credencial por serviço:** server e worker CPU usam `eclume-server` no Redis e no MinIO; o
  worker GPU, `eclume-gpu`, que só lê o áudio e escreve os artefatos. O root do MinIO fica no
  MinIO, no `minio-init` e no backup; o usuário `default` do Redis está desligado
  ([server-nucleo.md](../standards/code/server-nucleo.md#credenciais-de-redis-e-minio)). Para
  depurar o Redis: `compose exec redis sh -c 'redis-cli --user eclume-server --pass "$ECLUME_REDIS_SERVER_PASSWORD"'`.
- **Privilégio mínimo:** os contêineres Python (server, workers, `migrate`, `mdns`) rodam com
  `cap_drop: [ALL]` e `no-new-privileges`; o Caddy fica como está, porque escuta em porta baixa.
- **Limites de memória** em caddy, server, worker, worker-gpu, redis e minio: o `mem_limit` por
  env `ECLUME_MEM_<SERVIÇO>` (256m, 768m, 2g, 8g, 256m e 512m) e o `memswap_limit` (memória mais
  swap) por `ECLUME_MEMSWAP_<SERVIÇO>`, com padrão de 1,5 × o teto (384m, 1152m, 3g, 12g, 384m e
  768m). Sem o `memswap_limit`, cada contêiner usaria outro tanto em swap e o `docker stats`
  subestimaria o uso real. Os padrões são os da revisão do holetz/eclume#151; o valor certo
  continua o pico × 1,5 da medição de 24 h de `docker stats`. Para
  ajustar, defina o par em `deploy/.env.prod` e faça deploy: o `deploy.sh` recusa um
  `memswap_limit` menor que o `mem_limit`, que o `up` recusaria no meio do deploy. **Nomes
  anteriores ao worker único:** `ECLUME_MEM_WORKER_AGENTS` ainda vale para o `worker` enquanto o
  env não tiver `ECLUME_MEM_WORKER`; `ECLUME_MEM_WORKER_CPU` e `ECLUME_MEM_WEB` não valem mais
  (apague-os do env). O Postgres não tem teto: ganha `oom_score_adj: -800` (o OOM do host escolhe
  outro antes) e `shm_size: 256m`; o `mdns` também não. Um contêiner que estoura o teto morre
  dentro do próprio cgroup e o `restart` o traz de volta. O `release-desktop.sh` limita o build a
  `ECLUME_BUILD_MEMORY` (6g), ao lado das 2 CPUs.
- **Peso de CPU por papel (`cpu_shares`, só vale na disputa):** 2048 para quem atende a requisição
  (caddy, server, postgres), 1024 para o apoio (redis, minio, worker) e 512 para o que pode
  esperar (worker-gpu, cuja conta pesada é na GPU, e mdns). O gate, o staging e o backup do host
  rodam com 256.
- **Healthchecks leves e espaçados:** o `worker` pela sonda `python -m eclume_server.sonda fila
  default agents` (só a stdlib e o cliente do Redis) e o worker-gpu pelo heartbeat, a cada 60 s; o
  server (`/api/v1/health/ready`), Postgres, Redis e MinIO a cada 30 s. Durante o `start_period`,
  o `start_interval` (1 a 2 s) apressa o primeiro `healthy`, para o `up --wait` do deploy não
  esperar um intervalo inteiro; o `start_interval` pede o Docker Engine 25 ou mais novo.
- **Restart `unless-stopped` e logs rotacionados** (3 × 10 MB por container): o stack volta
  sozinho depois de um reboot, sem ninguém rodar deploy.

### Dados em `/srv/eclume`

| Pasta | Conteúdo |
|---|---|
| `pg/`, `redis/`, `minio/` | volumes `eclume-prod-*` (bind) do banco, das filas e dos objetos |
| `caddy/data`, `caddy/config` | **CA interna do Caddy**: apagar gera uma CA nova e obriga a reinstalar a raiz em todos os clientes |
| `models/` | cache de modelos do worker GPU |
| `downloads/` | instaladores do desktop, `latest.json` e `eclume-root.crt` |
| `secrets/` (700) | `env.prod`, `hf_token`, `admin-password`, chaves do updater, keystore Android, `restic-password`, `restic-fora.env` e `restic-rclone/` (a configuração do rclone do destino fora) — tudo 600 |
| `backups/` | `restic/` (repositório cifrado), `minio/.espelho/`, `pre-deploy/`, `backup.log` e `ensaio.log` |
| `estado/` (700) | `backup.json`, `fora.json`, `ensaio.json` (`ok`, `at`, `detalhe` de cada etapa noturna, lidos pelo `vigia.sh`), `secrets.sha256` e `vigia/` |
| `bin/` | `backup.sh`, `restaurar-backup.sh`, `staging.sh` e `vigia.sh`, instalados pelo deploy |

## Deploy

Da máquina de desenvolvimento, com o contexto `gpu-host` do [runbook do host](host-setup.md):

```bash
bash deploy/deploy.sh --context gpu-host --gerar-env   # uma vez: deploy/.env.prod com segredos aleatórios
bash deploy/deploy.sh --plan --context gpu-host
bash deploy/deploy.sh --context gpu-host
bash deploy/bootstrap-admin.sh --context gpu-host --email admin@example.com   # uma vez
```

Os scripts não têm contexto padrão: sem `--context` (ou `ECLUME_DOCKER_CONTEXT`), recusam. Este
host tem GPU e sobe sem `--sem-gpu`. O `deploy.sh` usa o contexto Docker para build e subida e o SSH (o alvo sai do endpoint
`ssh://` do contexto) para o que é do host. Em ordem:

1. Recusa, antes de qualquer escrita no host, uma árvore de trabalho suja, um HEAD que o GitHub não
   tem e um HEAD sem o status `eclume/gate` = `success` do gate do host (`bash deploy/gate.sh`;
   [monorepo.md](../standards/code/monorepo.md)). Recusa também um HEAD fora de `origin/main` ou
   que não descende do SHA em produção (o último do `deploys.log`), salvo `--fora-do-main
   "<motivo>"` (ramo de teste; o motivo vai ao histórico) ou `--voltar` (retorno), e um
   `deploy/.env.prod` que perde ou muda chave da cópia do host (abaixo). O `--plan` mostra, sem
   recusar: o SHA em produção e o alvo, quantos commits os separam, as migrations pendentes, o
   env × host, a GPU ocupada e o gate. Recusa também com o disco do host em 90% ou mais
   (`ECLUME_DISK_LIMIT`), antes e depois do build.
2. Cria as pastas de `/srv/eclume` e um `hf_token` vazio se faltar. Um arquivo ausente num bind
   mount viraria pasta.
3. Guarda a cópia de `deploy/.env.prod` em `/srv/eclume/secrets/env.prod`, instala os scripts
   de backup em `bin/` e a linha `# eclume-backup` no crontab.
4. Constrói `server`, `caddy` (a imagem `eclume-edge`, com o SPA) e `worker-gpu` no daemon do
   host a partir do `git archive` do SHA num diretório temporário da estação — compose,
   Dockerfiles e scripts são os do SHA, nunca os da árvore de trabalho (`--services` restringe, e
   `web` ainda vale como o nome antigo do `caddy`; `--sem-build` pula). Quais imagens o SHA tem e
   quais serviços sobem saem do compose dele (`docker compose config` lido pelo `deploy_lib.py
   topologia`). Uma imagem que não se constrói agora precisa já estar no host: o primeiro deploy
   da borda com o SPA constrói o `caddy`. O build grava
   `ECLUME_COMMIT` (o `/api/v1/health` o devolve em `commit`) e as tags `:<sha>` ao lado de `:prod`;
   o deploy marca com `:<sha>` também as imagens que não construiu, e cada deploy deixa um trio. No
   `worker-gpu` só a tag muda: com o código igual, o cache devolve a mesma imagem e o container não
   é recriado.
5. **GPU ocupada:** espera o `busy` do heartbeat cair até `--espera-gpu` (30 min); ao fim, recusa,
   salvo `--interromper-gpu`. O SIGTERM drena (o worker termina o job atual).
6. Com migration pendente, grava `pg_dump -Fc` em `/srv/eclume/backups/pre-deploy/` antes do
   `migrate`; `restaurar-backup.sh --banco <dump> --confirmo` restaura só o banco a partir dele.
7. `up --wait postgres redis minio` → `run --rm minio-init` → `run --rm migrate` →
   `up --wait server worker worker-gpu` → `up --force-recreate --remove-orphans --wait caddy`.
   Os one-shots ficam fora do `--wait`, que trata a saída 0 de um serviço que ninguém espera como
   falha. O Caddy é sempre recriado porque o compose não recria um container quando só o
   `configs.content` muda. A CA está no volume e sobrevive. Com a borda nova no ar, o
   `--remove-orphans` retira os contêineres de serviços que o compose do SHA não tem mais: no
   primeiro deploy do holetz/eclume#151, `web`, `worker-cpu` e `worker-agents`.
8. Publica a CA em `/srv/eclume/downloads/eclume-root.crt`, acrescenta uma linha ao
   `/srv/eclume/deploys.log`, aplica a retenção, poda o cache do BuildKit com mais de 7 dias
   (`docker builder prune --filter until=168h`) e confere o health (com o `commit` do SHA) pela CA
   publicada.

### Rastreio, retenção e retorno

- **O que está em produção** sai de três lugares que concordam: `GET /api/v1/health` (`commit`),
  as tags `eclume-{server,edge,worker-gpu}:<sha>` (`eclume-web` em vez de `eclume-edge` nos deploys
  anteriores ao holetz/eclume#151) e `/srv/eclume/deploys.log` (TSV: data, SHA, flags, motivo,
  migrations aplicadas e o dump pré-deploy).
- **Retenção:** o host guarda o trio de imagens e o dump dos últimos 3 deploys distintos
  (`ECLUME_DEPLOYS_RETIDOS`); as tags fora da janela saem, dos trios novos (`edge`) e dos antigos
  (`web`), e o `image prune` só leva o que ficou sem tag (rótulo `org.eclume.image`: `server`,
  `edge`, `web`, `worker-gpu`).
- **`bash deploy/deploy.sh --context gpu-host --voltar <sha>`** sobe o trio retido daquele deploy,
  sem build e sem migrate (o `deploy_lib.py voltar` decide), com o compose daquele SHA: voltar a
  um SHA anterior ao holetz/eclume#151 sobe `web`, `worker-cpu` e `worker-agents` de novo, com o
  Caddy puro, e o `--remove-orphans` retira o `worker` único. Um passo atrás vale mesmo com
  migration nova, pela regra expandir/contrair
  ([server-nucleo.md](../standards/code/server-nucleo.md)); mais de um passo com migrations que o
  alvo não conhece recusa e aponta o dump pré-deploy para restaurar o banco antes.
- **Ramo de teste** é `--fora-do-main "<motivo>"`; o deploy seguinte do `main` exige descender do
  que está em produção, então volte ao `main` com `--voltar` ou com um commit do `main` que já
  contém o ramo.

### Gate e dispensa

O push do `main` dispara o gate no host sozinho (hook `.githooks/pre-push`); confira com
`bash deploy/gate.sh --estado` antes do deploy. Um branch de teste precisa do gate no próprio SHA:
publique o branch e rode `bash deploy/gate.sh` nele (uns 40 minutos no host), ou dispense.
A dispensa é `bash deploy/deploy.sh --context gpu-host --sem-gate "<motivo>"`: vale só para essa
invocação, dispensa só o status (árvore limpa e commit no GitHub continuam exigidos) e deixa no
commit o status `eclume/gate-dispensa` com o motivo. Use-a só em emergência — uma correção de
produção que não pode esperar o gate, ou o gate quebrado por algo fora do código (host, imagem,
rede) — e rode o gate no mesmo SHA logo depois.

### Segredos

`deploy/.env.prod` (600, no `.gitignore`) sai de `deploy/.env.prod.example` por
`--gerar-env`, com `openssl rand`; o `--gerar-env` recusa quando o host já tem
`secrets/env.prod` (o deploy restaura essa cópia num checkout sem env). O deploy compara o env
local com a cópia do host **por chave** — o host manda só o sha256 de cada valor — e recusa
quando uma chave do host falta ou mudou; chave nova só no local passa. `--substituir-env` aceita
a troca e guarda antes `secrets/env.prod.<data>`. As senhas são hex, porque entram na DSN sem escape, e
`ECLUME_ENCRYPTION_KEY` é o base64 de 32 bytes. O deploy recusa enquanto houver um `=troque-`.
Sem o arquivo no checkout (outra máquina, outra worktree), o deploy o restaura da cópia do
host.

| Variável | Observação |
|---|---|
| `ECLUME_PG_PASSWORD` | do superusuário `eclume` (migrador); só vale na criação do volume; para trocar depois, `ALTER USER eclume PASSWORD '…'` antes de mudar o env |
| `ECLUME_RUNTIME_PG_PASSWORD` | do papel `eclume_server`, a conexão do server e do worker CPU. O `migrate` a aplica a cada deploy, então trocá-la é mudar o env e fazer deploy. Um env anterior a ela ganha uma gerada pelo próprio `deploy.sh` (append, sem tocar no resto) |
| `ECLUME_MINIO_USER`, `ECLUME_MINIO_PASSWORD` | root do MinIO: só o MinIO, o `minio-init` e os scripts de backup a usam |
| `ECLUME_MINIO_SERVER_PASSWORD`, `ECLUME_MINIO_GPU_PASSWORD` | dos usuários `eclume-server` e `eclume-gpu` do MinIO; o `minio-init` as aplica a cada deploy, então trocar é mudar o env e fazer deploy. Um env anterior a elas as ganha geradas pelo `deploy.sh` (append), com aviso no `--plan` |
| `ECLUME_REDIS_SERVER_PASSWORD`, `ECLUME_REDIS_GPU_PASSWORD` | dos usuários `eclume-server` e `eclume-gpu` da ACL do Redis; a ACL é recriada com o contêiner do Redis no deploy. Geradas pelo `deploy.sh` quando faltam, como as do MinIO |
| `ECLUME_MEM_<SERVIÇO>`, `ECLUME_MEMSWAP_<SERVIÇO>` | opcionais: teto de memória e de memória mais swap de cada serviço, que sobem juntos (ver Stack) |
| `ECLUME_REDIS_MAXMEMORY` | opcional (`160mb`): `maxmemory` do Redis com `noeviction`, abaixo do `ECLUME_MEM_REDIS`; no teto o Redis recusa escritas em vez de despejar chaves da fila ou morrer pelo OOM. Suba os dois juntos |
| `ECLUME_AGENT_MAX_JOBS` | opcional (2): vagas da fila `eclume:agents` no `worker` |
| `ECLUME_JOB_GRACE_SECONDS`, `ECLUME_JOB_STALL_SECONDS` | opcionais (120 e 1800): detecção de job morto ([jobs-transcricao.md](../standards/api/jobs-transcricao.md#job-morto)) |
| `ECLUME_KEEP_ASR_RESIDENT`, `ECLUME_RESIDENT_MIN_FREE_MB`, `ECLUME_MODEL_IDLE_SECONDS` | opcionais (1, 2500, 300): o ASR residente entre jobs no worker GPU ([worker-gpu.md](worker-gpu.md)) |
| `ECLUME_SECRET_KEY` | assina as URLs de parte e de áudio; trocar invalida as que estão em circulação |
| `ECLUME_ENCRYPTION_KEY` | cifra as chaves de API dos providers e os segredos do painel admin; o worker GPU recebe a mesma, para abrir o token do HF que chega cifrado no job; trocar obriga a recadastrá-los ([server-agentes.md](../standards/code/server-agentes.md), [server-admin.md](../standards/code/server-admin.md)) |
| `ECLUME_PUBLIC_URL` | `https://192.168.15.199:8443`, a base das URLs devolvidas ao cliente |
| `ECLUME_SIGNUP_OPEN` | `true` (padrão): qualquer pessoa na LAN cria conta por `POST /api/v1/auth/signup`, com o aceite do aviso. `false` fecha o cadastro sem deploy de código: mude o env e recrie o server (`bash deploy/deploy.sh --context gpu-host --sem-build`) |
| `ECLUME_SIGNUPS_PER_IP_PER_DAY` | `5` (padrão): teto de cadastros criados por IP em 24 h, além do teto por minuto. Depois do deploy das cotas (holetz/eclume#98), a dona sobrepõe as cotas da própria conta em Admin → Usuários |
| `ECLUME_CLAUDE_CLI` | obrigatória, `0` ou `1`: o build arg que põe a CLI `claude` na imagem do server. Esta produção usa `1` (o `claude-cli` é o provider dela); `0` constrói a imagem só com software livre e o `claude-cli` falha com `provider_not_configured` |
| `ECLUME_CLAUDE_OAUTH_TOKEN` | opcional: token de longa duração do Claude (`claude setup-token`, 1 ano), entregue ao `worker` como `CLAUDE_CODE_OAUTH_TOKEN`. O caminho normal é o token no painel (abaixo), que vence este; sem nenhum dos dois, o `claude-cli` falha com `provider_not_configured`. **Não monte** o `~/.claude/.credentials.json` do host: a renovação do OAuth diverge no bind mount ([server-agentes.md](../standards/code/server-agentes.md#deploy)) |

### Admin, contas e provider

Não há organização: cada conta de usuário é isolada pela RLS do dono, e o painel é da
**plataforma**. O **painel de administração** fica em
**`https://192.168.15.199:8443/admin/entrar`**: não há link para ele no app do usuário. A **conta de admin** (`admins`) é separada das contas de usuário, com login e
sessão próprios em `/admin/entrar`, que só alcançam `/admin/*`
([server-admin.md](../standards/code/server-admin.md)).

- **Contas de usuário** nascem pelo cadastro aberto (`POST /api/v1/auth/signup`; a tela Criar
  conta do web), com o aceite do aviso de consentimento. Não há convite nem CLI de usuário; o admin só ativa ou desativa contas em
  Admin → Usuários. `ECLUME_SIGNUP_OPEN=false` fecha o cadastro.
- **Conta de admin.** O `bootstrap-admin.sh` (pelo one-shot `migrate`, com o superusuário) cria a
  conta de admin `admin@example.com` por `eclume-server admin create`. A senha é
  gerada no host e fica **só** em `/srv/eclume/secrets/admin-password` (600). Ela chega ao CLI
  por um pipe (`--password-stdin`) e nunca é gravada na estação. Com alguma conta de admin no
  banco, o script não faz nada.
- **Migração da organização (008, holetz/eclume#32).** Os usuários antigos viraram contas
  independentes, com gravações, pessoas, coleções e templates do dono. Cada admin antigo ganhou
  uma conta de admin com o **mesmo e-mail e o mesmo hash**: a senha de `admin-password` entra nas
  duas até alguém trocar uma delas.
- **Trocar a senha do admin** (encerra as sessões dele):
  `ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password | "${P[@]}" run --rm -T migrate eclume-server admin set-password --email admin@example.com --password-stdin`
  (grave a nova senha no arquivo antes; `P` como em Operação). A senha da conta de usuário se troca pelo app.

O provider desta produção é o `claude-cli` ("Claude (servidor)", modelo `sonnet`), uma escolha
deste host e não do produto: ele roda o `claude -p` no worker de agentes, na imagem construída com
`ECLUME_CLAUDE_CLI=1`, com o token entregue pelo painel ou pelo env, sem montar a credencial do
host. A matriz do que cada tipo exige está em [server-agentes.md](../standards/code/server-agentes.md#o-que-cada-provider-exige).
O smoke não cadastra provider: prova o resumo com o que estiver cadastrado para `summaries`, de
qualquer tipo, ou com o de `--provider <id>`.

**Decisão pendente (holetz/eclume#129, tarefa 5.3):** se os termos da Anthropic permitem que o
token de uma assinatura sirva as contas do eclume. Até a dona registrar a decisão aqui, o
`claude-cli` segue como provider desta produção; a troca é recadastrar o provider no painel.

**Token do Claude.** Num computador com o Claude Code logado na assinatura, `claude setup-token`
abre a autorização no navegador e imprime o token (`sk-ant-oat01-…`). Cadastre-o no painel:
**Admin → Agentes → Claude (servidor) → Editar → Token do Claude**. Ele fica cifrado no banco e
vence o `ECLUME_CLAUDE_OAUTH_TOKEN` do env, que sobra como alternativa de operação sem painel. O
token vale 1 ano e não se renova: gere outro antes de vencer (o sintoma é o resumo falhando com
`provider_auth` na Saúde do admin). O painel grava a data de cadastro (`key_set_at`), e
`eclume-server saude --json` informa o vencimento (`claude_token.days_left`); o `vigia.sh` avisa
com 30 dias ou menos. O token só no env não tem data: o vigia avisa uma vez "validade desconhecida".

Numa estação Windows ([estacao-windows.md](estacao-windows.md)), o `.gitattributes` mantém os
scripts com LF em qualquer checkout. Sem `flock`, a trava vira o diretório `deploy/.deploy.lock.d`.

## Validar

**As provas que escrevem rodam no staging, nunca na produção** (holetz/eclume#91). O
`eclume-staging` é um projeto compose efêmero no host (`deploy/docker-compose.staging.yml`), com o
código do `main` e os dados do último backup restaurados do repositório fora do host, Caddy só em
`https://127.0.0.1:18444`, transcrição em CPU e sem mDNS. `staging.sh subir` o deixa de pé com uma
conta descartável (admin e usuário com o mesmo e-mail, em `~/eclume-staging/conta`) e a CA dele em
`~/eclume-staging/ca/ca.crt`; `staging.sh derrubar` o apaga (`down -v`). Da estação, o túnel
`ssh -L 18444:127.0.0.1:18444` o alcança.

```bash
ssh holetz@192.168.15.199 /srv/eclume/bin/staging.sh subir
ssh holetz@192.168.15.199 cat eclume-staging/ca/ca.crt > /tmp/staging-ca.crt
ssh -f -N -L 18444:127.0.0.1:18444 holetz@192.168.15.199
ssh holetz@192.168.15.199 "sed -n 's/^ECLUME_PASSWORD=//p' eclume-staging/conta" \
  | python3 deploy/smoke_prod.py --ca /tmp/staging-ca.crt --email staging@eclume.invalid
ssh holetz@192.168.15.199 /srv/eclume/bin/staging.sh derrubar
```

**Na produção, só leitura:** `smoke_prod.py --somente-leitura` (health, SPA, `/downloads/`, cadastro
e sessão de admin) e o painel de administração (`e2e-prod/admin.spec.ts`). Sem
`--somente-leitura`, o smoke recusa com saída 2 a URL de produção (`https://192.168.15.199:8443` ou
`ECLUME_PUBLIC_URL`) antes de qualquer requisição; `prova.spec.ts`, `producao.spec.ts` e o
`mobile/e2e/prova.mjs` recusam do mesmo jeito.

```bash
ssh holetz@192.168.15.199 cat /srv/eclume/downloads/eclume-root.crt > /tmp/eclume-root.crt
ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password \
  | python3 deploy/smoke_prod.py --url https://192.168.15.199:8443 --ca /tmp/eclume-root.crt --somente-leitura
```

O `smoke_prod.py` usa só a biblioteca padrão. Ele confere health, SPA (o `index.html` das rotas
sem cache longo), o `404` sem `immutable` de um `/assets/*` que não existe (o chunk de um deploy
anterior não pode voltar como `index.html` guardado por um ano), `/downloads/latest.json`
e o cadastro aberto com o aviso, entra pela sessão de admin (escolhe o provider de resumos já
cadastrado, sem cadastrar nenhum; falha dizendo o que cadastrar se não houver) e pela de
usuário, com o mesmo e-mail e a mesma senha (`--admin-email` e `ECLUME_SMOKE_ADMIN_PASSWORD`
quando divergirem), e envia `worker-gpu/tests/fixtures/duas-vozes.ogg` pelo upload
multipart. Depois espera a transcrição com 2 locutores e um resumo `done`. Sobre essa gravação,
prova a gravação centrada no resumo (holetz/eclume#34): edita o resumo à mão (versão `manual`),
pede ao chat "Diga quem fala primeiro na reunião e acrescente isso no início do resumo" e espera a
resposta `done` com `reads` não vazio e uma versão `chat` (o tempo do chat sai no log), volta à
gerada, grava 2 marcadores, acha a gravação na biblioteca do dia dela com `kind=meeting` e baixa
os quatro formatos de exportação conferindo o `Content-Type` e a assinatura `PK` do DOCX. No fim,
imprime `OK`. Um áudio já enviado volta `deduplicated`, e o smoke confere a transcrição que já
existe; cada rodada acrescenta versões e marcadores à mesma gravação.

**Processamento automático** (`--pipeline`, no staging): retranscreve uma gravação e espera as seis etapas do
pipeline `done` (recebido, pré-processamento, transcrição, campos, tipo de agenda e resumo), com a
duração de cada uma, os campos automáticos, o tipo detectado e o resumo automático. Uma etapa
`failed` ou `skipped` falha o smoke. Sem `--recording`, a gravação é a do áudio de fixture:

```bash
ssh holetz@192.168.15.199 "sed -n 's/^ECLUME_PASSWORD=//p' eclume-staging/conta" \
  | python3 deploy/smoke_prod.py --ca /tmp/staging-ca.crt --email staging@eclume.invalid --pipeline --recording <id de uma gravação restaurada>
```

**Painel de administração no navegador** (`npm --prefix web run test:e2e:prod`, só leitura, no
Chrome da estação): entra com a conta de admin, percorre as sete telas com os dados reais, espera a
segunda leitura da Saúde em até 17 s, confere `/admin/voz` → Locutores, que a sessão de admin dá
401 em `GET /api/v1/me` e que o logout fecha a sessão. Os screenshots ficam em
`web/test-results/prod/`. O padrão é o Google Chrome; numa estação sem ele, `E2E_CHANNEL=msedge`
usa o Edge.

```bash
ECLUME_PROD_URL=https://192.168.15.199:8443 ECLUME_ADMIN_EMAIL=admin@example.com   ECLUME_ADMIN_PASSWORD="$(ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password)"   npm --prefix web run test:e2e:prod
```

**Biblioteca e gravação no navegador** (`web/e2e-real/producao.spec.ts`, no Google Chrome do host,
contra o staging): com a conta descartável, confere pelo painel admin (mesma senha) que há provider para resumos e
chat, importa um M4A pelo modal e confere a data lida dos metadados, acha o evento na segunda
21/09/2026 às 09:00, espera o pipeline até "Resumo pronto", edita o resumo, pede um ajuste ao
chat, baixa o DOCX (assinatura `PK`) e exclui a gravação da prova. Os screenshots, claro e escuro,
ficam no host em `~/build/<pasta>/test-results/prod/`.

```bash
remote-run . 'ffmpeg -loglevel error -y -i worker-gpu/tests/fixtures/duas-vozes.ogg -c:a aac -metadata creation_time=2026-09-21T12:00:00Z /tmp/eclume-prova.m4a && npm --prefix web ci && . ~/eclume-staging/conta && ECLUME_E2E_EMAIL="$ECLUME_EMAIL" ECLUME_E2E_PASSWORD="$ECLUME_PASSWORD" ECLUME_E2E_AUDIO=/tmp/eclume-prova.m4a npx --prefix web playwright test -c web/playwright.real.config.ts producao.spec.ts'
```

**MCP e pareamento** (`deploy/smoke_mcp.py`, com o SDK `mcp`, então por `uv run`): confere que o
descritor traz a impressão digital da CA dada, cria um PAT de leitura de 1 hora, e o cliente MCP
real lista as 9 ferramentas, busca e lê uma gravação e tem a exclusão recusada por falta de
`recordings:delete`; depois gera um código de pareamento, troca-o por uma credencial de
dispositivo e confere o estado `used`. Revoga o que criou. A descoberta se prova da estação:

```bash
ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password \
  | uv run python deploy/smoke_mcp.py --ca /tmp/eclume-root.crt
uv run eclume-server discover --timeout 10
```

**Prova do web** (`bash deploy/prova-web-prod.sh`, `web/e2e-prod/prova.spec.ts`, no Chrome da
estação ou com `E2E_CHANNEL=msedge`, contra o staging pelo túnel que o script abre): entra pela tela
com a conta descartável (lida em `~/eclume-staging/conta` no host),
cria um campo temporário, testa a regra nas últimas gravações e o exclui; gera o código de vínculo
em App desktop e confere que a contagem começa entre 9:55 e 10:00 e desce; lê o QR de App móvel no
próprio navegador (SVG → `<canvas>` → `jsqr`) e confere o `pair_url` com o código da tela; confere o
endereço MCP contra `GET /api/v1/server`, cria um token só de leitura e o revoga em Tokens de
acesso; busca "token" na central e abre o artigo; e abre a gaveta de ajuda em Pessoas. Termina
com `OK`, sem erro de página, e deixa os screenshots em `web/test-results/prod/`. Os códigos de
vínculo gerados vencem sozinhos em 10 minutos.

```bash
ECLUME_PROD_SSH=holetz@192.168.15.199 bash deploy/prova-web-prod.sh
```

## Conectar um assistente (MCP)

1. Na web, crie um token em **Conexão MCP** (ou em Tokens de acesso) com os grupos de escopo
   que o assistente precisa ([grupos](../standards/code/server-mcp-e-dispositivos.md#grupos-da-tela-conexão-mcp))
   e a validade; o segredo `eclp_…` aparece uma vez.
2. No cliente MCP, cadastre um servidor HTTP streamable em `https://192.168.15.199:8443/mcp`
   com o header `Authorization: Bearer eclp_…`. Exemplo do Claude Code:
   `claude mcp add --transport http eclume https://192.168.15.199:8443/mcp --header "Authorization: Bearer eclp_…"`.
3. O cliente precisa confiar na CA interna (a seção abaixo); o Claude Code e outros clientes
   em Node aceitam `NODE_EXTRA_CA_CERTS=/caminho/eclume-root.crt`.
4. Revogar o token na web desliga o assistente. A Saúde do admin mostra quantos assistentes
   usaram o MCP nas últimas 24 h.

## CA raiz nos clientes

HTTPS é obrigatório para o microfone e a conversão de mídia no navegador. A raiz fica em
**`https://192.168.15.199:8443/downloads/eclume-root.crt`** (um certificado só, a raiz da CA
ativa). Ela é distinta da do lumea. Os apps (desktop e celular) **não** usam o repositório do
sistema: fixam a raiz por conta própria, pela impressão digital, na primeira execução ou no
pareamento ([server-mcp-e-dispositivos.md](../standards/code/server-mcp-e-dispositivos.md#fixação-da-ca-pelos-apps)).
Só o navegador, o Claude Desktop/Code (MCP) e o lumea precisam da raiz instalada.

A raiz própria do eclume (`ECLUME_TLS_CA=eclume`) tem restrição de nome crítica: só vale para o
IP de `ECLUME_PUBLIC_HOST` e os nomes de `ECLUME_CA_NOMES` (hoje `holetz-pc.local`), e só para
servidor TLS. Instalá-la numa estação não deixa ninguém se passar por outro site com ela. A chave
fica em `/srv/eclume/secrets/ca/` (o deploy a gera uma vez e nunca a sobrescreve; entra no backup
de `secrets/`). A raiz `local` do Caddy, das instalações anteriores, não tem restrição e sai na
rotação abaixo.

- **Primeiro download** (antes de confiar): `curl -k -o eclume-root.crt https://192.168.15.199:8443/downloads/eclume-root.crt`,
  ou `scp holetz@192.168.15.199:/srv/eclume/downloads/eclume-root.crt .`. Confira a impressão
  digital contra o host:
  `openssl x509 -noout -fingerprint -sha256 -in eclume-root.crt`.
- **Linux:** `sudo cp eclume-root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`.
- **Windows:** `certutil -addstore -f Root eclume-root.crt`, como administrador.
- **macOS:** `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain eclume-root.crt`.
- **Firefox:** importe em Configurações → Certificados, porque ele usa um repositório próprio.
- **lumea:** monte o PEM no container `api` e aponte `LUMEA_ECLUME_CA_BUNDLE` para ele, com
  `LUMEA_ECLUME_URL=https://192.168.15.199:8443` (`deploy/.env.remote` do lumea).
- **Prova da restrição** numa estação: `bash deploy/prova-ca-restrita.sh` gera uma raiz
  descartável de `127.0.0.1`, sobe `127.0.0.1:18445` (dentro) e `127.0.0.2:18446` (fora) e confere
  o `curl`; com a raiz descartável instalada, Chrome, Edge e Firefox abrem o primeiro e recusam o
  segundo. Remova a raiz descartável depois (o script imprime o comando).

### Rotação para a raiz restrita

Três passos, cada um com conferência. A ordem importa: os apps só atravessam a virada sozinhos se
já tiverem guardado a próxima raiz.

1. **Anunciar.** Com o desktop e o celular que trazem a próxima raiz (holetz/eclume#101)
   publicados e instalados, faça o deploy comum (`ECLUME_TLS_CA` ausente ou `local`). O deploy
   gera `/srv/eclume/secrets/ca/raiz.crt` e `raiz.key` se faltarem, o `publish-ca` publica a raiz
   própria em `/downloads/eclume-root-proxima.crt`, e o descritor passa a trazer
   `ca_next_sha256`; o `--plan` mostra a CA ativa e a próxima, e o fim do deploy confere o
   anúncio. Confira também:
   `curl -fsS --ssl-no-revoke --cacert eclume-root.crt https://192.168.15.199:8443/api/v1/server`
   (traz `"ca_next_sha256":"<64 hex>"`). Os apps guardam a próxima na sonda (celular) ou em até
   6 h (desktop).
2. **Virar**, na data decidida. Antes, instale a próxima raiz
   (`https://192.168.15.199:8443/downloads/eclume-root-proxima.crt`) nas estações, no lumea e nos
   clientes MCP, **ao lado** da atual. Durante a janela, quem usa um bundle PEM recebe as duas
   raízes num arquivo só: `cat eclume-root.crt eclume-root-proxima.crt > eclume-raizes.pem`, para
   `LUMEA_ECLUME_CA_BUNDLE` e `NODE_EXTRA_CA_CERTS` (Claude Desktop/Code). Depois, ponha
   `ECLUME_TLS_CA=eclume` no `deploy/.env.prod` e faça o deploy: o Caddy emite pela raiz própria,
   o `publish-ca` publica a própria como `eclume-root.crt` e apaga a próxima, e o fim do deploy
   confere que a publicada é a raiz própria. Em seguida, troque a variável
   `ECLUME_SERVER_CA_SHA256` pela impressão nova e solte um release do desktop
   ([desktop-distribuicao.md](../standards/code/desktop-distribuicao.md#servidor-embutido-no-instalador)):
   os instaladores antigos em `/downloads` embutem a impressão velha. Confira desktop e celular
   sincronizando sem nova entrada; quem ficou para trás entra ou pareia de novo.
3. **Aposentar**, depois da janela: tire a raiz velha das estações, do lumea e dos clientes MCP
   (o bundle volta a ter só a nova) e apague a raiz `local` do host:
   `ssh holetz@192.168.15.199 'sudo rm -rf /srv/eclume/caddy/data/caddy/pki/authorities/local'`.
   Confira: `ssh holetz@192.168.15.199 '! sudo test -e /srv/eclume/caddy/data/caddy/pki/authorities/local/root.key'`.
   Com a ativa `eclume`, o Caddy não recria a `local`.

O deploy recusa `ECLUME_TLS_CA=eclume` sem a raiz própria quando já há uma raiz publicada: virar
sem anunciar trocaria a raiz de quem confia na atual.

## Backup e restauração

**Agendamento: cron do usuário `holetz`.** Ele não tem linger, então um timer systemd de usuário
não rodaria fora de sessão. O `deploy.sh` instala os scripts em `bin/`, gera
`secrets/restic-password` e inicializa o repositório local na primeira vez, e grava as duas linhas:

```
30 3 * * * ECLUME_DATA_DIR=/srv/eclume /srv/eclume/bin/backup.sh >> /srv/eclume/backups/backup.log 2>&1 # eclume-backup
30 4 * * * ECLUME_DATA_DIR=/srv/eclume /srv/eclume/bin/staging.sh ensaio >> /srv/eclume/backups/ensaio.log 2>&1 # eclume-ensaio
```

**Snapshot restic cifrado, em dois repositórios.** O `backup.sh` roda o restic (imagem oficial
fixada por digest, num contêiner como root com as fontes só leitura) e grava um snapshot em
`backups/restic` (o local, para erro lógico) e o copia (`restic copy`) para o repositório **fora do
host**, descrito em `secrets/restic-fora.env` (`RESTIC_REPOSITORY` e a credencial do destino; S3,
B2, `rest-server`, `rclone:` ou outro que o restic fale), com a mesma senha (`secrets/restic-password`). Os dois
ficam fora do snapshot (seria circular): **a cópia de cada um fora do host é da dona**, num cofre. O
repositório fora é criado uma vez com `restic init --copy-chunker-params` a partir do local, para a
deduplicação valer na cópia. Nesta produção, o destino é o OneDrive da dona, pelo rclone (abaixo).

| No snapshot (`/eclume/…`) | O que é |
|---|---|
| `pg/roles.sql` | `pg_dumpall --roles-only` (o `eclume_app` é do cluster, não do banco) |
| `pg/eclume.dump` | `pg_dump -Fc eclume` |
| `pre-deploy/` | os dumps de antes das migrations (holetz/eclume#92) |
| `minio/` | o espelho do bucket (`backups/minio/.espelho`, `mc mirror --remove`) |
| `caddy/data/caddy/pki/` | a CA interna do Caddy, com `root.key` |
| `secrets/` | `env.prod` (com `ECLUME_ENCRYPTION_KEY`), `admin-password`, `hf_token`, chave do updater e senha, keystore Android e senha — menos `restic-*` |

Os dumps só existem em claro numa pasta temporária durante a rodada; fica em claro só o espelho do
bucket (as gravações já estão no MinIO do mesmo disco). Retenção: **7 diários** (`MANTER`,
`forget --keep-daily 7` todo dia e `prune` só aos domingos, o `--prune` do mesmo `forget`) nos dois
repositórios. O host também é CI e staging, então todo contêiner do backup leva `--cpu-shares 256`
e `GOMAXPROCS=1` (restic e mc) e o `restic backup` lê com `--read-concurrency 1`; o `backup.sh`
passa `backup.log` e `ensaio.log` para `<nome>.log.1` ao chegarem a 5 MB (`ECLUME_LOG_MAX_KB`),
guardando uma geração. **Janela de exclusão:** uma gravação
excluída some do bucket na hora, mas sobrevive nos snapshots — local e fora do host — por até 7
dias, e nos dumps `pre-deploy/` pelo tempo que eles ficarem. Cada etapa grava
`estado/backup.json`, `estado/fora.json` e `estado/ensaio.json` (`ok`, `at`, `detalhe`), que o
`vigia.sh` lê, e o backup grava `estado/secrets.sha256` (sha256 de `secrets/` e da PKI no snapshot).
O `deploy.sh --plan` mostra a idade do último `ok` de cada etapa.

**Ensaio noturno** (`staging.sh ensaio`, às 04:30): restaura o snapshot mais recente **do
repositório fora** no `eclume-staging`, aplica o `migrate` do `main` sobre o banco restaurado e roda
o `smoke_prod.py` contra ele. Confere também o que o smoke não vê: o sha256 de `secrets/` e da PKI
restaurados contra `estado/secrets.sha256`, a impressão digital da raiz restaurada contra
`downloads/eclume-root.crt`, o `content_hash` de um lote de 20 áudios restaurados e
`restic check --read-data-subset` de 1/7 rotativo do repositório fora. Sai sempre com `down -v`;
recusa com o disco em 90% ou mais. Falha deixa `estado/ensaio.json` com `ok: false` e o motivo.

O ensaio é **proporcional**. Aos domingos (ou com `ECLUME_ENSAIO_DIA=7`) é o **completo**: o
snapshot inteiro, o lote de áudios conferido sobre o bucket restaurado e o smoke de resumo e chat
(que gasta a cota do Claude). Nos outros dias é o **parcial**: restaura só `pg/`, `secrets/` e
`caddy/` mais os áudios do lote, sorteado no banco restaurado, e roda o smoke `--somente-leitura`;
o `estado/ensaio.json` diz "ensaio parcial". As imagens `eclume-server:<sha>` e `eclume-edge:<sha>`
(ou `eclume-web:<sha>`, antes do holetz/eclume#151) que o deploy reteve para o SHA do `main` são
reaproveitadas, sem build; só o que falta é construído (e, no completo, a retida do server precisa
do `claude`, senão o server é reconstruído). O staging sobe todo serviço de longa duração do
compose do `main`, sem lista fixa: a borda com o SPA e o worker CPU único, como na produção. Todo contêiner do staging leva `--cpu-shares 256` (os serviços, por um
`~/eclume-staging/cpu-shares.yml` gerado a cada execução) e o restic e o mc, `GOMAXPROCS=1`. O
`subir` é sempre a restauração completa.

```bash
ssh holetz@192.168.15.199 /srv/eclume/bin/backup.sh                    # backup agora
ssh holetz@192.168.15.199 /srv/eclume/bin/staging.sh ensaio            # ensaio agora
ssh holetz@192.168.15.199 /srv/eclume/bin/restaurar-backup.sh --teste   # prova o mais recente, no host
ssh holetz@192.168.15.199 /srv/eclume/bin/restaurar-backup.sh --aplicar 2026-09-25 --confirmo
```

- **`[--repositorio local|fora] --teste [<snap>]`** restaura o snapshot (padrão `latest`; também o
  id restic ou a data AAAA-MM-DD) numa pasta temporária, o dump num banco `eclume_restore_teste` e o
  bucket num `eclume-restore-teste`. Depois compara as contagens (usuários, gravações,
  transcrições, resumos e objetos) com a produção e apaga tudo.
- **`[--repositorio local|fora] --aplicar <snap> --confirmo`** valida o dump e o restaura num banco
  temporário (`eclume_restore_novo`) antes de parar qualquer coisa; só então para server e workers
  e troca o banco `eclume` pelo temporário. Depois espelha o bucket do snapshot de volta, sem apagar objetos
  que não estão no backup, e sobe os serviços.
- **`--banco <dump> --confirmo`** volta só o banco a um dump `pre-deploy/` (holetz/eclume#92).
- **Validação prévia (`--banco` e `--aplicar`).** O script roda `pg_restore --list` e restaura o
  dump num banco temporário com os serviços ainda no ar. Dump truncado ou corrompido recusa a
  restauração com `FALHA`, apaga o temporário e deixa o banco `eclume` e os serviços como estavam.
  Se a troca de nomes falhar depois da parada, o banco antigo (`eclume_antes`) volta ao nome e os
  serviços sobem. Exige espaço para uma segunda cópia do banco durante a restauração.

**Host novo.** Basta a senha do repositório e a credencial do destino, tiradas do cofre:

1. Grave `/srv/eclume/secrets/restic-password` e `/srv/eclume/secrets/restic-fora.env` (700/600).
2. `restaurar-backup.sh --host-novo /srv/eclume` devolve `secrets/` (com o `env.prod`) e a PKI do
   Caddy em `caddy/data/caddy/pki`, **antes** do primeiro deploy, para manter a CA dos clientes.
3. Rode o deploy (com o `env.prod` restaurado como `deploy/.env.prod`) e então
   `restaurar-backup.sh --repositorio fora --aplicar latest --confirmo`.

Com o destino no OneDrive, a credencial não vai para o cofre: o passo 1 inclui autorizar o rclone de
novo no host novo, como abaixo, porque a conta da dona é a credencial.

**Destino fora no OneDrive (rclone, desde 2026-10-08).** O `restic-fora.env` é
`RESTIC_REPOSITORY=rclone:eclume-onedrive:eclume-restic`, uma pasta no OneDrive pessoal da dona,
escolhido por ela no lugar do B2. A imagem do restic não traz o `rclone` que esse backend chama, e
por isso o `backup.sh`, o `staging.sh` e o `restaurar-backup.sh` montam dois itens:

- o binário estático da imagem `rclone/rclone` fixada por digest (`RCLONE_IMAGE`), por um volume
  `eclume-rclone-<digest>` que o Docker preenche na primeira montagem;
- a configuração de `secrets/restic-rclone/`, gravável porque o rclone renova o token OAuth a cada
  hora. Ele regrava o arquivo como root, e por isso a configuração só se lê por um contêiner.

A autorização é do eclume, separada da do rclone pessoal do host: um mesmo refresh token usado em
dois lugares pode ser invalidado pela Microsoft. A pasta `eclume-restic/` está excluída do filtro do
bisync pessoal (`~/.config/rclone-bisync-onedrive-israel.filters`), que espelha a raiz do OneDrive.
Para autorizar, ou para reautorizar com `config reconnect eclume-onedrive:` no lugar de
`config create …` depois de um `invalid_grant` no `backup.log`, rode da estação. O túnel leva a
porta 53682 do OAuth ao host, e o navegador da estação abre o link `http://127.0.0.1:53682/auth?…`
que o rclone imprime:

```bash
ssh -t -L 53682:127.0.0.1:53682 holetz@192.168.15.199 \
  'install -d -m 700 /srv/eclume/secrets/restic-rclone && docker run --rm -it --network host \
     -v /srv/eclume/secrets/restic-rclone:/config/rclone rclone/rclone:1.75.1 \
     config create eclume-onedrive onedrive'
```

## Operação

```bash
P=(docker --context gpu-host compose -p eclume -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod)
"${P[@]}" ps --all
"${P[@]}" logs -f --tail 100 worker-gpu
"${P[@]}" exec postgres psql -U eclume eclume
"${P[@]}" run --rm -T migrate eclume-server admin create --email <e-mail> --name "<nome>" --password-stdin
bash deploy/deploy.sh --context gpu-host --services "server caddy"   # só código do server e do web (a borda)
```

- **Token do Claude vencido:** o resumo falha com `provider_auth`. Gere outro com
  `claude setup-token` e cadastre-o no painel, como em [Admin, contas e provider](#admin-contas-e-provider);
  nada é montado do host e nenhum serviço precisa reiniciar.
- **Job de transcrição parado:** o worker CPU marca sozinho como falha recuperável (`worker_lost`,
  `job_lost`, `job_stalled`) o job que o worker GPU abandonou; o dono retranscreve ou o admin usa
  "Tentar de novo" na Saúde ([jobs-transcricao.md](../standards/api/jobs-transcricao.md#job-morto)).
- **Staging** (`eclume-staging`, 127.0.0.1:18444): `staging.sh subir` para as provas,
  `staging.sh derrubar` depois; o ensaio noturno o sobe e derruba sozinho. Falha do ensaio: veja
  `estado/ensaio.json` e o fim de `backups/ensaio.log`.
- **E2E do web contra o backend real** num stack efêmero, sem tocar a produção:
  `remote-run . 'bash deploy/e2e-real.sh'` ([frontend-web.md](../standards/code/frontend-web.md)).
- **Token do Hugging Face:** grave em Administração → Locutores (vence o arquivo) ou troque
  `/srv/eclume/secrets/hf_token` (600). O worker relê a cada job, sem reiniciar
  ([worker-gpu.md](worker-gpu.md)).
- **Instaladores do desktop:** `deploy/publicar-desktop.sh` grava em `/srv/eclume/downloads/`,
  que o Caddy já serve ([host-setup.md](host-setup.md), seção dos instaladores). Desde a 0.2.0,
  o release embute o endereço e a impressão digital da CA deste servidor (variáveis
  `ECLUME_SERVER_URL` e `ECLUME_SERVER_CA_SHA256`): trocar a CA raiz (a virada da rotação acima)
  ou o endereço exige atualizar as variáveis e soltar um release novo
  ([desktop-distribuicao.md](../standards/code/desktop-distribuicao.md#servidor-embutido-no-instalador)).
  Publicar é `bash deploy/release-desktop.sh --publicar --notas "<texto>"` (compila no host, sem
  Actions; `--plan` antes mostra o que sairia) e, com o release criado,
  `ssh holetz@192.168.15.199 'bash -s -- desktop-v<versão>' < deploy/publicar-desktop.sh`.
- **Logs:** uma linha JSON por registro (`ts`, `level`, `logger`, `msg` e, quando houver,
  `request_id`, `recording_id`, `revision`, `job_id`); toda resposta da API leva `X-Request-ID`.
  Para seguir uma requisição ou um job:
  `"${P[@]}" logs --no-log-prefix server | grep '"request_id": "<id>"'` (ou `"recording_id": "<id>"`
  nos workers). Campos e o que nunca entra em
  [server-nucleo.md](../standards/code/server-nucleo.md#logs).
- **Saúde e prontidão:** `/api/v1/health/ready` dá 503 nomeando Postgres, Redis ou MinIO fora, e é
  o healthcheck do `server`; os workers têm healthcheck pelas chaves de heartbeat das filas
  (`"${P[@]}" ps` mostra `unhealthy`). Os números da Saúde do admin pelo terminal:
  `"${P[@]}" exec server eclume-server saude --json`.
- **Alertas (`vigia.sh`):** o cron `# eclume-vigia` roda `/srv/eclume/bin/vigia.sh` a cada 5 min
  (o `deploy.sh` instala). Avisa quando: disco ≥ 85%; backup, cópia fora do host ou ensaio sem
  `ok` há mais de 26 h (`estado/*.json`; sem eles, a última linha `ok:` do `backup.log`);
  contêiner do projeto `eclume` `unhealthy`, reiniciando ou parado em duas rodadas seguidas; job
  na fila da GPU há mais de 2 h; 3 ou mais falhas em 24 h ou qualquer `provider_auth`; token do
  Claude vencendo em 30 dias; `nvidia-smi` falhando ou sem heartbeat do worker GPU; `saude --json`
  sem resposta. Cada alerta sai uma vez, repete a cada 6 h e manda o aviso de volta ao normal;
  estado em `/srv/eclume/estado/vigia/`. Limites por ambiente (`VIGIA_DISCO_PCT`,
  `VIGIA_BACKUP_HORAS`, `VIGIA_TOKEN_DIAS`, `VIGIA_REPETIR_HORAS`). Para ver sem mandar:
  `ssh holetz@192.168.15.199 /srv/eclume/bin/vigia.sh --simular`. **Canal:** ainda não decidido
  (holetz/eclume#93, tarefa 5.3); até lá os alertas vão para `estado/vigia/alertas.log` e para o
  syslog (`journalctl -t eclume-vigia`).
- **Disco:** o `deploy.sh` mostra o uso no `--plan`. Para liberar espaço, rode
  `docker --context gpu-host builder prune -f --filter until=720h`; nunca faça `image prune -a`,
  porque ele apagaria imagens dos serviços pessoais.

## Coexistência com o lumea

O lumea usa a 443, o projeto `lumea`, os containers `lumea-*` e os dados em `/srv/lumea`. O
eclume usa a 8443, o projeto `eclume`, os volumes `eclume-prod-*` e os dados em `/srv/eclume`,
com CA, rede e Caddy próprios. Nenhum comando daqui toca os containers, volumes ou imagens do
lumea ou dos serviços pessoais (Jellyfin, *arr, qBittorrent, Samba). Depois de um deploy,
`curl --cacert lumea-root.crt https://192.168.15.199/api/health` deve seguir 200.
