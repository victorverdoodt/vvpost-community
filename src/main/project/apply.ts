import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  REQUIRED_SECRET,
  SchemaId,
  validateConnector,
  validateJsonSchema,
  validateEnvironment,
  validateFlow,
  type Connector,
  type Endpoint,
  type Environment,
  type Flow,
  type ResponseExample
} from '@vvpost/schemas'
import { BodySchemaError, bodyValue, inferBodySchema, setBodyField, type BodyFieldSpec } from '@vvpost/core/connectors/body-schema'
import { literalSecrets } from '@vvpost/core/connectors/edit'
import { checkBody, checkExample } from '@vvpost/core/connectors/registry'
import {
  extractSharedSchemas,
  resolveSchemaRefs,
  rootSchemaName,
  SCHEMA_NAME,
  schemaFile,
  schemaRefs,
  type SharedSchema
} from '@vvpost/core/connectors/shared-schemas'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { chainBasePath, compileFlows, connectorToFlows, isBaseFlow, requestFlowToEndpoint } from '@vvpost/core/flows/inherit'
import { literalFlowSecrets, loadFlows, FLOW_SUFFIX } from '@vvpost/core/flows/workspace'
import { isProjectDir } from '@vvpost/core/projects'
import { sensitiveFields, type PiiType } from '@vvpost/core/pii'
import { endpointHash } from '../importers/spec-hash'
import { diskText, versionOf } from '../workspace/file-version'
import { describeLeaks, findSecretLeaks } from '../workspace/leak-guard'
import { mergeSecrets, readSecretsStore, type SecretValue, type SecretsStore } from '../workspace/vault'
import { aiGuard, connectorFingerprints, reviewReasons } from './guard'
import { ProjectOpError, type ProjectApplyResult, type ProjectChange, type ProjectOp, type ProjectOpIssue } from './ops'
import { addReviewMarks } from './review'

export const CONNECTOR_SUFFIX = '.connector.vvpost.json'
export const DOCS_SUFFIX = '.connector.vvpost.md'
const ENV_SUFFIX = '.env.json'
/** Um lote não passa disto (uma migração grande cabe; um laço da IA não). */
export const MAX_OPS = 2000

export interface ApplyOptions {
  /** Só calcula as mudanças: nada é gravado. */
  dryRun?: boolean
  /** Quem escreve. 'ai' liga as regras do MCP (sem segredos, revisão de auth e destino). */
  actor?: 'app' | 'ai'
  /**
   * Conferência extra do que o lote acrescenta a cada arquivo (as linhas que não
   * estavam no arquivo antes); devolve o motivo da recusa.
   */
  checkText?: (path: string, added: string) => string | undefined
  /**
   * Concorrência otimista: caminho relativo → versão (versionOf) que quem escreve leu; null exige
   * que o arquivo não exista. Diferente do disco, o lote é recusado com `conflicts`.
   */
  expect?: Record<string, string | null>
}

export { versionOf }

interface Entry<T> {
  file: string
  doc: T
  /** Arquivo de onde veio, se mudou de lugar. */
  from?: string
  dirty: boolean
  /** Última operação que mexeu nele, para apontar o erro de validação. */
  op: number
  /** Conector aberto de um fluxo-base para as operações de conector; volta a fluxos no fim do lote. */
  asFlows?: FlowBacking
}

/** Os fluxos de um fluxo-base aberto como conector, e como ele era, para não regravar o que não mudou. */
interface FlowBacking {
  base: Entry<Flow>
  /** Fluxo de requisição de cada endpoint, pelo id do endpoint. */
  requests: Map<string, Entry<Flow>>
  connector: Connector
  endpoints: Map<string, Endpoint>
}

/** O projeto em memória durante o lote. */
export interface Draft {
  dir: string
  connectors: Map<string, Entry<Connector>>
  environments: Map<string, Entry<Environment>>
  flows: Map<string, Entry<Flow>>
  /** Markdown por caminho; null apaga e moveFrom copia o .md de outro conector. Só os que o lote tocou. */
  docs: Map<string, { text: string | null; moveFrom?: string; op: number }>
  /** Texto original de cada arquivo conhecido (conectores, ambientes, fluxos e docs lidos). */
  originals: Map<string, string>
  /** Arquivos do workspace que existem mas não foram carregados (inválidos ou duplicados). */
  unknownFiles: Set<string>
  /** Ambientes com id legível cujo arquivo não passa no schema: o erro diz o que corrigir. */
  invalidEnvironments: Map<string, string>
  /** Arquivos que o lote apagou. */
  deleted: Map<string, number>
  secrets: { value: SecretValue; overwrite: boolean; op: number }[]
  /** Conectores renomeados no lote: id novo → id antigo. */
  renamed: Map<string, string>
  /**
   * Conectores e endpoints que são fluxos (fluxo-base e fluxo de requisição): id ou
   * "<conector>/<endpoint>" → arquivo do fluxo. Ficam de fora das operações de conector;
   * edita-se o fluxo.
   */
  flowSources: Map<string, string>
  /** Conectores dos fluxos-base, só para conferir a herança dos outros. */
  flowBases: Map<string, Connector>
  /**
   * Conectores que este projeto só lê (id → origem): os da organização, os do Compartilhado
   * do workspace e as bases de outros projetos ("<projeto>:<id>"). Entram em flowBases.
   */
  readOnly: Map<string, string>
  /** Schemas compartilhados do projeto (schemas/<Nome>.schema.json), pelo nome. */
  schemas: Map<string, Entry<JsonSchema>>
  /** Os do Compartilhado da raiz, que um projeto cita mas não edita. */
  readOnlySchemas: Map<string, SharedSchema>
}

type JsonSchema = Record<string, unknown>

const OpError = ProjectOpError

/**
 * Aplica um lote de operações ao projeto (docs/mcp.md, "Editar o projeto"). As
 * operações rodam em sequência sobre uma cópia em memória; no fim tudo é validado
 * (schemas, herança, credenciais literais, segredos do vault em arquivos
 * versionados) e só então os arquivos são gravados. Com qualquer erro, nada muda.
 */
export async function applyProjectOps(dir: string, ops: ProjectOp[], options: ApplyOptions = {}): Promise<ProjectApplyResult> {
  const result: ProjectApplyResult = {
    ok: false,
    dryRun: !!options.dryRun,
    changes: [],
    errors: [],
    warnings: [],
    secrets: { stored: 0, skipped: 0 },
    review: []
  }
  if (ops.length > MAX_OPS) {
    result.errors.push({ op: -1, message: `${ops.length} operações no lote; o limite é ${MAX_OPS}` })
    return result
  }
  if (options.expect) {
    const conflicts: NonNullable<ProjectApplyResult['conflicts']> = []
    for (const [path, expected] of Object.entries(options.expect)) {
      if (isAbsolute(path) || normalize(path).split(/[\\/]/).includes('..')) {
        result.errors.push({ op: -1, message: `expect: caminho fora do projeto: ${path}` })
        continue
      }
      const actual = versionOf(await diskText(join(dir, path)))
      if (actual !== expected) conflicts.push({ path, expected, actual })
    }
    if (conflicts.length) result.conflicts = conflicts
    if (result.errors.length || conflicts.length) return result
  }
  const draft = await loadDraft(dir)
  const original = snapshot(draft)

  ops.forEach((op, i) => {
    try {
      if (options.actor === 'ai') aiGuard.before(op, draft)
      applyOp(draft, op, i, result.warnings)
    } catch (err) {
      if (!(err instanceof OpError)) throw err
      result.errors.push({ op: i, message: err.message })
    }
  })
  closeFlowBases(draft, result.errors)
  if (result.errors.length) return result

  if (options.actor === 'ai') aiGuard.restore(draft, original, result)
  validate(draft, original, result)
  if (options.actor === 'ai') aiGuard.after(draft, original, result)
  if (result.errors.length) return result

  const changes = await planChanges(draft, result)
  if (result.errors.length) return result

  const store = await readSecretsStore(dir).catch((): SecretsStore => ({}))
  const pending: SecretsStore = structuredClone(store)
  const toStore: SecretValue[] = []
  for (const s of draft.secrets) {
    const current = pending[s.value.environmentId]?.[s.value.variable]
    if (current !== undefined && current !== REQUIRED_SECRET && !s.overwrite) {
      result.secrets.skipped++
      continue
    }
    ;(pending[s.value.environmentId] ??= {})[s.value.variable] = s.value.value
    toStore.push(s.value)
  }
  result.secrets.stored = toStore.length

  const leaks = await findSecretLeaks(
    dir,
    changes.map((c) => ({ path: c.path, content: c.after ?? null })),
    pending
  )
  if (leaks.length) result.errors.push({ op: -1, message: describeLeaks(leaks).replace(/^Commit bloqueado/, 'Gravação bloqueada') })
  if (options.checkText) {
    for (const c of changes) {
      const had = new Set((c.before ?? '').split('\n'))
      const added = c.after?.split('\n').filter((line) => !had.has(line)).join('\n')
      const reason = added ? options.checkText(c.path, added) : undefined
      if (reason) result.errors.push({ op: touchedBy(draft, c.path), message: `${c.path}: ${reason}` })
    }
  }
  if (options.actor === 'ai') {
    // Tirar a marca de dado pessoal é decisão do usuário: com ela, o valor não chega à IA.
    const marked = (texts: (string | null | undefined)[]) => {
      const fields = new Map<string, PiiType>()
      for (const t of texts) {
        if (!t) continue
        try {
          sensitiveFields(JSON.parse(t), fields)
        } catch {
          // não é JSON (página .md): sem schema
        }
      }
      return fields
    }
    const after = marked(changes.map((c) => c.after))
    const lost = [...marked(changes.map((c) => c.before)).keys()].filter((name) => !after.has(name))
    if (lost.length) {
      result.errors.push({
        op: -1,
        message: `a IA não tira a marca x-sensitive (dado pessoal) de ${lost.join(', ')}: quem tira é o usuário, no app ou no arquivo`
      })
    }
  }
  if (result.errors.length) return result

  if (options.actor === 'ai') {
    // Fluxos-base entram como os conectores que eles são: a IA trocar o login, a auth ou o
    // destino de uma base pede a mesma revisão que num conector.
    const withBases = (connectors: Map<string, Connector>, flows: Iterable<Flow>) => {
      const all = new Map(connectors)
      for (const { connector } of compileFlows([...flows].map((flow) => ({ file: '', flow })), connectors).bases) all.set(connector.id, connector)
      return all
    }
    const before = connectorFingerprints(withBases(original.connectors, original.flows.values()), original.environments)
    const after = connectorFingerprints(
      withBases(new Map([...draft.connectors].map(([id, e]) => [id, e.doc])), [...draft.flows.values()].map((e) => e.doc)),
      [...draft.environments.values()].map((e) => e.doc)
    )
    for (const [id, fp] of after) {
      const was = before.get(draft.renamed.get(id) ?? id)
      if (fp !== null && fp !== was) result.review.push(id)
    }
  }

  result.changes = changes
  result.ok = true
  if (options.dryRun) return result

  // A validação rodou sobre o que o lote leu; se alguém gravou um destes arquivos nesse meio
  // tempo (a pessoa no app, outro agente), gravar por cima perderia a mudança dela.
  const changed: NonNullable<ProjectApplyResult['conflicts']> = []
  for (const c of changes) {
    const now = await diskText(join(dir, c.path))
    if (now !== (c.before ?? null)) changed.push({ path: c.path, expected: versionOf(c.before), actual: versionOf(now) })
  }
  if (changed.length) {
    result.ok = false
    result.conflicts = changed
    return result
  }

  for (const c of changes) {
    const path = join(dir, c.path)
    if (c.after === undefined) continue
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, c.after)
    await rename(tmp, path)
  }
  for (const c of changes) {
    if (c.after !== undefined) continue
    await unlink(join(dir, c.path)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err
    })
  }
  if (toStore.length) await mergeSecrets(dir, toStore)
  if (result.review.length) await addReviewMarks(dir, result.review, new Date(), reviewReasons(draft, result.review))
  return result
}

