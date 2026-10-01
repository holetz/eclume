# Instalar o app desktop do eclume

O app desktop grava as reuniões (microfone e áudio do computador) e as envia para transcrição no
eclume. Ele fica na bandeja do sistema. O release sai para Windows e Linux; o macOS fica fora
enquanto o repositório for privado.

Os instaladores ficam na página de download do eclume, em
`https://192.168.15.199:8443/downloads/`. Escolha o arquivo da sua plataforma:

| Plataforma | Arquivo recomendado | Alternativa |
|---|---|---|
| Windows 10/11 (64 bits) | `eclume_<versão>_x64-setup.exe` | `eclume_<versão>_x64_pt-BR.msi` (instalação para todos os usuários, exige administrador) |
| Linux (x86_64; Ubuntu 24.04, Debian 13 ou mais novos) | `eclume_<versão>_amd64.AppImage` | `eclume_<versão>_amd64.deb` (Debian, Ubuntu e derivados) |

O `SHA256SUMS` da pasta da versão traz o hash de cada arquivo, para quem quiser conferir o
download (`sha256sum -c SHA256SUMS` no Linux, `Get-FileHash <arquivo>` no PowerShell).

## Depois de instalar: entrar

Na primeira vez, o app abre a tela **Bem-vindo** e já mostra o servidor: "eclume em
192.168.15.199 · Veio com este instalador". Entre com o **e-mail e a senha** da sua conta no
eclume. Sem conta, "Crie uma na web" abre o cadastro.

- O app confia no certificado do servidor sozinho: ele baixa a CA do eclume e confere a
  impressão digital que veio no instalador. **Não é preciso instalar certificado no sistema.**
- Em **Avançado**, dá para entrar com o **código de pareamento** de 6 caracteres que a web mostra
  em Configurações · App desktop, ou digitar outro endereço. Um endereço digitado mostra a
  impressão digital do certificado: confira com quem administra o servidor antes de "Confiar e
  continuar".
- "Sair" (na janela ou em Configurações · Servidor) desliga este computador da conta; as
  gravações que ainda não subiram esperam o próximo login.

O navegador continua precisando da CA raiz do eclume para abrir o eclume web sem aviso. Peça o
arquivo `eclume-root.crt` ao administrador e instale:

- **Windows:** clique duas vezes no arquivo → "Instalar certificado" → "Máquina local" →
  "Colocar todos os certificados no repositório a seguir" → "Autoridades de Certificação Raiz
  Confiáveis". Ou, num terminal como administrador: `certutil -addstore -f Root eclume-root.crt`.
- **Linux (Debian/Ubuntu):** `sudo cp eclume-root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`.
- **Firefox** usa repositório próprio: importe em Configurações → Privacidade e Segurança →
  Certificados → Ver certificados → Autoridades.

## Atalhos

| Ação | Windows e Linux |
|---|---|
| Iniciar ou parar a gravação | `Ctrl+Alt+R` |
| Nova nota de voz (para sozinha depois de 4 s de silêncio) | `Ctrl+Alt+N` |
| Adicionar marcador durante a gravação | `Ctrl+Alt+M` |

Os atalhos valem com o app em segundo plano e mudam em Configurações · Áudio. Arquivos de áudio
ou vídeo gravados fora do app entram por **Importar arquivo…** (ou arrastados para a janela).

## Windows

1. Baixe o `eclume_<versão>_x64-setup.exe` e abra.
2. O instalador é **assinado** (assinatura de código Authenticode): o Windows mostra o nome do
   editor no pedido de confirmação. Enquanto a assinatura ainda não tem reputação no SmartScreen,
   pode aparecer o aviso "O Windows protegeu o computador", agora com o editor: clique em **Mais
   informações** e depois em **Executar assim mesmo**. O aviso aparece só na primeira vez.
   Para conferir a assinatura, clique com o botão direito no arquivo → **Propriedades** → aba
   **Assinaturas digitais**: o nome do editor e a data do carimbo aparecem ali. Um instalador sem
   essa aba veio de um release publicado sem assinatura (`--sem-assinatura`).
3. O instalador instala para o seu usuário, sem pedir administrador, e cria o atalho no menu
   Iniciar. O app abre na bandeja, perto do relógio.

Se o navegador bloquear o download ("não é baixado com frequência"), escolha **Manter** no menu
do download.

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
gravação ou um envio**. No Windows, o instalador roda em modo passivo e reabre o app; no Linux, o
app reinicia.

O pacote de atualização é assinado com a chave do eclume, então uma atualização adulterada é
recusada mesmo sem assinatura de código. A atualização automática vale para o `setup.exe`, o
`.msi`, o AppImage e o `.deb` (pede a senha de administrador).

## Desinstalar

- **Windows:** Configurações → Aplicativos → eclume → Desinstalar.
- **Linux:** apague o AppImage, ou `sudo apt remove eclume`.

As gravações e a configuração ficam na pasta de dados do app e não são apagadas na desinstalação.
