# Instalar o app desktop do eclume

O app desktop grava as reuniões (microfone e áudio do computador) e as envia para transcrição no
eclume. Ele fica na bandeja do sistema (no macOS, na barra de menus).

Os instaladores ficam na página de download do eclume, em
`https://192.168.15.199:8443/downloads/`. Escolha o arquivo da sua plataforma:

| Plataforma | Arquivo recomendado | Alternativa |
|---|---|---|
| Windows 10/11 (64 bits) | `eclume_<versão>_x64-setup.exe` | `eclume_<versão>_x64_pt-BR.msi` (instalação para todos os usuários, exige administrador) |
| Linux (x86_64; Ubuntu 24.04, Debian 13 ou mais novos) | `eclume_<versão>_amd64.AppImage` | `eclume_<versão>_amd64.deb` (Debian, Ubuntu e derivados) |
| macOS 15 ou mais novo (Intel e Apple Silicon) | `eclume_<versão>_universal.dmg` | — |

O `SHA256SUMS` da pasta da versão traz o hash de cada arquivo, para quem quiser conferir o
download (`sha256sum -c SHA256SUMS` no Linux, `shasum -a 256 <arquivo>` no macOS,
`Get-FileHash <arquivo>` no PowerShell).

## Antes de instalar: o certificado do eclume

O servidor eclume usa um certificado próprio (a CA interna do Caddy). O navegador e o app só
confiam nele depois que a CA raiz do eclume é instalada no sistema. Sem ela, o app não sincroniza
nem se atualiza. Peça o arquivo `eclume-root.crt` ao administrador e instale:

- **Windows:** clique duas vezes no arquivo → "Instalar certificado" → "Máquina local" →
  "Colocar todos os certificados no repositório a seguir" → "Autoridades de Certificação Raiz
  Confiáveis". Ou, num terminal como administrador: `certutil -addstore -f Root eclume-root.crt`.
- **macOS:** `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain eclume-root.crt`.
- **Linux (Debian/Ubuntu):** `sudo cp eclume-root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`.
- **Firefox** usa repositório próprio: importe em Configurações → Privacidade e Segurança →
  Certificados → Ver certificados → Autoridades.

## Windows

1. Baixe o `eclume_<versão>_x64-setup.exe` e abra.
2. O app **não tem assinatura de código**, então o Windows mostra o aviso do SmartScreen
   ("O Windows protegeu o computador"). Clique em **Mais informações** e depois em
   **Executar assim mesmo**. O aviso aparece só na primeira vez.
3. O instalador instala para o seu usuário, sem pedir administrador, e cria o atalho no menu
   Iniciar. O app abre na bandeja, perto do relógio.

Se o navegador bloquear o download ("não é baixado com frequência"), escolha **Manter** no menu
do download.

## macOS

1. Baixe o `eclume_<versão>_universal.dmg`, abra e arraste o **eclume** para **Aplicativos**.
2. O app **não é assinado nem notarizado pela Apple**, então o Gatekeeper recusa a primeira
   abertura. Libere de um destes jeitos:
   - no Terminal: `xattr -dr com.apple.quarantine /Applications/eclume.app` e abra de novo; ou
   - tente abrir, depois vá em **Ajustes do Sistema → Privacidade e Segurança** e clique em
     **Abrir Mesmo Assim**.
3. Na primeira gravação, o macOS pede permissão para o **microfone** e para **gravar o áudio do
   sistema**. Autorize as duas; sem elas, a gravação sai muda.

O app vive na barra de menus, sem ícone no Dock.

## Linux

### AppImage (qualquer distribuição)

```bash
chmod +x eclume_<versão>_amd64.AppImage
./eclume_<versão>_amd64.AppImage
```

Algumas distribuições exigem o FUSE 2 para rodar AppImage (`sudo apt install libfuse2t64` no
Ubuntu 24.04, `libfuse2` nas versões anteriores). A bandeja precisa de suporte a
AppIndicator: no GNOME, instale a extensão "AppIndicator and KStatusNotifierItem Support".

### .deb (Debian, Ubuntu e derivados)

```bash
sudo apt install ./eclume_<versão>_amd64.deb
```

## Atualizações

O app confere a cada 6 horas (e 30 segundos depois de abrir) se há versão nova no servidor
eclume. Quando há, baixa, confere a assinatura do pacote e instala sozinho — **nunca durante uma
gravação ou um envio**. No Windows, o instalador roda em modo passivo e reabre o app; no Linux e
no macOS, o app reinicia.

O pacote de atualização é assinado com a chave do eclume, então uma atualização adulterada é
recusada mesmo sem assinatura de código. A atualização automática vale para o `setup.exe`, o
`.msi`, o AppImage, o `.deb` (pede a senha de administrador) e o app do macOS.

## Desinstalar

- **Windows:** Configurações → Aplicativos → eclume → Desinstalar.
- **macOS:** arraste `/Applications/eclume.app` para o Lixo.
- **Linux:** apague o AppImage, ou `sudo apt remove eclume`.

As gravações e a configuração ficam na pasta de dados do app e não são apagadas na desinstalação.