// ---------------------------------------------------------------------------
// Leitura

async function loadDraft(dir: string): Promise<Draft> {
  const ws = await loadWorkspace(dir)
  const draft: Draft = {
    dir,
    connectors: new Map(),
    environments: new Map(),
    flows: new Map(),
    docs: new Map(),
    originals: new Map(),
    unknownFiles: new Set(ws.issues.map((i) => i.file)),
    invalidEnvironments: new Map(),
    deleted: new Map(),
    secrets: [],
    renamed: new Map(),
    flowSources: ws.flowSources ?? new Map(),
    flowBases: new Map(),
    readOnly: new Map(),
    schemas: new Map(),
    readOnlySchemas: new Map()
  }
  for (const [id, connector] of ws.connectors) {
    const file = ws.connectorFiles.get(id)!
    const from = ws.shared?.get(id)
    if (from) {
      draft.readOnly.set(id, from)
      draft.flowBases.set(id, connector)
      continue
    }
    if (draft.flowSources.has(id)) {
      draft.flowBases.set(id, connector)
      continue
    }
    const text = await readFile(join(dir, file), 'utf8')
    // O documento como está no arquivo: endpoints que vêm de fluxos de requisição não entram nele,
    // e os schemas compartilhados continuam citados.
    const own = validateConnector(JSON.parse(text))
    draft.connectors.set(id, { file, doc: own.ok ? own.value : (ws.unresolved?.get(id) ?? connector), dirty: false, op: -1 })
    draft.originals.set(file, text)
  }
  for (const name of await readdir(join(dir, 'environments')).catch(() => [] as string[])) {
    if (!name.endsWith(ENV_SUFFIX)) continue
    const file = `environments/${name}`
    const text = await readFile(join(dir, file), 'utf8').catch(() => undefined)
    if (text === undefined) continue
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      draft.unknownFiles.add(file)
      continue
    }
    const r = validateEnvironment(doc)
    if (!r.ok || draft.environments.has(r.value.id)) {
      draft.unknownFiles.add(file)
      const id = (doc as { id?: unknown } | null)?.id
      if (!r.ok && typeof id === 'string') {
        const issues = r.issues.map((x) => `${x.path} ${x.message}`).join('; ')
        draft.invalidEnvironments.set(id, `${file} não passa no schema (${issues}); corrija o arquivo antes de editar o ambiente`)
      }
      continue
    }
    draft.environments.set(r.value.id, { file, doc: r.value, dirty: false, op: -1 })
    draft.originals.set(file, text)
  }
  for (const [name, s] of ws.schemas ?? []) {
    if (s.shared) {
      draft.readOnlySchemas.set(name, s)
      continue
    }
    draft.schemas.set(name, { file: s.file, doc: s.schema, dirty: false, op: -1 })
    draft.originals.set(s.file, await readFile(join(dir, s.file), 'utf8'))
  }
  const flows = await loadFlows(dir)
  for (const issue of flows.issues) draft.unknownFiles.add(issue.file)
  for (const { file, flow } of flows.flows) {
    draft.flows.set(flow.id, { file, doc: flow, dirty: false, op: -1 })
    draft.originals.set(file, await readFile(join(dir, file), 'utf8'))
  }
  return draft
}

export interface DraftSnapshot {
  connectors: Map<string, Connector>
  environments: Environment[]
  flows: Map<string, Flow>
  schemas: Map<string, JsonSchema>
}

function snapshot(draft: Draft): DraftSnapshot {
  return {
    connectors: new Map([...draft.connectors].map(([id, e]) => [id, structuredClone(e.doc)])),
    environments: [...draft.environments.values()].map((e) => structuredClone(e.doc)),
    flows: new Map([...draft.flows].map(([id, e]) => [id, structuredClone(e.doc)])),
    schemas: new Map([...draft.schemas].map(([name, e]) => [name, structuredClone(e.doc)]))
  }
}

/** O schema compartilhado pelo nome: o do projeto (como está no lote) ou o do Compartilhado. */
const schemaLookup =
  (draft: Draft, own: ReadonlyMap<string, JsonSchema> = new Map([...draft.schemas].map(([n, e]) => [n, e.doc]))) =>
  (name: string): JsonSchema | undefined =>
    own.get(name) ?? draft.readOnlySchemas.get(name)?.schema

/** O schema do projeto que se edita pelo nome; o do Compartilhado diz onde editar. */
function schemaEntry(draft: Draft, name: string): Entry<JsonSchema> {
  const entry = draft.schemas.get(name)
  if (entry) return entry
  const from = draft.readOnlySchemas.get(name)
  if (from) throw new OpError(`o schema "${name}" é de ${from.shared} (${from.file}) e aqui é só leitura: edite onde ele está, ou crie um "${name}" no projeto com upsertSchema`)
  throw new OpError(`o schema "${name}" não existe (schemas do projeto: ${[...draft.schemas.keys()].join(', ') || 'nenhum'})`)
}

/** Quem cita o schema: "conector <id>", "fluxo <id>" ou "schema <nome>". */
function schemaUsers(draft: Draft, name: string): string[] {
  const out: string[] = []
  for (const [id, e] of draft.connectors) if (schemaRefs(e.doc.endpoints).has(name)) out.push(`conector ${id}`)
  for (const [id, e] of draft.flows) if (schemaRefs(e.doc).has(name)) out.push(`fluxo ${id}`)
  for (const [other, e] of draft.schemas) if (other !== name && schemaRefs(e.doc).has(name)) out.push(`schema ${other}`)
  return out
}

/** A origem de spec de cada endpoint do documento e o hash que os campos dele dão agora. */
function specSources(doc: Connector | Flow): { source: { hash: string }; hash: () => string }[] {
  if ('nodes' in doc) {
    const source = doc.source && 'hash' in doc.source ? (doc.source as { hash: string }) : undefined
    if (!source) return []
    const hash = () => {
      const e = requestFlowToEndpoint(doc)
      return typeof e === 'string' ? '' : endpointHash(e)
    }
    return [{ source, hash }]
  }
  return (doc.endpoints ?? []).flatMap((e) => (e.source ? [{ source: e.source, hash: () => endpointHash(e) }] : []))
}

/** Valor vazio de um tipo, para o campo novo nos exemplos quando o field não traz example. */
const EMPTY_BY_TYPE: Record<string, unknown> = { string: '', integer: 0, number: 0, boolean: false, array: [], object: {} }

/**
 * Leva o campo de um schema compartilhado para os corpos dos exemplos de resposta que o citam: em
 * {"$ref": "schema:<name>"} direto, numa lista (items) ou dentro de outro schema compartilhado. Só
 * caminhos de objeto ("a.b"); o exemplo que já tem o campo fica como está.
 */
