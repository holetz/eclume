// A rota corrente depois da primeira troca de rota dentro da moldura (`ShellFrame`), ou `null`
// antes dela e fora da moldura: o `PageHead` leva o foco ao título quando ela muda. A primeira
// carga e a troca só de busca não mudam o valor, então não movem o foco.
import { createContext, useContext } from 'react'

export const NavigatedPathContext = createContext<string | null>(null)

export function useNavigatedPath(): string | null {
  return useContext(NavigatedPathContext)
}
