import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateJsonSchema, type Connector, type ConnectorAuth, type Endpoint, type ResponseExample } from '@vvpost/schemas'
import type {
  BodyCheck,
  BodyValidation,
  ConnectorRegistry,
  ExampleCheck,
  HttpMethod,
  RegistryConnector,
  RegistryEndpoint,
  SchemaField,
  SchemaIssue
} from '../types'
import { joinPath, resolveConnector, type ResolvedConnector } from './resolve'
import { rootSchemaName, schemaFile } from './shared-schemas'
import { describeAuth } from './summary'
import type { LoadedWorkspace } from './workspace'
import { FLOW_SUFFIX } from '../flows/workspace'

const CONNECTOR_SUFFIX = '.connector.vvpost.json'
const DOCS_SUFFIX = '.connector.vvpost.md'
/** Arquivo de documentação maior que isto não é lido (não é documentação, é acidente). */
const MAX_DOCS_BYTES = 512 * 1024

/**
 * Connector Registry: cada conector com o que o próprio arquivo define, o
 * resultado da herança (com a origem de cada valor), a documentação viva do arquivo
 * *.connector.vvpost.md ao lado e os corpos do conector conferidos com o bodySchema.
 */
export async function buildRegistry(ws: LoadedWorkspace): Promise<ConnectorRegistry> {
  const issues = [...ws.issues]
  const children = new Map<string, Connector[]>()
  for (const c of ws.connectors.values()) {
    if (c.extends) children.set(c.extends, [...(children.get(c.extends) ?? []), c])
  }

  const connectors = await Promise.all(
    [...ws.connectors.values()].map(async (raw): Promise<RegistryConnector> => {
      const file = ws.connectorFiles.get(raw.id) ?? ''
      let resolved: ResolvedConnector | undefined
      let error: string | undefined
      try {
        resolved = resolveConnector(raw.id, ws.connectors)
        // Só o conector onde está o problema avisa, não cada descendente dele.
        for (const w of resolved.warnings) if (w.connector === raw.id) issues.push({ file, message: w.message })
      } catch (err) {
        error = (err as Error).message
      }

      // A documentação escrita fica ao lado: <nome>.connector.vvpost.md, ou <nome>.flow.vvpost.md num fluxo-base.
      const docsFile = file.endsWith(CONNECTOR_SUFFIX)
        ? file.slice(0, -CONNECTOR_SUFFIX.length) + DOCS_SUFFIX
        : file.endsWith(FLOW_SUFFIX)
          ? file.slice(0, -'.json'.length) + '.md'
          : ''
      const docsText = docsFile ? await readDocs(join(ws.dir, docsFile), docsFile, issues) : undefined
      const endpoints = raw.endpoints ?? []
      const docs = docsText === undefined ? undefined : splitDocs(docsText)
      for (const id of docs?.sections.keys() ?? []) {
        if (!endpoints.some((e) => e.id === id)) {
          issues.push({ file: docsFile, message: `seção {#${id}} não corresponde a nenhum endpoint de "${raw.id}"` })
        }
      }

      const config = raw.config ?? {}
      return {
        id: raw.id,
        name: raw.name,
        version: raw.version,
        ...(raw.description !== undefined && { description: raw.description }),
        file,
        ...(raw.extends !== undefined && { extends: raw.extends }),
        children: (children.get(raw.id) ?? []).map((c) => c.name).sort((a, b) => a.localeCompare(b)),
        chain: resolved?.chain ?? [raw.id],
        own: {
          ...(config.baseUrl !== undefined && { baseUrl: config.baseUrl }),
          ...(config.basePath !== undefined && { basePath: config.basePath }),
          headers: Object.entries(config.headers ?? {}).map(([name, value]) => ({ name, value })),
          ...(config.auth && { auth: { type: config.auth.type, summary: authSummary(config.auth) } }),
          tls: !!config.tls
        },
        ...(resolved && { resolved: layers(resolved, ws.connectors) }),
        endpoints: endpoints.map((e) => {
          const shared = rootSchemaName(ws.unresolved?.get(raw.id)?.endpoints?.find((x) => x.id === e.id)?.bodySchema)
          const sharedSchema = shared === undefined ? undefined : { name: shared, file: ws.schemas?.get(shared)?.file ?? schemaFile(shared) }
          return describeEndpoint(e, resolved, docs?.sections.get(e.id), sharedSchema)
        }),
        ...(docs && { docs: { file: docsFile, overview: docs.overview } }),
        diagrams: {
          hierarchy: hierarchyDiagram(raw, ws.connectors, children),
          ...(resolved?.auth && { auth: authDiagram(resolved.auth.config, resolved.auth.from, ws.connectors) })
        },
        ...(error !== undefined && { error }),
        ...specSource(raw.id, ws.connectors)
      }
    })
  )
  connectors.sort((a, b) => a.name.localeCompare(b.name))
  return { dir: ws.dir, connectors, issues }
}

