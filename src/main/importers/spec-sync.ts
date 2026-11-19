import { cp, mkdtemp, readdir, rm, stat, unlink, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import type { Connector, Flow } from '@vvpost/schemas'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { projectLayout } from '@vvpost/core/projects'
import { applyProjectOps, type ApplyOptions, type ProjectOp } from '../project'
import { workspaceProblems, type WorkspaceProblem } from '../workspace/problems'
import { describeOp, forTarget, inWorkspaceFormat, loadProject, prepareSources, specRoot } from './index'
import { isOpenApi } from './openapi'
import { planImport, type ImportPlan, type ProjectSnapshot } from './plan'
import { readSourceLocation, storedLocation } from './source'

/**
 * A spec do código como fonte do contrato (docs/openapi-sync.md): cada conector vinculado a uma
 * spec OpenAPI (`source.location`, por import ou por `link`) é relido de lá e sincronizado pelo
 * mesmo plano da reimportação (plan.ts, syncSpecs). A spec manda nos campos de contrato do
 * endpoint (SPEC_FIELDS) e nos schemas que vieram dela; o resto (cenários, exemplos, scripts,
 * config do conector, ambientes, fluxos e documentação) é do VVPost e não é tocado. Um endpoint
 * que saiu da spec fica até `prune`. Rodar de novo sem mudança na spec não grava nada.
 *
 * O relatório diz o que difere (o drift) e o que o sync quebra: o workspace é validado antes e
 * depois, numa cópia temporária com as mudanças aplicadas, e o que aparece só depois é quebra.
 */

export type SpecSyncStatus = 'new' | 'updated' | 'conflict' | 'edited' | 'linked' | 'removed'

export interface SpecSyncEndpoint {
  /** "<conector>/<endpoint>" no projeto (num novo, o id que ele vai ter). */
  key: string
  method: string
  path: string
  /**
   * new: está na spec e não no projeto. updated: mudou na spec. conflict: mudou na spec e foi
   * editado no projeto. edited: editado no projeto sem mudança na spec. linked: feito à mão, passa
   * a seguir a operação com o mesmo método e caminho. removed: saiu da spec.
   */
  status: SpecSyncStatus
  /** O sync aplica (ou aplicou) a spec neste endpoint; num removido, apaga. */
  applied: boolean
  /** Campos de contrato que diferem (projeto → spec). */
  fields?: string[]
  /** Removido: cenários, fluxos e documentos que dependem dele. */
  dependents?: string[]
}

export interface SpecSyncResult {
  /** O conector vinculado (o raiz da spec no projeto). */
  connector: string
  location: string
  /** info.version da spec lida. */
  version?: string
  endpoints: SpecSyncEndpoint[]
  schemas: ImportPlan['schemas']
  /** Endpoints da família que não vieram da spec nem batem com uma operação dela (só informação). */
  onlyInProject: string[]
  /** O que a validação acusa depois do sync e não acusava antes (corpo de cenário fora do schema novo, diretiva sem alvo...). */
  breaks: WorkspaceProblem[]
  /** O projeto difere da spec (endpoint novo, alterado, editado, removido ou schema). */
  drift: boolean
  /** Há quebra: `breaks`, ou um endpoint removido de que algo depende. */
  breaking: boolean
  changes: { path: string; action: 'create' | 'update' | 'delete' }[]
  errors: { file: string; message: string }[]
}

export interface SpecSyncOptions {
  /** Só as specs destes conectores (o conector ou o ancestral vinculado). Sem isso, todas. */
  connectors?: readonly string[]
  /** Vincula o conector a esta spec (URL ou caminho) antes de sincronizar. */
  link?: { connector: string; location: string }
  /** Apaga os endpoints que saíram da spec. */
  prune?: boolean
  /** Conflito e edição local ficam com a versão do projeto (o padrão é a spec ganhar). */
  keepEdits?: boolean
  /** Grava; sem isso, só calcula o relatório. */
  apply?: boolean
  actor?: ApplyOptions['actor']
  checkText?: ApplyOptions['checkText']
  /** Pula a validação antes e depois (o relatório sai sem `breaks`). */
  skipBreaks?: boolean
}

export interface SpecSyncReport {
  ok: boolean
  dryRun: boolean
  results: SpecSyncResult[]
  /** Erro que impede o sync inteiro (nenhuma spec vinculada, link inválido). */
  errors: { file: string; message: string }[]
}

export class SpecSyncError extends Error {}

/** Sincroniza (ou só confere, sem `apply`) os conectores vinculados a specs OpenAPI. */
export async function syncSpecSources(dir: string, options: SpecSyncOptions = {}): Promise<SpecSyncReport> {
  const report: SpecSyncReport = { ok: false, dryRun: !options.apply, results: [], errors: [] }
  let roots: { id: string; location: string }[]
  let link: Connector['source'] | undefined
  try {
    if (options.link) {
      link = await linkSource(dir, options.link.connector, options.link.location)
      roots = [{ id: options.link.connector, location: link!.location }]
    } else roots = await linkedRoots(dir, options.connectors)
  } catch (err) {
    if (!(err instanceof SpecSyncError)) throw err
    report.errors.push({ file: options.link?.connector ?? 'sync', message: err.message })
    return report
  }
  if (!roots.length) {
    report.errors.push({
      file: 'sync',
      message: 'nenhum conector vinculado a uma spec OpenAPI: importe a spec (vvpost import) ou vincule um conector (vvpost sync --link <spec> --connector <id>)'
    })
    return report
  }
  for (const root of roots) {
    report.results.push(await syncRoot(dir, root, options, root.id === options.link?.connector ? link : undefined))
  }
  report.ok = report.results.every((r) => !r.errors.length)
  return report
}

/** Os raízes de spec do projeto (conector com `source` sem ancestral com `source`), fora os só de leitura. */
async function linkedRoots(dir: string, only?: readonly string[]): Promise<{ id: string; location: string }[]> {
  const ws = await loadWorkspace(dir)
  const own = new Map([...ws.connectors].filter(([id]) => !ws.shared?.has(id)))
  const roots = new Map<string, string>()
  if (only?.length) {
    for (const id of only) {
      if (!ws.connectors.has(id)) throw new SpecSyncError(`conector "${id}" não existe no projeto`)
      const root = specRoot(ws.connectors, id)
      if (!root) throw new SpecSyncError(`o conector "${id}" não está vinculado a uma spec OpenAPI (nem o raiz dele): use --link`)
      if (ws.shared?.has(root.id)) throw new SpecSyncError(`"${root.id}" vem do Compartilhado ou do catálogo: sincronize onde ele é editado`)
      roots.set(root.id, root.source!.location)
    }
  } else {
    for (const c of own.values()) if (c.source && specRoot(ws.connectors, c.id) === c) roots.set(c.id, c.source.location)
  }
  return [...roots].map(([id, location]) => ({ id, location })).sort((a, b) => a.id.localeCompare(b.id))
}

/** Confere o pedido de vínculo e devolve o `source` que o conector vai ter. Não grava. */
async function linkSource(dir: string, connectorId: string, location: string): Promise<Connector['source']> {
  const ws = await loadWorkspace(dir)
  const connector = ws.connectors.get(connectorId)
  if (!connector) throw new SpecSyncError(`conector "${connectorId}" não existe no projeto`)
  if (ws.shared?.has(connectorId)) throw new SpecSyncError(`"${connectorId}" vem do Compartilhado ou do catálogo: vincule onde ele é editado`)
  const stored = storedLocation(location, dir)
  const current = specRoot(ws.connectors, connectorId)
  if (current && current.source!.location !== stored) {
    throw new SpecSyncError(`"${connectorId}" já segue a spec ${current.source!.location}${current.id === connectorId ? '' : ` (pelo conector ${current.id})`}`)
  }
  let data: unknown
  try {
    data = await readSourceLocation(stored, dir)
  } catch (err) {
    throw new SpecSyncError(`${location}: ${(err as Error).message}`)
  }
  if (!isOpenApi(data)) throw new SpecSyncError(`${location}: não é uma spec OpenAPI 3.x nem Swagger 2.0`)
  const version = (data as { info?: { version?: unknown } }).info?.version
  return { type: 'openapi', location: stored, ...(typeof version === 'string' && { version }) }
}

async function syncRoot(
  dir: string,
  root: { id: string; location: string },
  options: SpecSyncOptions,
  link: Connector['source'] | undefined
): Promise<SpecSyncResult> {
  const result: SpecSyncResult = {
    connector: root.id,
    location: root.location,
    endpoints: [],
    schemas: [],
    onlyInProject: [],
    breaks: [],
    drift: false,
    breaking: false,
    changes: [],
    errors: []
  }
  let data: unknown
  try {
    data = await readSourceLocation(root.location, dir)
  } catch (err) {
    result.errors.push({ file: root.location, message: `não foi possível ler a spec: ${(err as Error).message}` })
    return result
  }
  if (!isOpenApi(data)) {
    result.errors.push({ file: root.location, message: 'não é uma spec OpenAPI 3.x nem Swagger 2.0' })
    return result
  }
  const version = (data as { info?: { version?: unknown } }).info?.version
  if (typeof version === 'string') result.version = version
  const file = basename(root.location.replace(/[?#].*$/, '')) || root.location
  const prepared = prepareSources([{ file, data, location: root.location }])
  const conversion = [...prepared.result.errors, ...prepared.invalid]
  if (conversion.length) {
    result.errors.push(...conversion)
    return result
  }

  const project = await loadProject(dir)
  if (link) linkInMemory(project, root.id, link)
  const documents = forTarget(prepared.result, dir)
  const first = planImport(documents, project, { specWins: !options.keepEdits })
  // Na sincronização, todo id importado que já existe mescla; removidos só saem com prune.
  const syncDecisions = Object.fromEntries(
    first.connectors
      .flatMap((c) => c.endpoints)
      .filter((e) => e.sync && e.status === 'removed' && options.prune)
      .map((e) => [e.sync!.key, 'spec' as const])
  )
  const plan = planImport(documents, project, { specWins: !options.keepEdits, syncDecisions })
  result.schemas = plan.schemas
  // Só a versão da spec mudou: não regrava o conector a cada build que troca o info.version.
  const meaningful = plan.ops.filter((op) => !(op.op === 'patchConnector' && op.id === root.id && Object.keys(op.set).join() === 'source'))
  let ops: ProjectOp[] = meaningful.length ? plan.ops : []
  if (link) ops = [{ op: 'patchConnector', id: root.id, set: { source: link } }, ...ops.filter((op) => !(op.op === 'patchConnector' && op.id === root.id))]
  ops = inWorkspaceFormat(ops, project)

  describeEndpoints(result, plan, project, root.id, await docsMentions(dir))
  result.drift =
    result.endpoints.some((e) => e.status !== 'linked' || (e.fields?.length ?? 0) > 0) || result.schemas.length > 0

  if (ops.length) {
    const dry = await applyProjectOps(dir, ops, { dryRun: true, actor: options.actor ?? 'app', ...(options.checkText && { checkText: options.checkText }) })
    if (!dry.ok) {
      for (const e of dry.errors) result.errors.push({ file: describeOp(ops[e.op]), message: e.message })
      for (const c of dry.conflicts ?? []) result.errors.push({ file: c.path, message: 'o arquivo mudou durante o sync; rode de novo' })
      return result
    }
    result.changes = dry.changes.map(({ path, action }) => ({ path, action }))
    if (!options.skipBreaks) {
      try {
        result.breaks = await breaksOf(dir, dry.changes)
      } catch (err) {
        result.errors.push({ file: root.location, message: `não foi possível conferir o que o sync quebra: ${(err as Error).message}` })
      }
    }
    if (options.apply && !result.errors.length) {
      const applied = await applyProjectOps(dir, ops, { actor: options.actor ?? 'app', ...(options.checkText && { checkText: options.checkText }) })
      if (!applied.ok) {
        for (const e of applied.errors) result.errors.push({ file: describeOp(ops[e.op]), message: e.message })
        for (const c of applied.conflicts ?? []) result.errors.push({ file: c.path, message: 'o arquivo mudou durante o sync; rode de novo' })
      }
    }
  }
  result.breaks.push(...nowPrivate(plan))
  result.breaking = result.breaks.length > 0 || result.endpoints.some((e) => e.status === 'removed' && (e.dependents?.length ?? 0) > 0)
  return result
}

/** Endpoint público (requiresAuth: false) que a spec passou a proteger: quem chamava sem credencial passa a levar 401/403. */
function nowPrivate(plan: ImportPlan): WorkspaceProblem[] {
  const out: WorkspaceProblem[] = []
  for (const c of plan.connectors) {
    for (const e of c.endpoints) {
      const change = e.sync?.changes.find((ch) => ch.field === 'requiresAuth')
      if (!change || e.sync!.decision !== 'spec' || change.before !== 'false' || change.after !== 'true') continue
      out.push({ file: `${c.id}/${e.id}`, message: `${e.method} ${e.path} era público e passou a exigir autenticação: quem chama sem credencial passa a receber 401/403` })
    }
  }
  return out
}

/** O projeto como se o conector já tivesse o `source`, para planejar o vínculo e o sync num lote só. */
function linkInMemory(project: ProjectSnapshot, id: string, source: Connector['source']): void {
  const c = project.connectors.get(id)
  if (c) project.connectors.set(id, { ...c, source: source! })
}

function describeEndpoints(result: SpecSyncResult, plan: ImportPlan, project: ProjectSnapshot, rootId: string, docs: Map<string, Set<string>>): void {
  const flows = [...(project.flows?.values() ?? [])]
  for (const c of plan.connectors) {
    for (const e of c.endpoints) {
      const key = `${c.id}/${e.id}`
      if (e.status === 'existing') continue
      if (e.status === 'new') {
        result.endpoints.push({ key, method: e.method, path: e.path, status: 'new', applied: true })
        continue
      }
      const sync = e.sync!
      result.endpoints.push({
        key,
        method: e.method,
        path: e.path,
        status: e.status,
        applied: sync.decision === 'spec',
        ...(sync.changes.length && { fields: sync.changes.map((ch) => ch.field) }),
        ...(e.status === 'removed' && { dependents: [] })
      })
    }
  }
  for (const e of result.endpoints) {
    if (e.status === 'removed') e.dependents = [...dependentsOf(e.key, project, flows), ...[...(docs.get(e.key) ?? [])].map((f) => `documento ${f}`)]
  }
  // Endpoints feitos no projeto que a spec não tem: o sync não mexe neles.
  const linked = new Set(result.endpoints.map((e) => e.key))
  for (const c of project.connectors.values()) {
    if (specRoot(project.connectors, c.id)?.id !== rootId) continue
    for (const e of c.endpoints ?? []) {
      const key = `${c.id}/${e.id}`
      if (!e.source && !e.plugin && !linked.has(key)) result.onlyInProject.push(key)
    }
  }
}

/** O que depende de um endpoint: os cenários dele e os nós de fluxo que o chamam (fora o fluxo do próprio endpoint). */
function dependentsOf(key: string, project: ProjectSnapshot, flows: Flow[]): string[] {
  const [connectorId, endpointId] = splitKey(key)
  const endpoint = project.connectors.get(connectorId)?.endpoints?.find((e) => e.id === endpointId)
  const out = (endpoint?.scenarios ?? []).map((s) => `cenário ${s.id}`)
  for (const flow of flows) {
    for (const node of flow.nodes) {
      if (node.type !== 'request' || node.request.connector !== connectorId || node.request.endpoint !== endpointId) continue
      out.push(`fluxo ${flow.id}`)
      break
    }
  }
  return out
}

const splitKey = (key: string): [string, string] => {
  const at = key.lastIndexOf('/')
  return [key.slice(0, at), key.slice(at + 1)]
}

// ---------------------------------------------------------------------------
// O que o sync quebra

const COPY_SKIP = new Set(['.git', 'node_modules', '.vvpost'])
const MAX_COPY_BYTES = 200 * 1024 * 1024

/**
 * Valida o workspace como está e como fica com as mudanças (numa cópia temporária da pasta do
 * workspace, com o Compartilhado), e devolve o que só aparece depois.
 */
async function breaksOf(dir: string, changes: { path: string; after?: string }[]): Promise<WorkspaceProblem[]> {
  const root = projectLayout(dir).root
  const temp = await mkdtemp(join(tmpdir(), 'vvpost-sync-'))
  try {
    await copyWorkspace(root, temp)
    const copy = join(temp, relative(root, dir))
    for (const c of changes) {
      const path = join(copy, c.path)
      if (c.after === undefined) await unlink(path).catch(() => {})
      else {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, c.after)
      }
    }
    const [before, after] = await Promise.all([problemsAt(dir), problemsAt(copy)])
    const seen = new Set(before.map(problemKey))
    return after.map((p) => ({ ...p, message: p.message.split(copy).join(dir) })).filter((p) => !seen.has(problemKey(p)))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

const problemKey = (p: WorkspaceProblem) => `${p.file}\u0000${p.message}`

async function problemsAt(dir: string): Promise<WorkspaceProblem[]> {
  // Sem o catálogo da organização: os dois lados ficam iguais nele, e a cópia não busca nada na rede.
  const ws = await loadWorkspace(dir, { shared: [] })
  const flows = await loadFlows(dir)
  const { problems, warnings } = await workspaceProblems(ws, flows, true)
  return [...problems, ...warnings]
}

async function copyWorkspace(from: string, to: string): Promise<void> {
  let total = 0
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(from, rel), { withFileTypes: true })) {
      if (COPY_SKIP.has(entry.name)) continue
      const path = rel ? join(rel, entry.name) : entry.name
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      total += (await stat(join(from, path))).size
      if (total > MAX_COPY_BYTES) throw new Error('a pasta do workspace passa de 200 MB')
      await mkdir(dirname(join(to, path)), { recursive: true })
      await cp(join(from, path), join(to, path))
    }
  }
  await walk('')
}

const MENTION = /\{\{>\s*(?:endpoint|request)\s+([^\s}]+)\s*\}\}/g
const MAX_DOC_FILES = 2000

/**
 * Os endpoints que cada Markdown do projeto cita por {{> endpoint c/e}} ou {{> request c/e/cenário}}:
 * "<conector>/<endpoint>" → arquivos.
 */
async function docsMentions(dir: string): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  let count = 0
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (COPY_SKIP.has(entry.name) || count > MAX_DOC_FILES) continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        count++
        const text = await readFile(join(dir, path), 'utf8').catch(() => '')
        for (const m of text.matchAll(MENTION)) {
          const [c, e] = m[1]!.split('/')
          if (!c || !e) continue
          const key = `${c}/${e}`
          if (!out.has(key)) out.set(key, new Set())
          out.get(key)!.add(path)
        }
      }
    }
  }
  await walk('')
  return out
}
