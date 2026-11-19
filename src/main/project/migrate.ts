import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateConnector, type Connector, type Flow } from '@vvpost/schemas'
import { extractSharedSchemas } from '@vvpost/core/connectors/shared-schemas'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { connectorToFlows } from '@vvpost/core/flows/inherit'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { applyProjectOps, type ApplyOptions } from './apply'
import type { ProjectApplyResult, ProjectOp } from './ops'

const CONNECTOR_SUFFIX = '.connector.vvpost.json'

export interface MigrationPlan {
  /** Um migrateConnector por conector que converte (e, antes, extractSchemas se há schema repetido). */
  ops: ProjectOp[]
  /** Os conectores que viram fluxos. */
  converted: string[]
  /** Os schemas repetidos que viram compartilhados, com quantas cópias cada um substitui. */
  schemas: { name: string; uses: number }[]
  /** Conectores que ficam no formato antigo, e por quê. */
  skipped: { id: string; file?: string; reason: string }[]
}

/**
 * O que `vvpost migrate` e o Converter do app fazem: todo conector do formato antigo deste
 * projeto (não os compartilhados nem os do Compartilhado) que já cabe no formato de fluxos, e os
 * schemas copiados em vários endpoints (o import antigo do OpenAPI) viram schemas compartilhados.
 * `only` limita aos ids pedidos (e aí os schemas ficam como estão).
 */
export async function planMigration(dir: string, only?: readonly string[]): Promise<MigrationPlan> {
  const ws = await loadWorkspace(dir)
  const plan: MigrationPlan = { ops: [], converted: [], schemas: [], skipped: [] }
  const docs: (Connector | Flow)[] = []
  for (const id of only ?? []) {
    if (!ws.connectors.has(id)) plan.skipped.push({ id, reason: 'não existe no workspace' })
  }
  for (const [id, file] of ws.connectorFiles) {
    if (only && !only.includes(id)) continue
    if (ws.shared?.has(id)) {
      if (only) plan.skipped.push({ id, file, reason: `é de ${ws.shared.get(id)}, só leitura aqui` })
      continue
    }
    if (ws.flowSources?.has(id) || !file.endsWith(CONNECTOR_SUFFIX)) {
      if (only) plan.skipped.push({ id, file, reason: 'já é um fluxo-base' })
      continue
    }
    // O documento como está no arquivo: os endpoints que vêm de fluxos não entram na conta.
    const raw = validateConnector(JSON.parse(await readFile(join(dir, file), 'utf8')))
    if (raw.ok) docs.push(raw.value)
    if (!raw.ok) {
      plan.skipped.push({ id, file, reason: 'o arquivo não passa no schema' })
      continue
    }
    const { unsupported } = connectorToFlows(raw.value)
    if (unsupported.length) plan.skipped.push({ id, file, reason: `ainda não cabe no formato de fluxos: ${unsupported.join('; ')}` })
    else {
      plan.ops.push({ op: 'migrateConnector', id })
      plan.converted.push(id)
    }
  }
  if (!only) {
    // A mesma conta do extractSchemas, numa cópia, só para saber se há o que compartilhar.
    docs.push(...(await loadFlows(dir)).flows.map((f) => f.flow))
    const bodies = docs.flatMap((d) =>
      'nodes' in d
        ? [...d.nodes.flatMap((n) => (n.type === 'request' && n.request.bodySchema ? [n.request.bodySchema] : [])), ...(d.examples ?? []).flatMap((x) => (x.schema ? [x.schema] : []))]
        : (d.endpoints ?? []).flatMap((e) => [...(e.bodySchema ? [e.bodySchema] : []), ...(e.examples ?? []).flatMap((x) => (x.schema ? [x.schema] : []))])
    )
    const existing = new Map([...(ws.schemas ?? [])].map(([name, s]) => [name, s.schema] as const))
    const found = extractSharedSchemas(structuredClone(bodies), existing)
    if (found.uses.size) {
      plan.ops.unshift({ op: 'extractSchemas' })
      plan.schemas = [...found.uses].map(([name, uses]) => ({ name, uses })).sort((a, b) => a.name.localeCompare(b.name))
    }
  }
  return plan
}

/** Converte os conectores do plano num lote só (tudo ou nada). Sem nada para converter, result é null. */
export async function migrateWorkspace(
  dir: string,
  options: ApplyOptions & { connectors?: readonly string[] } = {}
): Promise<{ plan: MigrationPlan; result: ProjectApplyResult | null }> {
  const { connectors, ...apply } = options
  const plan = await planMigration(dir, connectors)
  return { plan, result: plan.ops.length ? await applyProjectOps(dir, plan.ops, apply) : null }
}
