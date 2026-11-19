import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Connector } from '@vvpost/schemas'
import type { ImportPlanInput, PostmanImportPreview } from '@shared/ipc'
import { renameSchemaRefs, schemaBody } from '@vvpost/core/connectors/shared-schemas'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { connectorToFlows } from '@vvpost/core/flows/inherit'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { applyProjectOps, CONNECTOR_SUFFIX, type ProjectOp } from '../project'
import { convertBundle, isBundle, type ImportSourceResult } from './bundle'
import { convertBruno, isBruFile, isBrunoFolder, isBrunoJson } from './bruno'
import { isImportText, type ForeignConversion } from './foreign'
import { convertHar, isHar } from './har'
import { convertInsomnia, isInsomnia } from './insomnia'
import { EMPTY_PROJECT, planImport, type ImportOp, type ProjectSnapshot } from './plan'
import { convertOpenApi, isOpenApi } from './openapi'
import { convertPostman, type PostmanSource } from './postman'
import { convertWsdl, isWsdlText } from './wsdl'
import { fetchImportUrl, isUrl, readImportFile, readSourceLocation, storedLocation } from './source'
import { validateImport } from './workspace'

/** Um arquivo de import já lido. `location` (caminho absoluto ou URL) fica no conector de uma spec OpenAPI. */
export interface ImportSource extends PostmanSource {
  location?: string
}

export interface PreparedImport {
  id: string
  /** Resultado completo, com os valores de segredo. Fica só no main process. */
  result: ImportSourceResult
  readErrors: { file: string; message: string }[]
  /** Saídas da conversão que não passaram nos schemas (bug do importador): bloqueiam a gravação. */
  invalid: { file: string; message: string }[]
}

export interface ImportTarget {
  dir: string
  /** É o workspace aberto no app. */
  isWorkspace: boolean
}

/**
 * Lê os arquivos escolhidos (coleções e ambientes do Postman, pacotes do VVPost, specs
 * OpenAPI e Swagger em JSON ou YAML, exportações do Insomnia, coleções do Bruno — pasta, .bru
 * ou JSON —, HAR e WSDL), converte e valida. Não grava nada.
 */
export async function prepareImport(paths: string[]): Promise<PreparedImport> {
  const sources: ImportSource[] = []
  const readErrors: { file: string; message: string }[] = []
  for (const path of paths) {
    const file = basename(path)
    try {
      sources.push({ file, data: await readImportFile(path), location: path })
    } catch (err) {
      readErrors.push({ file, message: (err as Error).message })
    }
  }
  return prepareSources(sources, readErrors)
}

/** Baixa e prepara uma spec OpenAPI (ou outro arquivo de import) por URL. */
export async function prepareUrlImport(url: string): Promise<PreparedImport> {
  const file = new URL(url).pathname.split('/').pop() || new URL(url).host
  try {
    return prepareSources([{ file, data: await fetchImportUrl(url), location: url }])
  } catch (err) {
    return prepareSources([], [{ file: url, message: (err as Error).message }])
  }
}

/**
 * Lê de novo a spec de onde um conector do projeto veio (o próprio conector ou o
 * ancestral mais próximo com `source`) e prepara a reimportação.
 */
