---
titulo: Habilidades e ações do Agente
topico: resumos
paginas: [agente]
relacionados: [conversar-com-o-agente, ajustar-pelo-chat, conectar-assistente-mcp]
termos: [habilidade, habilidades, instrução, instruções, ação, ações, lote, confirmar, regenerar, tag, coleção, tipo de agenda]
ordem: 6
atualizado: 2026-10-05
---
O Agente pode seguir um jeito de trabalhar que você repete, guardado como **habilidade**, e pode
propor mudanças em várias gravações de uma vez, que só acontecem depois que você confirma.

## Criar uma habilidade

Em [Habilidades](/agente/habilidades), no grupo Agente do menu, clique em **Nova habilidade** e
preencha:

- **Nome**: curto, em letras minúsculas, números e hífens, como `ata` ou `checklist-comite`. É o
  que você digita na conversa.
- **Descrição**: o que a habilidade faz. O Agente lê a descrição para decidir quando usá-la sozinho.
- **Instruções**: o roteiro em Markdown, como o formato da resposta e o que conferir.
- **Ferramentas** (opcional): marque **Limitar as ferramentas** para a habilidade usar só as que
  você escolher, por exemplo só os resumos e a geração de arquivo.

Cada habilidade pode ser editada, desligada ou excluída. Desligada, ela não aparece no seletor nem
para o Agente.

## Usar na conversa

Na tela [Agente](/agente), comece a mensagem com `/nome`, como `/ata reunião de ontem`, ou escolha a
habilidade no seletor ao lado do botão Enviar. A pergunta mostra o nome da habilidade usada. Sem
escolher nenhuma, o Agente pode carregar sozinho a habilidade cuja descrição combina com o pedido.

## Pedir mudanças em lote

Peça em linguagem natural, como "gere de novo os resumos das reuniões de diretoria de setembro",
"ponha a tag auditoria nas gravações do cliente Aurora", "inclua essas gravações na coleção
Diretoria" ou "troque o tipo de agenda dessas gravações para Comitê". O Agente não muda nada
sozinho: a resposta traz um cartão com o que será feito e a lista das gravações afetadas.

- **Confirmar** executa a mudança. O cartão acompanha o andamento e mostra, por gravação, o que foi
  feito, o que já estava assim e o que falhou.
- **Descartar** desiste da proposta, sem mudar nada.

Uma proposta vale por 24 horas. Confirmar de novo não repete a mudança.

## Limites

Cada proposta alcança até 20 gravações para gerar resumos de novo e até 50 para tags, coleções e
tipo de agenda; acima disso, o Agente pede para você estreitar o pedido (um período, um tipo, uma
coleção ou uma tag). O Agente usa coleções e tipos de agenda que já existem. Gerar resumos de novo
conta na cota de pedidos ao agente da sua conta, como os resumos pedidos na tela.