/** A spec de onde o conector veio: a dele ou a do ancestral mais próximo que guarda uma. */
function specSource(id: string, connectors: ReadonlyMap<string, Connector>): Pick<RegistryConnector, 'source'> {
  const seen = new Set<string>()
  for (let cur = connectors.get(id); cur && !seen.has(cur.id); cur = cur.extends ? connectors.get(cur.extends) : undefined) {
    if (cur.source) {
      return { source: { location: cur.source.location, ...(cur.source.version && { version: cur.source.version }), from: cur.id } }
    }
    seen.add(cur.id)
  }
  return {}
}

/** Confere um corpo digitado com o bodySchema do endpoint. */
export function validateEndpointBody(
  ws: LoadedWorkspace,
  connectorId: string,
  endpointId: string,
  body: string
): BodyValidation {
  const endpoint = ws.connectors.get(connectorId)?.endpoints?.find((e) => e.id === endpointId)
  if (!endpoint) return { ok: false, message: `endpoint "${endpointId}" não existe em "${connectorId}"` }
  if (!endpoint.bodySchema) return { ok: false, message: 'o endpoint não tem bodySchema' }
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch (err) {
    return { ok: false, message: `JSON inválido (${(err as Error).message})` }
  }
  const issues = checkBody(endpoint.bodySchema, data)
  return issues.length ? { ok: false, issues } : { ok: true }
}

async function readDocs(
  path: string,
  file: string,
  issues: ConnectorRegistry['issues']
): Promise<string | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') issues.push({ file, message: (err as Error).message })
    return undefined
  }
  if (text.length > MAX_DOCS_BYTES) {
    issues.push({ file, message: `maior que ${MAX_DOCS_BYTES / 1024} KB; ignorado` })
    return undefined
  }
  return text
}

