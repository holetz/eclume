---
type: project
title: Runbook do host GPU
description: Como preparar o servidor 192.168.15.199 (Ubuntu 24.04, GTX 1660 Super) para receber os containers do eclume e do lumea: IP fixo, driver NVIDIA, Docker, NVIDIA Container Toolkit, firewall e docker context.
resource: deploy/**
tags: [host, deploy, gpu, runbook]
timestamp: 2026-09-25
audience: both
authority: current
source: holetz/eclume#1, holetz/eclume#28
maintainer: holetz
---

# Preparar o host 192.168.15.199

Este runbook deixa o servidor pronto para receber os containers do eclume e do lumea. O servidor
roda Ubuntu 24.04 LTS com uma NVIDIA GTX 1660 Super (6 GB). Os passos 1 a 8 rodam **no
servidor**; o passo 9 roda **na máquina de desenvolvimento**.

Portas:

| Serviço | Endereço |
|---|---|
| lumea | `https://192.168.15.199` (443) |
| eclume | `https://192.168.15.199:8443` |

## Estado real do host (provisionado em 2026-09-24, spec holetz/eclume#4)

| Item | Estado |
|---|---|
| Máquina | `holetz-pc`, usuário `holetz` (sudo sem senha), 4 CPUs, 15 GB RAM, ~56 GB livres em `/` |
| GPU | GTX 1660 SUPER 6 GB, driver 595.91.07, runtime `nvidia` já configurado no Docker |
| Docker | 29.1.3 do repositório do Ubuntu, mantido no lugar do Docker CE (passo 3 dispensado) |
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

Os agentes de sumarização podem usar o Claude Code do próprio servidor.

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude setup-token   # token de longa duração (1 ano) para o eclume
```

O worker CPU do eclume recebe o token por `ECLUME_CLAUDE_OAUTH_TOKEN`
([deploy-producao.md](deploy-producao.md#segredos)), sem montar a sessão do host: o bind mount de
`~/.claude/.credentials.json` diverge quando o `claude` do host renova o OAuth.

## 8. Token do Hugging Face (diarização)

1. Crie um token de leitura em <https://huggingface.co/settings/tokens>.
2. Aceite os termos de `pyannote/speaker-diarization-community-1`, e também dos demais modelos
   gated indicados pela spec `engine-asr-whisperx`, com a mesma conta.
3. O token entra no `.env` do eclume no servidor. Ele nunca é versionado.

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

## Instaladores do desktop (sem assinatura de código)

Os instaladores saem do workflow `desktop-release` (tag `desktop-v<versão>`) como um GitHub
Release privado; o contrato está em
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
- **Chave do updater (minisign):** a privada e a senha estão nos secrets do GitHub
  `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; a cópia de segurança fica em
  `/srv/eclume/secrets/tauri-updater.key` e `tauri-updater.key.password` (`chmod 600`), nunca no
  repo. A pública está em `desktop/src-tauri/tauri.conf.json`. Perder a privada obriga a
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
