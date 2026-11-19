import type {
  ImportAdjustment,
  ImportConflictMode,
  ImportPlanConnector,
  ImportPlanEndpoint,
  ImportSyncDecision,
  PostmanImportPreview
} from '@shared/ipc'

/** Item selecionado na árvore da revisão. */
export type Selection =
  | { kind: 'connector'; key: string }
  | { kind: 'endpoint'; connectorKey: string; endpointId: string }
  | { kind: 'environment'; key: string }
  | { kind: 'flow'; key: string }
  /** Endpoint do projeto que a reimportação de uma spec atualiza, deixa em conflito ou apaga. */
  | { kind: 'sync'; key: string }
  | null

type SyncStatus = Exclude<ImportPlanEndpoint['status'], 'new' | 'existing'>

export const SYNC_LABEL: Record<SyncStatus, string> = {
  updated: 'mudou na spec',
  conflict: 'conflito',
  removed: 'saiu da spec',
  linked: 'vinculado à spec',
  edited: 'editado no projeto'
}

export const SYNC_HINT: Record<SyncStatus, string> = {
  updated: 'A operação mudou na spec e o endpoint não foi editado no projeto.',
  conflict: 'A operação mudou na spec e o endpoint também foi editado no projeto.',
  removed: 'A operação não está mais na spec.',
  linked: 'O endpoint foi feito no projeto e a spec tem uma operação com o mesmo método e caminho: ele passa a segui-la.',
  edited: 'O endpoint foi editado no projeto e a operação não mudou na spec.'
}

/** O que cada decisão faz, por situação. */
export const SYNC_DECISION_LABEL: Record<SyncStatus, Record<ImportSyncDecision, string>> = {
  updated: { spec: 'Aplicar a versão da spec', keep: 'Manter como está' },
  conflict: { spec: 'Aplicar a versão da spec (perde a edição)', keep: 'Manter a versão do projeto' },
  removed: { spec: 'Apagar o endpoint', keep: 'Manter no projeto' },
  linked: { spec: 'Aplicar a versão da spec', keep: 'Vincular e manter a versão do projeto' },
  edited: { spec: 'Voltar à versão da spec (perde a edição)', keep: 'Manter a versão do projeto' }
}

/** Tom do selo de cada situação da reimportação. */
export const SYNC_TONE: Record<SyncStatus, 'accent' | 'warning' | 'danger'> = {
  updated: 'accent',
  linked: 'accent',
  conflict: 'warning',
  edited: 'warning',
  removed: 'danger'
}

/** Nome do campo do endpoint na lista de diferenças. */
export const SYNC_FIELD_LABEL: Record<string, string> = {
  name: 'Nome',
  description: 'Descrição',
  method: 'Método',
  path: 'Caminho',
  headers: 'Headers',
  query: 'Query',
  bodySchema: 'Schema do corpo',
  body: 'Corpo de exemplo'
}

export const CONFLICT_LABEL: Record<ImportConflictMode, string> = {
  merge: 'mesclar no existente',
  rename: 'importar como novo',
  replace: 'substituir'
}

export const CONFLICT_HINT: Record<ImportConflictMode, string> = {
  merge: 'Mantém o que já está no projeto e acrescenta só endpoints, cenários e variáveis novos.',
  rename: 'Importa ao lado do existente, com outro id.',
  replace: 'Regrava o arquivo do projeto com o que veio no import.'
}

export const fieldClass =
  'h-7 w-full rounded-[var(--radius-control)] border border-border bg-surface px-2 text-xs text-fg outline-none focus:border-accent'

/** Ids de um conector importado e de todos os descendentes (não podem virar pai dele). */
export function subtree(connectors: ImportPlanConnector[], key: string): Set<string> {
  const node = connectors.find((c) => c.key === key)
  const out = new Set<string>(node ? [node.id] : [])
  let grew = true
  while (grew) {
    grew = false
    for (const c of connectors) {
      if (c.extends && out.has(c.extends) && !out.has(c.id)) {
        out.add(c.id)
        grew = true
      }
    }
  }
  return out
}

/** Profundidade de cada conector na árvore (pela cadeia de `extends` presente na prévia). */
export function depths(connectors: ImportPlanConnector[]): Map<string, number> {
  const byId = new Map(connectors.map((c) => [c.id, c]))
  const out = new Map<string, number>()
  const depth = (c: ImportPlanConnector, seen = new Set<string>()): number => {
    const known = out.get(c.id)
    if (known !== undefined) return known
    const parent = c.extends ? byId.get(c.extends) : undefined
    const d = parent && !seen.has(parent.id) ? depth(parent, seen.add(c.id)) + 1 : 0
    out.set(c.id, d)
    return d
  }
  for (const c of connectors) depth(c)
  return out
}

/** Frase curta para a lista de ajustes ("Desfazer"). */
export function describeAdjustment(a: ImportAdjustment, preview: PostmanImportPreview | null): string {
  const name = (key: string) => preview?.connectors.find((c) => c.key === key || c.id === key)?.name ?? key
  switch (a.op) {
    case 'renameConnector':
      return `Renomear conector para "${a.name}"`
    case 'setParent':
      return a.parent ? `${name(a.id)} herda de ${name(a.parent.id)}` : `${name(a.id)} vai para a raiz`
    case 'dissolveConnector':
      return `Desfazer a pasta ${name(a.id)}`
    case 'excludeConnector':
      return `Não importar ${name(a.id)}`
    case 'groupEndpoints':
      return `Agrupar ${a.endpointIds.length} endpoint(s) em "${a.name}"`
    case 'renameEndpoint':
      return `Renomear endpoint para "${a.name}"`
    case 'moveEndpoint':
      return `Mover ${a.endpointId} para ${name(a.to.id)}`
    case 'excludeEndpoint':
      return `Não importar ${a.endpointId}`
    case 'mergeIntoScenario':
      return `${a.endpointId} vira cenário de ${a.into.endpointId}`
    case 'excludeEnvironment':
      return `Não importar o ambiente ${a.id}`
    case 'excludeFlow':
      return `Não importar o fluxo ${preview?.flows.find((f) => f.key === a.id)?.name ?? a.id}`
  }
}
