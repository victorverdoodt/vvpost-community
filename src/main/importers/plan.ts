import type { Assertion, Connector, Endpoint, Environment, Flow, Scenario } from '@vvpost/schemas'
import type {
  ImportAdjustment,
  ImportConflictMode,
  ImportFieldChange,
  ImportPlanConnector,
  ImportPlanEnvironment,
  ImportPlanFlow,
  ImportPlanInput,
  ImportScenarioSuggestion,
  ImportSyncDecision
} from '@shared/ipc'
import type { ProjectOp } from '../project'
import { deepEqual } from '@vvpost/core/scenarios/assert'
import { renameSchemaRefs, schemaBody, schemaRefs } from '@vvpost/core/connectors/shared-schemas'
import { endpointHash, schemaHash, SPEC_FIELDS } from './openapi'
import { keepSensitiveMarks, specAddsSensitiveMarks } from './spec-hash'
import { slug, UniqueIds, type ImportedSecret } from './postman'

/**
 * Revisão do import antes de gravar (módulo puro, sem disco nem Electron).
 *
 * O usuário ajusta a hierarquia convertida com uma lista de `ImportAdjustment`
 * (renomear, mover, agrupar, desfazer pasta, excluir, mesclar uma requisição como
 * cenário de outro endpoint), que é reaplicada do zero a cada mudança. Depois o
 * resultado é reconciliado com o projeto de destino: conectores e ambientes com id
 * já usado são mesclados (padrão), renomeados ou substituídos, e tudo vira uma lista
 * de operações da camada de escrita do projeto (src/main/project), a mesma que o MCP
 * usa, em vez de arquivos inteiros.
 */

/** O que o planejamento precisa do projeto de destino. `LoadedWorkspace` serve. */
export interface ProjectSnapshot {
  connectors: Map<string, Connector>
  environments: Map<string, Environment>
  flows?: Map<string, Flow>
  /** O workspace tem conectores no formato antigo: o import grava conectores, não fluxos. */
  legacy?: boolean
  /** Os schemas compartilhados que o projeto já tem (e os do Compartilhado, com `shared`). */
  schemas?: ReadonlyMap<string, { schema: Record<string, unknown>; shared?: string }>
}

export const EMPTY_PROJECT: ProjectSnapshot = { connectors: new Map(), environments: new Map() }

/**
 * O que um import traz, venha do Postman ou de um pacote do VVPost: documentos já
 * no formato do projeto e os valores de segredo, que só vão para o vault.
 */
export interface ImportDocuments {
  connectors: Connector[]
  environments: Environment[]
  secrets: ImportedSecret[]
  flows?: Flow[]
  /** Markdown por id de conector importado. */
  docs?: Record<string, string>
  /**
   * Schemas compartilhados que os endpoints citam ("schema:<Nome>"), pelo nome. Os do OpenAPI levam
   * "x-vvpost": {source, hash}, para a reimportação atualizar só o que não foi editado no projeto.
   */
  schemas?: Record<string, Record<string, unknown>>
}

/** Operações da camada de escrita do projeto que o import gera (subconjunto de `ProjectOp`). */
export type ImportOp = Extract<
  ProjectOp,
  {
    op:
      | 'upsertConnector'
      | 'patchConnector'
      | 'upsertEndpoint'
      | 'deleteEndpoint'
      | 'upsertScenario'
      | 'upsertEnvironment'
      | 'storeSecret'
      | 'upsertFlow'
      | 'writeDoc'
      | 'upsertSchema'
  }
>

export interface ImportPlan {
  /** Conectores na ordem pai antes de filho: importados e os do projeto que recebem algo. */
  connectors: ImportPlanConnector[]
  environments: ImportPlanEnvironment[]
  flows: ImportPlanFlow[]
  /** Quantos conectores levam documentação Markdown. */
  docs: number
  ops: ImportOp[]
  suggestions: ImportScenarioSuggestion[]
  /** Observações sobre os ajustes (ex.: cenário sem teste de status no Postman). */
  notes: { source: string; message: string }[]
  /** Ajustes que não puderam ser aplicados, pela posição na lista. */
  errors: { adjustment: number; message: string }[]
  /**
   * Schemas compartilhados que o import cria ou que a reimportação de uma spec muda: `new`, `updated`
   * (mudou só na spec) ou `conflict` (editado no projeto; `applied` diz se a versão da spec entra).
   */
  schemas: { name: string; status: 'new' | 'updated' | 'conflict'; applied: boolean }[]
}

const DEFAULT_ASSERTION: Assertion = { target: 'status', operator: 'lessThan', expected: 500 }

const clone = <T>(v: T): T => structuredClone(v)

class AdjustError extends Error {}

/** Estado de trabalho: os conectores importados e o que vai para conectores do projeto. */
interface Draft {
  connectors: Connector[]
  excludedEnvironments: Set<string>
  excludedFlows: Set<string>
  /** Por id de conector do projeto: endpoints novos e cenários novos em endpoints existentes. */
  additions: Map<string, { endpoints: Endpoint[]; scenarios: { endpointId: string; scenario: Scenario }[] }>
  notes: { source: string; message: string }[]
}

