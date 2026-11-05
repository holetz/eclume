---
titulo: O que o pré-processamento faz com o áudio
topico: processamento
paginas: [gravacao]
relacionados: [etapas-do-processamento, por-que-falhou, corrigir-transcricao]
termos: [pré-processamento, ruído, volume, silêncio, canais, 16 kHz, mono, qualidade do áudio]
ordem: 2
atualizado: 2026-09-27
---
Antes da transcrição, o servidor prepara uma cópia do áudio para o modelo entender melhor a fala.
Quem administra o servidor escolhe o que essa etapa faz, e vale para todas as gravações.

## O que pode acontecer com o áudio

- **Formato:** o áudio sempre vira 16 kHz mono, o formato que o modelo de transcrição usa.
- **Redução de ruído:** tira ruído de fundo constante, como ar-condicionado e ventilador.
- **Normalização do volume:** deixa a fala num volume parecido do começo ao fim.
- **Corte do silêncio:** tira o silêncio do início e do fim da gravação. Os tempos da transcrição
  continuam os do áudio original.
- **Separação de canais:** quando cada canal do arquivo tem uma pessoa, como em algumas gravações
  de telefone, cada canal é transcrito à parte. Um áudio com os dois canais iguais pula esse passo.

## O áudio que você ouve

O player da gravação toca sempre o **original**. A cópia preparada só serve para a transcrição e é
descartada depois.

## Se o pré-processamento falhar

A transcrição segue com o áudio só convertido para 16 kHz mono, e a etapa aparece como falha, com
o motivo. A gravação não para por isso.
