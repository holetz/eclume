# Changelog do app desktop

O que muda no app desktop do eclume (Windows e Linux). A seção de cada versão é a nota do release:
o `deploy/release-desktop.sh` a põe no `latest.json` e o app a mostra no aviso "Atualizado para X".
O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões, o
[SemVer](https://semver.org/lang/pt-BR/); a norma está em
[versionamento.md](../docs/standards/code/versionamento.md).

## [Não lançado]

## [0.5.1] - 2026-10-05

### Adicionado

- As gravações recentes também no menu do ícone ao lado do relógio, com o estado de cada uma e
  um submenu para copiar o resumo, abrir no web ou tentar o envio de novo (holetz/eclume#147).
- Quantas gravações o menu do ícone mostra, em Configurações → Geral, à parte da janela: uma por
  padrão.

### Alterado

- Em Configurações → Geral, a opção da janela passa a se chamar "Gravações recentes na janela".

## [0.5.0] - 2026-10-05

### Adicionado

- Painel das gravações recentes no topo, com a etapa e o progresso de cada uma, o "Precisa de
  você" quando a gravação pede ação (inclusive quando espera os nomes dos locutores) e o botão
  para copiar o resumo (holetz/eclume#141, holetz/eclume#144).
- Quantas gravações o painel mostra, em Configurações → Geral.
- Aviso quando uma gravação fica aguardando a marcação dos locutores.

## [0.4.1] - 2026-10-01

### Adicionado

- O microfone se reconecta sozinho quando cai no meio da reunião.
- A gravação sempre fecha o arquivo e avisa quando para sem você pedir.
- Posição na fila de transcrição e estado do processador na bandeja.
- Aviso quando o resumo fica pronto ou falha.
- Idioma da transcrição escolhido por arquivo, além do padrão da conta.
- Build do instalador do Windows pronto para a assinatura de código.

### Mudado

- Estados do processamento com nome e motivo, iguais aos do web e do celular.
- Configurações reorganizadas, com as regras do processamento automático juntas.
- Cores e contraste dos controles no Design System.
- A CA do servidor fica fixada de forma estrita, e o app acompanha a rotação para a raiz própria
  com restrição de nome.

### Corrigido

- O app travava ao salvar as configurações (deadlock no refresh da bandeja).
- Congelamentos da janela: pânicos isolados em cada laço, parada da gravação fora do lock e
  comandos assíncronos.

## [0.4.0] - 2026-09-30

### Adicionado

- O app inicia com o sistema ao ser instalado, com a opção para desativar.

### Removido

- Funções sem uso e textos que citavam versões antigas.

## [0.3.0] - 2026-09-29

### Adicionado

- Pasta sincronizada: os resumos e as transcrições em Markdown numa pasta local, organizados por
  coleção e por mês, prontos para o Obsidian ou um agente.
- Gravação das chamadas do WhatsApp, com detecção e política próprias.
- Tema do sistema, claro ou escuro, e ícones da bandeja por estado.
- Idioma da transcrição nas configurações.
- Aviso de resumo pronto com "Copiar" e "Abrir".
- Teste por fonte na aba Áudio, com microfone e áudio do sistema que podem ficar em "Nenhum".

### Mudado

- Detector de silêncio relativo à fala, com histerese e voz sustentada.
- Importar abre direto o seletor de arquivos do sistema.
- O release passa a incluir o Windows por padrão.

### Corrigido

- O chaveiro roda numa thread própria e o updater não depende dele.
- Pânicos vão para o `eclume.log` com a thread, o local e o backtrace.

## [0.2.1] - 2026-09-27

### Corrigido

- A CA anunciada pelo mDNS só é aceita depois da conferência.
- Os marcadores ficam travados durante o upload.
- O login do dispositivo pede o aceite do aviso na web quando o servidor exige.

## [0.2.0] - 2026-09-27

### Adicionado

- O app no Design System: abas Reuniões, Armazenamento, Áudio e Servidor, menu da bandeja,
  notificações, menu de ajuda e atalhos de teclado.
- Login com e-mail e senha ou código e pareamento do dispositivo.
- Descoberta do servidor na rede e endereço embutido no instalador, com a CA fixada pela impressão
  digital.
- Upload com a natureza, a origem da data e os marcadores.
- Aviso de versão atualizada.

## [0.1.2] - 2026-09-25

### Corrigido

- A mixagem preserva a faixa que volta de um silêncio sem pacotes.
- A detecção reconhece o próprio app pelo executável, não pelo caminho.

### Adicionado

- Log do app em arquivo rotacionado.

## [0.1.1] - 2026-09-25

### Adicionado

- O updater confia na CA extra do sync.

## [0.1.0] - 2026-09-24

### Adicionado

- Primeira versão: captura do microfone e do áudio do sistema, bandeja, detecção de reuniões,
  sincronização com o servidor e instaladores para Windows e Linux com updater.
