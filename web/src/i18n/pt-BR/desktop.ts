import type en from '../en/desktop'
import type { Catalog } from '../locale'

const desktop: Catalog<typeof en> = {
  kicker: 'Minhas configurações',
  title: 'App desktop',
  lead: 'Grava reuniões e notas de voz no computador e envia para este servidor. O instalador abaixo já conhece este servidor: você só entra com seu e-mail e senha.',
  systems: 'Sistemas',
  link: {
    title: 'Instalou de outro lugar?',
    text: 'Abra o app, escolha Vincular com um código e digite este código. Ele vence em 10 minutos.',
    generate: 'Gerar código de vínculo',
  },
  devices: 'Computadores vinculados',
  empty: 'Nenhum computador vinculado ainda.',
  unpair: 'O computador para de enviar gravações até entrar de novo.',
  searching: 'Procurando os instaladores…',
  download: 'Baixar <hidden>para {{platform}}</hidden>',
  unpublished: 'Os instaladores ainda não foram publicados neste servidor.',
  firstTime: 'Primeira vez?',
  platform: {
    macos: {
      requirements: 'Apple Silicon e Intel · macOS 15 ou mais novo',
      firstRun: 'Na primeira abertura, clique no app com o botão direito e escolha “Abrir”, ou libere em Ajustes do Sistema › Privacidade e Segurança › “Abrir mesmo assim”. O macOS também pede acesso ao microfone e à gravação de áudio do sistema.',
    },
    windows: {
      requirements: 'Windows 10 ou 11 · 64 bits',
      firstRun: 'O Windows pode avisar que “protegeu o computador”. Clique em “Mais informações” e depois em “Executar assim mesmo”: o instalador não tem assinatura digital.',
    },
    linux: {
      requirements: 'x86-64 · PipeWire ou PulseAudio',
      firstRun: 'Dê permissão de execução ao AppImage (chmod +x) antes de abrir.',
    },
  },
  type: {
    nsis: 'Instalador .exe',
    msi: 'Pacote .msi',
    appimage: 'AppImage',
    deb: 'Pacote .deb',
    dmg: 'Imagem .dmg',
  },
}

export default desktop
