import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { useCollections } from '../collections/queries'
import { useVoiceAssignment, type VoiceAssignment } from '../people/queries'
import { useTagAssignment, type TagAssignment } from '../tags/queries'
import styles from './Automation.module.css'
import { useAgendaTypes, useFields } from '../organize/queries'

const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 })

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

interface Step {
  title: string
  /** O que a etapa faz, em uma frase. */
  what: string
  /** A tela que configura a etapa; sem ela, a etapa é da plataforma. */
  to?: string
  linkLabel?: string
  state: ReactNode
}

/** O estado de uma etapa vindo de uma consulta: carregando, erro ou o texto calculado. */
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

function tagState(tags: TagAssignment): string {
  if (!tags.auto_fill) return 'Tags: desligadas'
  if (tags.mode === 'fixed') return `Tags: só as cadastradas (${tags.catalog_count})`
  return 'Tags: o agente pode criar tags'
}

/**
 * Processamento automático (pasta própria: lê pessoas, tags, coleções e organize sem criar ciclo
 * entre elas): a visão geral, na ordem do pipeline, do que o eclume faz sozinho depois
 * de cada gravação. Só lê o que as telas de cada etapa configuram e leva até elas; nada se edita aqui.
 */
export function AutomationPage() {
  useHelpTopic('automacao')
  const voice = useVoiceAssignment()
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
        leva à tela que a configura. <Link to="/ajuda/o-que-acontece-depois-da-gravacao">Saiba como funciona</Link>.
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
