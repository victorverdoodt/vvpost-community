import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { connectorToFlows } from '@vvpost/core/flows/inherit'
import { FLOW_SUFFIX } from '@vvpost/core/flows/workspace'
import type { Connector } from '@vvpost/schemas'
import { applyProjectOps, CONNECTOR_SUFFIX } from './apply'
import type { ProjectOp } from './ops'

/**
 * O editor de conector grava no formato do workspace (docs/flows.md, Herança): um fluxo-base volta
 * para o fluxo e os fluxos de requisição dele, e um conector novo num workspace sem conectores no
 * formato antigo nasce como fluxo-base. Devolve null quando o conector é do formato antigo, que
 * continua gravando o .connector.vvpost.json.
 */
export async function saveConnectorInFormat(dir: string, connector: Connector, file?: string): Promise<{ file: string } | null> {
  const ws = await loadWorkspace(dir)
  let ops: ProjectOp[]
  if (file) {
    if (!file.endsWith(FLOW_SUFFIX)) return null
    const owner = [...(ws.flowSources ?? [])].find(([key, f]) => f === file && !key.includes('/'))?.[0]
    if (!owner) throw new Error(`${file} não é um fluxo-base`)
    if (owner !== connector.id) throw new Error(`"${owner}" é um fluxo-base (${file}): o id se troca pelo fluxo`)
    ops = [{ op: 'upsertConnector', connector }]
  } else {
    const legacy = [...ws.connectorFiles].some(([id, f]) => f.endsWith(CONNECTOR_SUFFIX) && !ws.shared?.has(id))
    if (legacy || ws.connectors.has(connector.id) || connectorToFlows(connector).unsupported.length) return null
    ops = [
      { op: 'upsertConnector', connector },
      { op: 'migrateConnector', id: connector.id }
    ]
  }
  const result = await applyProjectOps(dir, ops, { actor: 'app' })
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n') || 'O conector não foi gravado.')
  const base = `/${connector.id}${FLOW_SUFFIX}`
  return { file: file ?? result.changes.find((c) => c.path.endsWith(base))?.path ?? `flows/${connector.id}/${connector.id}${FLOW_SUFFIX}` }
}

/**
 * Um lote da IA (edit_project) no formato do workspace, como o import e o editor do app: num
 * workspace sem conectores no formato antigo, cada conector novo do lote vira fluxos no fim
 * (migrateConnector). Fica no formato antigo o que o fluxo ainda não representa (endpoint de
 * plugin) e o conector que o próprio lote renomeia ou apaga.
 */
export async function opsInWorkspaceFormat(dir: string, ops: ProjectOp[]): Promise<ProjectOp[]> {
  const ws = await loadWorkspace(dir)
  const legacy = [...ws.connectorFiles].some(([id, f]) => f.endsWith(CONNECTOR_SUFFIX) && !ws.shared?.has(id))
  if (legacy || !Array.isArray(ops)) return ops
  const keep = new Set<string>()
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue
    if (op.op === 'moveConnector' || op.op === 'deleteConnector' || op.op === 'migrateConnector') keep.add(op.id)
    if (op.op === 'upsertEndpoint' && op.endpoint?.plugin) keep.add(op.connectorId)
  }
  const created = new Set<string>()
  for (const op of ops) {
    if (op?.op !== 'upsertConnector' || typeof op.connector?.id !== 'string') continue
    const id = op.connector.id
    if (ws.connectors.has(id) || keep.has(id) || op.file) continue
    if (connectorToFlows(op.connector).unsupported.length) created.delete(id)
    else created.add(id)
  }
  return created.size ? [...ops, ...[...created].map((id): ProjectOp => ({ op: 'migrateConnector', id }))] : ops
}
