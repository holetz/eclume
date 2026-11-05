// The desktop app installers come from /downloads/instaladores.json, which
// deploy/publicar-desktop.sh publishes on the host (standard desktop-distribuicao.md). Only what the
// page uses is validated; the rest of the manifest is ignored.
import { useQuery } from '@tanstack/react-query'
import { i18n } from '../../i18n'

type DesktopOs = 'windows' | 'macos' | 'linux'

export interface Installer {
  plataforma: DesktopOs
  tipo: string
  arquivo: string
  url: string
  tamanho: number
  recomendado: boolean
}

interface InstallerManifest {
  versao: string
  instaladores: Installer[]
}

export interface Platform {
  os: DesktopOs
  name: string
  readonly requirements: string
  /** First-install warning: the installers are not signed. */
  readonly firstRun: string
}

/** A platform whose `requirements` and `firstRun` read the `desktop` catalog in the active locale. */
const platform = (os: DesktopOs, name: string): Platform => ({
  os,
  name,
  get requirements() {
    return i18n.t(`desktop:platform.${os}.requirements`)
  },
  get firstRun() {
    return i18n.t(`desktop:platform.${os}.firstRun`)
  },
})

export const PLATFORMS: readonly Platform[] = [platform('macos', 'macOS'), platform('windows', 'Windows'), platform('linux', 'Linux')]

const TYPES = ['nsis', 'msi', 'appimage', 'deb', 'dmg'] as const

/** The installer type in words ("Instalador .exe"), or `null` for a type this page does not know. */
export function typeLabel(type: string): string | null {
  return (TYPES as readonly string[]).includes(type) ? i18n.t(`desktop:type.${type as (typeof TYPES)[number]}`) : null
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

/** The validated manifest, or `null` when it does not have the expected shape. */
export function parseInstallers(value: unknown): InstallerManifest | null {
  const m = value as { versao?: unknown; instaladores?: unknown }
  if (typeof m !== 'object' || m === null || typeof m.versao !== 'string' || !Array.isArray(m.instaladores)) return null
  if (!m.instaladores.every(isInstaller)) return null
  return { versao: m.versao, instaladores: m.instaladores }
}

/** This server's installer manifest; `null` when it has not been published yet or came back invalid. */
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
