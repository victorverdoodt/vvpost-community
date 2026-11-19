/**
 * Ordem das abas na barra única do workspace. As abas de arquivo e de ferramenta são do shell; as
 * dos módulos (Quick Request, Flow Studio) chegam pelas fontes de abas, na ordem de cada módulo.
 */

/** Chave da aba de um módulo: src:<módulo>:<id>. */
export const sourceKey = (owner: string, id: string): string => `src:${owner}:${id}`

export function parseSourceKey(key: string): { owner: string; id: string } | null {
  if (!key.startsWith('src:')) return null
  const at = key.indexOf(':', 4)
  return at < 0 ? null : { owner: key.slice(4, at), id: key.slice(at + 1) }
}

/**
 * Junta a ordem atual com as abas que os módulos publicam: some o que o módulo fechou, e uma aba
 * nova entra logo depois da irmã anterior do mesmo módulo, ou depois de `after` (a aba ativa),
 * ou no fim. As outras abas não mudam de lugar.
 */
export function mergeOrder(order: readonly string[], sources: ReadonlyMap<string, readonly string[]>, after?: string): string[] {
  const present = new Set<string>()
  for (const [owner, ids] of sources) for (const id of ids) present.add(sourceKey(owner, id))
  const next = order.filter((key) => {
    const src = parseSourceKey(key)
    return !src || (sources.has(src.owner) ? present.has(key) : false)
  })
  for (const [owner, ids] of sources) {
    ids.forEach((id, i) => {
      const key = sourceKey(owner, id)
      if (next.includes(key)) return
      const sibling = ids
        .slice(0, i)
        .reverse()
        .map((x) => sourceKey(owner, x))
        .find((k) => next.includes(k))
      const anchor = sibling ?? (after && next.includes(after) ? after : undefined)
      if (anchor) next.splice(next.indexOf(anchor) + 1, 0, key)
      else next.push(key)
    })
  }
  return next
}

/** A vizinha que fica ativa quando `key` fecha: a da direita, ou a da esquerda. */
export function neighborOf(order: readonly string[], key: string): string | undefined {
  const i = order.indexOf(key)
  if (i < 0) return undefined
  return order[i + 1] ?? order[i - 1]
}