export async function prepareSpecReimport(dir: string, connectorId: string): Promise<PreparedImport> {
  const { connectors } = await loadProject(dir)
  const root = specRoot(connectors, connectorId)
  if (!root) {
    return prepareSources([], [{ file: connectorId, message: 'o conector não veio de uma spec OpenAPI (nem o raiz dele)' }])
  }
  const location = root.source!.location
  try {
    return prepareSources([{ file: basename(location.replace(/[?#].*$/, '')) || location, data: await readSourceLocation(location, dir), location }])
  } catch (err) {
    return prepareSources([], [{ file: location, message: (err as Error).message }])
  }
}

/** O conector, ou o ancestral mais próximo, que guarda a spec de onde veio. */
export function specRoot(connectors: ReadonlyMap<string, Connector>, id: string): Connector | undefined {
  const seen = new Set<string>()
  for (let cur = connectors.get(id); cur && !seen.has(cur.id); cur = cur.extends ? connectors.get(cur.extends) : undefined) {
    if (cur.source) return cur
    seen.add(cur.id)
  }
  return undefined
}

/** O conteúdo é de um dos formatos de fora: Insomnia, Bruno (pasta, .bru ou JSON), HAR ou WSDL. */
export function isForeignImport(file: string, data: unknown): boolean {
  return (
    isInsomnia(data) ||
    isBrunoFolder(data) ||
    isBrunoJson(data) ||
    isBruFile(file, data) ||
    isHar(data) ||
    (isImportText(data) && isWsdlText(data.$text))
  )
}

/**
 * Insomnia, Bruno, HAR e WSDL viram coleções Postman v2.1 em memória, que vão junto com as do
 * Postman para o mesmo `convertPostman` (ids, variáveis e segredos compartilhados no lote).
 * `.bru` soltos do mesmo lote formam uma coleção só.
 */
function convertForeign(sources: ImportSource[]): { postman: PostmanSource[]; foreign: ForeignConversion[]; rest: ImportSource[] } {
  const postman: PostmanSource[] = []
  const foreign: ForeignConversion[] = []
  const rest: ImportSource[] = []
  const bru = sources.filter((s) => isBruFile(s.file, s.data))
  for (const s of sources) {
    const d = s.data
    let conv: ForeignConversion | undefined
    if (bru.includes(s)) continue
    if (isInsomnia(d)) conv = convertInsomnia(s.file, d)
    else if (isBrunoFolder(d) || isBrunoJson(d)) conv = convertBruno(s.file, d)
    else if (isHar(d)) conv = convertHar(s.file, d)
    else if (isImportText(d) && isWsdlText(d.$text)) conv = convertWsdl(s.file, d.$text)
    else if (isImportText(d)) {
      rest.push({ ...s, data: undefined })
      foreign.push({ format: 'wsdl', name: s.file, postman: [], warnings: [], errors: [{ file: s.file, message: 'XML que não é um WSDL 1.1, nem .bru do Bruno' }] })
      continue
    } else {
      rest.push(s)
      continue
    }
    foreign.push(conv)
    postman.push(...conv.postman)
  }
  if (bru.length) {
    const dir = bru[0]!.location ? basename(dirname(bru[0]!.location)) : 'Bruno'
    const conv = convertBruno(dir || 'Bruno', undefined, bru.map((s) => ({ file: s.file, text: (s.data as { $text: string }).$text })))
    // Os arquivos do lote aparecem na revisão como uma fonte só.
    conv.postman.forEach((p) => (p.file = bru.length === 1 ? bru[0]!.file : `${bru.length} arquivos .bru`))
    foreign.push(conv)
    postman.push(...conv.postman)
  }
  return { postman, foreign, rest: rest.filter((s) => s.data !== undefined) }
}

/** O mesmo que `prepareImport`, com o conteúdo já lido (MCP, CLI, testes). */
export function prepareSources(input: ImportSource[], readErrors: { file: string; message: string }[] = []): PreparedImport {
  const { postman: converted, foreign, rest: sources } = convertForeign(input)
  const postman = [...sources.filter((s) => !isBundle(s.data) && !isOpenApi(s.data)), ...converted]
  const result: ImportSourceResult = postman.length
    ? { ...convertPostman(postman), flows: [], docs: {} }
    : { sources: [], connectors: [], environments: [], flows: [], docs: {}, secrets: [], warnings: [], errors: [] }
  relabelForeign(result, foreign)
  for (const s of sources) {
    if (!isBundle(s.data) && !isOpenApi(s.data)) continue
    const b = isBundle(s.data) ? convertBundle(s.file, s.data) : convertOpenApi(s.file, s.data, s.location ?? s.file)
    result.sources.push(...b.sources)
    result.warnings.push(...b.warnings)
    result.errors.push(...b.errors)
    result.secrets.push(...b.secrets)
    Object.assign(result.docs!, b.docs)
    mergeSchemas(result, b)
    for (const c of b.connectors) {
      if (result.connectors.some((x) => x.id === c.id)) result.errors.push({ file: s.file, message: `conector "${c.id}" já veio de outro arquivo` })
      else result.connectors.push(c)
    }
    for (const e of b.environments) {
      if (result.environments.some((x) => x.id === e.id)) result.errors.push({ file: s.file, message: `ambiente "${e.id}" já veio de outro arquivo` })
      else result.environments.push(e)
    }
    for (const f of b.flows ?? []) {
      if (result.flows!.some((x) => x.id === f.id)) result.errors.push({ file: s.file, message: `fluxo "${f.id}" já veio de outro arquivo` })
      else result.flows!.push(f)
    }
  }
  return { id: randomUUID(), result, readErrors, invalid: validateImport(result) }
}

/**
 * Junta os schemas compartilhados de mais uma fonte: o mesmo nome com outro conteúdo (duas specs com
 * um "Pedido" cada) ganha sufixo na fonte que chega, e as citações dela acompanham.
 */
function mergeSchemas(result: ImportSourceResult, b: ImportSourceResult): void {
  if (!b.schemas) return
  const all = (result.schemas ??= {})
  const names = new Map<string, string>()
  for (const [name, schema] of Object.entries(b.schemas)) {
    if (!all[name] || isDeepStrictEqual(schemaBody(all[name]), schemaBody(schema))) continue
    let n = name
    for (let i = 2; all[n] || b.schemas[n]; i++) n = `${name}_${i}`
    names.set(name, n)
  }
  if (names.size) {
    for (const c of b.connectors) renameSchemaRefs(c.endpoints, names)
    for (const s of Object.values(b.schemas)) renameSchemaRefs(s, names)
  }
  for (const [name, schema] of Object.entries(b.schemas)) all[names.get(name) ?? name] ??= schema
}

/**
 * Na revisão, cada arquivo de Insomnia, Bruno, HAR ou WSDL aparece uma vez, com o formato,
 * em vez da coleção e dos ambientes do Postman montados a partir dele.
 */
function relabelForeign(result: ImportSourceResult, foreign: ForeignConversion[]): void {
  if (!foreign.length) return
  const byFile = new Map<string, ForeignConversion>()
  for (const f of foreign) for (const p of f.postman) byFile.set(p.file, f)
  const seen = new Set<string>()
  result.sources = result.sources.flatMap((s) => {
    const f = byFile.get(s.file)
    if (!f) return [s]
    if (seen.has(s.file)) return []
    seen.add(s.file)
    return [{ file: s.file, kind: f.format, name: f.name }]
  })
  for (const f of foreign) {
    result.warnings.unshift(...f.warnings)
    result.errors.push(...f.errors)
  }
}

/** Nome antigo, de quando só havia o Postman. */
export const preparePostmanImport = prepareImport

export async function loadProject(dir: string): Promise<ProjectSnapshot> {
  const [ws, flows] = await Promise.all([loadWorkspace(dir), loadFlows(dir)])
  const legacy = [...ws.connectorFiles].some(([id, file]) => file.endsWith(CONNECTOR_SUFFIX) && !ws.shared?.has(id))
  // Os conectores como estão nos arquivos: com os schemas compartilhados citados, não copiados.
  const connectors = new Map([...ws.connectors].map(([id, c]) => [id, ws.unresolved?.get(id) ?? c]))
  return { connectors, environments: ws.environments, flows: new Map(flows.flows.map((f) => [f.flow.id, f.flow])), legacy, ...(ws.schemas && { schemas: ws.schemas }) }
}

/**
 * O import grava no formato do workspace: num workspace sem conectores no formato antigo, cada
 * conector novo vira fluxos (docs/flows.md, Converter conectores em fluxos). Um conector que o
 * fluxo ainda não representa (com endpoint de plugin, por exemplo) fica no formato antigo.
 */
export function inWorkspaceFormat(ops: ProjectOp[], project: ProjectSnapshot): ProjectOp[] {
  if (project.legacy) return ops
  const fits = (c: Connector) =>
    !connectorToFlows(c).unsupported.length && !ops.some((op) => op.op === 'upsertEndpoint' && op.connectorId === c.id && op.endpoint.plugin)
  const migrate = ops.flatMap((op): ProjectOp[] =>
    op.op === 'upsertConnector' && !project.connectors.has(op.connector.id) && fits(op.connector) ? [{ op: 'migrateConnector', id: op.connector.id }] : []
  )
  return [...ops, ...migrate]
}

/**
 * Aplica os ajustes da revisão sobre a conversão, reconcilia com o projeto de destino
 * e simula a gravação pela camada de escrita do projeto (dry run), que confere schema,
 * herança e credenciais. Sem destino, a prévia não lista arquivos.
 */
export async function previewImport(
  prepared: PreparedImport,
  target: ImportTarget | null,
  input: ImportPlanInput = {}
): Promise<PostmanImportPreview> {
  const project = target ? await loadProject(target.dir) : EMPTY_PROJECT
  const documents = forTarget(prepared.result, target?.dir)
  const plan = planImport(documents, project, input)
  const errors = [...prepared.readErrors, ...prepared.result.errors, ...prepared.invalid]
  let changes: PostmanImportPreview['changes'] = []
  if (target && plan.ops.length && prepared.invalid.length === 0) {
    const ops = inWorkspaceFormat(plan.ops, project)
    const dry = await applyProjectOps(target.dir, ops, { dryRun: true, actor: 'app' })
    changes = dry.changes.map(({ path, action }) => ({ path, action }))
    errors.push(...dry.errors.map((e) => ({ file: describeOp(ops[e.op]), message: e.message })))
  }
  return {
    id: prepared.id,
    sources: prepared.result.sources,
    target,
    connectors: plan.connectors,
    environments: plan.environments,
    flows: plan.flows,
    docs: plan.docs,
    projectConnectors: [...project.connectors.values()]
      .map((c) => ({
        id: c.id,
        name: c.name,
        endpoints: (c.endpoints ?? []).map(({ id, name, method, path }) => ({ id, name, method, path }))
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    suggestions: plan.suggestions,
    notes: plan.notes,
    adjustmentErrors: plan.errors,
    secretValues: plan.environments.reduce((n, e) => n + e.secretValues, 0),
    warnings: [...prepared.result.warnings, ...sourceWarnings(documents, target?.dir)],
    errors,
    changes,
    canWrite: !!target && errors.length === 0 && changes.length > 0
  }
}

/** Grava o import no destino: tudo ou nada, pela camada de escrita do projeto. */
export async function writeImport(
  prepared: PreparedImport,
  target: ImportTarget,
  input: ImportPlanInput = {}
): Promise<{ written: string[] }> {
  if (prepared.invalid.length) throw new Error('a conversão gerou arquivos inválidos; nada foi gravado')
  const project = await loadProject(target.dir)
  const ops = inWorkspaceFormat(planImport(forTarget(prepared.result, target.dir), project, input).ops, project)
  const applied = await applyProjectOps(target.dir, ops, { actor: 'app' })
  if (!applied.ok) {
    const first = applied.errors[0]
    throw new Error(first ? `${describeOp(ops[first.op])}: ${first.message}` : 'a gravação falhou')
  }
  return { written: applied.changes.map((c) => c.path) }
}

/** O caminho da spec de cada conector importado, relativo ao projeto de destino quando ela está dentro dele. */
export function forTarget(result: ImportSourceResult, dir: string | undefined): ImportSourceResult {
  if (!result.connectors.some((c) => c.source)) return result
  // A marca dos schemas compartilhados guarda a mesma origem que o conector da spec.
  const mark = (s: Record<string, unknown>) => {
    const m = s['x-vvpost'] as { source?: unknown } | undefined
    return typeof m?.source === 'string' ? { ...s, 'x-vvpost': { ...m, source: storedLocation(m.source, dir) } } : s
  }
  return {
    ...result,
    connectors: result.connectors.map((c) =>
      c.source ? { ...c, source: { ...c.source, location: storedLocation(c.source.location, dir) } } : c
    ),
    ...(result.schemas && { schemas: Object.fromEntries(Object.entries(result.schemas).map(([n, s]) => [n, mark(s)])) })
  }
}

function sourceWarnings(result: ImportSourceResult, dir: string | undefined): { source: string; message: string }[] {
  if (!dir) return []
  return result.connectors
    .filter((c) => c.source && !isUrl(c.source.location) && isAbsolute(c.source.location))
    .map((c) => ({
      source: c.name,
      message: 'a spec está fora da pasta do projeto: o conector guarda o caminho absoluto, que só vale nesta máquina. Para o time reimportar, ponha a spec no projeto ou importe pela URL.'
    }))
}

export function describeOp(op: ProjectOp | undefined): string {
  switch (op?.op) {
    case 'upsertConnector':
      return op.connector.id
    case 'migrateConnector':
      return `${op.id} (fluxos)`
    case 'upsertEndpoint':
      return `${op.connectorId} › ${op.endpoint.id}`
    case 'upsertScenario':
      return `${op.connectorId} › ${op.endpointId} › ${op.scenario.id}`
    case 'upsertEnvironment':
      return op.environment.id
    case 'storeSecret':
      return `${op.environmentId} (segredo ${op.variable})`
    case 'upsertFlow':
      return op.flow.id
    case 'writeDoc':
      return `${op.connectorId} (documentação)`
    case 'upsertSchema':
      return `schema ${op.name}`
    default:
      return 'import'
  }
}
