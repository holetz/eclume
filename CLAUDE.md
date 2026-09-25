# CLAUDE.md — eclume

Language: pt-BR

Serviço de transcrição institucional e auto-hospedado. Este arquivo é o ponteiro operacional
carregado pelo Claude; o conhecimento durável vive em `docs/`.

## Operating this repo

O repositório está em bootstrap. Os comandos de build, teste e deploy entram pela spec
`bootstrap-repositorio` do épico `holetz/eclume#1`.

- Destino de hospedagem: `192.168.15.199` (Ubuntu, NVIDIA GTX 1660 Super com 6 GB), acessado por
  `docker --context gpu-host`. O runbook do host está em
  [docs/project/host-setup.md](docs/project/host-setup.md).
- Esta máquina de desenvolvimento não tem GPU. Em dev, o ASR roda em CPU ou aponta para o host.

## Where knowledge lives

- [docs/](docs/index.md): índice do conhecimento do projeto.
- [docs/project/referencias.md](docs/project/referencias.md): soluções de mercado reaproveitadas e
  o motivo de cada uma.

O workspace de specs é gerido pelo backend GitHub. Use as skills `quenching-specs-*` para
consultar ou conduzir esse ciclo.
