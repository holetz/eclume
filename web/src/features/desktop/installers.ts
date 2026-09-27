// Os instaladores do app desktop vêm de /downloads/instaladores.json, que o
// deploy/publicar-desktop.sh publica no host (standard desktop-distribuicao.md). Só o que a página
// usa é validado; o resto do manifesto é ignorado.
import { useQuery } from '@tanstack/react-query'

export type DesktopOs = 'windows' | 'macos' | 'linux'

export interface Installer {
  plataforma: DesktopOs
  tipo: string
  arquivo: string
  url: string
  tamanho: number
  recomendado: boolean
}

export interface InstallerManifest {
  versao: string
  instaladores: Installer[]
}

export interface Platform {
  os: DesktopOs
  name: string
  requirements: string
  /** Aviso da primeira instalação: os instaladores não são assinados. */
  firstRun: string
}

export const PLATFORMS: readonly Platform[] = [
  {
    os: 'macos',
    name: 'macOS',
    requirements: 'Apple Silicon e Intel · macOS 15 ou mais novo',
    firstRun:
      'Na primeira abertura, clique no app com o botão direito e escolha “Abrir”, ou libere em Ajustes do Sistema › Privacidade e Segurança › “Abrir mesmo assim”. O macOS também pede acesso ao microfone e à gravação de áudio do sistema.',
  },
  {
    os: 'windows',
    name: 'Windows',
    requirements: 'Windows 10 ou 11 · 64 bits',
    firstRun:
      'O Windows pode avisar que “protegeu o computador”. Clique em “Mais informações” e depois em “Executar assim mesmo”: o instalador não tem assinatura digital.',
  },
  {
    os: 'linux',
    name: 'Linux',
    requirements: 'x86-64 · PipeWire ou PulseAudio',
    firstRun: 'Dê permissão de execução ao AppImage (chmod +x) antes de abrir.',
  },
]

export const TYPE_LABELS: Record<string, string> = {
  nsis: 'Instalador .exe',
  msi: 'Pacote .msi',
  appimage: 'AppImage',
  deb: 'Pacote .deb',
  dmg: 'Imagem .dmg',
}

export function detectOs(userAgent: string): DesktopOs | null {
  if (/Windows/i.test(userAgent)) return 'windows'
  if (/Mac OS X|Macintosh/i.test(userAgent) && !/iPhone|iPad/i.test(userAgent)) return 'macos'
  if (/Linux|X11/i.test(userAgent) && !/Android/i.test(userAgent)) return 'linux'
  return null
}

const OSES: readonly string[] = ['windows', 'macos', 'linux']

function isInstaller(value: unknown): value is Installer {
  const i = value as Installer
  return (
    typeof i === 'object' &&
    i !== null &&
    OSES.includes(i.plataforma) &&
    typeof i.tipo === 'string' &&
    typeof i.arquivo === 'string' &&
    typeof i.url === 'string' &&
    typeof i.tamanho === 'number' &&
    typeof i.recomendado === 'boolean'
  )
}

/** O manifesto validado, ou `null` se ele não tem a forma esperada. */
export function parseInstallers(value: unknown): InstallerManifest | null {
  const m = value as { versao?: unknown; instaladores?: unknown }
  if (typeof m !== 'object' || m === null || typeof m.versao !== 'string' || !Array.isArray(m.instaladores)) return null
  if (!m.instaladores.every(isInstaller)) return null
  return { versao: m.versao, instaladores: m.instaladores }
}

/** O manifesto de instaladores deste servidor; `null` quando ainda não foi publicado ou veio inválido. */
export function useInstallers() {
  return useQuery({
    queryKey: ['installers'],
    queryFn: async () => {
      const response = await fetch(new URL('/downloads/instaladores.json', window.location.origin))
      if (!response.ok) return null
      try {
        return parseInstallers(await response.json())
      } catch {
        return null
      }
    },
    staleTime: 5 * 60_000,
  })
}
