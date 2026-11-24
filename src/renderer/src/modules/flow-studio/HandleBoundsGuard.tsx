import { useEffect } from 'react'
import { useStore, useUpdateNodeInternals, type ReactFlowState } from '@xyflow/react'

/** Nós já medidos que estão sem as posições das alças, numa chave estável para o seletor. */
function unmeasuredHandles(s: ReactFlowState): string {
  const ids: string[] = []
  for (const [id, node] of s.nodeLookup) if (node.measured.width && !node.internals.handleBounds) ids.push(id)
  return ids.join('\0')
}

/**
 * Remede as alças que o React Flow perde numa corrida: o nó é medido, mas uma versão do nó criada antes
 * da medição chega ao canvas e apaga as posições das alças. O tamanho não muda de novo, então o React Flow
 * não volta a medir, e as ligações desse nó somem do canvas. Este componente vê o nó nesse estado e pede a
 * medição outra vez. Fica dentro do <ReactFlow>.
 */
export function HandleBoundsGuard(): null {
  const missing = useStore(unmeasuredHandles)
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => {
    if (missing) updateNodeInternals(missing.split('\0'))
  }, [missing, updateNodeInternals])
  return null
}
