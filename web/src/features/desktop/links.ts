// Instaladores do app desktop. `href: null` = ainda não publicado. A spec de distribuição do
// desktop (holetz/eclume#16) preenche os links quando publicar os artefatos; só este arquivo muda.
export type DesktopOs = 'windows' | 'macos' | 'linux'

export interface Installer {
  label: string
  href: string | null
}

export interface Platform {
  os: DesktopOs
  name: string
  requirements: string
  installers: Installer[]
  /** Aviso da primeira instalação: os instaladores não são assinados. */
  firstRun: string
}

export const PLATFORMS: readonly Platform[] = [
  {
    os: 'windows',
    name: 'Windows',
    requirements: 'Windows 10 ou 11, 64 bits.',
    installers: [
      { label: 'Instalador (.exe)', href: null },
      { label: 'Pacote MSI (.msi)', href: null },
    ],
    firstRun:
      'O Windows pode avisar que “protegeu o computador”. Clique em “Mais informações” e depois em “Executar assim mesmo”: o instalador não tem assinatura digital.',
  },
  {
    os: 'macos',
    name: 'macOS',
    requirements: 'macOS 12 ou mais novo, Apple Silicon ou Intel.',
    installers: [{ label: 'Imagem de disco (.dmg)', href: null }],
    firstRun:
      'Na primeira abertura, clique no app com o botão direito e escolha “Abrir”, ou libere em Ajustes do Sistema › Privacidade e Segurança › “Abrir mesmo assim”. O macOS também pede acesso ao microfone e à gravação de áudio do sistema.',
  },
  {
    os: 'linux',
    name: 'Linux',
    requirements: 'Distribuições com PipeWire ou PulseAudio, 64 bits.',
    installers: [
      { label: 'AppImage', href: null },
      { label: 'Pacote Debian/Ubuntu (.deb)', href: null },
    ],
    firstRun: 'Dê permissão de execução ao AppImage (chmod +x) antes de abrir.',
  },
]

export function detectOs(userAgent: string): DesktopOs | null {
  if (/Windows/i.test(userAgent)) return 'windows'
  if (/Mac OS X|Macintosh/i.test(userAgent) && !/iPhone|iPad/i.test(userAgent)) return 'macos'
  if (/Linux|X11/i.test(userAgent) && !/Android/i.test(userAgent)) return 'linux'
  return null
}
