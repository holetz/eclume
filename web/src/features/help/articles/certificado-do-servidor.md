---
titulo: Por que o aparelho pergunta sobre o certificado
topico: conectar
paginas: [app-desktop, app-movel, mcp]
relacionados: [vincular-aparelho, conectar-assistente-mcp, instalar-app-desktop]
termos: [certificado, HTTPS, segurança, impressão digital, CA, confiar, aviso do navegador, troca do certificado, próxima raiz]
ordem: 5
atualizado: 2026-10-01
---
Este servidor usa um certificado próprio, e não um certificado de uma autoridade pública. A
conexão é cifrada do mesmo jeito, mas cada aparelho precisa saber que está falando com o servidor
certo.

## Como os apps conferem

Os apps não pedem para você instalar nada. Eles conferem a **impressão digital** do certificado,
uma sequência que identifica o servidor, recebida por um caminho confiável:

- **pelo instalador**, quando você baixou o app deste servidor;
- **pela rede**, quando o app acha o servidor sozinho;
- **pelo QR**, no celular.

Com um endereço digitado à mão, o app mostra a impressão digital para você conferir com quem
administra o servidor antes de continuar.

## Navegador e Claude Desktop

O navegador e o Claude Desktop confiam no certificado quando o computador confia na raiz dele.
Baixe a raiz em [/downloads/eclume-root.crt](/downloads/eclume-root.crt) e instale como
autoridade confiável no sistema. Quem administra o servidor tem o passo a passo de cada sistema.

## Navegador do celular

O **Abrir na web** do app abre a gravação no navegador do Android, que também precisa confiar na
raiz. Baixe [a raiz do servidor](/downloads/eclume-root.crt) no celular e instale em
Configurações › Segurança › Criptografia e credenciais › Instalar um certificado › **Certificado
de CA** (o caminho muda um pouco entre fabricantes). Sem isso, o navegador mostra o aviso de
conexão não particular.

## Quando o certificado do servidor muda

A raiz deste servidor só vale para o endereço dele: instalada no computador, ela não serve para
se passar por nenhum outro site.

Quando quem administra o servidor troca a raiz, ela é anunciada antes. Os apps atualizados
guardam a nova sozinhos e seguem funcionando na troca, sem você entrar de novo. Um app que ficou
para trás mostra **"O certificado do servidor mudou"**: entre ou pareie de novo.

No navegador e no Claude Desktop, instale também [a próxima raiz](/downloads/eclume-root-proxima.crt)
quando quem administra o servidor avisar, ao lado da atual. Depois da troca, a antiga pode sair.