const SECTION_HEADING = /^(#{1,6})\s+.*?\s*\{#([A-Za-z0-9_][A-Za-z0-9_.-]*)\}\s*$/
const ANY_HEADING = /^(#{1,6})\s/
const FENCE = /^\s*(`{3,}|~{3,})/

/**
 * Separa o Markdown do conector: um título terminado em {#id} abre a seção do
 * endpoint `id`, que vai até o próximo título do mesmo nível ou acima. O resto é a
 * visão geral do conector. Títulos dentro de blocos de código não contam.
 */
export function splitDocs(markdown: string): { overview: string; sections: Map<string, string> } {
  const overview: string[] = []
  const sections = new Map<string, string[]>()
  let current: { id: string; level: number } | null = null
  let fence: string | null = null

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMatch = FENCE.exec(line)
    if (fence) {
      if (fenceMatch && fenceMatch[1]!.startsWith(fence)) fence = null
    } else if (fenceMatch) {
      fence = fenceMatch[1]!
    } else {
      const section = SECTION_HEADING.exec(line)
      if (section) {
        current = { id: section[2]!, level: section[1]!.length }
        if (!sections.has(current.id)) sections.set(current.id, [])
        continue
      }
      const heading = ANY_HEADING.exec(line)
      if (heading && current && heading[1]!.length <= current.level) current = null
    }
    ;(current ? sections.get(current.id)! : overview).push(line)
  }
  return {
    overview: overview.join('\n').trim(),
    sections: new Map([...sections].map(([id, lines]) => [id, lines.join('\n').trim()]))
  }
}

function authSummary(auth: ConnectorAuth): string {
  return auth.type === 'none' ? 'Sem auth (desliga a herdada)' : describeAuth(auth)
}

/** Config efetiva com a origem de cada valor, do pai para o filho. */
function layers(resolved: ResolvedConnector, catalog: ReadonlyMap<string, Connector>): RegistryConnector['resolved'] {
  const headers = new Map<string, { name: string; value: string; from: string; overrides: string[] }>()
  let baseUrlFrom: string | undefined
  let authDisabledBy: string | undefined
  for (const id of resolved.chain) {
    const config = catalog.get(id)?.config
    if (!config) continue
    if (config.baseUrl !== undefined) baseUrlFrom = id
    for (const [name, value] of Object.entries(config.headers ?? {})) {
      const key = name.toLowerCase()
      const previous = headers.get(key)
      headers.set(key, { name, value, from: id, overrides: previous ? [...previous.overrides, previous.from] : [] })
    }
    if (config.auth) authDisabledBy = config.auth.type === 'none' ? id : undefined
  }
  return {
    ...(resolved.baseUrl !== undefined &&
      baseUrlFrom && { baseUrl: { value: joinPath(resolved.baseUrl, resolved.basePath), from: baseUrlFrom } }),
    basePath: resolved.basePath,
    headers: [...headers.values()],
    ...(resolved.auth && {
      auth: {
        type: resolved.auth.config.type,
        summary: describeAuth(resolved.auth.config),
        from: resolved.auth.from
      }
    }),
    ...(authDisabledBy && { authDisabledBy }),
    ...(resolved.tls && { tlsFrom: resolved.tls.from })
  }
}

function describeEndpoint(
  e: Endpoint,
  resolved: ResolvedConnector | undefined,
  docs: string | undefined,
  sharedSchema?: RegistryEndpoint['sharedSchema']
): RegistryEndpoint {
  const checks: BodyCheck[] = []
  if (e.bodySchema) {
    if (e.body !== undefined) checks.push({ source: 'body', label: 'Corpo padrão', issues: checkBody(e.bodySchema, e.body) })
    for (const sc of e.scenarios ?? []) {
      if (sc.overrides?.body === undefined) continue
      checks.push({ source: sc.id, label: `Cenário: ${sc.name}`, issues: checkBody(e.bodySchema, sc.overrides.body) })
    }
  }
  const exampleChecks = (e.examples ?? []).filter((x) => x.schema).map((x) => ({ id: x.id, name: x.name, status: x.status, issues: checkExample(x) }))
  return {
    id: e.id,
    name: e.name,
    ...(e.description !== undefined && { description: e.description }),
    method: e.method as HttpMethod,
    path: e.path,
    ...(resolved?.baseUrl !== undefined && { url: joinPath(resolved.baseUrl, resolved.basePath, e.path) }),
    ...(e.requiresAuth !== undefined && { requiresAuth: e.requiresAuth }),
    headers: Object.entries(e.headers ?? {}).map(([name, value]) => ({ name, value })),
    query: Object.entries(e.query ?? {}).map(([name, value]) => ({ name, value })),
    ...(e.bodySchema && { bodySchema: e.bodySchema }),
    ...(sharedSchema && { sharedSchema }),
    fields: e.bodySchema ? schemaFields(e.bodySchema) : [],
    ...(e.body !== undefined && {
      body: typeof e.body === 'string' ? e.body : JSON.stringify(e.body, null, 2)
    }),
    ...(docs && { docs }),
    checks,
    ...(exampleChecks.length && { exampleChecks }),
    scenarios: (e.scenarios ?? []).map((sc) => ({ id: sc.id, name: sc.name }))
  }
}

const WHOLE_TEMPLATE = /^\s*\{\{[^{}]+\}\}\s*$/
const HAS_TEMPLATE = /\{\{[^{}]+\}\}/
// O que um texto com variável dentro ({{$timestamp}}-1-1) só mostra depois da troca.
const TEXT_KEYWORDS = new Set(['pattern', 'format', 'minLength', 'maxLength', 'enum', 'const'])

/**
 * Valida o corpo com o bodySchema. Um valor que é inteiro uma variável ({{AMOUNT}})
 * só é conhecido no disparo: o erro de tipo nele não conta. Num texto com variável dentro,
 * padrão, formato, tamanho e enum também só valem depois da troca e não contam.
 */
export function checkBody(schema: Record<string, unknown>, body: unknown): SchemaIssue[] {
  const result = validateJsonSchema(schema, body, { keywords: true })
  if (result.ok) return []
  return result.issues
    .filter((i) => {
      const value = atPointer(body, i.path)
      if (typeof value !== 'string') return true
      if (WHOLE_TEMPLATE.test(value)) return false
      return !(HAS_TEMPLATE.test(value) && TEXT_KEYWORDS.has(i.keyword ?? ''))
    })
    .map(({ path, message }) => ({ path, message }))
}

/**
 * Confere uma resposta de exemplo com o schema dela. O corpo em texto que é JSON vale como o JSON;
 * {{$path.id}} e as variáveis que o mock troca não contam como erro de tipo (como no checkBody).
 * Exemplo sem schema ou sem corpo não tem o que conferir.
 */
export function checkExample(example: ResponseExample): SchemaIssue[] {
  if (!example.schema || example.body === undefined) return []
  let body = example.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      // texto puro: confere como texto
    }
  }
  return checkBody(example.schema, body)
}

/** A linha do validate (e do aviso do app) para um exemplo de resposta fora do schema dele. */
export function exampleProblem(check: ExampleCheck): string {
  const issues = check.issues
    .slice(0, 3)
    .map((i) => `${i.path || '/'}: ${i.message}`)
    .join('; ')
  return `exemplo de resposta "${check.name}" (${check.status}) fora do schema dele (${issues})`
}

function atPointer(data: unknown, pointer: string): unknown {
  if (!pointer) return data
  let current = data
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

type Schema = Record<string, unknown>
const MAX_FIELD_DEPTH = 6

/** Achata o bodySchema em linhas de tabela: propriedades aninhadas viram a.b, itens de array viram a[]. */
export function schemaFields(root: Schema): SchemaField[] {
  const fields: SchemaField[] = []
  const deref = (s: unknown, seen = 0): Schema => {
    if (!isSchema(s)) return {}
    const ref = s['$ref']
    if (typeof ref === 'string' && ref.startsWith('#/') && seen < 8) {
      let target: unknown = root
      for (const part of ref.slice(2).split('/')) target = isSchema(target) ? target[part] : undefined
      return deref(target, seen + 1)
    }
    return s
  }
  const walk = (raw: unknown, prefix: string, depth: number) => {
    const s = deref(raw)
    if (depth > MAX_FIELD_DEPTH) return
    const props = isSchema(s['properties']) ? s['properties'] : undefined
    const required = new Set(Array.isArray(s['required']) ? s['required'] : [])
    for (const [name, child] of Object.entries(props ?? {})) {
      const c = deref(child)
      const path = prefix ? `${prefix}.${name}` : name
      const values = Array.isArray(c['enum'])
        ? c['enum'].map((v) => JSON.stringify(v))
        : 'const' in c
          ? [JSON.stringify(c['const'])]
          : undefined
      fields.push({
        path,
        type: typeOf(c),
        required: required.has(name),
        ...(typeof c['description'] === 'string' && { description: c['description'] }),
        ...(values && { values })
      })
      walk(c, path, depth + 1)
      if (c['items'] !== undefined) walk(c['items'], `${path}[]`, depth + 1)
    }
  }
  walk(root, '', 0)
  if (fields.length === 0 && deref(root)['items'] !== undefined) walk(deref(root)['items'], '[]', 1)
  return fields
}

function typeOf(s: Schema): string {
  const t = s['type']
  if (Array.isArray(t)) return t.join(' | ')
  if (typeof t === 'string') {
    if (t === 'array' && isSchema(s['items']) && typeof s['items']['type'] === 'string') return `${s['items']['type']}[]`
    return t
  }
  if (Array.isArray(s['oneOf'])) return 'oneOf'
  if (Array.isArray(s['anyOf'])) return 'anyOf'
  if (Array.isArray(s['enum'])) return 'enum'
  return 'qualquer'
}

function isSchema(v: unknown): v is Schema {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Texto seguro dentro de um rótulo Mermaid entre aspas. */
function label(text: string): string {
  return text.replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/[\r\n]+/g, ' ')
}

/** Texto seguro numa mensagem de sequenceDiagram (sem ; e # que a sintaxe usa). */
function message(text: string): string {
  return text.replace(/#/g, '#35;').replace(/;/g, '#59;').replace(/[\r\n]+/g, ' ')
}

/**
 * Árvore de herança em Mermaid: a linhagem do conector até a raiz, os filhos diretos
 * e, em destaque, o próprio conector. Cada nó diz o que aquela camada define.
 */
export function hierarchyDiagram(
  self: Connector,
  catalog: ReadonlyMap<string, Connector>,
  children: ReadonlyMap<string, Connector[]>
): string {
  const lineage: Connector[] = [self]
  const seen = new Set([self.id])
  for (let parent = self.extends; parent && !seen.has(parent); ) {
    seen.add(parent)
    const c = catalog.get(parent)
    if (!c) break
    lineage.unshift(c)
    parent = c.extends
  }
  const ids = new Map<string, string>()
  const node = (id: string) => {
    if (!ids.has(id)) ids.set(id, `n${ids.size}`)
    return ids.get(id)!
  }
  const lines = ['graph TD']
  const describe = (c: Connector) => {
    const parts: string[] = []
    const config = c.config ?? {}
    if (config.baseUrl) parts.push('baseUrl')
    if (config.basePath) parts.push(config.basePath)
    if (config.headers && Object.keys(config.headers).length) parts.push(`${Object.keys(config.headers).length} header(s)`)
    if (config.auth) parts.push(`auth ${config.auth.type}`)
    if (config.tls) parts.push('mTLS')
    return [c.name, c.id, parts.join(', ')].filter(Boolean).map(label).join('<br/>')
  }
  for (const c of lineage) lines.push(`  ${node(c.id)}["${describe(c)}"]`)
  if (self.extends && !catalog.has(self.extends)) {
    lines.push(`  missing["${label(self.extends)}<br/>não existe no workspace"]:::missing`)
    lines.push(`  missing -.-> ${node(self.id)}`)
  }
  for (let i = 1; i < lineage.length; i++) lines.push(`  ${node(lineage[i - 1]!.id)} --> ${node(lineage[i]!.id)}`)
  for (const child of children.get(self.id) ?? []) {
    if (seen.has(child.id)) continue
    lines.push(`  ${node(child.id)}["${describe(child)}"]`)
    lines.push(`  ${node(self.id)} --> ${node(child.id)}`)
  }
  lines.push(`  class ${node(self.id)} current`)
  lines.push('  classDef current stroke:#6d8cff,stroke-width:2px')
  lines.push('  classDef missing stroke:#f87171,stroke-dasharray:4 3')
  return lines.join('\n')
}

/** Como a auth headless acontece antes de cada requisição, em sequenceDiagram. */
export function authDiagram(
  auth: Exclude<ConnectorAuth, { type: 'none' }>,
  from: string,
  catalog: ReadonlyMap<string, Connector>
): string {
  const owner = catalog.get(from)?.name ?? from
  // O cliente aparece genérico: a documentação é do sistema, não da ferramenta que a montou.
  const lines = ['sequenceDiagram', '  participant V as HttpClient', '  participant API as API']
  const note = `  Note over V: auth herdada de ${message(owner)}`
  switch (auth.type) {
    case 'oauth2': {
      lines.splice(2, 0, '  participant T as Token endpoint')
      lines.push(note)
      if (auth.grantType === 'authorization_code') {
        lines.splice(2, 0, '  participant N as Navegador')
        lines.push(`  V->>N: abre ${message(auth.authUrl ?? 'authUrl')}${auth.pkce === false ? '' : ' com code_challenge (PKCE)'}`)
        lines.push('  N-->>V: code no redirect de loopback')
      }
      lines.push(`  V->>T: POST ${message(auth.tokenUrl)} (grant_type=${auth.grantType})`)
      lines.push('  T-->>V: access_token, expires_in')
      lines.push('  Note over V: token em memória até expirar')
      lines.push('  V->>API: requisição + Authorization com o access_token')
      break
    }
    case 'login': {
      lines.splice(2, 0, '  participant L as Login')
      lines.push(note)
      lines.push(`  V->>L: ${auth.request.method ?? 'POST'} ${message(auth.request.url)}`)
      lines.push(`  L-->>V: token em ${message(auth.token)}`)
      const inject = auth.inject ?? {}
      lines.push(
        `  V->>API: requisição + ${inject.in === 'query' ? 'query' : 'header'} ${message(inject.name ?? 'Authorization')}`
      )
      break
    }
    case 'digest':
    case 'ntlm': {
      lines.push(note)
      lines.push(`  V->>API: requisição${auth.type === 'ntlm' ? ' + Authorization NTLM (negotiate)' : ''}`)
      lines.push(`  API-->>V: 401 + WWW-Authenticate ${auth.type === 'ntlm' ? 'NTLM (challenge)' : 'Digest (nonce)'}`)
      lines.push(`  V->>API: mesma requisição + Authorization ${auth.type === 'ntlm' ? 'NTLM (authenticate), na mesma conexão' : 'Digest'}`)
      break
    }
    default:
      lines.push(note)
      lines.push(`  V->>API: requisição + ${message(describeAuth(auth))}`)
  }
  lines.push('  API-->>V: resposta')
  return lines.join('\n')
}
