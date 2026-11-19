import { basename } from 'node:path'
import type { Connector, ConnectorAuth, Endpoint, Flow, Scenario } from '@vvpost/schemas'
import { buildRegistry } from '../connectors/registry'
import { resolveConnector, type ResolvedConnector } from '../connectors/resolve'
import type { LoadedWorkspace } from '../connectors/workspace'
import { createSecretSanitizer } from '../sanitizer'
import { isSensitiveName } from '../secrets'
import type { FlowCatalog, RegistryConnector, RegistryEndpoint } from '../types'
import { plainFlows } from '../flows/workspace'
import { c4Context, endpointSequence, flowDiagram, projectMap } from './diagrams'
import { renderDocMarkdown } from './markdown'
import type {
  ApiDocument,
  DocAssertion,
  DocConnector,
  DocEndpoint,
  DocFlowSummary,
  DocFlowUsage,
  DocHeader,
  DocScenario,
  DocScope,
  DocVariable
} from './model'

/** Origem dos headers que o próprio endpoint define (os outros vêm de um conector da cadeia). */
export const ENDPOINT_ORIGIN = '(endpoint)'

/** Escopo inválido (conector, endpoint ou request que não existe). */
export class DocsError extends Error {}

export interface GenerateDocsOptions {
  /** Nome do projeto no título; padrão: a pasta do workspace. */
  projectName?: string
  /** Quem gerou (app, CLI ou MCP), no rodapé. */
  generator?: string
  now?: Date
}

export interface GeneratedDocs {
  document: ApiDocument
  markdown: string
}

/**
 * Documentação rica de um nível da hierarquia (projeto, conector, endpoint ou request),
 * montada do mesmo Connector Registry da documentação viva do Catálogo: herança efetiva
 * com a origem de cada valor, auth, schemas, exemplos, cenários e asserções, a
 * documentação escrita, os fluxos que usam cada endpoint e os diagramas em Mermaid.
 *
 * Nenhum valor de segredo entra: variáveis secretas aparecem só pelo nome, o documento
 * passa pelo Secret Sanitizer (valores do vault, campos e headers de credencial,
 * formatos conhecidos) e o Markdown final é recusado se ainda tiver um valor conhecido.
 */
