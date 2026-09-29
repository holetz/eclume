import { useId, useState } from 'react'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import {
  DEFAULT_WORK_HOURS,
  readDensity,
  readLibraryOpening,
  readMotion,
  readWorkHours,
  resetEnvironment,
  saveDensity,
  saveLibraryOpening,
  saveMotion,
  saveWorkHours,
  type DensityPreference,
  type LibraryOpening,
  type MotionPreference,
  type WorkHours,
} from '../../app/preferences'
import { applyThemePreference, readThemePreference, type ThemePreference } from '../../app/theme'
import styles from './Environment.module.css'

interface Option<T extends string> {
  value: T
  label: string
}

const THEMES: Option<ThemePreference>[] = [
  { value: 'system', label: 'Sistema' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' },
]

const DENSITIES: Option<DensityPreference>[] = [
  { value: 'comfortable', label: 'Confortável' },
  { value: 'compact', label: 'Compacta' },
]

const MOTIONS: Option<MotionPreference>[] = [
  { value: 'system', label: 'Seguir o sistema' },
  { value: 'reduce', label: 'Reduzir' },
]

const OPENINGS: Option<LibraryOpening>[] = [
  { value: 'ultima', label: 'Última usada' },
  { value: 'semana', label: 'Semana' },
  { value: 'mes', label: 'Mês' },
  { value: 'lista', label: 'Lista' },
]

const SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ['?'], action: 'Abre a ajuda da página em que você está' },
  { keys: ['Esc'], action: 'Fecha a ajuda ou o diálogo aberto' },
  { keys: ['Ctrl', 'roda do mouse'], action: 'Aproxima ou afasta as horas na semana da biblioteca' },
]

const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`

/** Um controle segmentado do DS com rótulo e dica. */
function Segmented<T extends string>({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string
  hint?: string
  options: Option<T>[]
  value: T
  onChange: (value: T) => void
}) {
  const id = useId()
  return (
    <div className="field">
      <span className="field-label" id={`${id}-label`}>
        {label}
      </span>
      <div
        className={`seg ${styles.seg}`}
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        aria-describedby={hint ? `${id}-hint` : undefined}
      >
        {options.map((option) => (
          <label key={option.value} className="seg-opt">
            <input
              type="radio"
              name={id}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
      {hint && (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  )
}

/** Ajustes deste navegador: aparência, agenda e atalhos. Nada aqui vai para a conta ou o servidor. */
export function EnvironmentPage() {
  useHelpTopic('ambiente')
  const id = useId()
  const [theme, setTheme] = useState(readThemePreference)
  const [density, setDensity] = useState(readDensity)
  const [motion, setMotion] = useState(readMotion)
  const [opening, setOpening] = useState(readLibraryOpening)
  const [work, setWork] = useState(readWorkHours)
  const [notice, setNotice] = useState<string | null>(null)

  function changeWork(next: WorkHours) {
    setWork(next)
    saveWorkHours(next)
    setNotice(null)
  }

  function restore() {
    resetEnvironment()
    applyThemePreference('system')
    setTheme('system')
    setDensity(readDensity())
    setMotion(readMotion())
    setOpening(readLibraryOpening())
    setWork(readWorkHours())
    setNotice('Tudo voltou ao padrão.')
  }

  return (
    <section className={styles.page}>
      <PageHead kicker="Minhas configurações" title="Ambiente" />
      <p className={styles.lead}>
        Ajustes deste navegador. Eles valem aqui, sem mudar a sua conta nem os outros computadores e celulares.
      </p>

      <div className={styles.sections}>
        <section className="panel" aria-labelledby={`${id}-look`}>
          <h4 id={`${id}-look`}>Aparência</h4>
          <Segmented
            label="Tema"
            options={THEMES}
            value={theme}
            onChange={(value) => {
              setTheme(value)
              applyThemePreference(value)
              setNotice(null)
            }}
          />
          <Segmented
            label="Densidade"
            hint="Compacta aperta os espaços entre blocos para caber mais na tela; o tamanho do texto não muda."
            options={DENSITIES}
            value={density}
            onChange={(value) => {
              setDensity(value)
              saveDensity(value)
              setNotice(null)
            }}
          />
          <Segmented
            label="Movimento"
            hint="Reduzir desliga as animações e transições, mesmo que o sistema não peça."
            options={MOTIONS}
            value={motion}
            onChange={(value) => {
              setMotion(value)
              saveMotion(value)
              setNotice(null)
            }}
          />
        </section>

        <section className="panel" aria-labelledby={`${id}-agenda`}>
          <h4 id={`${id}-agenda`}>Agenda</h4>
          <fieldset className={styles.hours} aria-describedby={`${id}-work-hint`}>
            <legend className="field-label">Expediente</legend>
            <div className={styles.hourPair}>
              <label className="field">
                <span className="field-label">Início</span>
                <select
                  className="input"
                  value={work.start}
                  onChange={(event) => {
                    const start = Number(event.target.value)
                    changeWork({ start, end: Math.max(work.end, start + 1) })
                  }}
                >
                  {Array.from({ length: 24 }, (_, hour) => (
                    <option key={hour} value={hour}>
                      {hourLabel(hour)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Fim</span>
                <select
                  className="input"
                  value={work.end}
                  onChange={(event) => {
                    const end = Number(event.target.value)
                    changeWork({ start: Math.min(work.start, end - 1), end })
                  }}
                >
                  {Array.from({ length: 24 }, (_, index) => index + 1).map((hour) => (
                    <option key={hour} value={hour}>
                      {hourLabel(hour)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <span className="field-hint" id={`${id}-work-hint`}>
              A faixa destacada na semana da biblioteca, que ela mostra inteira ao abrir. O padrão é{' '}
              {hourLabel(DEFAULT_WORK_HOURS.start)} às {hourLabel(DEFAULT_WORK_HOURS.end)}.
            </span>
          </fieldset>
          <Segmented
            label="Abrir a biblioteca em"
            hint="Última usada volta à visão e aos filtros da sua última visita."
            options={OPENINGS}
            value={opening}
            onChange={(value) => {
              setOpening(value)
              saveLibraryOpening(value)
              setNotice(null)
            }}
          />
        </section>

        <section className="panel" aria-labelledby={`${id}-keys`}>
          <h4 id={`${id}-keys`}>Atalhos de teclado</h4>
          <dl className={styles.shortcuts}>
            {SHORTCUTS.map((shortcut) => (
              <div key={shortcut.action} className={styles.shortcut}>
                <dt>
                  {shortcut.keys.map((key, index) => (
                    <span key={key}>
                      {index > 0 && ' + '}
                      <kbd className={styles.kbd}>{key}</kbd>
                    </span>
                  ))}
                </dt>
                <dd>{shortcut.action}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <div className={styles.footer}>
        <button type="button" className="btn btn-secondary" onClick={restore}>
          Restaurar os padrões
        </button>
        {notice && (
          <span role="status" className="text-muted">
            {notice}
          </span>
        )}
      </div>
    </section>
  )
}
