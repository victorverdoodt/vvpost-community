import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import connectorSchema from '../schemas/connector.json' with { type: 'json' }
import environmentSchema from '../schemas/environment.json' with { type: 'json' }
import secretsEngineSchema from '../schemas/secrets-engine.json' with { type: 'json' }
import flowSchema from '../schemas/flow.json' with { type: 'json' }
import pluginSchema from '../schemas/plugin.json' with { type: 'json' }
import bundleSchema from '../schemas/bundle.json' with { type: 'json' }
import webhooksSchema from '../schemas/webhooks.json' with { type: 'json' }
import privacySchema from '../schemas/privacy.json' with { type: 'json' }
import projectSchema from '../schemas/project.json' with { type: 'json' }
import workspacePluginsSchema from '../schemas/workspace-plugins.json' with { type: 'json' }
import docsSchema from '../schemas/docs.json' with { type: 'json' }
import publishSchema from '../schemas/publish.json' with { type: 'json' }
import type { Connector } from './types/connector.ts'
import type { Environment } from './types/environment.ts'
import type { SecretsEngineConfig } from './types/secrets-engine.ts'
import type { Flow } from './types/flow.ts'
import type { PluginField, PluginManifest } from './types/plugin.ts'
import type { Bundle } from './types/bundle.ts'
import type { WebhooksConfig } from './types/webhooks.ts'
import type { PrivacyConfig } from './types/privacy.ts'
import type { Project } from './types/project.ts'
import type { WorkspacePlugins } from './types/workspace-plugins.ts'
import type { DocsConfig } from './types/docs.ts'
import type { PublishConfig, PublishNode } from './types/publish.ts'
import { checkSchemaVersion, type SchemaKind } from './versioning.ts'

export interface ValidationIssue {
  /** JSON Pointer do campo com problema ("" é a raiz). */
  path: string
  message: string
  /** A palavra-chave do JSON Schema que falhou (pattern, type...), só com { keywords: true }. */
  keyword?: string
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] }

// Uma instância e compilação sob demanda: quem só valida ambientes não paga
// pela compilação do schema de conector, e nada compila no startup do app.
let ajv: Ajv2020 | undefined
function getAjv(): Ajv2020 {
  if (!ajv) {
    ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      strictRequired: false,
      allowUnionTypes: true,
      // Erros de auth só do tipo escolhido em "type", em vez de um por alternativa do oneOf.
      discriminator: true
    })
    // Anotação usada só pelo gerador de tipos.
    ajv.addKeyword({ keyword: 'tsType', schemaType: 'string' })
    // O fluxo reusa partes do conector (auth, tls, cenários) pelo $id dele.
    ajv.addSchema(connectorSchema)
  }
  return ajv
}

function lazy<T>(schema: object): () => ValidateFunction<T> {
  let fn: ValidateFunction<T> | undefined
  return () => (fn ??= getAjv().compile<T>(schema))
}

const connectorValidator = (): ValidateFunction<Connector> => getAjv().getSchema<Connector>(connectorSchema.$id)!
const environmentValidator = lazy<Environment>(environmentSchema)
const secretsEngineValidator = lazy<SecretsEngineConfig>(secretsEngineSchema)
const flowValidator = lazy<Flow>(flowSchema)
const pluginValidator = lazy<PluginManifest>(pluginSchema)
const bundleValidator = lazy<Bundle>(bundleSchema)
const webhooksValidator = lazy<WebhooksConfig>(webhooksSchema)
const privacyValidator = lazy<PrivacyConfig>(privacySchema)
const docsValidator = lazy<DocsConfig>(docsSchema)
const publishValidator = lazy<PublishConfig>(publishSchema)
const projectValidator = lazy<Project>(projectSchema)
const workspacePluginsValidator = lazy<WorkspacePlugins>(workspacePluginsSchema)

function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? [])
    .filter((e) => e.keyword !== 'if')
    .map((e) =>
      e.keyword === 'discriminator'
        ? { path: `${e.instancePath}/${String(e.params.tag)}`, message: describeTag(e) }
        : { path: e.instancePath, message: describe(e) }
    )
}

function describeTag(e: ErrorObject): string {
  const value = e.params.tagValue
  return e.params.error === 'tag' && value === undefined
    ? `campo obrigatório ausente "${String(e.params.tag)}"`
    : `valor desconhecido ${JSON.stringify(value)}`
}

