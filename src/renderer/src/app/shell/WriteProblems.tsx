import { useEffect } from 'react'
import { useToast } from '../../design-system'

/**
 * Aviso depois de uma gravação do app que deixou o projeto com um problema que o `vvpost validate`
 * do CI reprova (diretiva quebrada no documento do projeto, corpo padrão fora do bodySchema): o
 * mesmo que o MCP devolve ao agente. Só o que a gravação causou.
 */
export function WriteProblems() {
  const notify = useToast()
  useEffect(
    () =>
      window.vvpost.onWriteProblems((problems) => {
        const more = problems.length > 1 ? ` (e mais ${problems.length - 1})` : ''
        notify(`Esta mudança deixou um problema que o vvpost validate reprova: ${problems[0]}${more}`, 'warning')
      }),
    [notify]
  )
  return null
}
