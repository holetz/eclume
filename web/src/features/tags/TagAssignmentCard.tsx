import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../api/problem'
import { Switch } from '../../shared/Switch'
import styles from './Tags.module.css'
import { useTagAssignment, useUpdateTagAssignment, type TagAssignment } from './queries'

const MODES = ['fixed', 'auto'] as const

/** From 1 to 5, like the contract. */
const LIMITS = [1, 2, 3, 4, 5]

/** How the agent assigns the tags after transcription: toggle, general rule, mode and limit. */
export function TagAssignmentCard() {
  const { t } = useTranslation('tags')
  const assignment = useTagAssignment()
  if (assignment.isPending) return <p role="status">{t('config.loading')}</p>
  if (assignment.isError) {
    return (
      <p className="alert alert-error" role="alert">
        {errorMessage(assignment.error)}
      </p>
    )
  }
  return <TagAssignmentForm assignment={assignment.data} />
}

function TagAssignmentForm({ assignment }: { assignment: TagAssignment }) {
  const { t } = useTranslation(['tags', 'common'])
  const update = useUpdateTagAssignment()
  const [instructions, setInstructions] = useState(assignment.instructions)
  const ids = { mode: useId(), rule: useId(), ruleHint: useId(), limit: useId() }
  const dirty = instructions.trim() !== assignment.instructions.trim()

  function saveRule() {
    update.mutate(
      { instructions: instructions.trim() },
      { onSuccess: (updated) => setInstructions(updated.instructions) },
    )
  }

  return (
    <section className={styles.config} aria-label={t('config.label')}>
      <Switch checked={assignment.auto_fill} onChange={(auto_fill) => update.mutate({ auto_fill })} disabled={update.isPending}>
        {t('config.auto')}
      </Switch>

      <div className="field">
        <label htmlFor={ids.rule}>{t('config.rule')}</label>
        <textarea
          id={ids.rule}
          className={`input ${styles.rule}`}
          value={instructions}
          maxLength={4000}
          aria-describedby={ids.ruleHint}
          onChange={(event) => setInstructions(event.target.value)}
        />
        <span id={ids.ruleHint} className="field-hint">
          {t('config.ruleHint')}
        </span>
        <div className={styles.ruleActions}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={saveRule} disabled={!dirty || update.isPending}>
            {t('common:save')}
          </button>
        </div>
      </div>

      <fieldset className={`field ${styles.fieldset}`}>
        <legend className="field-label">{t('config.mode')}</legend>
        <div className="seg">
          {MODES.map((mode) => (
            <label key={mode} className="seg-opt">
              <input
                type="radio"
                name={ids.mode}
                value={mode}
                checked={assignment.mode === mode}
                onChange={() => update.mutate({ mode })}
              />
              {t(`mode.${mode}`)}
            </label>
          ))}
        </div>
        <span className="field-hint">
          {assignment.mode === 'auto' ? t('mode.autoHint') : assignment.mode === 'fixed' ? t('mode.fixedHint') : null}
        </span>
      </fieldset>

      {assignment.mode === 'auto' && (
        <div className="field">
          <label htmlFor={ids.limit}>{t('config.limit')}</label>
          <select
            id={ids.limit}
            className={`input ${styles.limit}`}
            value={assignment.new_limit}
            onChange={(event) => update.mutate({ new_limit: Number(event.target.value) })}
          >
            {LIMITS.map((limit) => (
              <option key={limit} value={limit}>
                {t('config.limitOption', { count: limit })}
              </option>
            ))}
          </select>
          <span className={`field-hint ${styles.catalog}`}>
            <span>
              {t('config.catalog', { limit: assignment.catalog_limit })}
            </span>
            <span className="tabular">{t('config.catalogCount', { count: assignment.catalog_count, limit: assignment.catalog_limit })}</span>
          </span>
        </div>
      )}

      {update.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(update.error)}
        </p>
      )}
    </section>
  )
}
