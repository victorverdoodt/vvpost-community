import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { SchemaId, validateConnector, type Connector } from '@vvpost/schemas'
import type { ConnectorSource } from '../types'
import { literalSecrets } from './literal-secrets'
import { loadWorkspace } from './workspace'

export { literalSecrets }

const CONNECTOR_SUFFIX = '.connector.vvpost.json'
const CONNECTORS_DIR = 'connectors'

/** O conector como está no arquivo (sem a herança aplicada), para o editor. */
export async function readConnectorSource(dir: string, id: string): Promise<ConnectorSource> {
  const ws = await loadWorkspace(dir)
  const file = ws.connectorFiles.get(id)
  if (!file) throw new Error(`conector "${id}" não encontrado no workspace`)
  const shared = ws.shared?.get(id)
  if (shared) throw new Error(`"${id}" é um conector compartilhado de ${shared} e não se edita aqui; crie outro com "extends": "${id}"`)
  // Um fluxo-base se edita como conector: o compilado, com os endpoints dos fluxos de requisição
  // e as citações de schemas compartilhados como estão nos arquivos.
  const doc = ws.flowSources?.has(id) ? (ws.unresolved?.get(id) ?? ws.connectors.get(id)) : JSON.parse(await readFile(join(dir, file), 'utf8'))
  const result = validateConnector(doc)
  if (!result.ok) throw new Error(`${file} é inválido; corrija o arquivo antes de editar`)
  return { file, connector: result.value }
}

/**
 * Valida e grava um conector editado no app. Sem `file`, cria
 * connectors/<id>.connector.vvpost.json; com `file`, regrava esse arquivo. Um id já
 * usado por outro arquivo é recusado, e credenciais literais também: o arquivo vai
 * para o Git, então segredos entram como {{VAR}} de um ambiente.
 */
export async function saveConnector(dir: string, connector: Connector, file?: string): Promise<{ file: string }> {
  const result = validateConnector(connector)
  if (!result.ok) {
    throw new Error(`conector inválido: ${result.issues.slice(0, 5).map((i) => `${i.path || '/'}: ${i.message}`).join('; ')}`)
  }
  const literals = literalSecrets(result.value)
  if (literals.length) {
    throw new Error(
      `credencial escrita direto no conector (${literals.join(', ')}). Use uma variável {{NOME}} de um ambiente, marcada como segredo.`
    )
  }
  const target = file ?? `${CONNECTORS_DIR}/${result.value.id}${CONNECTOR_SUFFIX}`
  const clean = normalize(target)
  if (isAbsolute(target) || clean.startsWith('..') || !clean.endsWith(CONNECTOR_SUFFIX)) {
    throw new Error(`caminho de conector inválido: ${target}`)
  }
  const rel = clean.split(sep).join('/')
  const ws = await loadWorkspace(dir)
  const owner = ws.connectorFiles.get(result.value.id)
  const shared = ws.shared?.get(result.value.id)
  if (shared) throw new Error(`o id "${result.value.id}" é de um conector compartilhado de ${shared}; use outro id com "extends": "${result.value.id}"`)
  if (owner && owner !== rel) throw new Error(`o id "${result.value.id}" já é do conector em ${owner}`)
  // Trocar o id de um conector com filhos quebraria a herança deles.
  const previous = [...ws.connectorFiles].find(([, f]) => f === rel)?.[0]
  if (previous && previous !== result.value.id) {
    const children = [...ws.connectors.values()].filter((c) => c.extends === previous).map((c) => c.id)
    if (children.length) {
      throw new Error(`não dá para trocar o id de "${previous}": ${children.join(', ')} herda(m) dele`)
    }
  }
  const path = join(dir, clean)
  if (!file && (await readFile(path).then(() => true, () => false))) throw new Error(`${rel} já existe`)
  // "$schema" primeiro, como nos outros arquivos do workspace (autocomplete nos editores).
  const { $schema: _, ...rest } = result.value
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ $schema: SchemaId.Connector, ...rest }, null, 2)}\n`)
  return { file: rel }
}