export function planImport(
  result: ImportDocuments,
  project: ProjectSnapshot = EMPTY_PROJECT,
  input: ImportPlanInput = {}
): ImportPlan {
  const draft: Draft = {
    connectors: alignSpecRoots(clone(result.connectors), project),
    excludedEnvironments: new Set(),
    excludedFlows: new Set(),
    additions: new Map(),
    notes: []
  }
  const errors: ImportPlan['errors'] = []
  ;(input.adjustments ?? []).forEach((adj, i) => {
    try {
      applyAdjustment(draft, project, adj)
    } catch (err) {
      // Ajuste malformado (vindo do renderer) não derruba a revisão: vira erro dele.
      errors.push({ adjustment: i, message: err instanceof AdjustError ? err.message : 'ajuste inválido' })
    }
  })
  draft.connectors = preorder(draft.connectors)
  const flowsIn = clone(result.flows ?? [])
  const schemas = reconcileSchemas(result.schemas ?? {}, draft, flowsIn, project, input.specWins === true)

  const sync = syncSpecs(draft, project, input.conflicts ?? {}, input.syncDecisions ?? {}, input.specWins === true)
  const suggestions = suggestScenarioMerges(draft.connectors)
  const { connectors, ops, finalId, created } = reconcileConnectors(draft, project, input.conflicts ?? {}, sync)
  const envs = reconcileEnvironments(result, draft, project, input.environmentConflicts ?? {})
  const flows = reconcileFlows(flowsIn, draft, project, finalId, input.flowConflicts ?? {})
  // Documentação só de conector que o import cria ou substitui; um mesclado mantém a do projeto.
  const docs = Object.entries(result.docs ?? {}).flatMap(([id, markdown]): ImportOp[] =>
    created.has(id) && markdown.trim() ? [{ op: 'writeDoc', connectorId: finalId.get(id)!, markdown }] : []
  )
  return {
    connectors,
    environments: envs.environments,
    flows: flows.flows,
    docs: docs.length,
    ops: [...schemas.ops, ...ops, ...envs.ops, ...flows.ops, ...docs],
    suggestions,
    notes: draft.notes,
    errors,
    schemas: schemas.report
  }
}

// ---------------------------------------------------------------------------
// Schemas compartilhados

/**
 * Os schemas compartilhados que o que fica no import cita (direto ou por outro schema). Um nome que o
 * projeto não tem é criado; o mesmo conteúdo é reaproveitado; o que veio da mesma spec é atualizado
 * se ninguém o editou no projeto (o hash da marca x-vvpost ainda bate), e um editado fica como está
 * (com `specWins`, a spec ganha também nele). Um nome já usado no projeto por outro conteúdo ganha
 * sufixo, e as citações do import acompanham.
 */
function reconcileSchemas(
  schemas: Record<string, Record<string, unknown>>,
  draft: Draft,
  flows: Flow[],
  project: ProjectSnapshot,
  specWins: boolean
): { ops: ImportOp[]; report: ImportPlan['schemas'] } {
  const used = schemaRefs([draft.connectors.map((c) => c.endpoints), ...draft.additions.values(), flows])
  // Fecho transitivo: o schema citado por um schema citado também vai (endpoint → A → B → C).
  for (const pending = [...used]; pending.length; ) {
    for (const n of schemaRefs(schemas[pending.pop()!])) if (!used.has(n)) (used.add(n), pending.push(n))
  }
  const names = new Map<string, string>()
  const write = new Map<string, Record<string, unknown>>()
  const edited: string[] = []
  const renamed: string[] = []
  const report: ImportPlan['schemas'] = []
  for (const name of [...used].sort()) {
    const incoming = schemas[name]
    if (!incoming) continue
    const current = project.schemas?.get(name)
    if (!current) {
      write.set(name, clone(incoming))
      report.push({ name, status: 'new', applied: true })
      continue
    }
    // A versão da spec com as marcas de dado pessoal que o projeto acrescentou: elas ficam.
    const next = keepSensitiveMarks(clone(incoming), current.schema)
    if (deepEqual(schemaBody(current.schema), schemaBody(next))) continue
    const mark = current.schema['x-vvpost'] as { source?: unknown; hash?: unknown } | undefined
    const from = (incoming['x-vvpost'] as { source?: unknown } | undefined)?.source
    if (!current.shared && mark && from !== undefined && mark.source === from) {
      const untouched = mark.hash === schemaHash(current.schema)
      if (untouched || specWins) write.set(name, next)
      else edited.push(name)
      report.push({ name, status: untouched ? 'updated' : 'conflict', applied: untouched || specWins })
      continue
    }
    let n = name
    for (let i = 2; project.schemas?.has(n) || (n !== name && schemas[n]); i++) n = `${name}_${i}`
    names.set(name, n)
    write.set(n, clone(incoming))
    renamed.push(`${name} → ${n}`)
    report.push({ name: n, status: 'new', applied: true })
  }
  if (names.size) {
    for (const c of draft.connectors) renameSchemaRefs(c.endpoints, names)
    for (const a of draft.additions.values()) renameSchemaRefs(a, names)
    renameSchemaRefs(flows, names)
    for (const s of write.values()) renameSchemaRefs(s, names)
  }
  if (edited.length) {
    draft.notes.push({ source: 'Schemas', message: `${edited.join(', ')} foi editado no projeto e ficou como está; a versão da spec não foi aplicada.` })
  }
  if (renamed.length) {
    draft.notes.push({ source: 'Schemas', message: `nomes já usados no projeto por outro schema: ${renamed.join(', ')}.` })
  }
  return { ops: [...write].map(([name, schema]): ImportOp => ({ op: 'upsertSchema', name, schema })), report }
}

// ---------------------------------------------------------------------------
// Ajustes

