// O fluxo do botão Gravar, que o atalho "Gravar agora" do ícone também usa: as permissões, a
// explicação da bateria antes do primeiro Gravar sem a isenção e o `gravar`, que só confirma depois
// de o serviço de microfone entrar em primeiro plano. A tela (o Início) mostra o que o fluxo pede.

import { mensagemDeErro, type Ponte } from '../ponte/ponte'
import type { Aparelho } from '../ponte/tipos'

/** O que o fluxo pede à tela depois de uma etapa. */
export type PassoDoGravar =
  | { passo: 'gravando' }
  | { passo: 'sem_microfone' }
  | { passo: 'explicar_bateria' }
  | { passo: 'erro'; mensagem: string }

export const SEM_MICROFONE = 'Sem o microfone, o eclume não grava. Permita o microfone nas configurações do app.'

/**
 * Pede o microfone e as notificações; sem o microfone, para; antes do primeiro Gravar sem a isenção
 * de bateria, pede a explicação; senão, grava. `aoPermitir` recebe o que o sistema concedeu.
 */
export async function gravar(
  ponte: Ponte,
  aparelho: Aparelho | null,
  aoPermitir?: (notificacoes: boolean) => void,
): Promise<PassoDoGravar> {
  try {
    const permitido = await ponte.permissoes()
    aoPermitir?.(permitido.notificacoes)
    if (!permitido.microfone) return { passo: 'sem_microfone' }
    if (aparelho?.isencaoDeBateria === 'pedir') return { passo: 'explicar_bateria' }
    await ponte.gravar()
    return { passo: 'gravando' }
  } catch (e) {
    return { passo: 'erro', mensagem: mensagemDeErro(e) }
  }
}

/** Depois da explicação da bateria: pede a isenção (com `pedir`), relê o aparelho e grava. */
export async function gravarDepoisDaBateria(
  ponte: Ponte,
  pedir: boolean,
): Promise<{ passo: PassoDoGravar; aparelho: Aparelho | null }> {
  let aparelho: Aparelho | null = null
  try {
    if (pedir) await ponte.pedirIsencaoDeBateria()
    aparelho = await ponte.aparelho()
    await ponte.gravar()
    return { passo: { passo: 'gravando' }, aparelho }
  } catch (e) {
    return { passo: { passo: 'erro', mensagem: mensagemDeErro(e) }, aparelho }
  }
}