function describe(e: ErrorObject): string {
  switch (e.keyword) {
    case 'additionalProperties':
      return `campo desconhecido "${String(e.params.additionalProperty)}"`
    case 'required':
      return `campo obrigatório ausente "${String(e.params.missingProperty)}"`
    case 'propertyNames':
      return `nome de chave inválido "${String(e.params.propertyName)}"`
    case 'const':
      return `deve ser ${JSON.stringify(e.params.allowedValue)}`
    case 'enum':
      return `deve ser um de ${(e.params.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(', ')}`
    case 'type': {
      const types = String(e.params.type).split(',')
      return `deve ser ${types.map((t) => TYPE_NAMES[t] ?? t).join(' ou ')}`
    }
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
      return `deve ser ${COMPARISONS[e.keyword]} ${String(e.params.limit)}`
    case 'multipleOf':
      return `deve ser múltiplo de ${String(e.params.multipleOf)}`
    case 'minLength':
      return `deve ter ao menos ${plural(e.params.limit, 'caractere', 'caracteres')}`
    case 'maxLength':
      return `deve ter no máximo ${plural(e.params.limit, 'caractere', 'caracteres')}`
    case 'minItems':
      return `deve ter ao menos ${plural(e.params.limit, 'item', 'itens')}`
    case 'maxItems':
      return `deve ter no máximo ${plural(e.params.limit, 'item', 'itens')}`
    case 'minProperties':
      return `deve ter ao menos ${plural(e.params.limit, 'campo', 'campos')}`
    case 'maxProperties':
      return `deve ter no máximo ${plural(e.params.limit, 'campo', 'campos')}`
    case 'uniqueItems':
      return `não pode ter itens repetidos (os itens ${String(e.params.j)} e ${String(e.params.i)} são iguais)`
    case 'pattern':
      return `deve seguir o padrão ${String(e.params.pattern)}`
    case 'format':
      return `deve estar no formato ${String(e.params.format)}`
    case 'oneOf':
      return e.params.passingSchemas ? 'combina com mais de uma das opções; deve combinar com uma só' : 'não combina com nenhuma das opções'
    case 'anyOf':
      return 'não combina com nenhuma das opções'
    case 'not':
      return 'não deve combinar com o schema em "not"'
    case 'contains':
      return 'deve ter ao menos um item que siga o schema em "contains"'
    case 'dependentRequired':
    case 'dependencies':
      return `com "${String(e.params.property)}", o campo "${String(e.params.missingProperty)}" é obrigatório`
    case 'unevaluatedProperties':
      return `campo desconhecido "${String(e.params.unevaluatedProperty)}"`
    case 'additionalItems':
    case 'unevaluatedItems':
      return `deve ter no máximo ${plural(e.params.limit, 'item', 'itens')}`
    case 'false schema':
      return 'não é permitido aqui'
    default:
      return `não segue a regra "${e.keyword}" do schema`
  }
}

const TYPE_NAMES: Record<string, string> = {
  string: 'texto',
  number: 'número',
  integer: 'número inteiro',
  boolean: 'booleano',
  object: 'objeto',
  array: 'lista',
  null: 'null'
}

const COMPARISONS: Record<string, string> = {
  minimum: '>=',
  maximum: '<=',
  exclusiveMinimum: '>',
  exclusiveMaximum: '<'
}

const plural = (n: unknown, one: string, many: string) => `${String(n)} ${Number(n) === 1 ? one : many}`

function run<T>(
  kind: SchemaKind,
  validator: () => ValidateFunction<T>,
  input: unknown,
  semantic?: (value: T) => ValidationIssue[]
): ValidationResult<T> {
  // A versão vem antes da forma: um arquivo de schema mais novo dá um erro claro, não "campo desconhecido".
  const version = checkSchemaVersion(input, kind)
  if (!version.ok) return version
  const data = version.doc
  const validate = validator()
  if (!validate(data)) return { ok: false, issues: toIssues(validate.errors) }
  const issues = semantic?.(data) ?? []
  return issues.length ? { ok: false, issues } : { ok: true, value: data }
}

/**
 * Regras que JSON Schema não expressa: ids únicos por escopo, headers sem nome
 * repetido em maiúsculas diferentes (qual dos dois valeria?) e um conector não
 * pode herdar de si mesmo. Ciclos entre conectores diferentes exigem o catálogo
 * inteiro e ficam com o resolvedor de herança.
 */
