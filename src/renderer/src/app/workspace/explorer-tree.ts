import type { CatalogConnector } from '@shared/ipc'

/** Os conectores pela herança: cada um debaixo do pai (o último antes dele na cadeia), quando o pai está na lista. */
export function byInheritance(list: CatalogConnector[]): { roots: CatalogConnector[]; children: Map<string, CatalogConnector[]> } {
  const ids = new Set(list.map((c) => c.id))
  const children = new Map<string, CatalogConnector[]>()
  const roots: CatalogConnector[] = []
  for (const c of list) {
    const parent = c.chain.at(-2)
    if (parent && parent !== c.id && ids.has(parent)) children.set(parent, [...(children.get(parent) ?? []), c])
    else roots.push(c)
  }
  return { roots, children }
}

/** Conectores compartilhados que nenhum conector do projeto herda (nem por outro compartilhado). */
export function unusedShared(list: Pick<CatalogConnector, 'id' | 'shared' | 'chain'>[]): Set<string> {
  const used = new Set<string>()
  for (const c of list) if (!c.shared) for (const id of c.chain) used.add(id)
  return new Set(list.filter((c) => c.shared && !used.has(c.id)).map((c) => c.id))
}