function applyAdjustment(draft: Draft, project: ProjectSnapshot, adj: ImportAdjustment): void {
  switch (adj.op) {
    case 'renameConnector': {
      const name = adj.name.trim()
      if (!name) throw new AdjustError('o nome não pode ficar vazio')
      imported(draft, adj.id).name = name
      return
    }
    case 'setParent': {
      const c = imported(draft, adj.id)
      if (!adj.parent) {
        delete c.extends
        return
      }
      if (adj.parent.existing) {
        if (!project.connectors.has(adj.parent.id)) throw new AdjustError(`conector "${adj.parent.id}" não está no projeto`)
      } else {
        imported(draft, adj.parent.id)
        if (adj.parent.id === c.id || descendants(draft, c.id).has(adj.parent.id)) {
          throw new AdjustError(`"${c.name}" não pode herdar de si mesmo nem de um filho`)
        }
      }
      c.extends = adj.parent.id
      return
    }
    case 'dissolveConnector': {
      const c = imported(draft, adj.id)
      if (!c.extends) throw new AdjustError(`"${c.name}" não tem pai para receber os endpoints`)
      const parentId = c.extends
      const parentRef = { id: parentId, existing: !isImported(draft, parentId) }
      const before = baseUrlOf(draft, project, { id: c.id })
      const after = baseUrlOf(draft, project, parentRef)
      if (before !== after && c.endpoints?.length) {
        draft.notes.push({
          source: c.name,
          message: `os endpoints passam a usar a URL base ${after ?? '(nenhuma)'} em vez de ${before ?? '(nenhuma)'}.`
        })
      }
      for (const e of c.endpoints ?? []) addEndpoint(draft, project, parentRef, e)
      for (const child of draft.connectors) if (child.extends === c.id) child.extends = parentId
      draft.connectors = draft.connectors.filter((x) => x !== c)
      return
    }
    case 'excludeConnector': {
      const c = imported(draft, adj.id)
      const gone = descendants(draft, c.id).add(c.id)
      draft.connectors = draft.connectors.filter((x) => !gone.has(x.id))
      return
    }
    case 'groupEndpoints': {
      const c = imported(draft, adj.id)
      const name = adj.name.trim()
      if (!name) throw new AdjustError('o grupo precisa de um nome')
      if (adj.endpointIds.length === 0) throw new AdjustError('escolha ao menos um endpoint para agrupar')
      const moving = adj.endpointIds.map((id) => endpointOf(c, id))
      const ids = new UniqueIds([...draft.connectors.map((x) => x.id), ...project.connectors.keys()])
      const group: Connector = {
        $schema: c.$schema,
        id: ids.take(`${c.id}.${slug(name) || 'grupo'}`, '-'),
        name,
        version: c.version,
        extends: c.id,
        endpoints: moving
      }
      setEndpoints(c, (c.endpoints ?? []).filter((e) => !moving.includes(e)))
      draft.connectors.splice(draft.connectors.indexOf(c) + 1, 0, group)
      return
    }
    case 'renameEndpoint': {
      const name = adj.name.trim()
      if (!name) throw new AdjustError('o nome não pode ficar vazio')
      endpointOf(imported(draft, adj.connectorId), adj.endpointId).name = name
      return
    }
    case 'moveEndpoint': {
      const from = imported(draft, adj.connectorId)
      const e = endpointOf(from, adj.endpointId)
      if (!adj.to.existing && adj.to.id === from.id) return
      if (!adj.to.existing) imported(draft, adj.to.id)
      else if (!project.connectors.has(adj.to.id)) throw new AdjustError(`conector "${adj.to.id}" não está no projeto`)
      const before = baseUrlOf(draft, project, { id: from.id })
      const after = baseUrlOf(draft, project, adj.to)
      if (before !== after) {
        draft.notes.push({
          source: `${from.name} › ${e.name}`,
          message: `o caminho ${e.path} passa a usar a URL base ${after ?? '(nenhuma)'} em vez de ${before ?? '(nenhuma)'}.`
        })
      }
      setEndpoints(from, (from.endpoints ?? []).filter((x) => x !== e))
      addEndpoint(draft, project, adj.to, e)
      return
    }
    case 'excludeEndpoint': {
      const c = imported(draft, adj.connectorId)
      const e = endpointOf(c, adj.endpointId)
      setEndpoints(c, (c.endpoints ?? []).filter((x) => x !== e))
      return
    }
    case 'mergeIntoScenario': {
      const from = imported(draft, adj.connectorId)
      const source = endpointOf(from, adj.endpointId)
      const targetConnector = adj.into.connector.existing
        ? project.connectors.get(adj.into.connector.id)
        : imported(draft, adj.into.connector.id)
      if (!targetConnector) throw new AdjustError(`conector "${adj.into.connector.id}" não está no projeto`)
      const target = adj.into.connector.existing
        ? (targetConnector.endpoints ?? []).find((e) => e.id === adj.into.endpointId) ??
          additionsOf(draft, targetConnector.id).endpoints.find((e) => e.id === adj.into.endpointId)
        : (targetConnector.endpoints ?? []).find((e) => e.id === adj.into.endpointId)
      if (!target) throw new AdjustError(`endpoint "${adj.into.endpointId}" não existe em ${targetConnector.name}`)
      if (target === source) throw new AdjustError('uma requisição não vira cenário dela mesma')

      const pending = adj.into.connector.existing ? additionsOf(draft, targetConnector.id).scenarios : []
      const taken = [
        ...(target.scenarios ?? []).map((s) => s.id),
        ...pending.filter((p) => p.endpointId === target.id).map((p) => p.scenario.id)
      ]
      const { scenario, usedDefault } = scenarioFromVariant(target, source, taken, adj.name)
      if (usedDefault) {
        draft.notes.push({
          source: `${targetConnector.name} › ${target.name} › ${scenario.name}`,
          message: 'a requisição não tinha teste de status no Postman; o cenário verifica status < 500.'
        })
      }
      if (adj.into.connector.existing) pending.push({ endpointId: target.id, scenario })
      else target.scenarios = [...(target.scenarios ?? []), scenario]
      setEndpoints(from, (from.endpoints ?? []).filter((x) => x !== source))
      return
    }
    case 'excludeEnvironment':
      draft.excludedEnvironments.add(adj.id)
      return
    case 'excludeFlow':
      draft.excludedFlows.add(adj.id)
      return
    default:
      throw new AdjustError('ajuste desconhecido')
  }
}

/** URL base efetiva de um conector do import ou do projeto, pela cadeia de `extends`. */
function baseUrlOf(draft: Draft, project: ProjectSnapshot, ref: { id: string; existing?: boolean }): string | undefined {
  const seen = new Set<string>()
  let cur: Connector | undefined = ref.existing ? project.connectors.get(ref.id) : draft.connectors.find((c) => c.id === ref.id)
  let existing = !!ref.existing
  while (cur && !seen.has(cur.id)) {
    if (cur.config?.baseUrl) return cur.config.baseUrl
    seen.add(cur.id)
    const parent: string | undefined = cur.extends
    if (!parent) return undefined
    // Um importado pode herdar do projeto; um do projeto só herda do projeto.
    const next: Connector | undefined = existing ? undefined : draft.connectors.find((c) => c.id === parent)
    if (next) cur = next
    else {
      existing = true
      cur = project.connectors.get(parent)
    }
  }
  return undefined
}