function fillSchemaExamples(draft: Draft, name: string, path: string, field: BodyFieldSpec | null, op: number): void {
  if (path.includes('[')) throw new OpError('fillExamples vale para caminhos de objeto ("a.b"), não de lista')
  const keys = path.split('.')
  const value = field && (field.example !== undefined ? field.example : (EMPTY_BY_TYPE[String(field.type)] ?? null))
  const lookup = schemaLookup(draft)
  const apply = (body: Record<string, unknown>): boolean => {
    let at = body
    for (const k of keys.slice(0, -1)) {
      if (!at[k] || typeof at[k] !== 'object' || Array.isArray(at[k])) {
        if (!field) return false
        at[k] = {}
      }
      at = at[k] as Record<string, unknown>
    }
    const last = keys.at(-1)!
    if (!field) return last in at ? (delete at[last], true) : false
    if (last in at) return false
    at[last] = clone(value)
    return true
  }
  const visit = (schema: unknown, body: unknown, seen: Set<string>): boolean => {
    if (!schema || typeof schema !== 'object' || body === null || typeof body !== 'object') return false
    const s = schema as Record<string, unknown>
    const ref = typeof s['$ref'] === 'string' && s['$ref'].startsWith('schema:') ? s['$ref'].slice('schema:'.length) : undefined
    if (ref === name) return !Array.isArray(body) && apply(body as Record<string, unknown>)
    if (ref) return !seen.has(ref) && visit(lookup(ref), body, new Set([...seen, ref]))
    let changed = false
    if (Array.isArray(body)) {
      for (const item of body) changed = visit(s['items'], item, seen) || changed
      return changed
    }
    for (const [k, sub] of Object.entries((s['properties'] as Record<string, unknown> | undefined) ?? {})) {
      if (k in (body as Record<string, unknown>)) changed = visit(sub, (body as Record<string, unknown>)[k], seen) || changed
    }
    return changed
  }
  const fill = (examples: ResponseExample[] | undefined): boolean => {
    let changed = false
    for (const x of examples ?? []) {
      if (!x.schema || x.body === undefined) continue
      const parsed = typeof x.body === 'string' ? (() => { try { return JSON.parse(x.body as string) } catch { return undefined } })() : x.body
      if (parsed === undefined || !visit(x.schema, parsed, new Set())) continue
      x.body = typeof x.body === 'string' ? JSON.stringify(parsed, null, 2) : parsed
      changed = true
    }
    return changed
  }
  for (const e of draft.flows.values()) if (fill((e.doc as Flow & { examples?: ResponseExample[] }).examples)) touch(e, op)
  for (const e of draft.connectors.values()) {
    if (e.asFlows) continue
    let changed = false
    for (const endpoint of e.doc.endpoints ?? []) changed = fill(endpoint.examples) || changed
    if (changed) touch(e, op)
  }
}

