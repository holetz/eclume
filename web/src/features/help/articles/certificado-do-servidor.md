---
titulo: Por que o aparelho pergunta sobre o certificado
topico: conectar
paginas: [app-desktop, app-movel, mcp]
relacionados: [vincular-aparelho, conectar-assistente-mcp, instalar-app-desktop]
termos: [certificado, HTTPS, segurança, impressão digital, CA, confiar, aviso do navegador]
ordem: 5
atualizado: 2026-09-27
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