function isImported(draft: Draft, id: string): boolean {
  return draft.connectors.some((c) => c.id === id)
}

function imported(draft: Draft, id: string): Connector {
  const c = draft.connectors.find((x) => x.id === id)
  if (!c) throw new AdjustError(`conector "${id}" não está mais no import`)
  return c
}

function endpointOf(c: Connector, id: string): Endpoint {
  const e = (c.endpoints ?? []).find((x) => x.id === id)
  if (!e) throw new AdjustError(`endpoint "${id}" não está em ${c.name}`)
  return e
}

function setEndpoints(c: Connector, endpoints: Endpoint[]): void {
  if (endpoints.length) c.endpoints = endpoints
  else delete c.endpoints
}

function additionsOf(draft: Draft, id: string) {
  let a = draft.additions.get(id)
  if (!a) draft.additions.set(id, (a = { endpoints: [], scenarios: [] }))
  return a
}

/** Põe o endpoint no destino com um id livre lá. */
function addEndpoint(draft: Draft, project: ProjectSnapshot, to: { id: string; existing?: boolean }, e: Endpoint): void {
  if (to.existing) {
    const additions = additionsOf(draft, to.id)
    const taken = [...(project.connectors.get(to.id)?.endpoints ?? []), ...additions.endpoints].map((x) => x.id)
    additions.endpoints.push({ ...e, id: new UniqueIds(taken).take(e.id, '_') })
    return
  }
  const target = imported(draft, to.id)
  const taken = (target.endpoints ?? []).map((x) => x.id)
  setEndpoints(target, [...(target.endpoints ?? []), { ...e, id: new UniqueIds(taken).take(e.id, '_') }])
}

function descendants(draft: Draft, id: string): Set<string> {
  const out = new Set<string>()
  const visit = (parent: string) => {
    for (const c of draft.connectors) {
      if (c.extends === parent && !out.has(c.id)) {
        out.add(c.id)
        visit(c.id)
      }
    }
  }
  visit(id)
  return out
}

/** Pai antes dos filhos, mantendo a ordem original entre irmãos. */
function preorder(connectors: Connector[]): Connector[] {
  const ids = new Set(connectors.map((c) => c.id))
  const out: Connector[] = []
  const visit = (c: Connector) => {
    out.push(c)
    for (const child of connectors) if (child.extends === c.id) visit(child)
  }
  for (const c of connectors) if (!c.extends || !ids.has(c.extends)) visit(c)
  return out
}

// ---------------------------------------------------------------------------
// Requisição → cenário

/**
 * Valores para os {parâmetros} do caminho do endpoint a partir do caminho de uma
 * variação dele ("/users/{id}" e "/users/42" -> { id: "42" }). undefined quando a
 * variação não cabe no endpoint.
 */
export function matchPath(template: string, path: string): Record<string, string> | undefined {
  const t = template.split('/')
  const p = path.split('/')
  if (t.length !== p.length) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < t.length; i++) {
    if (t[i] === p[i]) continue
    const param = t[i]!.match(/^\{([^{}]+)\}$/)
    if (!param || !p[i] || /^\{[^{}]+\}$/.test(p[i]!)) return undefined
    params[param[1]!] = p[i]!
  }
  return params
}

/** Diferença entre dois mapas de headers/query como override de cenário (null tira o herdado). */
function mapDiff(
  base: Record<string, string> | undefined,
  next: Record<string, string> | undefined
): Record<string, string | null> | undefined {
  const out: Record<string, string | null> = {}
  const lower = (m: Record<string, string> | undefined) => new Map(Object.keys(m ?? {}).map((k) => [k.toLowerCase(), k]))
  const baseKeys = lower(base)
  const nextKeys = lower(next)
  for (const [k, v] of Object.entries(next ?? {})) {
    const baseKey = baseKeys.get(k.toLowerCase())
    if (baseKey === undefined || base![baseKey] !== v) out[k] = v
  }
  for (const [lk, k] of baseKeys) if (!nextKeys.has(lk)) out[k] = null
  return Object.keys(out).length ? out : undefined
}

const SEPARATORS = /^\s*(?:[-–—:|/›>]\s*|\()/

/** "Buscar usuário - não encontrado" sob "Buscar usuário" vira "não encontrado". */
function scenarioName(target: string, source: string): string {
  if (source.toLowerCase().startsWith(target.toLowerCase()) && source.length > target.length) {
    const rest = source.slice(target.length)
    if (SEPARATORS.test(rest)) {
      const name = rest.replace(SEPARATORS, '').replace(/\)\s*$/, '').trim()
      if (name) return name
    }
  }
  return source
}

export function scenarioFromVariant(
  target: Endpoint,
  source: Endpoint,
  takenIds: string[],
  name?: string
): { scenario: Scenario; usedDefault: boolean } {
  if (source.method !== target.method) {
    throw new AdjustError(`métodos diferentes (${source.method} e ${target.method}); só dá para mesclar variações do mesmo endpoint`)
  }
  const pathParams = matchPath(target.path, source.path)
  if (!pathParams) throw new AdjustError(`o caminho ${source.path} não corresponde a ${target.path}`)

  const overrides: NonNullable<Scenario['overrides']> = {}
  if (!deepEqual(source.body, target.body)) {
    if (source.body === undefined) overrides.body = null
    else overrides.body = clone(source.body)
  }
  if (!deepEqual(source.payload, target.payload)) {
    if (source.payload) overrides.payload = clone(source.payload)
    else if (source.body === undefined) overrides.payload = null
  }
  const headers = mapDiff(target.headers, source.headers)
  if (headers) overrides.headers = headers
  const query = mapDiff(target.query, source.query)
  if (query) overrides.query = query
  if (Object.keys(pathParams).length) overrides.pathParams = pathParams

  const assertions: Assertion[] = []
  for (const s of source.scenarios ?? []) {
    for (const a of s.assertions) if (!assertions.some((x) => deepEqual(x, a))) assertions.push(clone(a))
  }
  const usedDefault = assertions.length === 0
  const finalName = name?.trim() || scenarioName(target.name, source.name)
  const scenario: Scenario = {
    id: new UniqueIds(takenIds).take(slug(finalName, '_') || 'cenario', '_'),
    name: finalName,
    assertions: (usedDefault ? [DEFAULT_ASSERTION] : assertions) as Scenario['assertions']
  }
  if (source.description) scenario.description = source.description
  if (Object.keys(overrides).length) scenario.overrides = overrides
  return { scenario, usedDefault }
}

