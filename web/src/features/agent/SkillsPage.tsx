import { useId, useState, type FormEvent } from 'react'
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
  TOOL_KIND,
  normalizeSkillName,
  useAgentTools,
  useDeleteSkill,
  useSaveSkill,
  useSkills,
  useToggleSkill,
  type AgentSkill,
} from './skills'

function SkillDialog({ skill, onClose }: { skill: AgentSkill | null; onClose: () => void }) {
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
      title={skill ? `Editar /${skill.name}` : 'Nova habilidade'}
      size="lg"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form={`${id}-form`} className="btn btn-primary" disabled={save.isPending || !ready}>
            Salvar
          </button>
        </>
      }
    >
      <form id={`${id}-form`} className={styles.skillForm} onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor={`${id}-name`} className="field-label">
            Nome
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
            Na conversa, digite /{normalized || 'nome'} no começo da mensagem. Use letras minúsculas, números e hífens.
          </span>
          {name.trim() !== '' && !validName && (
            <span className="field-hint" role="alert">
              O nome precisa ter de 2 a 40 letras minúsculas, números ou hífens.
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor={`${id}-description`} className="field-label">
            Descrição
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
            O Agente lê a descrição para decidir quando usar a habilidade sozinho.
          </span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-instructions`} className="field-label">
            Instruções
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
            Em Markdown: o roteiro, o formato da resposta, o que conferir.
          </span>
        </div>
        <fieldset className={styles.skillTools}>
          <legend className="field-label">Ferramentas</legend>
          <label className="check">
            <input type="checkbox" checked={restrict} onChange={(event) => setRestrict(event.target.checked)} />
            <span className="box" />
            <span>Limitar as ferramentas que a habilidade usa</span>
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
                      {tool.description} <span className="text-muted">({TOOL_KIND[tool.kind]})</span>
                    </span>
                  </label>
                ))}
              </div>
            ))}
          {restrict && allowed.length === 0 && <span className="field-hint">Escolha ao menos uma ferramenta.</span>}
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
  const skills = useSkills()
  const toggle = useToggleSkill()
  const remove = useDeleteSkill()
  const [editing, setEditing] = useState<AgentSkill | 'new' | null>(null)
  const [deleting, setDeleting] = useState<AgentSkill | null>(null)
  const items = skills.data?.items ?? []

  return (
    <div className={styles.page}>
      <PageHead
        kicker="Agente"
        title="Habilidades"
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
            Nova habilidade
          </button>
        }
      />
      <p className="text-muted">
        Uma habilidade guarda um jeito de trabalhar que você repete. Na <Link to="/agente">conversa</Link>, chame-a
        com /nome ou pelo seletor; o Agente também a escolhe pela descrição.
      </p>
      {skills.isError ? (
        <p className="alert alert-error" role="alert">
          {errorMessage(skills.error)}
        </p>
      ) : skills.isPending ? (
        <p className="text-muted">Carregando as habilidades…</p>
      ) : items.length === 0 ? (
        <p className="text-muted">Nenhuma habilidade ainda. Crie a primeira com Nova habilidade.</p>
      ) : (
        <ul className={`list ${styles.sessions}`} aria-label="Habilidades">
          {items.map((skill) => (
            <li key={skill.id} className="list-row">
              <span className="list-row-title">
                /{skill.name}
                {!skill.enabled && <span className="chip"> desligada</span>}
              </span>
              <span className="list-row-sub">
                {skill.description}
                {skill.allowed_tools && ` · ${skill.allowed_tools.length} ferramenta(s) permitida(s)`}
              </span>
              <span className="list-row-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={`${skill.enabled ? 'Desligar' : 'Ligar'} /${skill.name}`}
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate({ id: skill.id, enabled: !skill.enabled })}
                >
                  {skill.enabled ? 'Desligar' : 'Ligar'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={`Editar /${skill.name}`}
                  onClick={() => setEditing(skill)}
                >
                  Editar
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={`Excluir /${skill.name}`}
                  onClick={() => setDeleting(skill)}
                >
                  Excluir
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {editing && <SkillDialog skill={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          title="Excluir habilidade"
          confirmLabel="Excluir"
          busy={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
        >
          <p>/{deleting.name} deixa de existir. As conversas que a usaram continuam como estão.</p>
        </ConfirmDialog>
      )}
    </div>
  )
}
