---
titulo: Sincronize seus resumos numa pasta
topico: conectar
paginas: [app-desktop, colecoes]
relacionados: [tags-e-colecoes, instalar-app-desktop, conectar-assistente-mcp]
termos: [pasta, sincronizar, sincronização, Obsidian, vault, Markdown, JSONL, agente, AGENTS.md, Claude Code, coleção, coleções, subpasta, espelho]
ordem: 6
atualizado: 2026-10-08
---
O app desktop pode manter uma pasta do seu computador com o **resumo** e a **transcrição** de cada
gravação da sua biblioteca. Assim você lê, busca e reaproveita o conteúdo fora do eclume, num editor
de notas ou com um agente.

## Ligue a sincronização

No app desktop, abra **Configurações**, aba **Pasta**:

1. Escolha a pasta de destino com **Escolher pasta…**. Use uma pasta só para isto, não a sua pasta
   pessoal.
2. Ligue **Sincronizar resumos numa pasta**.
3. Deixe **Incluir as transcrições** ligado se quiser os arquivos `.jsonl`, ou desligue para ficar só
   com os resumos. Mudar essa opção refaz a pasta no ciclo seguinte.

O app sincroniza a cada minuto e ao ligar. **Sincronizar agora** pede um ciclo na hora e confere a
biblioteca inteira, inclusive o que foi apagado no eclume. A primeira vez copia tudo e pode demorar
numa biblioteca grande.

## Como a pasta fica organizada

As [coleções](/colecoes) viram subpastas, e dentro de cada uma há uma pasta por mês:

```text
Clientes/
  2026-09/
    2026-09-18_1100_01928f3a.md
    2026-09-18_1100_01928f3a.jsonl
  2026-10/
    ...
Interno/
  ...
sem-colecao/
  ...
AGENTS.md
```

- Uma gravação em mais de uma coleção aparece em cada uma, com o mesmo conteúdo.
- As gravações que não estão em nenhuma coleção ficam em `sem-colecao`.
- A pasta do mês é a do **início da gravação**, na hora do seu computador.
- O nome do arquivo é a data, a hora e uma **referência** de 8 caracteres. Ordenar os arquivos por
  nome é ordenar por data. O título **não** está no nome (nomes longos dão erro em alguns
  sistemas): ele fica dentro do arquivo.
- A referência é a mesma que aparece, discreta, logo abaixo do título da gravação aqui no eclume
  ("ref. 01928f3a"). Passe o mouse sobre ela para ver o identificador completo. Use-a para achar,
  no computador, o arquivo de uma gravação, e vice-versa.
- O `.md` é o resumo atual, com propriedades no topo (`recording_id`, `title`, `aliases`,
  `recorded_at`, `collections`, `agenda_type`, `summary_version`). O `.jsonl` é a transcrição: a
  primeira linha descreve a gravação e cada linha seguinte é uma fala, com locutor, início, fim e
  texto.
- Se a transcrição mudou depois do resumo, o `.md` traz `summary_stale: true` nas propriedades e uma
  faixa de aviso no topo ("Resumo de uma versão anterior da transcrição"). É o mesmo aviso da
  página da gravação: use **Regenerar** no eclume e, no ciclo seguinte, o arquivo volta ao normal.
  Sem a transcrição espelhada, o app não consegue comparar e não avisa.
- Mudou a coleção no eclume? Os arquivos mudam de pasta no ciclo seguinte. Quem já usava a
  pasta antes da divisão por mês tem os arquivos reorganizados sozinhos, sem duplicar.

## Use como vault do Obsidian

Abra a pasta como **vault** no Obsidian. Ele lê os `.md`, com as propriedades, e ignora os
`.jsonl`. Como o nome do arquivo não tem o título, a busca rápida (`Ctrl+O`) e os links `[[...]]` encontram a
nota pelo título, que o app grava como `alias`. Por isso as transcrições, que são longas, não entram na busca nem no grafo do vault, mas
ficam ao lado do resumo quando você precisar delas.

## Use como pasta de trabalho de um agente

Na raiz da pasta o app mantém um `AGENTS.md` que explica a um agente, como o Claude Code, o que há
ali e como ler e pesquisar: a estrutura, as propriedades, o formato do JSONL e exemplos de busca
com `rg` e `jq`. Basta abrir o agente na pasta.

Para que o agente consulte o eclume diretamente, em vez de arquivos, veja
[Conecte um assistente pelo MCP](/ajuda/conectar-assistente-mcp).

## O que o app faz e não faz com os arquivos

- A pasta é um **espelho**: o eclume é a fonte. Editar um arquivo gerado não muda o resumo no
  servidor, e a edição se perde no próximo ciclo. Para editar de verdade, use
  [Editar o resumo](/ajuda/editar-resumo) no eclume, ou trabalhe numa cópia.
- Os seus próprios arquivos na pasta nunca são tocados: o app só mexe no que ele mesmo criou.
- Apagar uma gravação no eclume apaga os arquivos dela na pasta, na próxima conferência.
- Quem tem acesso à pasta lê os resumos e as transcrições: guarde-a onde só você tem acesso.