function connectorRules(connector: Connector): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (connector.extends === connector.id) {
    issues.push({ path: '/extends', message: 'um conector não pode herdar de si mesmo' })
  }
  const headers = (path: string, value: Record<string, unknown> | null | undefined) => {
    const seen = new Map<string, string>()
    for (const name of Object.keys(value ?? {})) {
      const first = seen.get(name.toLowerCase())
      if (first !== undefined) {
        issues.push({ path: `${path}/${name}`, message: `header "${name}" repetido ("${first}"): nomes de header não diferenciam maiúsculas` })
      } else {
        seen.set(name.toLowerCase(), name)
      }
    }
  }
  headers('/config/headers', connector.config?.headers)
  if (connector.config?.auth?.type === 'login') headers('/config/auth/request/headers', connector.config.auth.request.headers)
  const endpointIds = new Map<string, number>()
  connector.endpoints?.forEach((endpoint, i) => {
    const first = endpointIds.get(endpoint.id)
    if (first !== undefined) {
      issues.push({
        path: `/endpoints/${i}/id`,
        message: `id de endpoint duplicado "${endpoint.id}" (já usado em /endpoints/${first})`
      })
    } else {
      endpointIds.set(endpoint.id, i)
    }
    headers(`/endpoints/${i}/headers`, endpoint.headers)
    const scenarioIds = new Map<string, number>()
    endpoint.scenarios?.forEach((scenario, j) => {
      headers(`/endpoints/${i}/scenarios/${j}/overrides/headers`, scenario.overrides?.headers)
      const firstScenario = scenarioIds.get(scenario.id)
      if (firstScenario !== undefined) {
        issues.push({
          path: `/endpoints/${i}/scenarios/${j}/id`,
          message: `id de cenário duplicado "${scenario.id}" (já usado em /endpoints/${i}/scenarios/${firstScenario})`
        })
      } else {
        scenarioIds.set(scenario.id, j)
      }
    })
  })
  return issues
}

export function validateConnector(data: unknown): ValidationResult<Connector> {
  return run('connector', connectorValidator, data, connectorRules)
}

export function validateEnvironment(data: unknown): ValidationResult<Environment> {
  return run('environment', environmentValidator, data)
}

export function validateSecretsEngineConfig(data: unknown): ValidationResult<SecretsEngineConfig> {
  return run('secrets-engine', secretsEngineValidator, data)
}

/**
 * Regras do grafo que o JSON Schema não expressa: ids e nomes de nó únicos, arestas
 * entre nós que existem, branch só (e sempre) nas arestas que saem de um nó
 * condition (numa asserção, failWhenFalse, branch é opcional e só "true"), e
 * nenhum ciclo: a execução é topológica.
 */