/** A action SOAP do endpoint (header SOAPAction, ou `action=` do Content-Type no SOAP 1.2). */
function soapAction(e: Endpoint): string | undefined {
  const header = (name: string) => Object.entries(e.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1] ?? undefined
  return header('soapaction') ?? header('content-type')?.match(/action="?([^";]+)/)?.[1]
}

/**
 * Requisições que parecem variações de outro endpoint do mesmo conector: mesmo
 * método e mesmo caminho, ou um caminho concreto de um endpoint com {parâmetros}.
 */
export function suggestScenarioMerges(connectors: Connector[]): ImportScenarioSuggestion[] {
  const out: ImportScenarioSuggestion[] = []
  for (const c of connectors) {
    const endpoints = c.endpoints ?? []
    const sources = new Set<Endpoint>()
    const targets = new Set<Endpoint>()
    for (const source of endpoints) {
      if (targets.has(source)) continue
      // Prefere o mais genérico (mais parâmetros) e, empatado, o primeiro.
      const candidates = endpoints
        .filter((t) => t !== source && !sources.has(t) && t.method === source.method && matchPath(t.path, source.path))
        // Operações SOAP dividem método e caminho: quem as distingue é a action.
        .filter((t) => soapAction(t) === soapAction(source))
        .filter((t) => t.path !== source.path || endpoints.indexOf(t) < endpoints.indexOf(source))
        .sort((a, b) => params(b.path) - params(a.path) || endpoints.indexOf(a) - endpoints.indexOf(b))
      const target = candidates[0]
      if (!target) continue
      sources.add(source)
      targets.add(target)
      out.push({
        connectorId: c.id,
        endpointId: source.id,
        endpointName: source.name,
        into: { connectorId: c.id, endpointId: target.id, endpointName: target.name },
        scenarioName: scenarioName(target.name, source.name)
      })
    }
  }
  return out
}

const params = (path: string) => (path.match(/\{[^{}]+\}/g) ?? []).length

// ---------------------------------------------------------------------------
// Reimportação de uma spec OpenAPI

interface SyncItem {
  status: 'updated' | 'conflict' | 'removed' | 'linked' | 'edited'
  decision: ImportSyncDecision
  changes: ImportFieldChange[]
}

interface SpecSync {
  /** Por conector do projeto, por endpoint: o que a reimportação faz com ele. */
  items: Map<string, Map<string, SyncItem>>
  ops: ImportOp[]
}

/**
 * Spec reimportada com outro título (o id do raiz sai do título): se o projeto já tem um
 * conector com a mesma origem, o raiz importado passa a usar o id dele, e os filhos
 * acompanham, para a reimportação mesclar em vez de criar uma cópia.
 */
function alignSpecRoots(connectors: Connector[], project: ProjectSnapshot): Connector[] {
  for (const root of connectors.filter((c) => c.source && !c.extends)) {
    if (project.connectors.has(root.id)) continue
    // O raiz da spec no projeto pode herdar de outro conector (um feito à mão e vinculado depois).
    const existing = [...project.connectors.values()].find(
      (p) => p.source?.location === root.source!.location && (!p.extends || !project.connectors.get(p.extends)?.source)
    )
    if (!existing || connectors.some((c) => c.id === existing.id)) continue
    const old = root.id
    root.id = existing.id
    const taken = new Set(connectors.map((c) => c.id))
    for (const c of connectors) {
      if (c.extends !== old) continue
      c.extends = existing.id
      const renamed = c.id.startsWith(`${old}.`) ? `${existing.id}${c.id.slice(old.length)}` : c.id
      if (!taken.has(renamed)) {
        taken.delete(c.id)
        taken.add(renamed)
        c.id = renamed
      }
    }
  }
  return connectors
}

const SPEC_FIELD_LIST: readonly string[] = SPEC_FIELDS
const MAX_CHANGE_CHARS = 4000

function short(v: unknown): string | undefined {
  if (v === undefined) return undefined
  const text = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  return text.length > MAX_CHANGE_CHARS ? `${text.slice(0, MAX_CHANGE_CHARS)}…` : text
}

/** O endpoint do projeto com os campos que vêm da spec trocados pelos da nova versão; o resto (cenários, plugin) fica. */
const fields = (e: Endpoint) => e as unknown as Record<string, unknown>

function withSpecFields(local: Endpoint, spec: Endpoint): Endpoint {
  const next = { ...fields(local) }
  for (const f of SPEC_FIELD_LIST) delete next[f]
  for (const f of SPEC_FIELD_LIST) if (fields(spec)[f] !== undefined) next[f] = clone(fields(spec)[f])
  next['source'] = clone(spec.source)
  // A marca de dado pessoal que o projeto pôs num campo fica, mesmo com a spec ganhando.
  if (next['bodySchema'] !== undefined) keepSensitiveMarks(next['bodySchema'], local.bodySchema)
  return ordered(local.id, next)
}

/** O endpoint do projeto como está, só com a marca da operação da spec (vincular sem aplicar a spec). */
function withSource(local: Endpoint, spec: Endpoint): Endpoint {
  return ordered(local.id, { ...fields(local), source: clone(spec.source) })
}

