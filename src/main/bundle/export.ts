import { access, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  REQUIRED_SECRET,
  SchemaId,
  type Bundle,
  type Connector,
  type Environment,
  type EnvironmentVariable,
  type Flow
} from '@vvpost/schemas'
import { stringify as toYaml } from 'yaml'
import type { ExportFormat, ExportOptions, ExportSelection, ExportSummary } from '@shared/ipc'
import { loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { loadFlows, plainFlows } from '@vvpost/core/flows/workspace'
import type { FlowCatalog } from '@vvpost/core/types'
import { docsFileOf } from '../project/apply'
import { describeLeaks, findSecretLeaks } from '../workspace/leak-guard'
import { readSecretsStore, type SecretsStore } from '../workspace/vault'
import { isSecretName, looksLikeSecretValue, slug } from '../importers/postman'
import { bundleToOpenApi, OPENAPI_JSON_SUFFIX, OPENAPI_YAML_SUFFIX } from './openapi'
import { bundleToPostman, COLLECTION_SUFFIX, ENVIRONMENT_SUFFIX } from './postman'

/** Nome padrão do arquivo de pacote. */
export const BUNDLE_SUFFIX = '.vvpost.bundle.json'
const CONNECTOR_SUFFIX = '.connector.vvpost.json'

/**
 * Os fluxos que vão no pacote como fluxos: os fluxos-base e os de requisição já vão como os
 * conectores e endpoints que eles são, e o import grava no formato do workspace de destino.
 */
const ownFlows = (ws: LoadedWorkspace, catalog: FlowCatalog) => plainFlows(catalog, ws.flowSources)

export type { ExportFormat, ExportSelection }

export interface ExportResult {
  bundle: Bundle
  /** O pacote como vai para o arquivo. */
  text: string
  /** Avisos (variável que parecia segredo e saiu como pendente, dependência incluída...). */
  warnings: string[]
  summary: ExportSummary
  /** Conectores que entraram só por serem pais (extends) dos pedidos. */
  parentsOnly: string[]
}

export class ExportError extends Error {}

/**
 * Monta o pacote de exportação do projeto (schema bundle.json). Nenhum valor de
 * segredo sai: variáveis isSecret vão como __REQUIRED_SECRET__, variáveis com nome ou
 * formato de credencial também (com aviso), e o texto final ainda é conferido contra
 * os valores do vault e credenciais literais; se algo escapar, a exportação falha.
 */
export async function exportBundle(
  dir: string,
  selection: ExportSelection = {},
  meta: { name?: string; description?: string; generator?: string; now?: Date } = {}
): Promise<ExportResult> {
  const ws = await loadWorkspace(dir)
  const flowCatalog = await loadFlows(dir)
  const warnings: string[] = [...ws.issues, ...flowCatalog.issues].map((i) => `${i.file}: ${i.message} (fora do pacote)`)
  const partial =
    selection.connectors !== undefined ||
    selection.endpoints !== undefined ||
    selection.environments !== undefined ||
    selection.flows !== undefined

  // Fluxos e os conectores que eles usam.
  const flows: Flow[] = []
  const own = ownFlows(ws, flowCatalog)
  const flowIds = partial ? (selection.flows ?? []) : own.map((f) => f.flow.id)
  for (const id of flowIds) {
    const found = own.find((f) => f.flow.id === id)
    if (!found && ws.connectors.has(id)) throw new ExportError(`"${id}" é um fluxo-base: escolha-o entre os conectores`)
    if (!found) throw new ExportError(`fluxo "${id}" não existe no projeto`)
    flows.push(structuredClone(found.flow))
  }

  // Endpoints escolhidos por conector (undefined: todos).
  const onlyEndpoints = new Map<string, Set<string>>()
  for (const ref of selection.endpoints ?? []) {
    const slash = ref.lastIndexOf('/')
    const connectorId = ref.slice(0, slash)
    const endpointId = ref.slice(slash + 1)
    const c = ws.connectors.get(connectorId)
    if (slash <= 0 || !c) throw new ExportError(`endpoint "${ref}": use <conector>/<endpoint> de um conector do projeto`)
    if (!(c.endpoints ?? []).some((e) => e.id === endpointId)) throw new ExportError(`endpoint "${endpointId}" não existe em ${connectorId}`)
    let set = onlyEndpoints.get(connectorId)
    if (!set) onlyEndpoints.set(connectorId, (set = new Set()))
    set.add(endpointId)
  }

  const wanted = new Set<string>()
  const parentsOnly: string[] = []
  const asked = partial ? [...(selection.connectors ?? []), ...onlyEndpoints.keys()] : [...ws.connectors.keys()]
  for (const id of asked) {
    if (!ws.connectors.has(id)) throw new ExportError(`conector "${id}" não existe no projeto`)
    wanted.add(id)
  }
  for (const flow of flows) {
    for (const id of flowConnectors(flow)) {
      if (!ws.connectors.has(id)) {
        warnings.push(`o fluxo ${flow.id} usa o conector "${id}", que não está no projeto`)
      } else if (!wanted.has(id)) {
        wanted.add(id)
        warnings.push(`conector ${id} incluído porque o fluxo ${flow.id} usa`)
      }
    }
  }
  // Pais: sem eles a herança não resolve no projeto que importa.
  for (const id of [...wanted]) {
    for (let parent = ws.connectors.get(id)?.extends; parent && !wanted.has(parent); parent = ws.connectors.get(parent)?.extends) {
      if (!ws.connectors.has(parent)) break
      wanted.add(parent)
      parentsOnly.push(parent)
      warnings.push(`conector ${parent} incluído porque ${id} herda dele`)
    }
  }

  const connectors: Connector[] = []
  const visit = (c: Connector) => {
    connectors.push(exportConnector(c, onlyEndpoints.get(c.id), selection.scenarios !== false))
    for (const child of ws.connectors.values()) if (child.extends === c.id && wanted.has(child.id)) visit(child)
  }
  for (const c of [...ws.connectors.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (wanted.has(c.id) && (!c.extends || !wanted.has(c.extends))) visit(c)
  }

  const envIds = partial ? (selection.environments ?? []) : [...ws.environments.keys()]
  const environments: Environment[] = []
  for (const id of envIds) {
    const env = ws.environments.get(id)
    if (!env) throw new ExportError(`ambiente "${id}" não existe no projeto`)
    environments.push(exportEnvironment(env, warnings))
  }

  const docs: Record<string, string> = {}
  if (selection.docs !== false) {
    for (const c of connectors) {
      const file = ws.connectorFiles.get(c.id)!
      const text = await readFile(join(dir, docsFileOf(file)), 'utf8').catch(() => undefined)
      if (text !== undefined) docs[c.id] = text
    }
  }

  const bundle: Bundle = {
    $schema: SchemaId.Bundle,
    ...(meta.name && { name: meta.name }),
    ...(meta.description && { description: meta.description }),
    exportedAt: (meta.now ?? new Date()).toISOString(),
    ...(meta.generator && { generator: meta.generator }),
    connectors,
    environments,
    flows,
    ...(Object.keys(docs).length && { docs })
  }
  const text = `${JSON.stringify(bundle, null, 2)}\n`
  await assertNoSecrets(dir, bundle, text, ws.secrets)
  const endpoints = connectors.flatMap((c) => c.endpoints ?? [])
  return {
    bundle,
    text,
    warnings,
    parentsOnly,
    summary: {
      connectors: connectors.length,
      endpoints: endpoints.length,
      scenarios: endpoints.reduce((n, e) => n + (e.scenarios?.length ?? 0), 0),
      environments: environments.length,
      flows: flows.length,
      docs: Object.keys(docs).length
    }
  }
}

/** Um arquivo da exportação: o principal primeiro, depois os de apoio (ambientes do Postman). */
export interface ExportFile {
  /** Fim do nome do arquivo, ex.: .postman_collection.json ou .dev.postman_environment.json. */
  suffix: string
  text: string
  data: unknown
}

export interface FormatExportResult {
  format: ExportFormat
  files: [ExportFile, ...ExportFile[]]
  warnings: string[]
  summary: ExportSummary
}

/**
 * Exporta no formato pedido. Postman e OpenAPI partem do pacote do VVPost (a mesma seleção, os
 * mesmos pais e a mesma recusa de segredo) e o traduzem; o resultado ainda é conferido contra
 * os valores do vault antes de sair. `yaml` grava a spec OpenAPI em YAML.
 */
export async function exportAs(
  dir: string,
  selection: ExportSelection = {},
  meta: { name?: string; description?: string; generator?: string; now?: Date; yaml?: boolean } = {}
): Promise<FormatExportResult> {
  const format = selection.format ?? 'vvpost'
  const result = await exportBundle(dir, selection, meta)
  if (format === 'vvpost') {
    return { format, files: [{ suffix: BUNDLE_SUFFIX, text: result.text, data: result.bundle }], warnings: result.warnings, summary: result.summary }
  }
  let files: [ExportFile, ...ExportFile[]]
  let warnings: string[]
  // Fora do VVPost o pai que entrou só pela herança leva a configuração, não os endpoints dele.
  const source = structuredClone(result.bundle)
  for (const c of (source.connectors ?? []) as Connector[]) if (result.parentsOnly.includes(c.id)) delete c.endpoints
  if (format === 'postman') {
    const pm = bundleToPostman(source)
    files = [
      { suffix: COLLECTION_SUFFIX, text: `${JSON.stringify(pm.collection, null, 2)}\n`, data: pm.collection },
      ...pm.environments.map((env) => ({
        suffix: `.${slug(env.name) || slug(env.id) || 'ambiente'}${ENVIRONMENT_SUFFIX}`,
        text: `${JSON.stringify(env.data, null, 2)}\n`,
        data: env.data
      }))
    ]
    warnings = pm.warnings
  } else {
    const oa = bundleToOpenApi(source)
    files = [
      meta.yaml
        ? { suffix: OPENAPI_YAML_SUFFIX, text: toYaml(oa.spec, { aliasDuplicateObjects: false, lineWidth: 0 }), data: oa.spec }
        : { suffix: OPENAPI_JSON_SUFFIX, text: `${JSON.stringify(oa.spec, null, 2)}\n`, data: oa.spec }
    ]
    warnings = oa.warnings
  }
  const leaks = await findSecretLeaks(
    dir,
    files.map((f) => ({ path: f.suffix.slice(1), content: f.text }))
  )
  if (leaks.length) {
    throw new ExportError(
      `exportação recusada: o arquivo teria segredo.\n${describeLeaks(leaks).split('\n').slice(1, -1).join('\n')}\n` +
        'Troque o valor por uma variável {{NOME}} de um ambiente, marcada como segredo.'
    )
  }
  return { format, files, warnings: [...result.warnings, ...warnings], summary: result.summary }
}

/** Conectores que um fluxo usa (nós de requisição e adapters de plugin). */
export function flowConnectors(flow: Flow): string[] {
  const ids = new Set<string>()
  for (const node of flow.nodes) {
    const id = node.type === 'request' ? node.request.connector : node.type === 'plugin' ? node.plugin.connector : undefined
    if (id) ids.add(id)
  }
  return [...ids]
}

function exportConnector(c: Connector, endpoints: Set<string> | undefined, scenarios: boolean): Connector {
  const { $schema: _, ...rest } = structuredClone(c)
  const out: Connector = { $schema: SchemaId.Connector, ...rest }
  if (out.endpoints) {
    let list = endpoints ? out.endpoints.filter((e) => endpoints.has(e.id)) : out.endpoints
    if (!scenarios) list = list.map(({ scenarios: _s, ...e }) => e)
    if (list.length) out.endpoints = list
    else delete out.endpoints
  }
  return out
}

/** Segredo nunca sai: isSecret vira __REQUIRED_SECRET__, e o que parece credencial também. */
function exportEnvironment(env: Environment, warnings: string[]): Environment {
  const variables: Record<string, EnvironmentVariable> = {}
  for (const [name, v] of Object.entries(env.variables)) {
    const looksSecret = !v.isSecret && v.value !== '' && (isSecretName(name) || looksLikeSecretValue(v.value))
    if (v.isSecret || looksSecret) {
      variables[name] = { type: 'string', value: REQUIRED_SECRET, isSecret: true, ...(v.description && { description: v.description }) }
      if (looksSecret) warnings.push(`${env.id}: ${name} parece credencial e foi exportada como segredo pendente`)
    } else {
      variables[name] = structuredClone(v)
    }
  }
  const { $schema: _, ...rest } = env
  return { $schema: SchemaId.Environment, ...structuredClone(rest), variables }
}

async function assertNoSecrets(dir: string, bundle: Bundle, text: string, store: SecretsStore | undefined): Promise<void> {
  const secrets = store ?? (await readSecretsStore(dir).catch((): SecretsStore => ({})))
  const files = [
    { path: 'pacote', content: text },
    // Cada conector como arquivo de conector, para a checagem de credencial literal.
    ...(bundle.connectors ?? []).map((c) => ({
      path: `${(c as Connector).id}${CONNECTOR_SUFFIX}`,
      content: JSON.stringify(c)
    }))
  ]
  const leaks = await findSecretLeaks(dir, files, secrets)
  if (leaks.length) {
    throw new ExportError(
      `exportação recusada: o pacote teria segredo.\n${describeLeaks(leaks).split('\n').slice(1, -1).join('\n')}\n` +
        'Troque o valor por uma variável {{NOME}} de um ambiente, marcada como segredo.'
    )
  }
}

/** O que o projeto tem para exportar, sem nenhum valor de variável. */
export async function exportOptions(dir: string): Promise<ExportOptions> {
  const ws = await loadWorkspace(dir)
  const flowCatalog = await loadFlows(dir)
  const connectors: ExportOptions['connectors'] = []
  for (const c of [...ws.connectors.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const file = ws.connectorFiles.get(c.id)!
    const hasDocs = await access(join(dir, docsFileOf(file))).then(
      () => true,
      () => false
    )
    connectors.push({
      id: c.id,
      name: c.name,
      ...(c.extends && { extends: c.extends }),
      hasDocs,
      endpoints: (c.endpoints ?? []).map((e) => ({
        id: e.id,
        name: e.name,
        method: e.method,
        path: e.path,
        scenarios: e.scenarios?.length ?? 0
      }))
    })
  }
  return {
    dir,
    name: basename(dir),
    connectors,
    environments: [...ws.environments.values()].map((e) => {
      const vars = Object.values(e.variables)
      return { id: e.id, name: e.name, variables: vars.length, secrets: vars.filter((v) => v.isSecret).length }
    }),
    flows: ownFlows(ws, flowCatalog).map(({ flow }) => ({
      id: flow.id,
      name: flow.name,
      nodes: flow.nodes.length,
      connectors: flowConnectors(flow)
    }))
  }
}
