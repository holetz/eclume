import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { usePageTitle } from '../../app/usePageTitle'
import styles from './Admin.module.css'
import { SETTINGS_KEY, TEMPLATES_KEY, useTemplates } from './queries'
import { sectionTitle } from './sections'

type Template = Schemas['SummaryTemplate']

/** Templates de resumo da organização: os padrões que todos veem, e o padrão do resumo automático. */
export function TemplatesPage() {
  usePageTitle(sectionTitle('templates'))
  const templates = useTemplates()
  const [editing, setEditing] = useState<Template | 'new' | null>(null)
  const items = (templates.data?.items ?? []).filter((template) => template.scope === 'organization')

  return (
    <section className={styles.page} aria-labelledby="templates-titulo">
      <div className={styles.intro}>
        <h2 id="templates-titulo">Templates padrão</h2>
        <p className="text-muted">
          Templates da organização aparecem para todos os usuários, que podem criar os seus. O marcado como padrão é o do
          resumo automático de quem não escolheu um template pessoal.
        </p>
      </div>
      <div className={styles.actions}>
        {editing === null && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing('new')}>
            Novo template da organização
          </button>
        )}
      </div>
      {editing !== null && (
        <TemplateForm
          key={editing === 'new' ? 'novo' : editing.id}
          template={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      )}
      {templates.isPending && <p role="status">Carregando templates…</p>}
      {templates.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(templates.error)}
        </p>
      )}
      {templates.isSuccess && items.length === 0 && <p className="text-muted">A organização não tem templates padrão.</p>}
      <ul className={styles.list}>
        {items.map((template) => (
          <TemplateItem key={template.id} template={template} onEdit={() => setEditing(template)} />
        ))}
      </ul>
    </section>
  )
}

function useInvalidateTemplates() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY })
    // O padrão da organização mora em `summarization.default_template_id`.
    void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY })
  }
}

function TemplateForm({ template, onDone }: { template: Template | null; onDone: () => void }) {
  const invalidate = useInvalidateTemplates()
  const [name, setName] = useState(template?.name ?? '')
  const [description, setDescription] = useState(template?.description ?? '')
  const [instructions, setInstructions] = useState(template?.instructions ?? '')
  const ids = { name: useId(), description: useId(), instructions: useId() }
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description: description.trim() || null, instructions: instructions.trim() }
      return template === null
        ? unwrap(api.POST('/api/v1/summary-templates', { body: { ...body, scope: 'organization' } }))
        : unwrap(
            api.PATCH('/api/v1/summary-templates/{template_id}', {
              params: { path: { template_id: template.id } },
              body,
            }),
          )
    },
    onSuccess: () => {
      invalidate()
      onDone()
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    save.mutate()
  }

  const title = template ? `Editar “${template.name}”` : 'Novo template da organização'
  return (
    <form className={`card ${styles.form}`} onSubmit={submit} aria-label={title}>
      <h3>{title}</h3>
      <div className="field">
        <label htmlFor={ids.name}>Nome</label>
        <input id={ids.name} className="input" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={ids.description}>Descrição</label>
        <input
          id={ids.description}
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Opcional: quando usar este template"
        />
      </div>
      <div className="field">
        <label htmlFor={ids.instructions}>Instruções ao agente</label>
        <textarea
          id={ids.instructions}
          className="input"
          rows={8}
          required
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <span className="field-hint">Em Markdown. A transcrição é anexada pelo servidor; não a cole aqui.</span>
      </div>
      {save.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(save.error)}
        </p>
      )}
      <div className={styles.actions}>
        <button type="submit" className="btn btn-primary" disabled={save.isPending || !name.trim() || !instructions.trim()}>
          {save.isPending ? 'Salvando…' : template ? 'Salvar alterações' : 'Criar template'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

function TemplateItem({ template, onEdit }: { template: Template; onEdit: () => void }) {
  const invalidate = useInvalidateTemplates()
  const [confirming, setConfirming] = useState(false)
  const path = { params: { path: { template_id: template.id } } }
  const makeDefault = useMutation({
    mutationFn: () => unwrap(api.PATCH('/api/v1/summary-templates/{template_id}', { ...path, body: { is_default: true } })),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/summary-templates/{template_id}', path)),
    onSuccess: invalidate,
  })
  const failure = makeDefault.error ?? remove.error

  return (
    <li className={`card ${styles.card}`} aria-label={template.name}>
      <div className={styles.actions}>
        <h3>{template.name}</h3>
        {template.is_default && <span className="badge badge-success">Padrão da organização</span>}
      </div>
      {template.description && <p className="text-muted">{template.description}</p>}
      <p className={styles.instructions}>{template.instructions}</p>
      {confirming ? (
        <div className={styles.actions} role="group" aria-label={`Confirmar exclusão de ${template.name}`}>
          <span>Resumos já gerados continuam.</span>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
            Confirmar exclusão
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)}>
            Manter
          </button>
        </div>
      ) : (
        <div className={styles.actions}>
          {!template.is_default && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => makeDefault.mutate()} disabled={makeDefault.isPending}>
              Tornar padrão
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit} aria-label={`Editar ${template.name}`}>
            Editar
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setConfirming(true)}
            aria-label={`Excluir ${template.name}`}
          >
            Excluir
          </button>
        </div>
      )}
      {failure && (
        <p className={styles.error} role="alert">
          {errorMessage(failure)}
        </p>
      )}
    </li>
  )
}
