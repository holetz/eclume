import { useId, useState, type FormEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { Dialog } from '../../app/Dialog'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import styles from './AgentPage.module.css'
import {
  MAX_SKILL_DESCRIPTION,
  MAX_SKILL_INSTRUCTIONS,
  SKILL_NAME,
  normalizeSkillName,
  toolKindLabel,
  useAgentTools,
  useDeleteSkill,
  useSaveSkill,
  useSkills,
  useToggleSkill,
  type AgentSkill,
} from './skills'

function SkillDialog({ skill, onClose }: { skill: AgentSkill | null; onClose: () => void }) {
  const { t } = useTranslation('agent')
  const save = useSaveSkill()
  const tools = useAgentTools()
  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [instructions, setInstructions] = useState(skill?.instructions ?? '')
  const [restrict, setRestrict] = useState(skill?.allowed_tools != null)
  const [allowed, setAllowed] = useState<string[]>(skill?.allowed_tools ?? [])
  const id = useId()
  const normalized = normalizeSkillName(name)
  const validName = SKILL_NAME.test(normalized)
  const ready = validName && description.trim() !== '' && instructions.trim() !== '' && (!restrict || allowed.length > 0)

  function toggle(tool: string, on: boolean) {
    setAllowed((current) => (on ? [...current, tool] : current.filter((item) => item !== tool)))
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!ready) return
    const body = {
      name: normalized,
      description: description.trim(),
      instructions: instructions.trim(),
      allowed_tools: restrict ? allowed : null,
    }
    save.mutate({ id: skill?.id, body }, { onSuccess: onClose })
  }

  return (
    <Dialog
      title={skill ? t('skills.edit', { name: skill.name }) : t('skills.new')}
      size="lg"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('cancel')}
          </button>
          <button type="submit" form={`${id}-form`} className="btn btn-primary" disabled={save.isPending || !ready}>
            {t('save')}
          </button>
        </>
      }
    >
      <form id={`${id}-form`} className={styles.skillForm} onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor={`${id}-name`} className="field-label">
            {t('skills.name')}
          </label>
          <input
            id={`${id}-name`}
            className="input"
            maxLength={41}
            value={name}
            aria-describedby={`${id}-name-hint`}
            aria-invalid={name.trim() !== '' && !validName}
            onChange={(event) => setName(event.target.value)}
          />
          <span id={`${id}-name-hint`} className="field-hint">
            {t('skills.nameHint', { name: normalized || t('skills.namePlaceholder') })}
          </span>
          {name.trim() !== '' && !validName && (
            <span className="field-hint" role="alert">
              {t('skills.nameInvalid')}
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor={`${id}-description`} className="field-label">
            {t('skills.description')}
          </label>
          <input
            id={`${id}-description`}
            className="input"
            maxLength={MAX_SKILL_DESCRIPTION}
            value={description}
            aria-describedby={`${id}-description-hint`}
            onChange={(event) => setDescription(event.target.value)}
          />
          <span id={`${id}-description-hint`} className="field-hint">
            {t('skills.descriptionHint')}
          </span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-instructions`} className="field-label">
            {t('skills.instructions')}
          </label>
          <textarea
            id={`${id}-instructions`}
            className="input"
            rows={8}
            maxLength={MAX_SKILL_INSTRUCTIONS}
            value={instructions}
            aria-describedby={`${id}-instructions-hint`}
            onChange={(event) => setInstructions(event.target.value)}
          />
          <span id={`${id}-instructions-hint`} className="field-hint">
            {t('skills.instructionsHint')}
          </span>
        </div>
        <fieldset className={styles.skillTools}>
          <legend className="field-label">{t('skills.tools')}</legend>
          <label className="check">
            <input type="checkbox" checked={restrict} onChange={(event) => setRestrict(event.target.checked)} />
            <span className="box" />
            <span>{t('skills.restrict')}</span>
          </label>
          {restrict &&
            (tools.isError ? (
              <p className="alert alert-error" role="alert">
                {errorMessage(tools.error)}
              </p>
            ) : (
              <div className={styles.skillToolList}>
                {(tools.data?.items ?? []).map((tool) => (
                  <label key={tool.name} className="check">
                    <input
                      type="checkbox"
                      checked={allowed.includes(tool.name)}
                      onChange={(event) => toggle(tool.name, event.target.checked)}
                    />
                    <span className="box" />
                    <span>
                      {tool.description} <span className="text-muted">({toolKindLabel(tool.kind)})</span>
                    </span>
                  </label>
                ))}
              </div>
            ))}
          {restrict && allowed.length === 0 && <span className="field-hint">{t('skills.pickOne')}</span>}
        </fieldset>
        {save.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(save.error)}
          </p>
        )}
      </form>
    </Dialog>
  )
}

/** The Habilidades page: the reusable instructions the Agent follows, in the menu's Agente group. */
export function SkillsPage() {
  useHelpTopic('agente')
  const { t } = useTranslation('agent')
  const skills = useSkills()
  const toggle = useToggleSkill()
  const remove = useDeleteSkill()
  const [editing, setEditing] = useState<AgentSkill | 'new' | null>(null)
  const [deleting, setDeleting] = useState<AgentSkill | null>(null)
  const items = skills.data?.items ?? []

  return (
    <div className={styles.page}>
      <PageHead
        kicker={t('kicker')}
        title={t('skills.title')}
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
            {t('skills.new')}
          </button>
        }
      />
      <p className="text-muted">
        <Trans t={t} i18nKey="skills.lede" components={{ chat: <Link to="/agente" /> }} />
      </p>
      {skills.isError ? (
        <p className="alert alert-error" role="alert">
          {errorMessage(skills.error)}
        </p>
      ) : skills.isPending ? (
        <p className="text-muted">{t('skills.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-muted">{t('skills.none')}</p>
      ) : (
        <ul className={`list ${styles.sessions}`} aria-label={t('skills.title')}>
          {items.map((skill) => (
            <li key={skill.id} className="list-row">
              <span className="list-row-title">
                /{skill.name}
                {!skill.enabled && <span className="chip">{t('skills.off')}</span>}
              </span>
              <span className="list-row-sub">
                {skill.description}
                {skill.allowed_tools && t('skills.allowed', { n: skill.allowed_tools.length })}
              </span>
              <span className="list-row-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t('skills.toggleName', { action: skill.enabled ? t('skills.turnOff') : t('skills.turnOn'), name: skill.name })}
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate({ id: skill.id, enabled: !skill.enabled })}
                >
                  {skill.enabled ? t('skills.turnOff') : t('skills.turnOn')}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t('skills.edit', { name: skill.name })}
                  onClick={() => setEditing(skill)}
                >
                  {t('skills.editAction')}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t('skills.deleteName', { name: skill.name })}
                  onClick={() => setDeleting(skill)}
                >
                  {t('skills.delete')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {editing && <SkillDialog skill={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          title={t('skills.deleteTitle')}
          confirmLabel={t('skills.delete')}
          busy={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
        >
          <p>{t('skills.deleteBody', { name: deleting.name })}</p>
        </ConfirmDialog>
      )}
    </div>
  )
}