function flowRules(flow: Flow): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const ids = new Map<string, number>()
  const names = new Map<string, number>()
  flow.nodes.forEach((node, i) => {
    const firstId = ids.get(node.id)
    if (firstId !== undefined) {
      issues.push({ path: `/nodes/${i}/id`, message: `id de nó duplicado "${node.id}" (já usado em /nodes/${firstId})` })
    } else {
      ids.set(node.id, i)
    }
    const firstName = names.get(node.name)
    if (firstName !== undefined) {
      issues.push({ path: `/nodes/${i}/name`, message: `nome de nó duplicado "${node.name}" (já usado em /nodes/${firstName})` })
    } else {
      names.set(node.name, i)
    }
  })
  const next = new Map<string, string[]>()
  const seen = new Set<string>()
  flow.edges?.forEach((edge, i) => {
    const from = ids.get(edge.from)
    if (from === undefined) issues.push({ path: `/edges/${i}/from`, message: `nó "${edge.from}" não existe no fluxo` })
    if (!ids.has(edge.to)) issues.push({ path: `/edges/${i}/to`, message: `nó "${edge.to}" não existe no fluxo` })
    if (edge.from === edge.to) issues.push({ path: `/edges/${i}/to`, message: 'um nó não pode ligar a si mesmo' })
    if (from !== undefined) {
      const source = flow.nodes[from]!
      const isCondition = source.type === 'condition'
      // Uma asserção (failWhenFalse) só segue quando vale: a aresta dela não precisa de branch, e "false" nunca roda.
      const assertion = source.type === 'condition' && source.failWhenFalse === true
      if (assertion && edge.branch === 'false') {
        issues.push({ path: `/edges/${i}/branch`, message: `"${edge.from}" falha o fluxo quando não vale (failWhenFalse): o ramo "false" nunca roda` })
      } else if (isCondition && !assertion && edge.branch === undefined) {
        issues.push({ path: `/edges/${i}`, message: `aresta saindo da condição "${edge.from}" precisa de branch "true" ou "false"` })
      } else if (!isCondition && edge.branch !== undefined) {
        issues.push({ path: `/edges/${i}/branch`, message: 'branch só vale em arestas que saem de um nó condition' })
      }
    }
    const key = `${edge.from}\0${edge.to}\0${edge.branch ?? ''}`
    if (seen.has(key)) issues.push({ path: `/edges/${i}`, message: 'aresta duplicada' })
    seen.add(key)
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to])
  })
  const cycle = findCycle([...ids.keys()], next)
  if (cycle) issues.push({ path: '/edges', message: `o fluxo tem um ciclo: ${cycle.join(' → ')}` })
  if (flow.extends === flow.id) issues.push({ path: '/extends', message: 'um fluxo não pode herdar de si mesmo' })
  flow.nodes.forEach((node, i) => {
    if (node.type === 'request' && node.request.basePath === false && !node.cache) {
      issues.push({ path: `/nodes/${i}/request/basePath`, message: 'basePath: false só vale no nó de login de um fluxo-base (com cache)' })
    }
  })
  const headerNames = new Map<string, string>()
  for (const name of Object.keys(flow.defaults?.headers ?? {})) {
    const first = headerNames.get(name.toLowerCase())
    if (first !== undefined) {
      issues.push({ path: `/defaults/headers/${name}`, message: `header "${name}" repetido ("${first}"): nomes de header não diferenciam maiúsculas` })
    } else {
      headerNames.set(name.toLowerCase(), name)
    }
  }
  const scenarioIds = new Map<string, number>()
  flow.scenarios?.forEach((scenario, i) => {
    const first = scenarioIds.get(scenario.id)
    if (first !== undefined) {
      issues.push({ path: `/scenarios/${i}/id`, message: `id de cenário duplicado "${scenario.id}" (já usado em /scenarios/${first})` })
    } else {
      scenarioIds.set(scenario.id, i)
    }
  })
  return issues
}

/** Primeiro ciclo encontrado (busca em profundidade), como lista de ids que volta ao início. */
function findCycle(nodes: string[], next: Map<string, string[]>): string[] | undefined {
  const state = new Map<string, 'open' | 'done'>()
  const stack: string[] = []
  const visit = (id: string): string[] | undefined => {
    state.set(id, 'open')
    stack.push(id)
    for (const to of next.get(id) ?? []) {
      if (state.get(to) === 'open') return [...stack.slice(stack.indexOf(to)), to]
      if (!state.has(to)) {
        const found = visit(to)
        if (found) return found
      }
    }
    stack.pop()
    state.set(id, 'done')
    return undefined
  }
  for (const id of nodes) {
    if (state.has(id)) continue
    const found = visit(id)
    if (found) return found
  }
  return undefined
}

export function validateFlow(data: unknown): ValidationResult<Flow> {
  return run('flow', flowValidator, data, flowRules)
}

/**
 * Regras do manifesto que o JSON Schema não expressa: main dentro da pasta do
 * plugin, pelo menos uma contribuição, tipos de nó e protocolos únicos no plugin,
 * chaves de campo únicas, o default de um select entre as opções e o header da auth de um publicador.
 */
