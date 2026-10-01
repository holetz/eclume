---
titulo: Sua conta e quem vê suas gravações
topico: comecar
paginas: [biblioteca, ajuda, conta]
relacionados: [primeira-gravacao, sugestoes-por-voz]
termos: [conta, privacidade, quem vê, para onde vão os dados, dados, agente externo, amostras de voz, administrador, consentimento, aviso, cadastro, senha, trocar senha, esqueci a senha, redefinir senha, excluir conta, limite, cota, armazenamento]
ordem: 6
atualizado: 2026-10-01
---
Cada conta do eclume é um espaço próprio.

## O que é só seu

Dentro do eclume, suas gravações, transcrições, resumos, pessoas, campos e tipos de agenda só
aparecem para você. Não há compartilhamento entre contas: outra pessoa com conta neste servidor não vê nada do que é seu, e
você não vê nada do que é dela.

## Para onde vão seus dados

O áudio e a transcrição ficam guardados neste servidor. Quem transforma o áudio em texto é a
transcrição que quem administra configurou: em geral no próprio servidor, mas pode ser outra
máquina. Os resumos, os campos, o chat e a detecção do tipo de agenda são feitos por um agente de
IA que quem administra escolheu: pode rodar no servidor, na rede local ou fora dela, num serviço
externo. Nesse último caso, o texto da transcrição (não o áudio) vai para esse fornecedor.

Em **Minhas configurações › Conta › Privacidade e dados** você vê, para este servidor, onde é feita
cada etapa e quem processa o que sai, além de quantas impressões e amostras de voz a sua conta
guarda. Com a identificação por voz ligada no servidor, dá para desligar **Guardar amostras de voz
desta conta**: depois de confirmar, as amostras, as impressões e as sugestões de pessoa pela voz
são apagadas na hora, e nada de voz da conta é calculado ou guardado nas próximas gravações. Os
locutores já ligados às pessoas continuam ligados.

## O que quem administra o servidor faz

Quem administra o servidor cuida da configuração e da saúde do serviço: a transcrição, os agentes,
o pré-processamento do áudio, a identificação por voz e os tipos de agenda que cada conta nova
recebe. O painel de administração tem login próprio e não mostra títulos, transcrições nem resumos:
mostra só números de uso de cada conta. Quem administra também pode excluir uma conta, com tudo o
que é dela.

## Limites de uso

Cada conta tem limites, definidos por quem administra o servidor: o espaço total das gravações, o
tamanho de um arquivo, quantos arquivos sobem ao mesmo tempo, quantos minutos de áudio são
transcritos em 24 horas e quantos pedidos ao agente (resumos, ajustes e perguntas) cabem em 24
horas. Quando um limite é atingido, o eclume diz qual foi. Passar dos minutos de áudio não perde
nada: a gravação espera na fila até a janela de 24 horas abrir. Os arquivos de várias pessoas se
revezam na transcrição, um de cada conta por vez.

## O aviso que você aceitou

Ao criar a conta, você aceitou o aviso "Sou responsável por pedir o consentimento das pessoas que
gravo". O eclume não registra o consentimento de cada pessoa: combine com elas antes de gravar e
respeite quem pedir para não ser gravado.

## Trocar a senha

Em **Minhas configurações › Conta** (a engrenagem no alto), informe a senha atual e a nova duas
vezes. A nova precisa de ao menos 12 caracteres. Ao trocar, as outras sessões abertas desta conta
(outros navegadores) são encerradas. Com **Encerrar também aparelhos e tokens** marcada (o
padrão), os aplicativos desktop e celular ligados à conta e os tokens de acesso deixam de valer, e
cada aparelho pede login de novo: é o que convém quando você suspeita que a senha vazou.
Desmarcada, aparelhos e tokens continuam valendo e se revogam um a um em
[Tokens de acesso](/tokens).

## Esqueceu a senha

O eclume não envia e-mail. Peça a quem administra o servidor um link para redefinir a senha:
quem administra confirma que é você e entrega o link por fora (pessoalmente, por telefone ou por
mensagem). O link vale por 24 horas e uma só vez, e um link novo anula o anterior. Ao abri-lo, você
vê o e-mail da conta e digita a senha nova duas vezes, com ao menos 12 caracteres; depois, entra
com ela. Usar o link encerra todas as sessões abertas desta conta, em qualquer navegador. Os
aplicativos desktop e celular e os tokens de acesso continuam valendo; se suspeitar de acesso
indevido, revogue-os em [Tokens de acesso](/tokens). Quem administra nunca vê nem define a sua
senha.

## Excluir a conta

Na mesma tela, **Excluir minha conta** apaga para sempre tudo o que é seu neste servidor: gravações
e áudios, transcrições, resumos, pessoas e impressões de voz, coleções, tags, campos, tipos de
agenda, tokens e aparelhos vinculados. Para confirmar, digite a sua senha e marque que entende que
tudo será apagado. Não há como desfazer: se quiser guardar algo, exporte as gravações antes. Veja
[Exporte a transcrição e o resumo](/ajuda/exportar).