/** Os lugares de um conector ou fluxo que guardam JSON Schema de corpo (bodySchema e schema dos exemplos). */
function bodySchemasOf(doc: Connector | Flow): JsonSchema[] {
  const out: JsonSchema[] = []
  const examples = (list: ResponseExample[] | undefined) => {
    for (const x of list ?? []) if (x.schema) out.push(x.schema)
  }
  if ('nodes' in doc) {
    for (const n of doc.nodes) if (n.type === 'request' && n.request.bodySchema) out.push(n.request.bodySchema)
    examples(doc.examples)
  } else {
    for (const e of doc.endpoints ?? []) {
      if (e.bodySchema) out.push(e.bodySchema)
      examples(e.examples)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Operações

const clone = <T>(v: T): T => structuredClone(v)

function readOnlyRefused(draft: Draft, id: string): void {
  const from = draft.readOnly.get(id)
  if (from) throw new OpError(`"${id}" é de ${from} e aqui é só leitura: edite onde ele está, ou crie outro id com "extends": "${id}"`)
}

function connectorEntry(draft: Draft, id: string): Entry<Connector> {
  readOnlyRefused(draft, id)
  const e = draft.connectors.get(id) ?? openFlowBase(draft, id)
  if (!e) {
    // "loja-api.criarPedido" é o id do fluxo de um endpoint, não de um conector.
    const dot = id.lastIndexOf('.')
    const owner = dot > 0 ? (draft.connectors.get(id.slice(0, dot)) ?? openFlowBase(draft, id.slice(0, dot))) : undefined
    const endpoint = id.slice(dot + 1)
    if (owner?.doc.endpoints?.some((x) => x.id === endpoint)) {
      throw new OpError(
        `conector "${id}" não existe: é o endpoint "${endpoint}" do conector "${id.slice(0, dot)}"; mude-o com upsertEndpoint, setBodyField ou setBodySchema { connectorId: "${id.slice(0, dot)}", endpointId: "${endpoint}" }`
      )
    }
    throw new OpError(`conector "${id}" não existe`)
  }
  return e
}

const catalogOf = (draft: Draft) =>
  new Map<string, Connector>([...draft.flowBases, ...[...draft.connectors].map(([id, e]) => [id, e.doc] as const)])

/**
 * As operações de conector valem num fluxo-base: ele abre aqui como o conector que é (com os
 * endpoints dos fluxos de requisição) e, no fim do lote, closeFlowBases o devolve aos fluxos.
 */
function openFlowBase(draft: Draft, id: string): Entry<Connector> | undefined {
  // Um fluxo-base criado antes no mesmo lote (upsertFlow) ainda não está em flowSources.
  const created = draft.flows.get(id)
  const baseFile = draft.flowSources.get(id) ?? (created && isBaseFlow(created.doc) ? created.file : undefined)
  const base = baseFile ? draft.flows.get(id) : undefined
  if (!base || base.file !== baseFile) return undefined
  const children = [...draft.flows.values()].filter((f) => f.doc.extends === id && !isBaseFlow(f.doc))
  const catalog = catalogOf(draft)
  catalog.delete(id)
  const compiled = compileFlows([base, ...children].map((f) => ({ flow: f.doc, file: f.file })), catalog)
  const connector = compiled.bases[0]?.connector
  if (!connector || compiled.issues.length) {
    throw new OpError(`"${id}" é um fluxo-base (${baseFile}) com problema (${compiled.issues.map((x) => x.message).join('; ')}): corrija o fluxo com upsertFlow`)
  }
  const { endpoints: _, ...own } = connector
  const backing: FlowBacking = { base, requests: new Map(), connector: own, endpoints: new Map() }
  for (const e of compiled.endpoints) {
    backing.requests.set(e.endpoint.id, draft.flows.get(e.flowId)!)
    backing.endpoints.set(e.endpoint.id, e.endpoint)
    draft.flows.delete(e.flowId)
    draft.flowSources.delete(`${id}/${e.endpoint.id}`)
  }
  draft.flows.delete(id)
  draft.flowSources.delete(id)
  draft.flowBases.delete(id)
  const endpoints = [...backing.endpoints.values()]
  const entry: Entry<Connector> = { file: base.file, doc: clone({ ...own, ...(endpoints.length && { endpoints }) }), dirty: false, op: -1, asFlows: backing }
  draft.connectors.set(id, entry)
  return entry
}

/**
 * `next` com as chaves na ordem de `prev` (o arquivo como estava), para a regravação mudar só o
 * que mudou; uma chave nova entra antes da primeira que vem depois dela em `next`.
 */
function inKeyOrder<T extends object>(next: T, prev: object): T {
  const order = Object.keys(prev).filter((k) => k in next)
  const canonical = Object.keys(next)
  for (const [i, key] of canonical.entries()) {
    if (order.includes(key)) continue
    const after = canonical.slice(i + 1).find((k) => order.includes(k))
    order.splice(after === undefined ? order.length : order.indexOf(after), 0, key)
  }
  return Object.fromEntries(order.map((k) => [k, (next as Record<string, unknown>)[k]])) as T
}

/** Devolve aos fluxos os fluxos-base abertos no lote; só regrava a base e os endpoints que mudaram. */
function closeFlowBases(draft: Draft, errors: ProjectOpIssue[]): void {
  for (const [id, entry] of [...draft.connectors]) {
    const backing = entry.asFlows
    if (!backing) continue
    const flows = connectorToFlows(entry.doc, chainBasePath(id, catalogOf(draft)))
    draft.connectors.delete(id)
    const { endpoints = [], ...own } = entry.doc
    if (flows.unsupported.length) {
      errors.push({ op: entry.op, message: `"${id}" é um fluxo-base e o fluxo ainda não guarda: ${flows.unsupported.join('; ')}` })
      continue
    }
    const { base } = backing
    if (!isDeepStrictEqual(own, backing.connector)) {
      if (isDeepStrictEqual(own.config, backing.connector.config)) {
        // Só o nome, a descrição, a versão, o pai ou a origem: o resto do fluxo fica como estava.
        const doc = base.doc as Flow & Record<string, unknown>
        for (const key of ['name', 'description', 'version', 'extends', 'source'] as const) {
          if (isDeepStrictEqual(own[key], backing.connector[key])) continue
          if (own[key] === undefined) delete doc[key]
          else doc[key] = own[key] as never
        }
      } else base.doc = flows.base
      touch(base, entry.op)
    }
    draft.flows.set(id, base)
    draft.flowSources.set(id, base.file)
    // Uma base na pasta dela (flows/<id>/<id>.flow.vvpost.json) recebe os endpoints novos ao lado.
    const folder = basename(dirname(base.file)) === id ? dirname(base.file) : undefined
    const requests: Entry<Flow>[] = []
    for (const endpoint of endpoints) {
      let request = backing.requests.get(endpoint.id)
      if (!request || !isDeepStrictEqual(endpoint, backing.endpoints.get(endpoint.id))) {
        const flow = flows.requests.find((r) => r.id === `${id}.${endpoint.id}`)!
        delete flow.order
        if (request) {
          flow.id = request.doc.id
          if (request.doc.order !== undefined) flow.order = request.doc.order
          // O nó guarda o id e o nome do arquivo ("req" de quem escreveu à mão): é por eles que um
          // [REDACTED_SECRET] lido volta ao valor de antes (guard.ts) e que o diff fica só no que mudou.
          const node = request.doc.nodes[0]
          if (node) Object.assign(flow.nodes[0]!, { id: node.id, name: node.name })
          request.doc = inKeyOrder(flow, request.doc)
          touch(request, entry.op)
        } else {
          const file = folder ? `${folder}/${endpoint.id}${FLOW_SUFFIX}` : `flows/${flow.id}${FLOW_SUFFIX}`
          request = { file, doc: flow, dirty: true, op: entry.op }
        }
      }
      requests.push(request)
    }
    // Um endpoint novo vai depois dos outros. Se a ordem que os arquivos dão não for a do
    // conector, renumera, gravando só os arquivos cujo order muda.
    const isNew = (i: number) => !backing.requests.has(endpoints[i]!.id)
    if (requests.every((r, i) => isNew(i) || r.doc.order !== undefined)) {
      let next = Math.max(0, ...requests.map((r) => r.doc.order ?? 0))
      requests.forEach((r, i) => {
        if (isNew(i)) r.doc.order = ++next
      })
    }
    const rank = (r: Entry<Flow>) => r.doc.order ?? Number.MAX_SAFE_INTEGER
    const compiledOrder = requests.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.r.file.localeCompare(b.r.file))
    if (compiledOrder.some(({ i }, at) => i !== at)) {
      for (const [index, r] of requests.entries()) {
        if (r.doc.order === index + 1) continue
        r.doc = { ...r.doc, order: index + 1 }
        touch(r, entry.op)
      }
    }
    for (const [index, endpoint] of endpoints.entries()) {
      const request = requests[index]!
      if (draft.flows.has(request.doc.id)) {
        errors.push({ op: entry.op, message: `o endpoint "${endpoint.id}" de "${id}" e o fluxo "${request.doc.id}" que já existe teriam o mesmo id` })
        continue
      }
      draft.flows.set(request.doc.id, request)
      draft.flowSources.set(`${id}/${endpoint.id}`, request.file)
    }
    for (const [endpointId, request] of backing.requests) {
      if (!endpoints.some((e) => e.id === endpointId)) draft.deleted.set(request.file, entry.op)
    }
    draft.flowBases.set(id, entry.doc)
  }
}

function endpointOf(draft: Draft, entry: Entry<Connector>, endpointId: string): Endpoint {
  const e = entry.doc.endpoints?.find((x) => x.id === endpointId)
  const flow = draft.flowSources.get(`${entry.doc.id}/${endpointId}`)
  if (!e && flow) throw new OpError(`o endpoint "${endpointId}" de "${entry.doc.id}" é um fluxo de requisição (${flow}): edite o fluxo com upsertFlow`)
  if (!e) throw new OpError(`endpoint "${endpointId}" não existe em "${entry.doc.id}"`)
  return e
}

/** Um endpoint novo não pode ter o id de um fluxo de requisição do mesmo conector. */
function endpointOfFlowRefused(draft: Draft, connectorId: string, endpointId: string): void {
  const flow = draft.flowSources.get(`${connectorId}/${endpointId}`)
  if (flow) throw new OpError(`"${connectorId}" já tem o endpoint "${endpointId}" no fluxo de requisição ${flow}`)
}

/** Fluxos que herdam do conector (extends). */
function flowsExtending(draft: Draft, connectorId: string): string[] {
  return [...draft.flows.values()].filter((f) => f.doc.extends === connectorId).map((f) => f.doc.id)
}

function touch<T>(entry: Entry<T>, op: number): void {
  entry.dirty = true
  entry.op = op
}

function cleanPath(target: string, suffix: string, what: string): string {
  const clean = normalize(target)
  if (isAbsolute(target) || clean.startsWith('..') || clean.split(sep).some((p) => p.startsWith('.') && p !== '.') || !clean.endsWith(suffix)) {
    throw new OpError(`caminho de ${what} inválido: ${target} (relativo ao workspace, terminado em ${suffix})`)
  }
  return clean.split(sep).join('/')
}

/** O ambiente do lote; um arquivo inválido diz por que não dá para editar, em vez de "não existe". */
function environmentEntry(draft: Draft, id: string): Entry<Environment> {
  const entry = draft.environments.get(id)
  if (entry) return entry
  const inProject = isProjectDir(draft.dir)
  throw new OpError(
    draft.invalidEnvironments.get(id) ??
      `ambiente "${id}" não existe${inProject ? ' neste projeto; para complementar um ambiente do Compartilhado, crie antes upsertEnvironment com o mesmo id (as variáveis do projeto se somam às da raiz)' : ''}`
  )
}

function envFile(id: string): string {
  return `environments/${id.replace(/^env\./, '')}${ENV_SUFFIX}`
}

export function docsFileOf(connectorFile: string): string {
  // Um fluxo-base documenta no <nome>.flow.vvpost.md ao lado.
  if (connectorFile.endsWith(FLOW_SUFFIX)) return connectorFile.slice(0, -'.json'.length) + '.md'
  return connectorFile.slice(0, -CONNECTOR_SUFFIX.length) + DOCS_SUFFIX
}

function insertAt<T>(list: T[], item: T, index: number | undefined): void {
  if (index === undefined || index >= list.length) list.push(item)
  else list.splice(Math.max(0, index), 0, item)
}

function applyOp(draft: Draft, op: ProjectOp, i: number, warnings: ProjectOpIssue[]): void {
  switch (op.op) {
    case 'upsertConnector': {
      const doc = clone(op.connector)
      if (!doc || typeof doc !== 'object' || typeof doc.id !== 'string') throw new OpError('connector precisa de um id')
      delete doc.$schema
      readOnlyRefused(draft, doc.id)
      const existing = draft.connectors.get(doc.id) ?? openFlowBase(draft, doc.id)
      if (existing?.asFlows && op.file) throw new OpError(`"${doc.id}" é um fluxo-base (${existing.file}): o arquivo é o do fluxo`)
      const file = op.file ? cleanPath(op.file, CONNECTOR_SUFFIX, 'conector') : (existing?.file ?? `connectors/${doc.id}${CONNECTOR_SUFFIX}`)
      if (existing) {
        if (file !== existing.file) moveFile(draft, existing, file)
        existing.doc = doc
        touch(existing, i)
      } else {
        draft.connectors.set(doc.id, { file, doc, dirty: true, op: i })
      }
      return
    }
    case 'patchConnector': {
      const entry = connectorEntry(draft, op.id)
      const set = op.set ?? {}
      const doc = entry.doc as Connector & Record<string, unknown>
      for (const key of ['name', 'description', 'version', 'extends', 'config', 'source'] as const) {
        if (!(key in set)) continue
        const value = set[key]
        if (value === null) delete doc[key]
        else if (key === 'config') doc.config = mergeConfig(doc.config, value as Record<string, unknown>, i, warnings) as never
        else doc[key] = clone(value) as never
      }
      touch(entry, i)
      return
    }
    case 'moveConnector': {
      const entry = connectorEntry(draft, op.id)
      if (entry.asFlows && ((op.newId && op.newId !== op.id) || op.file)) {
        throw new OpError(`"${op.id}" é um fluxo-base (${entry.file}): renomeie ou mova o fluxo com upsertFlow`)
      }
      if (op.extends !== undefined) {
        if (op.extends === null) delete entry.doc.extends
        else entry.doc.extends = op.extends
      }
      if (op.newId && op.newId !== op.id) {
        if (draft.connectors.has(op.newId) || draft.flowSources.has(op.newId) || draft.readOnly.has(op.newId)) throw new OpError(`já existe um conector "${op.newId}"`)
        draft.connectors.delete(op.id)
        entry.doc.id = op.newId
        draft.connectors.set(op.newId, entry)
        draft.renamed.set(op.newId, draft.renamed.get(op.id) ?? op.id)
        draft.renamed.delete(op.id)
        for (const child of draft.connectors.values()) {
          if (child.doc.extends === op.id) {
            child.doc.extends = op.newId
            touch(child, i)
          }
        }
        for (const flow of draft.flows.values()) {
          if (renameConnectorInFlow(flow.doc, op.id, op.newId)) touch(flow, i)
        }
        // O arquivo acompanha o id quando seguia a convenção connectors/<id>.connector.vvpost.json.
        if (!op.file && entry.file === `connectors/${op.id}${CONNECTOR_SUFFIX}`) {
          moveFile(draft, entry, `connectors/${op.newId}${CONNECTOR_SUFFIX}`)
        }
      }
      if (op.file) moveFile(draft, entry, cleanPath(op.file, CONNECTOR_SUFFIX, 'conector'))
      touch(entry, i)
      return
    }
    case 'deleteConnector': {
      const entry = connectorEntry(draft, op.id)
      const children = [...draft.connectors.values()].filter((c) => c.doc.extends === op.id).map((c) => c.doc.id)
      children.push(...flowsExtending(draft, op.id))
      if (children.length) throw new OpError(`"${op.id}" tem filhos (${children.join(', ')}); mova ou apague os filhos antes`)
      draft.connectors.delete(op.id)
      draft.deleted.set(entry.from ?? entry.file, i)
      if (entry.from) draft.deleted.set(entry.file, i)
      for (const request of entry.asFlows?.requests.values() ?? []) draft.deleted.set(request.file, i)
      draft.docs.set(docsFileOf(entry.file), { text: null, op: i })
      const users = flowsUsing(draft, op.id)
      if (users.length) warnings.push({ op: i, message: `os fluxos ${users.join(', ')} usam "${op.id}"` })
      return
    }
    case 'upsertEndpoint': {
      const entry = connectorEntry(draft, op.connectorId)
      const endpoint = clone(op.endpoint)
      if (!endpoint || typeof endpoint.id !== 'string') throw new OpError('endpoint precisa de um id')
      endpointOfFlowRefused(draft, op.connectorId, endpoint.id)
      const list = (entry.doc.endpoints ??= [])
      const at = list.findIndex((e) => e.id === endpoint.id)
      if (at >= 0) {
        if (endpoint.scenarios === undefined && op.keepScenarios !== false && list[at]!.scenarios) {
          endpoint.scenarios = list[at]!.scenarios
        }
        if (endpoint.examples === undefined && op.keepScenarios !== false && list[at]!.examples) {
          endpoint.examples = list[at]!.examples
        }
        if (op.index !== undefined && op.index !== at) {
          list.splice(at, 1)
          insertAt(list, endpoint, op.index)
        } else list[at] = endpoint
      } else insertAt(list, endpoint, op.index)
      touch(entry, i)
      return
    }
    case 'moveEndpoint': {
      const from = connectorEntry(draft, op.connectorId)
      const endpoint = endpointOf(draft, from, op.endpointId)
      const to = op.toConnectorId ? connectorEntry(draft, op.toConnectorId) : from
      const newId = op.newId ?? endpoint.id
      if ((to !== from || newId !== endpoint.id) && to.doc.endpoints?.some((e) => e.id === newId)) {
        throw new OpError(`já existe o endpoint "${newId}" em "${to.doc.id}"`)
      }
      endpointOfFlowRefused(draft, to.doc.id, newId)
      from.doc.endpoints = from.doc.endpoints!.filter((e) => e !== endpoint)
      if (!from.doc.endpoints.length) delete from.doc.endpoints
      endpoint.id = newId
      insertAt((to.doc.endpoints ??= []), endpoint, op.index)
      touch(from, i)
      touch(to, i)
      for (const flow of draft.flows.values()) {
        if (moveEndpointInFlow(flow.doc, from.doc.id, op.endpointId, to.doc.id, newId)) touch(flow, i)
      }
      return
    }
    case 'deleteEndpoint': {
      const entry = connectorEntry(draft, op.connectorId)
      const endpoint = endpointOf(draft, entry, op.endpointId)
      entry.doc.endpoints = entry.doc.endpoints!.filter((e) => e !== endpoint)
      if (!entry.doc.endpoints.length) delete entry.doc.endpoints
      touch(entry, i)
      const users = flowsUsing(draft, op.connectorId, op.endpointId)
      if (users.length) warnings.push({ op: i, message: `os fluxos ${users.join(', ')} usam o endpoint "${op.endpointId}"` })
      return
    }
    case 'upsertScenario': {
      const entry = connectorEntry(draft, op.connectorId)
      const endpoint = endpointOf(draft, entry, op.endpointId)
      const scenario = clone(op.scenario)
      if (!scenario || typeof scenario.id !== 'string') throw new OpError('scenario precisa de um id')
      const list = (endpoint.scenarios ??= [])
      const at = list.findIndex((s) => s.id === scenario.id)
      if (at >= 0) list[at] = scenario
      else list.push(scenario)
      touch(entry, i)
      return
    }
    case 'deleteScenario': {
      const entry = connectorEntry(draft, op.connectorId)
      const endpoint = endpointOf(draft, entry, op.endpointId)
      const before = endpoint.scenarios?.length ?? 0
      endpoint.scenarios = (endpoint.scenarios ?? []).filter((s) => s.id !== op.scenarioId)
      if (endpoint.scenarios.length === before) throw new OpError(`cenário "${op.scenarioId}" não existe em "${op.endpointId}"`)
      if (!endpoint.scenarios.length) delete endpoint.scenarios
      touch(entry, i)
      return
    }
    case 'setBodySchema': {
      const entry = connectorEntry(draft, op.connectorId)
      const endpoint = endpointOf(draft, entry, op.endpointId)
      let schema = op.schema ?? undefined
      if (op.fromBody) {
        const body = bodyValue(endpoint.body)
        if (body === undefined) throw new OpError(`o endpoint "${op.endpointId}" não tem corpo padrão em JSON para gerar o schema`)
        schema = inferBodySchema(body)
      }
      if (schema !== undefined && (typeof schema !== 'object' || Array.isArray(schema))) throw new OpError('schema precisa ser um objeto JSON Schema')
      if (schema) endpoint.bodySchema = clone(schema)
      else delete endpoint.bodySchema
      touch(entry, i)
      return
    }
    case 'setBodyField': {
      const entry = connectorEntry(draft, op.connectorId)
      const endpoint = endpointOf(draft, entry, op.endpointId)
      // O corpo é um schema compartilhado: o campo muda nele, para todos os endpoints que o citam.
      const shared = rootSchemaName(endpoint.bodySchema)
      if (shared !== undefined) {
        applyOp(draft, { op: 'setSchemaField', name: shared, path: op.path, field: op.field }, i, warnings)
        const users = schemaUsers(draft, shared)
        warnings.push({ op: i, message: `o corpo de "${op.connectorId}/${op.endpointId}" é o schema compartilhado "${shared}": o campo mudou em ${schemaFile(shared)}, que vale para ${users.join(', ')}` })
        return
      }
      try {
        const next = setBodyField(endpoint.bodySchema, op.path, op.field)
        if (next) endpoint.bodySchema = next
        else delete endpoint.bodySchema
      } catch (err) {
        if (err instanceof BodySchemaError) throw new OpError(err.message)
        throw err
      }
      touch(entry, i)
      return
    }
    case 'upsertSchema': {
      if (typeof op.name !== 'string' || !SCHEMA_NAME.test(op.name)) {
        throw new OpError(`nome de schema inválido: "${String(op.name)}" (letras, números, _, . e -, começando por letra ou _)`)
      }
      if (!op.schema || typeof op.schema !== 'object' || Array.isArray(op.schema)) throw new OpError('schema precisa ser um objeto JSON Schema')
      const doc = clone(op.schema)
      if (rootSchemaName(doc) === op.name) {
        throw new OpError(`o schema "${op.name}" não pode ser só a citação dele mesmo; mande o schema inteiro ou mude um campo com setSchemaField`)
      }
      const existing = draft.schemas.get(op.name)
      if (existing) {
        existing.doc = doc
        touch(existing, i)
        return
      }
      const root = draft.readOnlySchemas.get(op.name)
      if (root) warnings.push({ op: i, message: `o schema "${op.name}" do projeto passa a valer aqui no lugar do de ${root.shared}` })
      draft.deleted.delete(schemaFile(op.name))
      draft.schemas.set(op.name, { file: schemaFile(op.name), doc, dirty: true, op: i })
      return
    }
    case 'deleteSchema': {
      const entry = schemaEntry(draft, op.name)
      const users = schemaUsers(draft, op.name)
      if (users.length) throw new OpError(`o schema "${op.name}" é citado por ${users.join(', ')}; troque as citações antes de apagar`)
      draft.schemas.delete(op.name)
      draft.deleted.set(entry.file, i)
      return
    }
    case 'setSchemaField': {
      const entry = schemaEntry(draft, op.name)
      try {
        entry.doc = setBodyField(entry.doc, op.path, op.field) ?? { type: 'object' }
      } catch (err) {
        if (err instanceof BodySchemaError) throw new OpError(err.message)
        throw err
      }
      touch(entry, i)
      if (op.fillExamples) fillSchemaExamples(draft, op.name, op.path, op.field, i)
      return
    }
    case 'extractSchemas': {
      const minUses = op.minUses ?? 2
      if (!Number.isInteger(minUses) || minUses < 1) throw new OpError('minUses precisa ser um inteiro a partir de 1')
      const docs: (Entry<Connector> | Entry<Flow>)[] = [...draft.connectors.values(), ...draft.flows.values()]
      const before = docs.map((e) => JSON.stringify(e.doc))
      // Endpoints de spec ainda como vieram dela: o hash acompanha, para a reimportação não ver edição.
      const fromSpec = docs.flatMap((e) => specSources(e.doc).filter((x) => x.source.hash === x.hash()))
      const existing = new Map<string, JsonSchema>([...[...draft.readOnlySchemas].map(([n, s]) => [n, s.schema] as const), ...[...draft.schemas].map(([n, e]) => [n, e.doc] as const)])
      const found = extractSharedSchemas(docs.flatMap((e) => bodySchemasOf(e.doc)), existing, minUses)
      for (const x of fromSpec) x.source.hash = x.hash()
      docs.forEach((e, at) => {
        if (JSON.stringify(e.doc) !== before[at]) touch(e as Entry<unknown>, i)
      })
      for (const [name, schema] of found.schemas) {
        draft.deleted.delete(schemaFile(name))
        draft.schemas.set(name, { file: schemaFile(name), doc: schema, dirty: true, op: i })
      }
      const summary = [...found.uses].map(([name, n]) => `${name} (${n})`).join(', ')
      warnings.push({ op: i, message: summary ? `schemas compartilhados citados no lugar das cópias: ${summary}` : 'nenhum schema repetido para compartilhar' })
      return
    }
    case 'upsertExample': {
      const entry = connectorEntry(draft, op.connectorId)
      const endpoint = endpointOf(draft, entry, op.endpointId)
      const example = clone(op.example)
      if (!example || typeof example.id !== 'string') throw new OpError('example precisa de um id')
      const list = (endpoint.examples ??= [])
      const at = list.findIndex((e) => e.id === example.id)
      if (at >= 0) list[at] = example
      else list.push(example)
      touch(entry, i)
      return
    }
    case 'deleteExample': {
      const entry = connectorEntry(draft, op.connectorId)
      const endpoint = endpointOf(draft, entry, op.endpointId)
      const before = endpoint.examples?.length ?? 0
      endpoint.examples = (endpoint.examples ?? []).filter((e) => e.id !== op.exampleId)
      if (endpoint.examples.length === before) throw new OpError(`exemplo "${op.exampleId}" não existe em "${op.endpointId}"`)
      if (!endpoint.examples.length) delete endpoint.examples
      touch(entry, i)
      return
    }
    case 'upsertEnvironment': {
      const incoming = clone(op.environment)
      if (!incoming || typeof incoming.id !== 'string') throw new OpError('environment precisa de um id')
      const existing = draft.environments.get(incoming.id)
      if (!existing && draft.invalidEnvironments.has(incoming.id)) throw new OpError(draft.invalidEnvironments.get(incoming.id)!)
      if (!existing) {
        const doc: Environment = {
          id: incoming.id,
          name: incoming.name,
          ...(incoming.description !== undefined && { description: incoming.description }),
          variables: incoming.variables ?? {}
        }
        draft.environments.set(incoming.id, { file: envFile(incoming.id), doc, dirty: true, op: i })
        return
      }
      const doc = existing.doc
      if (incoming.name !== undefined) doc.name = incoming.name
      if (incoming.description !== undefined) doc.description = incoming.description
      for (const [name, variable] of Object.entries(incoming.variables ?? {})) {
        const current = doc.variables[name]
        if (current && !op.overwriteValues) {
          // Valor, tipo e isSecret ficam os do projeto; descrição e placeholder vêm do novo.
          const { isSecret: _isSecret, ...rest } = variable
          const merged = { ...rest, type: current.type, value: current.value, ...(current.isSecret && { isSecret: true }) }
          // Igual ao que já está: mantém o objeto (e a ordem das chaves), para não regravar o arquivo à toa.
          doc.variables[name] = (isDeepStrictEqual(merged, current) ? current : merged) as never
        } else {
          doc.variables[name] = variable
        }
      }
      touch(existing, i)
      return
    }
    case 'deleteEnvironment': {
      const entry = environmentEntry(draft, op.id)
      draft.environments.delete(op.id)
      draft.deleted.set(entry.file, i)
      return
    }
    case 'setVariable': {
      const entry = environmentEntry(draft, op.environmentId)
      const vars = entry.doc.variables
      const current = vars[op.name]
      const secret = op.secret ?? current?.isSecret ?? false
      const keepValue = current !== undefined && !op.overwrite && !(secret && !current.isSecret)
      let next: Environment['variables'][string]
      if (secret) {
        next = { type: 'string', value: REQUIRED_SECRET, isSecret: true }
      } else {
        const value = keepValue ? current!.value : (op.value ?? current?.value ?? '')
        if (value === REQUIRED_SECRET) throw new OpError(`${op.name}: ${REQUIRED_SECRET} só vale para variáveis secretas`)
        next = { type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string', value } as never
      }
      const description = op.description ?? current?.description
      const placeholder = op.placeholder ?? current?.placeholder
      vars[op.name] = { ...next, ...(description !== undefined && { description }), ...(placeholder !== undefined && { placeholder }) }
      if (secret && op.value !== undefined) {
        // O valor vai para o vault, nunca para o arquivo versionado.
        draft.secrets.push({
          value: { environmentId: op.environmentId, variable: op.name, value: String(op.value) },
          overwrite: !!op.overwrite,
          op: i
        })
      }
      touch(entry, i)
      return
    }
    case 'deleteVariable': {
      const entry = environmentEntry(draft, op.environmentId)
      if (!(op.name in entry.doc.variables)) throw new OpError(`variável "${op.name}" não existe em "${op.environmentId}"`)
      delete entry.doc.variables[op.name]
      touch(entry, i)
      return
    }
    case 'upsertFlow': {
      const doc = clone(op.flow)
      if (!doc || typeof doc.id !== 'string') throw new OpError('flow precisa de um id')
      delete doc.$schema
      // Uma base com o id de um conector só de leitura trocaria, aqui, o que é de outro lugar.
      if (doc.defaults || doc.nodes?.some((n) => n.type === 'request' && n.cache)) readOnlyRefused(draft, doc.id)
      if (draft.connectors.get(doc.id)?.asFlows) throw new OpError(`"${doc.id}" foi editado como conector neste lote; mande o fluxo em outro lote`)
      const existing = draft.flows.get(doc.id)
      const file = op.file ? cleanPath(op.file, FLOW_SUFFIX, 'fluxo') : (existing?.file ?? `flows/${doc.id}${FLOW_SUFFIX}`)
      if (existing) {
        if (file !== existing.file) moveFile(draft, existing, file)
        existing.doc = doc
        touch(existing, i)
      } else draft.flows.set(doc.id, { file, doc, dirty: true, op: i })
      return
    }
    case 'migrateConnector': {
      if (draft.flowSources.has(op.id) || draft.connectors.get(op.id)?.asFlows) throw new OpError(`"${op.id}" já é um fluxo-base`)
      const entry = connectorEntry(draft, op.id)
      const catalog = catalogOf(draft)
      const { base, requests, unsupported } = connectorToFlows(entry.doc, chainBasePath(op.id, catalog))
      if (unsupported.length) throw new OpError(`"${op.id}" ainda não cabe no formato de fluxos: ${unsupported.join('; ')}`)
      catalog.delete(op.id)
      const folder = `flows/${op.id}`
      const files = new Map<Flow, string>([[base, `${folder}/${op.id}${FLOW_SUFFIX}`]])
      for (const r of requests) files.set(r, `${folder}/${r.id.slice(op.id.length + 1)}${FLOW_SUFFIX}`)
      // Os fluxos de requisição que já herdavam do conector continuam endpoints dele.
      const children = [...draft.flows.values()]
        .filter((f) => f.doc.extends === op.id && !isBaseFlow(f.doc))
        .map((f) => ({ flow: f.doc, file: f.file }))
      const compiled = compileFlows([...[...files].map(([flow, file]) => ({ flow, file })), ...children], catalog)
      if (compiled.issues.length || !compiled.bases[0]) {
        throw new OpError(`"${op.id}" não converte: ${compiled.issues.map((x) => x.message).join('; ') || 'a base não compila'}`)
      }
      for (const [flow] of files) {
        const taken = draft.flows.get(flow.id)
        if (taken) throw new OpError(`já existe o fluxo "${flow.id}" (${taken.file})`)
      }
      draft.connectors.delete(op.id)
      draft.deleted.set(entry.from ?? entry.file, i)
      if (entry.from) draft.deleted.set(entry.file, i)
      for (const [flow, file] of files) draft.flows.set(flow.id, { file, doc: flow, dirty: true, op: i })
      // A documentação vai para o .flow.vvpost.md da base; sem .md, nada é criado (planChanges).
      const oldDocs = docsFileOf(entry.file)
      const moved = draft.docs.get(oldDocs)
      draft.docs.set(oldDocs, { text: null, op: i })
      draft.docs.set(docsFileOf(files.get(base)!), moved?.text != null ? { ...moved, op: i } : { text: null, moveFrom: oldDocs, op: i })
      // Daqui em diante no lote (e na validação do fim), o conector é o da base.
      const connector = compiled.bases[0].connector
      draft.flowBases.set(op.id, { ...connector, endpoints: compiled.endpoints.map((e) => e.endpoint) })
      draft.flowSources.set(op.id, files.get(base)!)
      for (const e of compiled.endpoints) draft.flowSources.set(`${op.id}/${e.endpoint.id}`, e.file)
      return
    }
    case 'deleteFlow': {
      const entry = draft.flows.get(op.id)
      if (!entry) throw new OpError(`fluxo "${op.id}" não existe`)
      draft.flows.delete(op.id)
      draft.deleted.set(entry.file, i)
      return
    }
    case 'writeDoc': {
      const entry = connectorEntry(draft, op.connectorId)
      if (typeof op.markdown !== 'string') throw new OpError('markdown precisa ser texto')
      draft.docs.set(docsFileOf(entry.file), { text: op.markdown === '' ? null : op.markdown, op: i })
      return
    }
    case 'storeSecret': {
      const env = environmentEntry(draft, op.environmentId)
      if (!env.doc.variables[op.variable]?.isSecret) {
        throw new OpError(`"${op.variable}" não é uma variável secreta de "${op.environmentId}"; crie com setVariable secret: true`)
      }
      draft.secrets.push({
        value: { environmentId: op.environmentId, variable: op.variable, value: op.value },
        overwrite: !!op.overwrite,
        op: i
      })
      return
    }
    default:
      throw new OpError(`operação desconhecida: ${String((op as { op?: unknown }).op)}`)
  }
}

/**
 * config do patchConnector por chave, não inteiro: mudar a baseUrl ou um header não exige reenviar
 * a auth (nem a apaga sem querer). null numa chave a remove; headers mesclam pelo nome, e a lista
 * [{name, value}] que o agente costuma mandar vira o objeto do formato.
 */
function mergeConfig(current: unknown, patch: Record<string, unknown>, op: number, warnings: { op: number; message: string }[]): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new OpError('config precisa ser um objeto (as chaves mandadas trocam as de agora; null remove)')
  const out: Record<string, unknown> = { ...((current as Record<string, unknown> | undefined) ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key]
      continue
    }
    if (key !== 'headers') {
      out[key] = clone(value)
      continue
    }
    let headers = value as unknown
    if (Array.isArray(headers)) {
      if (!headers.every((h) => h && typeof h === 'object' && typeof h.name === 'string')) {
        throw new OpError('config.headers é um objeto {"Nome": "valor"} (null remove um header), não uma lista')
      }
      headers = Object.fromEntries(headers.map((h: { name: string; value?: unknown }) => [h.name, h.value ?? null]))
      warnings.push({ op, message: 'config.headers veio como lista [{name, value}] e foi gravado no formato {"Nome": "valor"}' })
    }
    if (!headers || typeof headers !== 'object') throw new OpError('config.headers é um objeto {"Nome": "valor"} (null remove um header)')
    const merged: Record<string, unknown> = { ...((out['headers'] as Record<string, unknown> | undefined) ?? {}) }
    for (const [name, v] of Object.entries(headers)) {
      if (v === null) delete merged[name]
      else if (typeof v !== 'string') throw new OpError(`config.headers.${name} precisa ser texto (um valor ou {{VAR}})`)
      else merged[name] = v
    }
    if (Object.keys(merged).length) out['headers'] = merged
    else delete out['headers']
  }
  return out
}

/** Muda o arquivo de um conector ou fluxo; a documentação do conector vai junto. */
function moveFile(draft: Draft, entry: Entry<Connector> | Entry<Flow>, file: string): void {
  if (file === entry.file) return
  const isConnector = entry.file.endsWith(CONNECTOR_SUFFIX)
  entry.from ??= entry.file
  if (isConnector) {
    const oldDocs = docsFileOf(entry.file)
    const moved = draft.docs.get(oldDocs)
    draft.docs.set(oldDocs, { text: null, op: entry.op })
    // Sem um texto novo no lote, o .md antigo é lido em planChanges.
    draft.docs.set(docsFileOf(file), moved ?? { text: null, moveFrom: oldDocs, op: entry.op })
  }
  entry.file = file
}

function renameConnectorInFlow(flow: Flow, from: string, to: string): boolean {
  let changed = false
  if (flow.extends === from) {
    flow.extends = to
    changed = true
  }
  for (const node of flow.nodes) {
    const target = node.type === 'request' ? node.request : node.type === 'plugin' ? node.plugin : undefined
    if (target && 'connector' in target && target.connector === from) {
      target.connector = to
      changed = true
    }
  }
  return changed
}

function moveEndpointInFlow(flow: Flow, fromConnector: string, fromEndpoint: string, toConnector: string, toEndpoint: string): boolean {
  let changed = false
  for (const node of flow.nodes) {
    if (node.type === 'request' && node.request.connector === fromConnector && node.request.endpoint === fromEndpoint) {
      node.request.connector = toConnector
      node.request.endpoint = toEndpoint
      changed = true
    }
  }
  return changed
}

function flowsUsing(draft: Draft, connectorId: string, endpointId?: string): string[] {
  return [...draft.flows.values()]
    .filter((f) =>
      f.doc.nodes.some((n) =>
        n.type === 'request'
          ? n.request.connector === connectorId && (endpointId === undefined || n.request.endpoint === endpointId)
          : n.type === 'plugin' && endpointId === undefined && n.plugin.connector === connectorId
      )
    )
    .map((f) => f.doc.id)
}

// ---------------------------------------------------------------------------
// Validação

/**
 * As bases que vêm de fora dos fluxos compilados. Uma base que está entre eles compila de novo
 * a partir do arquivo; passada também como conector, o compileFlows a ignora como id repetido e
 * os endpoints dela somem da validação (o corpo e os exemplos deixavam de ser conferidos).
 */
function basesOutside(draft: Draft, flows: Iterable<Flow>): Map<string, Connector> {
  const own = new Set([...flows].filter(isBaseFlow).map((f) => f.id))
  return new Map([...draft.flowBases].filter(([id]) => !own.has(id)))
}

function validate(draft: Draft, original: DraftSnapshot, result: ProjectApplyResult): void {
  const fmt = (issues: { path: string; message: string }[]) =>
    issues.slice(0, 5).map((x) => `${x.path || '/'}: ${x.message}`).join('; ')
  for (const [id, e] of draft.connectors) {
    if (!e.dirty) continue
    const r = validateConnector(e.doc)
    if (!r.ok) {
      result.errors.push({ op: e.op, message: `conector "${id}" inválido: ${fmt(r.issues)}` })
      continue
    }
    const literals = literalSecrets(r.value)
    if (literals.length) {
      result.errors.push({
        op: e.op,
        message: `credencial escrita direto no conector "${id}" (${literals.join(', ')}); use uma variável {{NOME}} de um ambiente, marcada como segredo`
      })
    }
  }
  const final = new Map<string, Connector>([...draft.flowBases, ...[...draft.connectors].map(([id, e]) => [id, e.doc] as const)])
  for (const [id, e] of draft.connectors) {
    // Herança quebrada que já existia antes do lote não é culpa dele.
    const wasOk = original.connectors.has(draft.renamed.get(id) ?? id) ? chainOk(draft.renamed.get(id) ?? id, original.connectors) : true
    if (wasOk && !chainOk(id, final)) {
      result.errors.push({ op: e.op, message: chainError(id, final) })
    }
  }
  for (const [id, e] of draft.environments) {
    if (!e.dirty) continue
    const r = validateEnvironment(e.doc)
    if (!r.ok) result.errors.push({ op: e.op, message: `ambiente "${id}" inválido: ${fmt(r.issues)}` })
  }
  // Os fluxos como o catálogo os lê: bases criadas no lote contam para os nós, e um fluxo de
  // requisição do lote que não vira endpoint diz por quê (antes, só o catálogo mostrava, depois).
  const compiled = compileFlows(
    [...draft.flows.values()].map((e) => ({ flow: e.doc, file: e.file })),
    basesOutside(draft, [...draft.flows.values()].map((e) => e.doc))
  )
  const withFlowBases = new Map(final)
  for (const { connector } of compiled.bases) {
    if (withFlowBases.has(connector.id)) continue
    const endpoints = compiled.endpoints.filter((x) => x.connectorId === connector.id).map((x) => x.endpoint)
    withFlowBases.set(connector.id, { ...connector, endpoints })
  }
  const dirtyByFile = new Map([...draft.flows.values()].filter((e) => e.dirty).map((e) => [e.file, e] as const))
  for (const issue of compiled.issues) {
    const e = dirtyByFile.get(issue.file)
    const doc = e?.doc as (Flow & { scenarios?: unknown[]; examples?: unknown[] }) | undefined
    // Só o nó que não cabe num endpoint (pathParams, followRedirects...): com cenários ou exemplos,
    // eles seriam ignorados em silêncio. O resto das issues o catálogo já mostra.
    if (!e || !doc?.extends || !issue.message.includes(`o nó de "${doc.id}"`)) continue
    if (doc.scenarios?.length || doc.examples?.length) {
      result.errors.push({ op: e.op, message: `fluxo "${doc.id}" não vira endpoint de "${doc.extends}" (os cenários e exemplos seriam ignorados): ${issue.message}` })
    } else result.warnings.push({ op: e.op, message: `fluxo "${doc.id}" não vira endpoint de "${doc.extends}": ${issue.message}` })
  }
  for (const [id, e] of draft.flows) {
    if (!e.dirty) continue
    const r = validateFlow(e.doc)
    if (!r.ok) {
      result.errors.push({ op: e.op, message: `fluxo "${id}" inválido: ${fmt(r.issues)}` })
      continue
    }
    const literals = literalFlowSecrets(r.value)
    if (literals.length) {
      result.errors.push({
        op: e.op,
        message: `credencial escrita direto no fluxo "${id}" (${literals.join(', ')}); use uma variável {{NOME}} de um ambiente, marcada como segredo`
      })
    }
    for (const node of e.doc.nodes) {
      const ref = node.type === 'request' ? node.request : node.type === 'plugin' ? node.plugin : undefined
      const connectorId = ref?.connector
      if (!connectorId) continue
      const connector = withFlowBases.get(connectorId)
      if (!connector) {
        result.warnings.push({ op: e.op, message: `fluxo "${id}", nó "${node.name}": conector "${connectorId}" não existe` })
      } else if (node.type === 'request' && node.request.endpoint && !connector.endpoints?.some((x) => x.id === node.request.endpoint)) {
        result.warnings.push({ op: e.op, message: `fluxo "${id}", nó "${node.name}": endpoint "${node.request.endpoint}" não existe em "${connectorId}"` })
      }
    }
  }
  // Schemas compartilhados: o que o lote gravou precisa compilar, e toda citação nova, existir.
  const lookup = schemaLookup(draft)
  const lookupBefore = schemaLookup(draft, original.schemas)
  for (const [name, e] of draft.schemas) {
    if (!e.dirty) continue
    const r = validateJsonSchema(resolveSchemaRefs(e.doc, lookup), null)
    const broken = !r.ok && r.issues.find((x) => x.path === '' && x.message.startsWith('schema inválido'))
    const why = broken && (/Maximum call stack/.test(broken.message) ? 'as citações de schema fecham um ciclo sem conteúdo' : broken.message.replace(/^schema inválido: /, ''))
    if (broken) result.errors.push({ op: e.op, message: `schema "${name}" inválido: ${why}` })
  }
  const cites = (what: string, refs: Set<string>, op: number) => {
    for (const name of refs) {
      if (!lookup(name)) result.errors.push({ op, message: `${what} cita o schema "${name}", que não existe (crie com upsertSchema)` })
    }
  }
  for (const [id, e] of draft.connectors) if (e.dirty) cites(`o conector "${id}"`, schemaRefs(e.doc.endpoints), e.op)
  for (const [id, e] of draft.flows) if (e.dirty) cites(`o fluxo "${id}"`, schemaRefs(e.doc), e.op)
  for (const [name, e] of draft.schemas) if (e.dirty) cites(`o schema "${name}"`, schemaRefs(e.doc), e.op)

  // Corpo padrão fora do bodySchema: o vvpost validate do CI reprova. Só o que o lote mudou
  // (num schema compartilhado mudado, todos os endpoints que o citam).
  const before = defaultBodies(
    original.connectors,
    compileFlows(
      [...original.flows.values()].map((flow) => ({ flow, file: '' })),
      basesOutside(draft, original.flows.values())
    ),
    lookupBefore
  )
  const after = defaultBodies(new Map([...draft.connectors].map(([id, e]) => [id, e.doc] as const)), compiled, lookup)
  const flowOps = new Map([...draft.flows.values()].map((e) => [e.file, e.op] as const))
  for (const [key, now] of after) {
    const [connectorId] = key.split('/') as [string]
    const was = before.get(`${draft.renamed.get(connectorId) ?? connectorId}${key.slice(connectorId.length)}`)
    if (was && isDeepStrictEqual(was.value, now.value)) continue
    const issues = checkBody(now.value.schema, now.value.body)
    if (!issues.length) continue
    const op = now.file ? (flowOps.get(now.file) ?? -1) : (draft.connectors.get(connectorId)?.op ?? -1)
    result.warnings.push({ op, message: `endpoint "${key}": corpo padrão fora do bodySchema (${fmt(issues)}); o vvpost validate do CI reprova` })
  }
  // Resposta de exemplo fora do schema dela: idem, só os exemplos que o lote mudou.
  const examplesBefore = responseExamples(
    original.connectors,
    compileFlows(
      [...original.flows.values()].map((flow) => ({ flow, file: '' })),
      basesOutside(draft, original.flows.values())
    ),
    lookupBefore
  )
  for (const [key, now] of responseExamples(new Map([...draft.connectors].map(([id, e]) => [id, e.doc] as const)), compiled, lookup)) {
    const [connectorId] = key.split('/') as [string]
    const was = examplesBefore.get(`${draft.renamed.get(connectorId) ?? connectorId}${key.slice(connectorId.length)}`)
    if (was && isDeepStrictEqual(was.value, now.value)) continue
    const issues = checkExample(now.value)
    if (!issues.length) continue
    const op = now.file ? (flowOps.get(now.file) ?? -1) : (draft.connectors.get(connectorId)?.op ?? -1)
    const endpoint = key.slice(0, key.lastIndexOf('#'))
    result.warnings.push({
      op,
      message: `endpoint "${endpoint}": exemplo de resposta "${now.value.name}" fora do schema dele (${fmt(issues)}); o vvpost validate do CI reprova${/obrigatório ausente/.test(fmt(issues)) && draft.schemas.size ? ' (um campo novo de schema compartilhado entra nos exemplos com setSchemaField { fillExamples: true })' : ''}`
    })
  }

  const files = new Map<string, string>()
  const claim = (file: string, what: string, op: number) => {
    const other = files.get(file)
    if (other) result.errors.push({ op, message: `${what} e ${other} usariam o mesmo arquivo ${file}` })
    else files.set(file, what)
  }
  for (const [id, e] of draft.connectors) claim(e.file, `o conector "${id}"`, e.op)
  for (const [id, e] of draft.environments) claim(e.file, `o ambiente "${id}"`, e.op)
  for (const [id, e] of draft.flows) claim(e.file, `o fluxo "${id}"`, e.op)
  for (const [name, e] of draft.schemas) claim(e.file, `o schema "${name}"`, e.op)
}

/**
 * Corpo padrão e bodySchema (com os schemas compartilhados resolvidos) de cada endpoint que tem os
 * dois: "<conector>/<endpoint>" → valores e arquivo do fluxo de requisição.
 */
function defaultBodies(connectors: ReadonlyMap<string, Connector>, flows: ReturnType<typeof compileFlows>, lookup: (name: string) => JsonSchema | undefined) {
  const out = new Map<string, { value: { body: unknown; schema: Record<string, unknown> }; file?: string }>()
  const add = (connectorId: string, e: Endpoint, file?: string) => {
    if (e.bodySchema && e.body !== undefined) {
      out.set(`${connectorId}/${e.id}`, { value: { body: e.body, schema: resolveSchemaRefs(e.bodySchema, lookup) }, ...(file && { file }) })
    }
  }
  for (const [id, c] of connectors) for (const e of c.endpoints ?? []) add(id, e)
  for (const x of flows.endpoints) add(x.connectorId, x.endpoint, x.file)
  return out
}

/** Os exemplos de resposta com schema (resolvido), por conector/endpoint#exemplo. */
function responseExamples(connectors: ReadonlyMap<string, Connector>, flows: ReturnType<typeof compileFlows>, lookup: (name: string) => JsonSchema | undefined) {
  const out = new Map<string, { value: ResponseExample; file?: string }>()
  const add = (connectorId: string, e: Endpoint, file?: string) => {
    for (const x of e.examples ?? []) {
      if (x.schema) out.set(`${connectorId}/${e.id}#${x.id}`, { value: { ...x, schema: resolveSchemaRefs(x.schema, lookup) }, ...(file && { file }) })
    }
  }
  for (const [id, c] of connectors) for (const e of c.endpoints ?? []) add(id, e)
  for (const x of flows.endpoints) add(x.connectorId, x.endpoint, x.file)
  return out
}

function chainOk(id: string, catalog: ReadonlyMap<string, Connector>): boolean {
  const seen = new Set<string>()
  for (let current: string | undefined = id; current; current = catalog.get(current)?.extends) {
    if (seen.has(current) || !catalog.has(current)) return false
    seen.add(current)
  }
  return true
}

function chainError(id: string, catalog: ReadonlyMap<string, Connector>): string {
  const seen: string[] = []
  for (let current: string | undefined = id; current; current = catalog.get(current)?.extends) {
    if (seen.includes(current)) return `herança circular: ${[...seen, current].join(' → ')}`
    if (!catalog.has(current)) return `"${seen.at(-1)}" herda de "${current}", que não existe no projeto`
    seen.push(current)
  }
  return `herança inválida em "${id}"`
}

// ---------------------------------------------------------------------------
// Arquivos

const json = (schema: string, doc: object) => {
  const { $schema: _, ...rest } = doc as Record<string, unknown>
  return `${JSON.stringify({ $schema: schema, ...rest }, null, 2)}\n`
}

async function planChanges(draft: Draft, result: ProjectApplyResult): Promise<ProjectChange[]> {
  const next = new Map<string, { content: string | null; op: number }>()
  for (const [file, op] of draft.deleted) next.set(file, { content: null, op })
  const put = (e: Entry<object>, schema: string) => {
    if (!e.dirty) return
    if (e.from && e.from !== e.file && !next.has(e.from)) next.set(e.from, { content: null, op: e.op })
    next.set(e.file, { content: json(schema, e.doc), op: e.op })
  }
  for (const e of draft.connectors.values()) put(e, SchemaId.Connector)
  for (const e of draft.environments.values()) put(e, SchemaId.Environment)
  for (const e of draft.flows.values()) put(e, SchemaId.Flow)
  // Um schema compartilhado é um JSON Schema comum: grava como veio, com o $schema que ele tiver.
  for (const e of draft.schemas.values()) if (e.dirty) next.set(e.file, { content: `${JSON.stringify(e.doc, null, 2)}\n`, op: e.op })
  for (const [file, d] of draft.docs) {
    let text = d.text
    if (d.moveFrom) {
      text = await readText(draft, d.moveFrom)
      if (text === null) continue
    }
    if (text === null && next.get(file)?.content) continue
    next.set(file, { content: text, op: d.op })
  }

  const changes: ProjectChange[] = []
  for (const [path, { content, op }] of [...next].sort(([a], [b]) => a.localeCompare(b))) {
    const known = draft.originals.has(path)
    const before = known ? draft.originals.get(path)! : await readText(draft, path)
    if (content === null) {
      if (before !== null) changes.push({ path, action: 'delete', before })
      continue
    }
    if (before === content || (before !== null && !path.endsWith(DOCS_SUFFIX) && sameDocument(before, content))) continue
    if (before !== null && !known && !path.endsWith(DOCS_SUFFIX)) {
      result.errors.push({ op, message: `${path} já existe no workspace (arquivo inválido ou de outro tipo); escolha outro file` })
      continue
    }
    changes.push({ path, action: before === null ? 'create' : 'update', ...(before !== null && { before }), after: content })
  }
  return changes
}

/**
 * O arquivo já diz o mesmo, só com outra formatação, ordem de chaves no topo ou sem o
 * $schema (escrito à mão): não regrava, para um import ou lote sem efeito não sujar o Git.
 */
function sameDocument(before: string, after: string): boolean {
  try {
    const { $schema: _a, ...a } = JSON.parse(before) as Record<string, unknown>
    const { $schema: _b, ...b } = JSON.parse(after) as Record<string, unknown>
    return isDeepStrictEqual(a, b)
  } catch {
    return false
  }
}

async function readText(draft: Draft, path: string): Promise<string | null> {
  if (draft.originals.has(path)) return draft.originals.get(path)!
  try {
    const text = await readFile(join(draft.dir, path), 'utf8')
    draft.originals.set(path, text)
    return text
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'EISDIR') return null
    throw err
  }
}

function touchedBy(draft: Draft, path: string): number {
  for (const map of [draft.connectors, draft.environments, draft.flows, draft.schemas] as Map<string, Entry<unknown>>[]) {
    for (const e of map.values()) if (e.file === path) return e.op
  }
  return draft.docs.get(path)?.op ?? draft.deleted.get(path) ?? -1
}