function pluginRules(manifest: PluginManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const main = manifest.main.replaceAll('\\', '/')
  if (main.startsWith('/') || /^[A-Za-z]:/.test(main) || main.split('/').includes('..')) {
    issues.push({ path: '/main', message: 'main precisa ser um caminho relativo dentro da pasta do plugin' })
  }
  const nodes = manifest.contributes.nodes ?? []
  const adapters = manifest.contributes.adapters ?? []
  const diagrams = manifest.contributes.diagrams
  const exporters = manifest.contributes.exporters ?? []
  const publishers = manifest.contributes.publishers ?? []
  const diagramItems = (diagrams?.iconPacks?.length ?? 0) + (diagrams?.blocks?.length ?? 0)
  if (nodes.length + adapters.length + exporters.length + publishers.length + diagramItems === 0) {
    issues.push({ path: '/contributes', message: 'o plugin não contribui nenhum nó, adapter, exportador, publicador, pacote de ícones nem bloco de diagrama' })
  }
  const unique = (values: string[], path: (i: number) => string, what: string) => {
    const first = new Map<string, number>()
    values.forEach((value, i) => {
      if (first.has(value)) issues.push({ path: path(i), message: `${what} duplicado "${value}"` })
      else first.set(value, i)
    })
  }
  unique(nodes.map((n) => n.type), (i) => `/contributes/nodes/${i}/type`, 'tipo de nó')
  unique(adapters.map((a) => a.protocol), (i) => `/contributes/adapters/${i}/protocol`, 'protocolo')
  // Exportadores e publicadores são o provider de um destino: os ids não se repetem entre eles.
  unique([...exporters, ...publishers].map((e) => e.id), (i) => (i < exporters.length ? `/contributes/exporters/${i}/id` : `/contributes/publishers/${i - exporters.length}/id`), 'exportador ou publicador')
  publishers.forEach((p, i) => {
    if (p.auth.type === 'header' && !p.auth.header) issues.push({ path: `/contributes/publishers/${i}/auth/header`, message: 'auth do tipo header precisa do nome do header' })
  })
  unique((diagrams?.iconPacks ?? []).map((p) => p.prefix), (i) => `/contributes/diagrams/iconPacks/${i}/prefix`, 'prefixo de ícones')
  diagrams?.iconPacks?.forEach((p, i) => {
    const file = p.file.replaceAll('\\', '/')
    if (file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split('/').includes('..')) {
      issues.push({ path: `/contributes/diagrams/iconPacks/${i}/file`, message: 'o pacote de ícones precisa ficar dentro da pasta do plugin' })
    }
  })
  const fieldRules = (fields: PluginField[] | undefined, base: string) => {
    unique((fields ?? []).map((f) => f.key), (i) => `${base}/fields/${i}/key`, 'campo')
    fields?.forEach((field, i) => {
      if (field.type === 'select' && field.default !== undefined && !field.options?.some((o) => o.value === field.default)) {
        issues.push({ path: `${base}/fields/${i}/default`, message: 'o default de um select precisa ser uma das opções' })
      }
    })
  }
  nodes.forEach((n, i) => fieldRules(n.fields, `/contributes/nodes/${i}`))
  adapters.forEach((a, i) => fieldRules(a.fields, `/contributes/adapters/${i}`))
  return issues
}

export function validatePluginManifest(data: unknown): ValidationResult<PluginManifest> {
  return run('plugin', pluginValidator, data, pluginRules)
}

// Schemas escritos pelo usuário (asserção matchesSchema) usam outra instância,
// sem o modo strict: palavras-chave desconhecidas de outras ferramentas não devem
// quebrar o teste. Compilados ficam em cache pelo texto do schema.
let userAjv: Ajv2020 | undefined
const userSchemas = new Map<string, ValidateFunction>()
const USER_SCHEMA_CACHE = 200

/**
 * Valida `data` contra um JSON Schema qualquer (draft 2020-12; os campos "$schema"
 * e "$id" são ignorados). Schema inválido volta como issue na raiz, sem exceção. Com
 * { keywords: true }, cada issue diz a palavra-chave que falhou.
 */
export function validateJsonSchema(schema: object, data: unknown, options: { keywords?: boolean } = {}): ValidationResult<unknown> {
  // Sem $id: dois schemas diferentes com o mesmo $id não podem coexistir na instância.
  const { $schema: _schema, $id: _id, ...rest } = schema as Record<string, unknown>
  const key = JSON.stringify(rest)
  let validate = userSchemas.get(key)
  if (!validate) {
    userAjv ??= new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true, validateFormats: false })
    try {
      validate = userAjv.compile(rest)
    } catch (err) {
      return { ok: false, issues: [{ path: '', message: `schema inválido: ${(err as Error).message}` }] }
    }
    if (userSchemas.size >= USER_SCHEMA_CACHE) {
      const [oldest, old] = userSchemas.entries().next().value!
      userSchemas.delete(oldest)
      userAjv.removeSchema(old.schema as object)
    }
    userSchemas.set(key, validate)
  }
  if (validate(data)) return { ok: true, value: data }
  const errors = (validate.errors ?? []).filter((e) => e.keyword !== 'if')
  const issues = toIssues(errors)
  return { ok: false, issues: options.keywords ? issues.map((i, n) => ({ ...i, keyword: errors[n]!.keyword })) : issues }
}