/** A ordem das chaves segue a do schema, para o arquivo não mudar à toa. */
function ordered(id: string, next: Record<string, unknown>): Endpoint {
  const out: Record<string, unknown> = { id }
  for (const k of ['name', 'description', 'method', 'path', 'requiresAuth', 'headers', 'query', 'bodySchema', 'body', 'payload', 'plugin', 'source', 'scenarios']) {
    if (next[k] !== undefined) out[k] = next[k]
  }
  return { ...out, ...next } as unknown as Endpoint
}

function fieldChanges(before: Endpoint, after: Endpoint): ImportFieldChange[] {
  const b = fields(before)
  const a = fields(after)
  return SPEC_FIELD_LIST.filter((f) => !deepEqual(b[f], a[f])).map((field) => ({
    field,
    ...(b[field] !== undefined && { before: short(b[field]) }),
    ...(a[field] !== undefined && { after: short(a[field]) })
  }))
}

/**
 * Reimportação de uma spec que o projeto já tem (o raiz importado existe no projeto e é
 * mesclado). Cada operação da spec é procurada nos endpoints que vieram dela, em toda a
 * família do raiz, pelo operationId e depois por método e caminho. O hash guardado no
 * endpoint diz se a operação mudou na spec e se o endpoint foi editado no projeto:
 * - mudou só na spec: atualiza (padrão), mantendo id, cenários e o resto;
 * - mudou na spec e no projeto: conflito, mantém o do projeto (padrão) ou aplica a spec;
 * - saiu da spec: mantém (padrão) ou apaga.
 * Um endpoint feito à mão (sem `source`) com o método e o caminho de uma operação é vinculado a
 * ela (`linked`), sem duplicar: recebe a marca da operação e, se diferir, a versão da spec (padrão
 * quando não difere ou com `specWins`) ou fica como está, já vinculado.
 * Com `specWins` (vvpost sync: a spec do código é a fonte do contrato), o conflito aplica a spec
 * por padrão, e um endpoint editado no projeto sem mudança na spec (`edited`) volta a ela.
 * As operações achadas saem dos conectores importados; o que sobra entra como novo.
 */
function syncSpecs(
  draft: Draft,
  project: ProjectSnapshot,
  conflicts: Record<string, ImportConflictMode>,
  decisions: Record<string, ImportSyncDecision>,
  specWins = false
): SpecSync {
  const sync: SpecSync = { items: new Map(), ops: [] }
  for (const root of draft.connectors.filter((c) => c.source && (!c.extends || !isImported(draft, c.extends)))) {
    const existingRoot = project.connectors.get(root.id)
    if (!existingRoot) continue
    const group = [root, ...[...descendants(draft, root.id)].map((id) => imported(draft, id))]
    if (group.some((c) => project.connectors.has(c.id) && (conflicts[c.id] ?? 'merge') !== 'merge')) continue

    // Família do raiz no projeto: ele e todo conector cuja cadeia de extends passa por ele.
    const family = [...project.connectors.values()].filter((c) => {
      const seen = new Set<string>()
      for (let cur: Connector | undefined = c; cur && !seen.has(cur.id); cur = cur.extends ? project.connectors.get(cur.extends) : undefined) {
        if (cur.id === root.id) return true
        seen.add(cur.id)
      }
      return false
    })
    const all = family.flatMap((c) => (c.endpoints ?? []).map((e) => ({ connectorId: c.id, endpoint: e })))
    const fromSpec = all.filter((x) => x.endpoint.source)
    const matched = new Set<Endpoint>()
    const find = (e: Endpoint) => {
      const free = fromSpec.filter((x) => !matched.has(x.endpoint))
      return (
        (e.source!.operationId ? free.find((x) => x.endpoint.source!.operationId === e.source!.operationId) : undefined) ??
        free.find((x) => x.endpoint.source!.operation === e.source!.operation) ??
        all.find(
          (x) =>
            !x.endpoint.source &&
            !x.endpoint.plugin &&
            !matched.has(x.endpoint) &&
            x.endpoint.method.toUpperCase() === e.method.toUpperCase() &&
            pathShape(x.endpoint.path) === pathShape(e.path)
        )
      )
    }
    const record = (connectorId: string, endpointId: string, item: SyncItem) => {
      let m = sync.items.get(connectorId)
      if (!m) sync.items.set(connectorId, (m = new Map()))
      m.set(endpointId, item)
    }

    for (const c of group) {
      const before = c.endpoints?.length ?? 0
      const keep: Endpoint[] = []
      for (const e of c.endpoints ?? []) {
        const hit = e.source ? find(e) : undefined
        if (!hit) {
          keep.push(e)
          continue
        }
        matched.add(hit.endpoint)
        const local = hit.endpoint
        const key = `${hit.connectorId}/${local.id}`
        const next = withSpecFields(local, e)
        if (!local.source) {
          const changes = fieldChanges(local, next)
          const decision = decisions[key] ?? (changes.length && !specWins ? 'keep' : 'spec')
          record(hit.connectorId, local.id, { status: 'linked', decision, changes })
          const endpoint = decision === 'spec' ? next : withSource(local, e)
          sync.ops.push({ op: 'upsertEndpoint', connectorId: hit.connectorId, endpoint, keepScenarios: true })
          continue
        }
        const stored = local.source.hash
        const specChanged =
          e.source!.hash !== stored || local.source.operation !== e.source!.operation || specAddsSensitiveMarks(e.bodySchema, local.bodySchema)
        const edited = endpointHash(local) !== stored
        if (!specChanged && !(edited && specWins)) continue
        const status = !specChanged ? 'edited' : edited ? 'conflict' : 'updated'
        const decision = decisions[key] ?? (edited && !specWins ? 'keep' : 'spec')
        record(hit.connectorId, local.id, { status, decision, changes: fieldChanges(local, next) })
        if (decision === 'spec') sync.ops.push({ op: 'upsertEndpoint', connectorId: hit.connectorId, endpoint: next, keepScenarios: true })
      }
      setEndpoints(c, keep)
      // Conector novo (tag nova) cujas operações já estavam no projeto em outro conector: não é criado vazio.
      if (before && !keep.length && c !== root && !project.connectors.has(c.id) && !descendants(draft, c.id).size) {
        draft.connectors = draft.connectors.filter((x) => x !== c)
      }
    }

    for (const { connectorId, endpoint } of fromSpec) {
      if (matched.has(endpoint)) continue
      const key = `${connectorId}/${endpoint.id}`
      const decision = decisions[key] ?? 'keep'
      record(connectorId, endpoint.id, { status: 'removed', decision, changes: [] })
      if (decision === 'spec') sync.ops.push({ op: 'deleteEndpoint', connectorId, endpointId: endpoint.id })
    }
    if (!deepEqual(existingRoot.source, root.source)) sync.ops.push({ op: 'patchConnector', id: root.id, set: { source: clone(root.source!) } })
  }
  return sync
}

