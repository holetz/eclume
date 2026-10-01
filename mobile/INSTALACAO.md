# Instalar o app móvel do eclume (Android)

O app móvel transforma o celular num microfone portátil: grava com a tela bloqueada, marca
instantes com uma nota opcional e guarda as gravações quando está longe do servidor. De volta ao
Wi‑Fi da rede do servidor, ele sincroniza sozinho. Ele não mostra transcrições: essas ficam na web.

Precisa de Android 8.0 ou mais novo.

## Baixar o APK

O APK fica no próprio servidor eclume, em `https://192.168.15.199:8443/downloads/movel/`. A página
**Minhas configurações → App móvel** da web mostra o botão "Baixar o APK" e um QR que abre o
download no celular.

- **O navegador do celular não confia no certificado interno do eclume.** Na primeira visita, ou
  instale a CA do servidor (`https://192.168.15.199:8443/downloads/eclume-root.crt`, em
  Configurações do Android → Segurança → Criptografia e credenciais → Instalar um certificado →
  Certificado de CA), ou aceite o aviso do navegador uma vez. O app em si não precisa disso: ele
  fixa a CA do servidor por conta própria.
- **Confira o arquivo**, se quiser: o `movel.json` e o `SHA256SUMS` da pasta da versão trazem o
  SHA-256 do APK (`sha256sum eclume-<versão>.apk` num computador).

## Instalar

1. Abra o APK baixado. O Android pede para permitir a instalação de "fontes desconhecidas" para
   o navegador (ou o gerenciador de arquivos): permita só para esta instalação.
2. Toque em **Instalar**. O app aparece como **eclume**.
3. Na primeira abertura, o Android pede o **microfone** e as **notificações** quando você toca em
   Gravar. As duas são necessárias: a notificação é o que mantém a gravação com a tela bloqueada.

## Primeira execução: achar o servidor e entrar

- **No Wi‑Fi do servidor**, o app procura o eclume sozinho ("Encontrado nesta rede"). Toque em
  **Conectar**, confira os blocos da impressão digital com os da web (Minhas configurações → App
  móvel) e toque em **Confiar**. Depois, entre com o **e-mail e a senha** da sua conta na web.
- **Pelo código da web**, sem senha: na web, abra Minhas configurações → App móvel; no app, toque
  em **Ler um código da web** e aponte a câmera para o QR. O código vale 10 minutos.
- **Digitando o endereço**: `192.168.15.199:8443`. O app mostra a impressão digital para você
  conferir com a web antes de confiar.
- Se o login disser para aceitar o aviso de responsabilidade, aceite-o na web e entre de novo.

## Atualizações

Na rede do eclume, o app confere uma vez por dia se há versão nova. Em **Configurações**, "Nova
versão disponível" baixa o APK pelo certificado fixado, confere o SHA-256 e abre o instalador do
Android, que pede a sua confirmação. A atualização instala por cima e mantém as gravações e o
pareamento.

## Desinstalar ou trocar de aparelho

- **Sair e esquecer o servidor** (em Configurações) apaga o acesso deste celular; as gravações que
  ainda aguardam o sync ficam e sobem no próximo servidor pareado.
- O acesso de um aparelho não se revoga sozinho: desvincule-o na web, em Minhas configurações →
  App móvel.

## Em alguns fabricantes

Aparelhos com economia de bateria agressiva (Xiaomi, Samsung, Huawei, entre outros) podem encerrar
apps em segundo plano. No primeiro Gravar, o eclume explica e pede para funcionar em segundo plano
(a isenção da otimização de bateria): toque em **Permitir** e confirme no Android. Se escolher
"Agora não", o pedido fica em **Configurações → Gravação → Gravar com a tela bloqueada**.

Alguns fabricantes têm uma economia própria além da do Android:

- **Samsung:** Configurações → Bateria → Limites de uso em segundo plano → tire o eclume de
  "Apps em suspensão" e "Apps em suspensão profunda".
- **Xiaomi:** Configurações → Apps → eclume → Economia de bateria → **Sem restrições**, e ligue a
  **Inicialização automática**.

Se o sistema ainda assim encerrar o eclume no meio de uma gravação, em alguns minutos aparece a
notificação **"A gravação foi interrompida · Toque para abrir"**. A gravação não se perde: ela fica
salva até o ponto em que parou e aparece como "Interrompida". Quando a gravação para sozinha (pouco
espaço livre, microfone que parou), sai a notificação "A gravação parou" com o motivo.