export async function generateDocumentation(
  ws: LoadedWorkspace,
  flows: FlowCatalog,
  scope: DocScope,
  options: GenerateDocsOptions = {}
): Promise<GeneratedDocs> {
  // Fluxos-base e de requisição se documentam como os conectores e endpoints que são.
  flows = { ...flows, flows: plainFlows(flows, ws.flowSources) }
  const registry = await buildRegistry(ws)
  const byId = new Map(registry.connectors.map((c) => [c.id, c]))
  const name = (id: string) => byId.get(id)?.name ?? id

  const target = scope.kind === 'project' ? null : byId.get(scope.connectorId)
  if (scope.kind !== 'project' && !target) throw new DocsError(`conector "${scope.connectorId}" não existe no workspace`)
  const raw = (id: string) => ws.connectors.get(id)!

  let endpointFilter: ((e: Endpoint) => boolean) | undefined
  let scenarioFilter: ((s: Scenario) => boolean) | undefined
  if (scope.kind === 'endpoint' || scope.kind === 'request') {
    const endpoint = raw(scope.connectorId).endpoints?.find((e) => e.id === scope.endpointId)
    if (!endpoint) throw new DocsError(`endpoint "${scope.endpointId}" não existe em "${scope.connectorId}"`)
    endpointFilter = (e) => e.id === scope.endpointId
    if (scope.kind === 'request') {
      if (!endpoint.scenarios?.some((s) => s.id === scope.scenarioId)) {
        throw new DocsError(`request "${scope.scenarioId}" não existe em "${scope.connectorId}/${scope.endpointId}"`)
      }
      scenarioFilter = (s) => s.id === scope.scenarioId
    }
  }

  const connectors = (target ? [target] : registry.connectors).map((c) =>
    describeConnector(c, raw(c.id), ws, flows, name, endpointFilter, scenarioFilter)
  )

  const all = [...ws.connectors.values()]
  const flowList: DocFlowSummary[] = flows.flows.map(({ file, flow }) => ({
    id: flow.id,
    name: flow.name,
    file,
    ...(flow.description !== undefined && { description: flow.description }),
    nodes: flow.nodes.length,
    connectors: [...flowConnectors(flow)]
  }))
  const relevantFlows =
    scope.kind === 'project' ? flowList : flowList.filter((f) => f.connectors.includes(scope.connectorId))

  // Variáveis: as que o conteúdo do documento usa (cadeia de herança, endpoints, cenários, fluxos).
  const used = new Set<string>()
  const scanned = new Set<string>()
  for (const c of connectors) {
    for (const id of c.chain.map((x) => x.id)) {
      if (scanned.has(id) || !ws.connectors.has(id)) continue
      scanned.add(id)
      collectVariables(ws.connectors.get(id)!.config, used)
    }
    for (const e of c.endpoints) for (const v of e.variables) used.add(v)
  }
  if (scope.kind === 'project') for (const { flow } of flows.flows) collectVariables(flow, used)

  const environments = [...ws.environments.values()]
  const variables: DocVariable[] = [...used].sort().map((v) => {
    const declared = environments.filter((env) => env.variables[v] !== undefined)
    const secret = isSensitiveName(v) || declared.some((env) => env.variables[v]!.isSecret)
    const description = declared.map((env) => env.variables[v]!.description).find(Boolean)
    return {
      name: v,
      secret,
      values: secret ? {} : Object.fromEntries(declared.map((env) => [env.id, String(env.variables[v]!.value)])),
      missingIn: environments.filter((env) => env.variables[v] === undefined).map((env) => env.id),
      ...(description && { description })
    }
  })

  const projectName = options.projectName ?? (basename(ws.dir) || 'Projeto')
  const endpoint = scope.kind === 'endpoint' || scope.kind === 'request' ? connectors[0]!.endpoints[0]! : null
  const title =
    scope.kind === 'project'
      ? `Documentação de ${projectName}`
      : scope.kind === 'connector'
        ? `Conector ${target!.name}`
        : scope.kind === 'endpoint'
          ? `${endpoint!.method} ${endpoint!.path} · ${endpoint!.name}`
          : `Request ${endpoint!.scenarios[0]!.name} · ${endpoint!.method} ${endpoint!.path}`

  const issues = registry.issues.filter(
    (i) => scope.kind === 'project' || connectors.some((c) => i.file === c.file || i.file === c.docsFile)
  )
  if (scope.kind === 'project') issues.push(...flows.issues)

  const document: ApiDocument = {
    title,
    scope,
    scopeLabel: { project: 'Projeto', connector: 'Conector', endpoint: 'Endpoint', request: 'Request' }[scope.kind],
    generatedAt: (options.now ?? new Date()).toISOString(),
    generator: options.generator ?? 'VVPost',
    project: {
      name: projectName,
      connectors: all.length,
      endpoints: all.reduce((n, c) => n + (c.endpoints?.length ?? 0), 0),
      scenarios: all.reduce((n, c) => n + (c.endpoints ?? []).reduce((m, e) => m + (e.scenarios?.length ?? 0), 0), 0),
      flows: flows.flows.length,
      environments: environments.map((env) => {
        const vars = Object.values(env.variables)
        return { id: env.id, name: env.name, variables: vars.length, secrets: vars.filter((v) => v.isSecret).length }
      }),
      ...(scope.kind === 'project' && {
        map: projectMap({
          connectors: registry.connectors.map((c) => ({
            id: c.id,
            name: c.name,
            ...(c.extends !== undefined && !c.error && { extends: c.extends }),
            endpoints: c.endpoints
          })),
          flows: flowList
        }),
        c4: c4Context({
          projectName,
          connectors: registry.connectors.map((c) => {
            const description = ws.connectors.get(c.id)?.description
            return {
              id: c.id,
              name: c.name,
              ...(description && { description }),
              ...(c.extends !== undefined && !c.error && { extends: c.extends }),
              endpoints: c.endpoints.length
            }
          }),
          flows: flowList
        })
      }),
      flowList: relevantFlows
    },
    connectors,
    variables,
    issues
  }

  // Última barreira: tudo que o documento leva passa pelo Secret Sanitizer.
  // Documentação é prosa: "Authorization: Bearer" num parágrafo não é credencial (formatos e valores do workspace seguem valendo).
  const sanitizer = createSecretSanitizer({ prose: true })
  sanitizer.addWorkspace(ws)
  const safe = sanitizer.sanitize(document)
  const markdown = renderDocMarkdown(safe)
  if (sanitizer.leaks(markdown)) {
    throw new DocsError('a documentação teria o valor de uma credencial; nada foi gerado')
  }
  return { document: safe, markdown }
}