/** O caminho sem os nomes dos parâmetros nem a barra final: /pets/{id} e /pets/{petId}/ são o mesmo. */
const pathShape = (path: string) => path.replace(/\{[^{}]+\}/g, '{}').replace(/\/+$/, '') || '/'

// ---------------------------------------------------------------------------
// Reconciliação com o projeto

function reconcileConnectors(
  draft: Draft,
  project: ProjectSnapshot,
  conflicts: Record<string, ImportConflictMode>,
  sync: SpecSync = { items: new Map(), ops: [] }
): { connectors: ImportPlanConnector[]; ops: ImportOp[]; finalId: Map<string, string>; created: Set<string> } {
  const ops: ImportOp[] = []
  const created = new Set<string>()
  const ids = new UniqueIds([...draft.connectors.map((c) => c.id), ...project.connectors.keys()])
  const finalId = new Map<string, string>()
  const mode = new Map<string, ImportConflictMode>()
  for (const c of draft.connectors) {
    if (!project.connectors.has(c.id)) {
      finalId.set(c.id, c.id)
      continue
    }
    const m = conflicts[c.id] ?? 'merge'
    mode.set(c.id, m)
    finalId.set(c.id, m === 'rename' ? ids.take(c.id, '-') : c.id)
  }

  const plan: ImportPlanConnector[] = []
  const shown = new Set<string>()
  const node = (c: Connector, key: string, origin: 'imported' | 'existing'): ImportPlanConnector => ({
    key,
    id: c.id,
    name: c.name,
    origin,
    ...(c.extends ? { extends: c.extends } : {}),
    ...(c.config?.baseUrl ? { baseUrl: c.config.baseUrl } : {}),
    endpoints: []
  })
  // Pai do projeto que não muda, mostrado só para a árvore fazer sentido.
  const showAncestors = (id: string | undefined) => {
    const chain: Connector[] = []
    for (let cur = id ? project.connectors.get(id) : undefined; cur && !shown.has(cur.id); ) {
      chain.unshift(cur)
      cur = cur.extends ? project.connectors.get(cur.extends) : undefined
    }
    for (const c of chain) {
      shown.add(c.id)
      plan.push({ ...node(c, c.id, 'existing'), endpoints: existingEndpoints(c), untouched: true })
    }
  }

  // Endpoints e cenários que entram em conectores do projeto.
  const incoming = new Map<string, { endpoints: Endpoint[]; scenarios: { endpointId: string; scenario: Scenario }[] }>()
  const incomingOf = (id: string) => {
    let a = incoming.get(id)
    if (!a) incoming.set(id, (a = { endpoints: [], scenarios: [] }))
    return a
  }
  for (const [id, a] of draft.additions) {
    incomingOf(id).endpoints.push(...a.endpoints)
    incomingOf(id).scenarios.push(...a.scenarios)
  }
  for (const id of sync.items.keys()) incomingOf(id)

  for (const c of draft.connectors) {
    const id = finalId.get(c.id)!
    const parent = c.extends ? (finalId.get(c.extends) ?? c.extends) : undefined
    const out: Connector = { ...clone(c), id }
    if (parent) out.extends = parent
    const m = mode.get(c.id)
    if (parent && !finalId.has(c.extends!)) showAncestors(parent)

    if (m === 'merge') {
      const existing = project.connectors.get(c.id)!
      showAncestors(existing.extends)
      const into = incomingOf(c.id)
      for (const e of c.endpoints ?? []) {
        const same =
          (existing.endpoints ?? []).find((x) => x.id === e.id) ??
          (existing.endpoints ?? []).find((x) => x.method === e.method && x.path === e.path)
        if (!same) {
          into.endpoints.push(e)
          continue
        }
        for (const s of e.scenarios ?? []) {
          if (!(same.scenarios ?? []).some((x) => x.id === s.id)) into.scenarios.push({ endpointId: same.id, scenario: s })
        }
      }
      // O conector do projeto aparece na posição do importado, com o que ele recebe.
      shown.add(c.id)
      plan.push({ ...node(existing, c.id, 'existing'), conflict: 'merge', endpoints: [] })
      continue
    }

    ops.push({ op: 'upsertConnector', connector: out })
    created.add(c.id)
    plan.push({
      ...node(out, c.id, 'imported'),
      ...(m ? { conflict: m } : {}),
      endpoints: (out.endpoints ?? []).map((e) => planEndpoint(e, 'new', true))
    })
    shown.add(id)
  }

  // Conectores do projeto que recebem endpoints ou cenários (merge e ajustes).
  for (const [id, a] of incoming) {
    const existing = project.connectors.get(id)
    const synced = sync.items.get(id)
    if (!existing || (!a.endpoints.length && !a.scenarios.length && !mode.has(id) && !synced)) continue
    const taken = new UniqueIds((existing.endpoints ?? []).map((e) => e.id))
    const added: Endpoint[] = []
    for (const e of a.endpoints) {
      const endpoint = { ...e, id: taken.take(e.id, '_') }
      added.push(endpoint)
      ops.push({ op: 'upsertEndpoint', connectorId: id, endpoint })
    }
    for (const s of a.scenarios) ops.push({ op: 'upsertScenario', connectorId: id, endpointId: s.endpointId, scenario: s.scenario })

    const endpoints = [
      ...(existing.endpoints ?? []).map((e) => {
        const scenarios = a.scenarios.filter((s) => s.endpointId === e.id).map((s) => s.scenario)
        const item = synced?.get(e.id)
        return {
          ...planEndpoint(e, 'existing', false),
          ...(item && {
            status: item.status,
            sync: { key: `${id}/${e.id}`, decision: item.decision, changes: item.changes }
          }),
          scenarios: [
            ...(e.scenarios ?? []).map((s) => ({ id: s.id, name: s.name, isNew: false })),
            ...scenarios.map((s) => ({ id: s.id, name: s.name, isNew: true }))
          ]
        }
      }),
      ...added.map((e) => planEndpoint(e, 'new', true))
    ]
    const at = plan.findIndex((p) => p.id === id)
    if (at >= 0) plan[at] = { ...plan[at]!, endpoints, untouched: false }
    else {
      showAncestors(existing.extends)
      plan.push({ ...node(existing, id, 'existing'), endpoints })
    }
  }
  for (const p of plan) if (p.origin === 'existing' && p.endpoints.length === 0) p.endpoints = existingEndpoints(project.connectors.get(p.id)!)
  ops.push(...sync.ops)
  return { connectors: orderTree(plan), ops, finalId, created }
}

