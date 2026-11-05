import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { useCollections } from '../collections/queries'
import {
  useSpeakerNaming,
  useUpdateSpeakerNaming,
  useVoiceAssignment,
  type SpeakerNaming,
  type VoiceAssignment,
} from '../people/queries'
import { Switch } from '../../shared/Switch'
import { useTagAssignment, type TagAssignment } from '../tags/queries'
import styles from './Automation.module.css'
import { useAgendaTypes, useFields } from '../organize/queries'

const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 })

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

interface Step {
  title: string
  /** What the step does, in one sentence. */
  what: string
  /** The screen that configures the step; without one, the step belongs to the platform. */
  to?: string
  linkLabel?: string
  state: ReactNode
  /** The switch that is changed right here, when no other screen owns it. */
  control?: ReactNode
}

/** The state of a step coming from a query: loading, error or the computed text. */
function stateOf<T>(query: UseQueryResult<T>, describe: (data: T) => string): ReactNode {
  if (query.isPending) return 'Carregando…'
  if (query.isError) return <span role="alert">{errorMessage(query.error)}</span>
  return describe(query.data)
}

function voiceState(voice: VoiceAssignment): string {
  if (!voice.platform_enabled) return 'Voz: desligada na plataforma'
  if (!voice.keep_samples) return 'Voz: a conta não guarda amostras de voz'
  if (!voice.enabled) return 'Voz: só sugere, não liga sozinho'
  return `Voz: liga sozinho a partir de ${percent.format(voice.threshold)}`
}

function namingState(naming: SpeakerNaming): string {
  if (!naming.required) return 'Não exigida: a gravação segue com "Locutor N"'
  if (naming.waiting_count === 0) return 'Exigida'
  return `Exigida · ${plural(naming.waiting_count, 'gravação esperando você', 'gravações esperando você')}`
}

function tagState(tags: TagAssignment): string {
  if (!tags.auto_fill) return 'Tags: desligadas'
  if (tags.mode === 'fixed') return `Tags: só as cadastradas (${tags.catalog_count})`
  return 'Tags: o agente pode criar tags'
}

/**
 * Automatic processing (its own folder: it reads people, tags, collections and organize without
 * creating a cycle between them): the overview, in pipeline order, of what eclume does on its own
 * after each recording. It reads what each step's screens configure and links to them; only the
 * mandatory speaker labelling, which has no other screen, is switched on right here.
 */
export function AutomationPage() {
  useHelpTopic('automacao')
  const voice = useVoiceAssignment()
  const naming = useSpeakerNaming()
  const updateNaming = useUpdateSpeakerNaming()
  const agendaTypes = useAgendaTypes()
  const fields = useFields()
  const tags = useTagAssignment()
  const collections = useCollections()

  const steps: Step[] = [
    {
      title: 'Pré-processamento e transcrição',
      what: 'O áudio é limpo, transcrito e separado por locutor. Quem configura é o administrador.',
      state: 'Da plataforma',
    },
    {
      title: 'Locutores pela voz',
      what: 'Cada locutor é comparado com as vozes das pessoas cadastradas.',
      to: '/pessoas',
      linkLabel: 'Configurar em Pessoas',
      state: stateOf(voice, voiceState),
    },
    {
      title: 'Marcação dos locutores',
      what: 'Exigida, a gravação com algum locutor sem pessoa espera você nomeá-lo antes do tipo, dos campos, das coleções e do resumo.',
      state: updateNaming.isError ? (
        <span role="alert">{errorMessage(updateNaming.error)}</span>
      ) : (
        stateOf(naming, namingState)
      ),
      control: naming.data && (
        <Switch
          label="Exigir a marcação dos locutores"
          checked={naming.data.required}
          disabled={updateNaming.isPending}
          onChange={(required) => updateNaming.mutate({ required })}
        />
      ),
    },
    {
      title: 'Tipo de agenda',
      what: 'O agente escolhe o tipo da reunião, que dá o título e as tags padrão.',
      to: '/config/agendas',
      linkLabel: 'Configurar em Tipos de agenda',
      state: stateOf(agendaTypes, (data) => plural(data.items.length, 'tipo de agenda', 'tipos de agenda')),
    },
    {
      title: 'Campos personalizados',
      what: 'O agente preenche os campos marcados para preenchimento automático.',
      to: '/config/campos',
      linkLabel: 'Configurar em Campos personalizados',
      state: stateOf(fields, (data) => {
        const auto = data.items.filter((field) => field.auto_fill && !field.builtin).length
        return auto === 0 ? 'Nenhum campo preenchido pelo agente' : plural(auto, 'campo preenchido pelo agente', 'campos preenchidos pelo agente')
      }),
    },
    {
      title: 'Tags',
      what: 'O agente marca os assuntos da gravação junto com os campos.',
      to: '/tags',
      linkLabel: 'Configurar em Tags',
      state: stateOf(tags, tagState),
    },
    {
      title: 'Coleções com regra',
      what: 'A gravação entra nas coleções cuja regra ela cumpre.',
      to: '/colecoes',
      linkLabel: 'Configurar em Coleções',
      state: stateOf(collections, (data) => {
        const ruled = data.items.filter((collection) => collection.auto_assign).length
        return ruled === 0 ? 'Nenhuma coleção com regra' : plural(ruled, 'coleção com regra', 'coleções com regra')
      }),
    },
    {
      title: 'Resumo',
      what: 'O resumo segue as instruções do tipo de agenda escolhido.',
      to: '/config/agendas',
      linkLabel: 'Configurar o resumo em Tipos de agenda',
      state: stateOf(agendaTypes, (data) => {
        const own = data.items.filter((type) => type.summary_instructions.trim()).length
        return own === 0 ? 'Resumo padrão em todos os tipos' : plural(own, 'tipo com instruções de resumo', 'tipos com instruções de resumo')
      }),
    },
  ]

  return (
    <section className={styles.page}>
      <PageHead kicker="Regras" title="Processamento automático" />
      <p className="text-muted">
        Depois de cada gravação, o eclume segue estas etapas sozinho, nesta ordem. Cada uma mostra como está agora e
        leva à tela que a configura. <Link to="/ajuda/after-the-recording">Saiba como funciona</Link>.
      </p>
      <ol className={`list ${styles.list}`} aria-label="Etapas do processamento automático">
        {steps.map((step, index) => (
          <li key={step.title} className="list-row">
            <span className="list-row-title">
              {index + 1}. {step.title}
            </span>
            <span className="list-row-sub">
              {step.what} <strong>{step.state}</strong>
            </span>
            {step.control && <span className="list-row-actions">{step.control}</span>}
            {step.to && (
              <span className="list-row-actions">
                <Link to={step.to} aria-label={step.linkLabel}>
                  Configurar
                </Link>
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
