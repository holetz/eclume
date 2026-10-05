// As habilidades do Agente (/agent/skills): instruções reutilizáveis da pessoa, com as ferramentas
// permitidas escolhidas do catálogo (/agent/tools). A conversa invoca uma por `/nome` ou pelo seletor.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'
import { AGENT_KEY } from './agent'

export type AgentSkill = Schemas['AgentSkill']
export type AgentSkillInput = Schemas['AgentSkillCreate']
export type AgentTool = Schemas['AgentTool']

export const MAX_SKILL_NAME = 40
export const MAX_SKILL_DESCRIPTION = 300
export const MAX_SKILL_INSTRUCTIONS = 8000
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/

export const skillsKey = [...AGENT_KEY, 'skills'] as const
export const toolsKey = [...AGENT_KEY, 'tools'] as const

/** A natureza da ferramenta, como a tela a nomeia. */
export const TOOL_KIND: Record<AgentTool['kind'], string> = {
  read: 'consulta',
  produce: 'gera arquivo',
  action: 'propõe mudança',
}

/** O nome digitado como a API o guarda: sem barra e em minúsculas. */
export const normalizeSkillName = (value: string) => value.trim().replace(/^\//, '').toLowerCase()

export function useSkills() {
  return useQuery({
    queryKey: skillsKey,
    queryFn: () => unwrap(api.GET('/api/v1/agent/skills')),
  })
}

export function useAgentTools() {
  return useQuery({
    queryKey: toolsKey,
    queryFn: () => unwrap(api.GET('/api/v1/agent/tools')),
    staleTime: Infinity,
  })
}

export function useSaveSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: AgentSkillInput }) =>
      id
        ? unwrap(api.PATCH('/api/v1/agent/skills/{skill_id}', { params: { path: { skill_id: id } }, body }))
        : unwrap(api.POST('/api/v1/agent/skills', { body })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: skillsKey }),
  })
}

export function useToggleSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      unwrap(api.PATCH('/api/v1/agent/skills/{skill_id}', { params: { path: { skill_id: id } }, body: { enabled } })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: skillsKey }),
  })
}

export function useDeleteSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/api/v1/agent/skills/{skill_id}', { params: { path: { skill_id: id } } })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: skillsKey }),
  })
}
