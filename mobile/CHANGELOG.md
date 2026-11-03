# Changelog do app do celular

O que muda no app do celular do eclume (Android). A seção de cada versão é a nota do release: o
`deploy/release-movel.sh` a põe no `movel.json`. O formato segue o
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões, o
[SemVer](https://semver.org/lang/pt-BR/); a norma está em
[versionamento.md](../docs/standards/code/versionamento.md).

## [Unreleased]

## [0.1.1] - 2026-10-01

Ainda não publicada.

### Adicionado

- "Gravar agora" pelo atalho do ícone.
- O microfone se reconecta sozinho quando cai no meio da gravação.
- Posição na fila de transcrição e estado do processador.
- Aviso quando o resumo fica pronto ou falha.
- Idioma da transcrição escolhido por arquivo, além do padrão da conta.

### Mudado

- O serviço de gravação não cai sem avisar.
- O sync em segundo plano é confiável e só usa o Wi-Fi de verdade.
- Estados do processamento com nome e motivo, iguais aos do web e do desktop.
- Estilos e contraste dos controles no Design System.
- A CA do servidor fica fixada de forma estrita, e o app acompanha a rotação para a raiz própria
  com restrição de nome.

## [0.1.0] - 2026-09-27

Ainda não publicada.

### Adicionado

- Primeira versão: gravador portátil com o serviço em primeiro plano, marcadores e sincronização
  com o servidor pelo Wi-Fi.
