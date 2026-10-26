---
type: project
title: Runbook do host GPU
description: "Como preparar o servidor 192.168.15.199 (Ubuntu 26.04, GTX 1660 Super) para receber os containers do eclume e do lumea: IP fixo, driver NVIDIA, Docker, NVIDIA Container Toolkit, firewall e docker context."
resource: deploy/**
tags: [host, deploy, gpu, runbook]
timestamp: 2026-10-08
audience: both
authority: current
source: holetz/eclume#1, holetz/eclume#28, holetz/eclume#41
maintainer: holetz
---

# Preparar o host 192.168.15.199

Este é o runbook **deste** host: deixa o servidor da consultoria pronto para receber os
containers do eclume e do lumea. Os requisitos e passos para qualquer servidor, com ou sem GPU,
estão em [auto-hospedar.md](../how-to/auto-hospedar.md); desenvolver sem GPU e sem este host, em
[desenvolver-sem-gpu.md](../how-to/desenvolver-sem-gpu.md). O servidor
roda Ubuntu 26.04 LTS (atualizado do 24.04 em 2026-10-08) com uma NVIDIA GTX 1660 Super (6 GB). Os passos 1 a 8 rodam **no
servidor**; o passo 9 roda **na máquina de desenvolvimento**.

Portas:

| Serviço | Endereço |
|---|---|
| lumea | `https://192.168.15.199` (443) |
| eclume | `https://192.168.15.199:8443` |

## Estado real do host (provisionado em 2026-09-24, spec holetz/eclume#4)

| Item | Estado |
|---|---|
| Máquina | `holetz-pc`, usuário `holetz` (sudo pede senha desde o upgrade para o 26.04), 4 CPUs, 15 GB RAM, ~56 GB livres em `/` |
| GPU | GTX 1660 SUPER 6 GB, driver 595.99.02 (`nvidia-driver-595-open` e `linux-modules-nvidia-595-open-generic`), runtime `nvidia` já configurado no Docker |
| Docker | 29.1.3 do repositório do Ubuntu, mantido no lugar do Docker CE (passo 3 dispensado). `docker.io`, `containerd` e `runc` marcados como manuais (`apt-mark manual`), e os plugins compose e buildx em `~/.docker/cli-plugins` |
| Coexistência | O host é o servidor doméstico do usuário, com Jellyfin, *arr, qBittorrent, homepage, Sunshine e Samba. Esses serviços **não são tocados**. O Jellyfin pode disputar a GPU. |
| Firewall | ufw já ativo, com regras 443 (lumea) e 8443 (eclume) só para `192.168.15.0/24` |
| SSH | chave `ed25519` da máquina de dev autorizada. **O login por senha foi mantido** (passo 1.4 não aplicado), para não trancar o usuário fora de outros dispositivos. |
| Claude | `~/.local/bin/claude` (2.1.282) já logado |
| Builds | uv e Rust stable em `~/.local/bin` e `~/.cargo/bin`, com as deps de build do Tauri instaladas |
| eclume em produção | projeto `eclume` na 8443 desde 2026-09-25 (holetz/eclume#14), dados em `/srv/eclume`, backup no cron do `holetz` às 03:30; runbook em [deploy-producao.md](deploy-producao.md) |

**Builds pesados rodam no host, não na máquina de dev** (ela trava durante reuniões). Uma estação
Windows se prepara por [estacao-windows.md](estacao-windows.md):

- Imagens: `docker --context gpu-host compose ... build`, direto no daemon do host, sem registry.
- Cargo, npm e uv: `remote-run <dir> '<comando>'` (`~/.local/bin/remote-run` na máquina de dev).
  O helper sincroniza o diretório por rsync (sem `.git`, preservando `target/`, `node_modules/`,
  `.venv/` e `dist/` no host) e executa em `~/build/<caminho>` com `nice`.
- Arquivos gerados no host (um `Cargo.lock` atualizado, por exemplo) não voltam sozinhos: traga-os
  com `rsync holetz@192.168.15.199:build/<nome>/<arquivo> <local>` **logo depois** do comando que
  os gerou, porque o próximo `remote-run` sobrescreve a cópia do host com a local.
- O `cmake` (exigido pela libopus embutida do desktop) está em `~/.local/bin`, instalado por
  `uv tool install cmake`, sem apt.
- **O rsync preserva a data de modificação.** Um arquivo editado aqui **antes** de o host terminar
  um build anterior chega ao host com data mais velha que o artefato dele, e o cargo o considera
  atualizado: o teste roda contra o código antigo, e o erro aparece longe da causa (uma função
  "não encontrada" que existe). Dê `touch` nos arquivos alterados (`touch crates/*/src/*.rs`)
  antes do `remote-run`.
- **O release do desktop compila do commit, não da árvore** (`git archive`): o que não foi
  commitado não entra. O ensaio (sem `--publicar`) não exige push nem versão nova e deixa os
  instaladores em `~/eclume-build/release/dist-<versão>`; o script recusa começar com o disco do
  host em 90% ou mais.
- Disco: pode com `docker builder prune -f --filter until=720h` quando apertar.

## 1. IP fixo e SSH

1. No roteador, reserve o IP `192.168.15.199` (reserva DHCP) para a placa de rede do servidor.
2. No servidor:
   ```bash
   sudo apt-get update && sudo apt-get install -y openssh-server
   ```
3. Na máquina de desenvolvimento:
   ```bash
   ssh-copy-id usuario@192.168.15.199
   ```
4. Depois de confirmar que o login por chave funciona, desligue o login por senha:
   ```bash
   echo 'PasswordAuthentication no' | sudo tee /etc/ssh/sshd_config.d/10-hardening.conf
   sudo systemctl restart ssh
   ```

## 2. Driver NVIDIA

```bash
sudo ubuntu-drivers install
sudo reboot
nvidia-smi   # a GTX 1660 SUPER deve aparecer com 6144 MiB
```

## 3. Docker Engine e compose plugin (repositório oficial)

```bash
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"   # saia e entre de novo na sessão
```

## 4. NVIDIA Container Toolkit

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi
```

## 5. Diretórios de dados

```bash
sudo mkdir -p /srv/eclume /srv/lumea
sudo chown "$USER":"$USER" /srv/eclume /srv/lumea
df -h /srv   # reserve pelo menos 50 GB para modelos e áudio
```

## 6. Firewall

```bash
sudo ufw default deny incoming
sudo ufw allow from 192.168.15.0/24 to any port 22 proto tcp
sudo ufw allow from 192.168.15.0/24 to any port 443 proto tcp
sudo ufw allow from 192.168.15.0/24 to any port 8443 proto tcp
# Anúncio mDNS do eclume (serviço `mdns`, rede do host; holetz/eclume#35).
sudo ufw allow from 192.168.15.0/24 to any port 5353 proto udp
sudo ufw enable
```

O `mdns` roda com `network_mode: host`, então o 5353/udp passa **pelo** ufw (só as portas
publicadas pelo Docker passam por fora). O `before.rules` padrão do Ubuntu já aceita o mDNS
multicast (`224.0.0.251:5353`), e a descoberta funcionou sem a regra; ela deixa explícito o que o
eclume precisa, inclusive para consultas unicast. O deploy não tem sudo: é um passo manual, feito
uma vez.

> **Atenção:** portas publicadas pelo Docker (`ports:` no compose) **passam por fora do ufw**.
> Postgres, Redis e MinIO não podem ter `ports:` publicadas, ou devem ser ligados a
> `127.0.0.1:`. Só o Caddy de cada stack publica porta.

## 7. `claude -p` no servidor

Os agentes de sumarização desta produção usam o provider `claude-cli`, escolha deste host (a
matriz dos quatro providers está em [server-agentes.md](../standards/code/server-agentes.md#o-que-cada-provider-exige)).
A CLI que roda no worker vem da imagem construída com `ECLUME_CLAUDE_CLI=1` no `.env.prod` do deploy;
a do host só serve para gerar o token.

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude setup-token   # token de longa duração (1 ano) para o eclume
```

O worker de agentes do eclume recebe o token pelo painel (Admin → Agentes → Token do Claude) ou por
`ECLUME_CLAUDE_OAUTH_TOKEN` ([deploy-producao.md](deploy-producao.md#segredos)), sem montar a
sessão do host: o bind mount de `~/.claude/.credentials.json` diverge quando o `claude` do host
renova o OAuth. Se os termos permitem esse uso do token de assinatura é decisão pendente da dona
(holetz/eclume#129).

## 8. Token do Hugging Face (diarização)

1. Crie um token de leitura em <https://huggingface.co/settings/tokens>.
2. Aceite os termos de `pyannote/speaker-diarization-community-1`, e também dos demais modelos
   gated indicados em `holetz/eclume#8`, com a mesma conta.
3. O token vai em `/srv/eclume/secrets/hf_token` ou no painel de administração (veja
   [worker-gpu.md](worker-gpu.md)). Ele nunca é versionado.

## 9. Na máquina de desenvolvimento: contexto Docker

```bash
docker context create gpu-host --docker "host=ssh://usuario@192.168.15.199"
docker --context gpu-host info | grep -i runtimes   # deve listar nvidia
docker --context gpu-host run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi
```

Os builds e deploys usam `--context gpu-host`. O loop de desenvolvimento continua local.

## 10. Certificado do Caddy (depois do primeiro deploy)

Cada stack usa Caddy com `tls internal`, e cada uma tem a sua CA. HTTPS é obrigatório para a
conversão de mídia no navegador (WebCodecs) e para o microfone. O deploy do eclume publica a raiz
em `https://192.168.15.199:8443/downloads/eclume-root.crt` (`/srv/eclume/downloads/`):

```bash
scp holetz@192.168.15.199:/srv/eclume/downloads/eclume-root.crt .
```

- **Linux:** copie para `/usr/local/share/ca-certificates/eclume-root.crt` e rode
  `sudo update-ca-certificates`.
- **Windows:** rode `certutil -addstore -f Root eclume-root.crt` como administrador.
- **macOS:** rode
  `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain eclume-root.crt`.
- **Firefox:** importe em Configurações → Certificados, porque ele usa repositório próprio.

A conferência da impressão digital e o uso pelo lumea (`LUMEA_ECLUME_CA_BUNDLE`) estão em
[deploy-producao.md](deploy-producao.md#ca-raiz-nos-clientes).

## Upgrade de versão do Ubuntu

O upgrade do 24.04 para o 26.04 (2026-10-08) derrubou o host inteiro. O `do-release-upgrade`
removeu o `docker-compose` v1, e o `apt autoremove` seguinte levou `docker.io`, `containerd` e
`runc`, que tinham sido instalados como dependência dele. Os dados em `/var/lib/docker` sobrevivem,
porque o pacote é removido sem purge. No próximo upgrade:

- **Antes do `autoremove`:** `apt-mark showmanual | grep -E '^(docker.io|containerd|runc)$'` deve
  listar os três. Se faltar algum, rode `sudo apt-get install -y docker.io` e
  `sudo apt-mark manual docker.io containerd runc`.
- **Repositórios de terceiros:** o upgrade desativa as listas de fora do Ubuntu. Reative a do NVIDIA
  Container Toolkit no formato deb822, em `/etc/apt/sources.list.d/nvidia-container-toolkit.sources`:
  ```
  Types: deb
  URIs: https://nvidia.github.io/libnvidia-container/stable/deb/amd64/
  Suites: /
  Signed-By: /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  ```
- **Driver do kernel novo:** `sudo apt-get install -y linux-modules-nvidia-595-open-generic`, e
  depois confira com `nvidia-smi`.
- **GPU nos contêineres:** um `systemctl daemon-reload` (que `systemctl enable` e a instalação de
  pacotes também disparam) com contêineres GPU já de pé corta o acesso deles aos `/dev/nvidia*`.
  No `eclume-worker-gpu-1`, o `nvidia-smi` falha com `Failed to initialize NVML: Unknown Error`; no
  `jellyfin`, `: < /dev/nvidia-uvm` dá `Operation not permitted`. O host continua normal e o
  vigia não percebe, porque testa o `nvidia-smi` do host e o heartbeat do worker. Para corrigir,
  basta `docker restart` nos dois.
- **Contêineres sem política de restart** não voltam depois de um boot. O lumea ficou parado de
  2026-10-02 a 2026-10-08 assim. Ele foi corrigido com
  `docker update --restart unless-stopped` nos serviços longos, que é o que o
  `docker-compose.remote.yml` dele declara.
- **Prova:** o smoke só leitura do eclume ([deploy-producao.md](deploy-producao.md)) e
  `curl -k https://192.168.15.199/api/health` (200) do lumea.

## Gate de qualidade (`~/eclume-gate`)

O gate (`bash deploy/gate.sh` na estação; norma em
[monorepo.md](../standards/code/monorepo.md)) roda no host, no usuário `holetz`:

- `~/eclume-gate/src-<sha>-<época>`: a árvore extraída do `git archive`, apagada ao fim;
  `~/eclume-gate/logs/<sha>.log`: o log de cada execução completa; `~/eclume-gate/.trava-<n>`:
  the slot locks. Up to `ECLUME_GATE_SLOTS` (2) gates run at once, one per slot; a third waits for
  a free slot. Inside a gate, up to `ECLUME_GATE_JOBS` (2) pillars run at once, each from its own
  copy of the tree (`src-<sha>-<época>.p-<pilar>`), and `gpu-e2e` runs last, alone, under
  `~/eclume-gate/.trava-gpu`.
- `~/eclume-gate/cache`: target do cargo por pilar, registry do cargo, caches do uv, do npm, dos
  navegadores do Playwright e do `cargo-xwin` (~15 GB depois de duas execuções; acima de
  `ECLUME_GATE_CACHE_GB`, 25 GB, os target/ recomeçam). Para liberar disco, apague a pasta inteira:
  a próxima execução reconstrói.
- Imagens: `eclume-gate:<Rust>` (`deploy/gate.Dockerfile`), sobre `eclume-desktop-build-windows:<Rust>`
  e `eclume-desktop-build:<Rust>` (a versão de `desktop/rust-toolchain.toml`), que o gate constrói
  se faltarem; as de tag `24.04` são da época anterior à fixação e podem ser apagadas. O primeiro build da imagem do
  gate levou ~20 minutos.
- Compose project `eclume-gate-<slot>` (Postgres, Redis, MinIO and the mock on `127.0.0.1:55633`,
  `56580`, `59201` and `4211`, plus the slot number), brought down with `down -v` at the end; it
  never touches the `eclume` project.
- Pilar `gpu-e2e`: roda no host (não no contêiner), sobe o projeto compose `eclume-gpu-test` (Redis
  em `127.0.0.1:16379`, MinIO em `19000`, o worker-gpu com a GPU) e o derruba com `down -v` ao fim;
  usa os modelos e o token do Hugging Face de `/srv/eclume`, divide a VRAM de 6 GB com a produção e
  espera o `busy` e a VRAM livre antes de subir (sai 75, inconclusivo, se a GPU não liberar).
  Linha de base com o host parado (2026-10-07, holetz/eclume#159): 887 MiB ocupados pela sessão
  gráfica (Xorg, gnome-shell, Firefox, Discord, Steam), nenhum processo CUDA do eclume (o worker-gpu
  descarrega os modelos e recicla o processo na ociosidade) e ~400 MiB retidos pelo driver; sobram
  ~4,8 GB livres, acima do mínimo de 4096 MiB. Conferir com
  `nvidia-smi --query-compute-apps=pid,used_memory --format=csv` (vazio com o host parado).
  Norma em [monorepo.md](../standards/code/monorepo.md).
- Limites por pilar: `--cpus` `ECLUME_GATE_CPUS` (3; the host has had 12 CPUs since October 2026), `--cpu-shares 256` (também nos serviços de teste e no mock, por um
  `~/eclume-gate/cpu-shares-<slot>.yml` gerado a cada execução: a produção vence a CPU quando disputam),
  `nice`, teto de memória `ECLUME_GATE_MEMORY` (4g; o pico medido foi ~2,6 GiB no link do desktop e
  do windows). O pilar android, medido em 08/10/2026 (holetz/eclume#188) com `memory.peak` do cgroup do
  contêiner: pico no teto de 4 GiB, `anon` de 4056 MiB e `oom_kill` 1, com o Gradle (2403 MiB), o daemon
  do Kotlin (972 MiB) e o build-tools do Kotlin (507 MiB) vivos ao mesmo tempo; o cargo não estava no
  pico. A causa era o `./gradlew --stop` que faltava: o Gradle que o `tauri android build` deixa de pé
  (2 GiB) convivia com o `gradlew --no-daemon` seguinte, e o Kotlin compilava num segundo JVM. Com
  `kotlin.compiler.execution.strategy=in-process`, `-Xmx1536m`, `org.gradle.workers.max=2` e o `--stop`
  em `deploy/pilares.sh`, duas execuções seguidas passaram com `anon` de 2658 e 2870 MiB, pico do
  cgroup de 3581 MiB (o resto é cache de página) e `oom_kill` 0, sem subir o teto. Uma execução completa levou 16 a 21 minutos com a produção de pé, e recusa com o
  disco em 90%.
- Proporcional: o host roda só os pilares que o diff desde o último SHA verde exige (`--todos` na
  estação força os dez) e abandona o SHA que o pre-push disparou e que o `main` já ultrapassou
  (`eclume/gate` = `error` "superado por <sha>"); `bash deploy/gate.sh --estado <sha>` mostra a
  descrição com os pilares rodados e os dispensados. O deploy sem status do SHA da ponta se resolve
  com `bash deploy/gate.sh <sha>`, que nunca é abandonado.
- Poda a cada execução: logs com mais de 30 dias, imagens de build de outra versão do Rust (as
  `eclume-gate`, `eclume-desktop-build`, `-windows` e `eclume-mobile-build` sem a tag atual) e
  `src-*` com mais de um dia. Os `dist-*` do release (`~/eclume-build/release` e `/movel`) ficam nos
  3 mais recentes, podados a cada `release-desktop.sh` e `release-movel.sh`.
- O `gh` do host (conta `holetz`, escopo `repo`) publica o status `eclume/gate`; os contêineres dos
  pilares não recebem o token. O NDK de `~/android-sdk/ndk/28.2.13676358` entra só leitura no
  pilar `mobile`.

## Instaladores do desktop (sem assinatura de código)

Os instaladores saem de `deploy/release-desktop.sh` (compila no host e cria a tag
`desktop-v<versão>` como um GitHub Release privado; o workflow `desktop-release` é só a
alternativa manual); o contrato está em
[desktop-distribuicao.md](../standards/code/desktop-distribuicao.md). Como o repo é privado, os
clientes baixam do próprio servidor eclume:

- **Pasta servida:** `/srv/eclume/downloads/`, publicada em `https://192.168.15.199:8443/downloads/`
  pelo Caddy do eclume ([deploy-producao.md](deploy-producao.md)). Na raiz ficam `latest.json`
  (manifesto do
  updater), `instaladores.json` (lista para a página de download) e `INSTALACAO.md`; cada versão
  fica em `/srv/eclume/downloads/<versão>/`, com as três mais recentes mantidas.
- **Publicar um release** (no host, onde o `gh` está autenticado):
  ```bash
  deploy/publicar-desktop.sh desktop-v0.1.0
  # da máquina de dev, sem clonar nada no host:
  ssh holetz@192.168.15.199 'bash -s -- desktop-v0.1.0' < deploy/publicar-desktop.sh
  ```
  O script confere o `SHA256SUMS` antes de trocar os manifestos da raiz.
- **Chave do updater (minisign):** a privada e a senha ficam em
  `/srv/eclume/secrets/tauri-updater.key` e `tauri-updater.key.password` (`chmod 600`), que o
  release no host lê; os mesmos valores estão nos secrets do GitHub `TAURI_SIGNING_PRIVATE_KEY` e
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` para o workflow manual — mas um secret do GitHub não se lê de
  volta e não é cópia recuperável: a cópia é o snapshot restic cifrado de `secrets/` que o
  `backup.sh` leva para fora do host ([deploy-producao.md](deploy-producao.md#backup-e-restauração)).
  Nunca no repo. A pública está em `desktop/src-tauri/tauri.conf.json`. Perder a privada obriga a
  reinstalar o app à mão em todos os clientes.

Avisos da primeira instalação, detalhados para o usuário em
[desktop/INSTALACAO.md](../../desktop/INSTALACAO.md):

- **Windows:** o SmartScreen avisa na primeira execução. Clique em "Mais informações" e depois em
  "Executar assim mesmo".
- **macOS:** o Gatekeeper recusa o app não notarizado. Rode
  `xattr -dr com.apple.quarantine /Applications/eclume.app`, ou tente abrir e libere em Ajustes do
  Sistema → Privacidade e Segurança → "Abrir Mesmo Assim".
- **Linux:** o AppImage precisa de `chmod +x` (e, em algumas distros, do FUSE 2); o `.deb` instala
  com `sudo apt install ./eclume_<versão>_amd64.deb`.
- **Todos:** o updater e o sync só confiam no servidor depois que a CA raiz do Caddy é instalada
  no cliente (passo 10).

## Ambiente Android (build e emulador do app móvel)

O app móvel ([mobile/](../../mobile/README.md)) compila e roda o emulador no host, que tem KVM.
Tudo fica em `~/`, sem sudo, pelo script idempotente
[mobile/scripts/android-sdk.sh](../../mobile/scripts/android-sdk.sh):

```bash
ssh holetz@192.168.15.199 'bash -s' < mobile/scripts/android-sdk.sh
```

- **O que instala:** as command-line tools 22.0 do Android em `~/android-sdk` (SHA-256 conferido), um
  JDK 21 portátil em `~/jdk-21` (o OpenJDK do Ubuntu no host só tem o runtime, sem `javac`), os
  pacotes `platform-tools`, `platforms;android-36`, `build-tools;36.0.0`, `ndk;28.2.13676358`,
  `emulator` e `system-images;android-35;google_apis;x86_64`, os quatro alvos `rustup` Android e o
  AVD `eclume-35` (Pixel 6, 2 GB de RAM).
- **Ambiente:** `~/.config/eclume/android-env.sh` exporta `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME` e
  o `PATH`. Todo comando de build Android começa com
  `source ~/.config/eclume/android-env.sh`, também pelo `remote-run`.
- **Disco:** o script recusa instalar se o disco passar de 88 % (o deploy recusa acima de 90 %). O
  SDK ocupa ~7 GB, o JDK ~350 MB e o AVD ~250 MB (cresce com o uso). Para liberar espaço, use
  `docker builder prune -af` e apague os `~/build/*/target` do eclume já mesclados; nunca apague
  imagens de outros projetos.
- **Segunda execução:** só confere e imprime "nada a fazer".
- **KVM:** o `/dev/kvm` dá leitura e escrita ao `holetz` por ACL; sem isso, o script avisa e o
  emulador fica sem aceleração.
- **Command-line tools fixadas na 22.0:** a 23 troca o `sdkmanager` pelo `android sdk` e muda a
  saída do `--list_installed` (`ndk/28…` no lugar de `ndk;28…`). A 22 ainda avisa que o
  `sdkmanager` está obsoleto; o aviso é esperado.