function describeConnector(
  c: RegistryConnector,
  raw: Connector,
  ws: LoadedWorkspace,
  flows: FlowCatalog,
  name: (id: string) => string,
  endpointFilter?: (e: Endpoint) => boolean,
  scenarioFilter?: (s: Scenario) => boolean
): DocConnector {
  let resolved: ResolvedConnector | undefined
  try {
    resolved = resolveConnector(c.id, ws.connectors)
  } catch {
    // herança quebrada: c.error já diz o motivo
  }
  const rawEndpoints = (raw.endpoints ?? []).filter((e) => !endpointFilter || endpointFilter(e))
  const shared = ws.shared?.get(c.id)
  return {
    id: c.id,
    name: c.name,
    version: c.version,
    ...(c.description !== undefined && { description: c.description }),
    file: c.file,
    ...(c.docs && { docsFile: c.docs.file, ...(c.docs.overview && { overview: c.docs.overview }) }),
    ...(c.extends !== undefined && { extends: c.extends }),
    chain: c.chain.map((id) => ({ id, name: name(id) })),
    children: c.children,
    ...(shared && { shared }),
    ...(c.resolved && {
      effective: {
        ...(c.resolved.baseUrl && { baseUrl: c.resolved.baseUrl }),
        basePath: c.resolved.basePath,
        headers: c.resolved.headers,
        ...(c.resolved.auth && { auth: { ...c.resolved.auth, details: authDetails(resolved?.auth?.config) } }),
        ...(c.resolved.authDisabledBy && { authDisabledBy: c.resolved.authDisabledBy }),
        ...(c.resolved.tlsFrom && { tlsFrom: c.resolved.tlsFrom })
      }
    }),
    ...(c.error !== undefined && { error: c.error }),
    diagrams: c.diagrams,
    endpoints: rawEndpoints.map((e) =>
      describeEndpoint(c, e, c.endpoints.find((x) => x.id === e.id)!, resolved, flows, name, scenarioFilter)
    ),
    omittedEndpoints: (raw.endpoints?.length ?? 0) - rawEndpoints.length
  }
}