/**
 * Envelope do pacote de exportação. Os documentos de dentro são validados um a um
 * com o próprio schema por quem importa, para cada erro apontar o documento.
 */
export function validateBundle(data: unknown): ValidationResult<Bundle> {
  return run('bundle', bundleValidator, data)
}

/**
 * Regras dos hooks que o JSON Schema não expressa: ids únicos e um caminho atendido
 * por um hook só (dois hooks no mesmo caminho deixariam a resposta ambígua).
 */
function webhooksRules(config: WebhooksConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const ids = new Map<string, number>()
  const paths = new Map<string, number>()
  config.hooks?.forEach((hook, i) => {
    const firstId = ids.get(hook.id)
    if (firstId !== undefined) issues.push({ path: `/hooks/${i}/id`, message: `id de hook duplicado "${hook.id}" (já usado em /hooks/${firstId})` })
    else ids.set(hook.id, i)
    const path = hook.path.length > 1 ? hook.path.replace(/\/+$/, '') : hook.path
    const firstPath = paths.get(path)
    if (firstPath !== undefined) issues.push({ path: `/hooks/${i}/path`, message: `caminho "${hook.path}" já atendido por /hooks/${firstPath}` })
    else paths.set(path, i)
  })
  return issues
}

/** .vvpost/webhooks.json: o servidor local de webhooks. */
export function validateWebhooksConfig(data: unknown): ValidationResult<WebhooksConfig> {
  return run('webhooks', webhooksValidator, data, webhooksRules)
}

/** .vvpost/privacy.json: dados pessoais no que vai ao agente de IA. */
export function validatePrivacyConfig(data: unknown): ValidationResult<PrivacyConfig> {
  return run('privacy', privacyValidator, data)
}

/** vvpost.docs.json: o modelo da documentação do projeto (fonte, capa, cabeçalho, rodapé, cores). */
export function validateDocsConfig(data: unknown): ValidationResult<DocsConfig> {
  return run('docs', docsValidator, data)
}

/** vvpost.publish.json: destinos do "Enviar para…" e a estrutura de pastas e páginas de cada um. */
export function validatePublishConfig(data: unknown): ValidationResult<PublishConfig> {
  return run('publish', publishValidator, data, publishRules)
}

/** Ids de destino e chaves de nó únicos: a chave é o que liga um nó à página já publicada. */
function publishRules(config: PublishConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const ids = new Set<string>()
  config.targets.forEach((target, i) => {
    if (ids.has(target.id)) issues.push({ path: `/targets/${i}/id`, message: `destino "${target.id}" repetido` })
    ids.add(target.id)
    const keys = new Set<string>()
    const walk = (nodes: PublishNode[], path: string, depth: number) => {
      nodes.forEach((node, j) => {
        const at = `${path}/${j}`
        if (depth > 8) issues.push({ path: at, message: 'a estrutura passa de 8 níveis' })
        if ('key' in node && node.key) {
          if (keys.has(node.key)) issues.push({ path: `${at}/key`, message: `chave "${node.key}" repetida no destino` })
          keys.add(node.key)
        }
        if ('children' in node && node.children) walk(node.children, `${at}/children`, depth + 1)
      })
    }
    walk(target.structure, `/targets/${i}/structure`, 1)
  })
  return issues
}

/** vvpost.project.json: a subpasta do workspace que é um projeto. */
export function validateProject(data: unknown): ValidationResult<Project> {
  return run('project', projectValidator, data, projectRules)
}

/** vvpost.plugins.json: os plugins que o workspace usa, com a versão aceita de cada um. */
export function validateWorkspacePlugins(data: unknown): ValidationResult<WorkspacePlugins> {
  return run('workspace-plugins', workspacePluginsValidator, data)
}

function projectRules(project: Project): ValidationIssue[] {
  // "flow:<id>" é a chave das marcas de revisão de fluxo; um projeto "flow" se confundiria com ela.
  return project.id === 'flow' ? [{ path: '/id', message: '"flow" é reservado; use outro id' }] : []
}