function existingEndpoints(c: Connector) {
  return (c.endpoints ?? []).map((e) => planEndpoint(e, 'existing', false))
}

function planEndpoint(e: Endpoint, status: 'new' | 'existing', scenariosNew: boolean) {
  return {
    id: e.id,
    name: e.name,
    method: e.method,
    path: e.path,
    status,
    scenarios: (e.scenarios ?? []).map((s) => ({ id: s.id, name: s.name, isNew: scenariosNew }))
  }
}

function orderTree(nodes: ImportPlanConnector[]): ImportPlanConnector[] {
  const ids = new Set(nodes.map((n) => n.id))
  const out: ImportPlanConnector[] = []
  const seen = new Set<ImportPlanConnector>()
  const visit = (n: ImportPlanConnector) => {
    if (seen.has(n)) return
    seen.add(n)
    out.push(n)
    for (const child of nodes) if (child.extends === n.id) visit(child)
  }
  for (const n of nodes) if (!n.extends || !ids.has(n.extends)) visit(n)
  return out
}

function reconcileEnvironments(
  result: ImportDocuments,
  draft: Draft,
  project: ProjectSnapshot,
  conflicts: Record<string, ImportConflictMode>
): { environments: ImportPlanEnvironment[]; ops: ImportOp[] } {
  const ops: ImportOp[] = []
  const environments: ImportPlanEnvironment[] = []
  const ids = new UniqueIds([...result.environments.map((e) => e.id), ...project.environments.keys()])
  for (const env of result.environments) {
    const excluded = draft.excludedEnvironments.has(env.id)
    const existing = project.environments.get(env.id)
    const mode = existing ? (conflicts[env.id] ?? 'merge') : undefined
    const id = mode === 'rename' ? ids.take(env.id, '-') : env.id
    const variables = Object.entries(env.variables).map(([name, v]) => ({
      name,
      isSecret: v.isSecret === true,
      exists: mode === 'merge' && existing!.variables[name] !== undefined
    }))
    const secrets = result.secrets.filter((s: ImportedSecret) => s.environmentId === env.id)
    environments.push({
      key: env.id,
      id,
      name: env.name,
      origin: existing && mode !== 'rename' ? 'existing' : 'imported',
      ...(mode ? { conflict: mode } : {}),
      excluded,
      variables,
      secretValues: excluded ? 0 : secrets.filter((s) => !(mode === 'merge' && existing!.variables[s.variable])).length
    })
    if (excluded) continue
    ops.push({ op: 'upsertEnvironment', environment: { ...clone(env), id }, overwriteValues: mode === 'replace' })
    for (const s of secrets) {
      ops.push({ op: 'storeSecret', environmentId: id, variable: s.variable, value: s.value, overwrite: mode !== 'merge' })
    }
  }
  return { environments, ops }
}

/**
 * Fluxos do pacote: os nós passam a apontar para o id final dos conectores (que muda
 * com "importar como novo"). Um fluxo com id já usado no projeto é mantido (padrão),
 * importado com outro id ou substituído.
 */
function reconcileFlows(
  flows: Flow[],
  draft: Draft,
  project: ProjectSnapshot,
  finalId: Map<string, string>,
  conflicts: Record<string, ImportConflictMode>
): { flows: ImportPlanFlow[]; ops: ImportOp[] } {
  const ops: ImportOp[] = []
  const out: ImportPlanFlow[] = []
  const ids = new UniqueIds([...flows.map((f) => f.id), ...(project.flows?.keys() ?? [])])
  for (const flow of flows) {
    const excluded = draft.excludedFlows.has(flow.id)
    const exists = project.flows?.has(flow.id) ?? false
    const mode = exists ? (conflicts[flow.id] ?? 'merge') : undefined
    const id = mode === 'rename' ? ids.take(flow.id, '-') : flow.id
    const next: Flow = { ...clone(flow), id }
    const missing = new Set<string>()
    for (const node of next.nodes) {
      const target = node.type === 'request' ? node.request : node.type === 'plugin' ? node.plugin : undefined
      if (!target?.connector) continue
      const mapped = finalId.get(target.connector)
      if (mapped) target.connector = mapped
      else if (!project.connectors.has(target.connector)) missing.add(target.connector)
    }
    out.push({
      key: flow.id,
      id,
      name: flow.name,
      origin: exists && mode !== 'rename' ? 'existing' : 'imported',
      ...(mode ? { conflict: mode } : {}),
      excluded,
      nodes: flow.nodes.length,
      ...(missing.size ? { missingConnectors: [...missing] } : {})
    })
    if (excluded || mode === 'merge') continue
    if (missing.size) {
      draft.notes.push({
        source: flow.name,
        message: `o fluxo usa conector(es) que não vão estar no projeto: ${[...missing].join(', ')}.`
      })
    }
    ops.push({ op: 'upsertFlow', flow: next })
  }
  return { flows: out, ops }
}