function describeEndpoint(
  c: RegistryConnector,
  raw: Endpoint,
  e: RegistryEndpoint,
  resolved: ResolvedConnector | undefined,
  flows: FlowCatalog,
  name: (id: string) => string,
  scenarioFilter?: (s: Scenario) => boolean
): DocEndpoint {
  const headers = new Map<string, DocHeader>()
  for (const h of c.resolved?.headers ?? []) headers.set(h.name.toLowerCase(), h)
  for (const h of e.headers) {
    const previous = headers.get(h.name.toLowerCase())
    headers.set(h.name.toLowerCase(), {
      ...h,
      from: ENDPOINT_ORIGIN,
      overrides: previous ? [...previous.overrides, previous.from] : []
    })
  }

  const scenarios = (raw.scenarios ?? []).filter((s) => !scenarioFilter || scenarioFilter(s)).map((s) => describeScenario(s, e))
  const variables = new Set<string>()
  collectVariables({ path: raw.path, headers: raw.headers, query: raw.query, body: raw.body }, variables)
  for (const s of raw.scenarios ?? []) if (!scenarioFilter || scenarioFilter(s)) collectVariables(s.overrides, variables)

  const usages: DocFlowUsage[] = []
  for (const { file, flow } of flows.flows) {
    const nodes = flow.nodes.filter(
      (n) => n.type === 'request' && n.request.connector === c.id && n.request.endpoint === raw.id
    )
    if (!nodes.length) continue
    usages.push({
      id: flow.id,
      name: flow.name,
      file,
      ...(flow.description !== undefined && { description: flow.description }),
      nodes: nodes.map((n) => n.name),
      diagram: flowDiagram(flow, new Set(nodes.map((n) => n.id)))
    })
  }

  const prefix = e.url && resolved?.baseUrl !== undefined ? e.url.slice(resolved.baseUrl.replace(/\/+$/, '').length) : ''
  return {
    id: e.id,
    name: e.name,
    method: e.method,
    path: e.path,
    ...(e.url !== undefined && { url: e.url }),
    ...(e.requiresAuth !== undefined && { requiresAuth: e.requiresAuth }),
    ...(e.description !== undefined && { description: e.description }),
    ...(e.docs !== undefined && { docs: e.docs }),
    pathParams: [...e.path.matchAll(/(?<!\{)\{([A-Za-z0-9_.-]+)\}(?!\})/g)].map((m) => m[1]!),
    headers: [...headers.values()],
    query: e.query,
    variables: [...variables].sort(),
    ...(e.bodySchema && { bodySchema: JSON.stringify(e.bodySchema, null, 2) }),
    ...(e.sharedSchema && { sharedSchema: e.sharedSchema }),
    fields: e.fields,
    ...(e.body !== undefined && { body: e.body }),
    checks: e.checks.filter((k) => k.source === 'body' || scenarios.some((s) => s.id === k.source)),
    scenarios,
    flows: usages,
    diagrams: {
      sequence: endpointSequence({
        connectorName: c.name,
        chain: c.chain.map(name),
        method: e.method,
        path: prefix.startsWith('/') ? prefix : e.path,
        ...(resolved?.auth && { auth: { config: resolved.auth.config, fromName: name(resolved.auth.from) } }),
        scenarios
      })
    }
  }
}

function describeScenario(s: Scenario, e: RegistryEndpoint): DocScenario {
  const o = s.overrides ?? {}
  const entries = <T>(record: Record<string, T> | undefined) =>
    record && Object.entries(record).map(([name, value]) => ({ name, value }))
  const assertions: DocAssertion[] = s.assertions.map((a) => ({
    target: a.target,
    operator: a.operator,
    ...(a.expected !== undefined && { expected: typeof a.expected === 'string' ? a.expected : JSON.stringify(a.expected) })
  }))
  const status = s.assertions.find((a) => a.target === 'status' && a.operator === 'equals' && typeof a.expected === 'number')
  const check = e.checks.find((k) => k.source === s.id)
  return {
    id: s.id,
    name: s.name,
    ...(s.description !== undefined && { description: s.description }),
    overrides: {
      ...(o.body !== undefined && { body: typeof o.body === 'string' ? o.body : JSON.stringify(o.body, null, 2) }),
      ...(o.headers !== undefined && { headers: o.headers === null ? null : entries(o.headers)! }),
      ...(o.query !== undefined && { query: entries(o.query)! }),
      ...(o.pathParams !== undefined && { pathParams: entries(o.pathParams)! })
    },
    assertions,
    ...(status && { expectedStatus: status.expected as number }),
    ...(check && { check })
  }
}

const WHOLE_TEMPLATE = /^\s*\{\{[^{}]+\}\}\s*$/
/** Campos da auth que guardam credencial: só o nome da variável aparece. */
const CREDENTIAL_FIELDS = new Set(['token', 'value', 'password', 'clientSecret', 'passphrase', 'secretAccessKey', 'sessionToken', 'consumerSecret', 'tokenSecret'])

