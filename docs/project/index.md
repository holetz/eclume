# `project/` — o manual deste repositório

A referência operacional do próprio repositório: soluções de mercado reaproveitadas, o runbook do
host e outros fatos sobre o eclume como código mantido. Cada página tem `type: project`.

* [deploy-producao.md](deploy-producao.md) — o eclume em produção no host: compose com Caddy na 8443, deploy pelo contexto Docker, segredos, admin, CA nos clientes, backup e restauração
* [host-setup.md](host-setup.md) — como preparar o servidor `192.168.15.199` para receber os containers do eclume e do lumea
* [referencias.md](referencias.md) — soluções de mercado avaliadas e como o eclume usa cada uma
* [worker-gpu.md](worker-gpu.md) — o worker GPU na GTX 1660 SUPER: compute type, benchmark medido, imagem, cache de modelos, token do Hugging Face e operação