/** Configuração da auth para a documentação: campos de credencial só como {{VAR}}. */
function authDetails(auth: Exclude<ConnectorAuth, { type: 'none' }> | undefined): { name: string; value: string }[] {
  if (!auth) return []
  const out: { name: string; value: string }[] = []
  const add = (field: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    const credential = CREDENTIAL_FIELDS.has(field) || isSensitiveName(field)
    out.push({ name: field, value: credential && !WHOLE_TEMPLATE.test(text) ? 'definido no arquivo (não exibido)' : text })
  }
  switch (auth.type) {
    case 'bearer':
      add('header', auth.header ?? 'Authorization')
      add('prefix', auth.prefix ?? 'Bearer')
      add('token', auth.token)
      break
    case 'apiKey':
      add('in', auth.in ?? 'header')
      add('name', auth.name)
      add('value', auth.value)
      break
    case 'basic':
      add('username', auth.username)
      add('password', auth.password)
      break
    case 'oauth2':
      add('grantType', auth.grantType)
      add('authUrl', auth.authUrl)
      add('redirectUri', auth.redirectUri)
      if (auth.grantType === 'authorization_code') add('pkce', auth.pkce ?? true)
      add('tokenUrl', auth.tokenUrl)
      add('clientId', auth.clientId)
      add('clientSecret', auth.clientSecret)
      add('username', auth.username)
      add('password', auth.password)
      add('scope', auth.scope)
      add('audience', auth.audience)
      add('clientAuthentication', auth.clientAuthentication ?? 'basic')
      add('tokenRequestFormat', auth.tokenRequestFormat ?? 'form')
      break
    case 'login':
      add('request', `${auth.request.method ?? 'POST'} ${auth.request.url}`)
      add('tokenPath', auth.token)
      add('expiresIn', auth.expiresIn)
      add('ttlSeconds', auth.ttlSeconds)
      add('inject', `${auth.inject?.in ?? 'header'} ${auth.inject?.name ?? 'Authorization'}: ${auth.inject?.value ?? 'Bearer {{$token}}'}`)
      break
    case 'digest':
      add('username', auth.username)
      add('password', auth.password)
      break
    case 'ntlm':
      add('domain', auth.domain)
      add('username', auth.username)
      add('password', auth.password)
      add('workstation', auth.workstation)
      break
    case 'awsSigV4':
      add('service', auth.service)
      add('region', auth.region)
      add('accessKeyId', auth.accessKeyId)
      add('secretAccessKey', auth.secretAccessKey)
      add('sessionToken', auth.sessionToken)
      break
    case 'oauth1':
      add('signatureMethod', auth.signatureMethod ?? 'HMAC-SHA1')
      add('consumerKey', auth.consumerKey)
      add('consumerSecret', auth.consumerSecret)
      add('token', auth.token)
      add('tokenSecret', auth.tokenSecret)
      add('realm', auth.realm)
      break
  }
  return out
}

const TEMPLATE_VAR = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g

/** Variáveis {{VAR}} do ambiente em qualquer valor (as {{ $nodes... }} e {{$token}} ficam de fora). */
function collectVariables(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 32 || value === undefined || value === null) return
  if (typeof value === 'string') {
    for (const m of value.matchAll(TEMPLATE_VAR)) into.add(m[1]!)
    return
  }
  if (typeof value !== 'object') return
  for (const [k, v] of Object.entries(value)) {
    collectVariables(k, into, depth + 1)
    collectVariables(v, into, depth + 1)
  }
}

function flowConnectors(flow: Flow): Set<string> {
  const out = new Set<string>()
  for (const n of flow.nodes) {
    if (n.type === 'request' && n.request.connector) out.add(n.request.connector)
    if (n.type === 'plugin' && n.plugin.connector) out.add(n.plugin.connector)
  }
  return out
}
