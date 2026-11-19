import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Connector, Environment, Flow } from '@vvpost/schemas'
import type { LoadedWorkspace } from '../connectors/workspace'
import { plainFlows } from '../flows/workspace'
import type { FlowCatalog } from '../types'
import { architectureDiagrams, architectureDrift, staleReferences, type ArchitectureCatalog, type ArchitectureDiagram, type DriftItem } from '../docs/architecture'
import { authHeaderName } from '../connectors/auth-contract'
import { resolveConnector } from '../connectors/resolve'
import { SENSITIVE_HEADERS } from '../secrets'
import { loadBrand } from '../brand/load'
import { agentFilesCodeMapDrift, codeMapDrift, repoRoot } from '../docs/codemap'
import { formatTokenValue, type BrandItem } from '../brand/tokens'
import type { LintDocument, LintLocation } from './engine'
import type { JsonPathSegment } from './jsonpath'

/**
 * O documento que as regras do VVPost leem: os conectores do projeto como estão nos arquivos (sem
 * a herança resolvida), os ambientes, os fluxos comuns e as páginas de docs/. O `given` de uma
 * regra é um JSONPath sobre ele:
 *
 *   $.connectors[*]                      conector (id, name, description, config, endpoints...)
 *   $.connectors[*].endpoints[*]         endpoint (id, name, method, path, examples, scenarios...)
 *   $.environments[*]                    ambiente (id, name, variables: { NOME: { value, isSecret } })
 *   $.flows[*]                           fluxo (id, name, description, nodes, edges)
 *   $.docs[*]                            página (file, title, headings, text, references)
 *   $.diagrams[*]                        diagrama C4 de docs/ (file, line, type, elements, relations, bindings)
 *   $.drift[*]                           divergência entre a documentação e o catálogo (code, message, file, line)
 *   $.auth[*]                            auth de cada conector com a herança (connector, auth, from, authHeader) e os
 *                                        headers de credencial que cada endpoint e cenário manda por conta própria
 *   $.tokens[*]                          token da marca de brand/*.tokens.json (name, type, value, modes, description, file)
 *   $.brand[*]                           achado da marca: tokens, contraste e o código do frontend (code, message, file, line)
 *
 * Os conectores compartilhados e os do Compartilhado de um projeto ficam de fora: são lidos, não
 * escritos, aqui.
 */
export interface LintWorkspaceDocument {
  connectors: Connector[]
  environments: Environment[]
  flows: Flow[]
  docs: LintDocPage[]
  diagrams: ArchitectureDiagram[]
  drift: DriftItem[]
  auth: LintConnectorAuth[]
  tokens: LintBrandToken[]
  brand: BrandItem[]
}

/** Token da marca para as regras do time: o valor resolvido em texto curto (#bd948a, 8px). */
export interface LintBrandToken {
  name: string
  type: string
  value: string
  modes?: Record<string, string>
  description?: string
  file: string
  line?: number
}

/** A auth efetiva de um conector e quem, nos endpoints dele, manda credencial no header por fora dela. */
export interface LintConnectorAuth {
  connector: string
  /** O tipo da auth com a herança, ou null sem auth. */
  auth: string | null
  /** O conector de onde a auth vem. */
  from?: string
  /** O header em que a auth põe a credencial (minúsculas), quando é header. */
  authHeader?: string
  endpoints: { id: string; credentialHeaders: string[]; scenarios: { id: string; credentialHeaders: string[] }[] }[]
}

export interface LintDocPage {
  file: string
  title: string
  headings: string[]
  text: string
  /** Diretivas {{> tipo}} usadas na página. */
  directives: string[]
  /** O que a página cita do catálogo: por diretiva, por "<conector>/<endpoint>" ou por "MÉTODO /caminho" no texto. */
  references: { connectors: string[]; endpoints: string[] }
}

const DOCS_DIR = 'docs'
const MAX_PAGES = 300
const MAX_PAGE_BYTES = 512 * 1024
const DIRECTIVE = /\{\{>\s*([a-z0-9]+)\b\s*([^}]*)\}\}/g
const METHOD_PATH = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s`'")<>]*)/g

export async function buildLintDocument(ws: LoadedWorkspace, flows: FlowCatalog): Promise<LintDocument> {
  const own = (file: string | undefined) => file !== undefined && !file.startsWith('../') && !file.startsWith('shared:')
  const connectorFile = (id: string) => ws.flowSources?.get(id) ?? ws.connectorFiles.get(id)
  const connectors = [...ws.connectors.values()].filter((c) => !ws.shared?.has(c.id) && own(connectorFile(c.id)))
  const environments = [...ws.environments.values()].filter((e) => own(ws.environmentFiles?.get(e.id)))
  const flowEntries = plainFlows(flows, ws.flowSources)
  const { pages: docs, diagramFiles } = await readDocPages(ws.dir, connectors)
  const catalog: ArchitectureCatalog = { connectors: [...ws.connectors.values()], ownConnectors: connectors, flows: flowEntries }
  const diagrams = [...docs.map((p) => ({ file: p.file, text: p.text })), ...diagramFiles].flatMap((f) => architectureDiagrams(f.file, f.text))
  const root = repoRoot(ws.root ?? ws.dir)
  const codeMaps = [
    ...(await Promise.all(docs.map((p) => codeMapDrift(root, p.file, p.text)))).flat(),
    ...(await agentFilesCodeMapDrift(ws.dir, root))
  ]
  const drift = [...architectureDrift(diagrams, catalog), ...docs.flatMap((p) => staleReferences(p.file, p.text, catalog)), ...codeMaps]
  const auth = connectorAuth(connectors, ws.connectors)
  const brandLoad = await loadBrand(ws.dir, { ...(ws.root && { root: ws.root }), scan: true })
  const tokens: LintBrandToken[] = brandLoad.files.flatMap((f) =>
    f.tokens
      .filter((t) => t.resolved !== undefined)
      .map((t) => ({
        name: t.name,
        type: t.type,
        value: formatTokenValue(t.resolved),
        ...(t.modes && { modes: Object.fromEntries(Object.entries(t.modes).map(([m, v]) => [m, formatTokenValue(v)])) }),
        ...(t.description && { description: t.description }),
        file: t.file,
        ...(t.line !== undefined && { line: t.line })
      }))
  )
  const brand = brandLoad.items
  const data: LintWorkspaceDocument = { connectors, environments, flows: flowEntries.map((f) => f.flow), docs, diagrams, drift, auth, tokens, brand }

  const locate = (path: JsonPathSegment[]): LintLocation | null => {
    const [root, index, ...rest] = path
    if (typeof index !== 'number') return null
    if (root === 'connectors') {
      const c = connectors[index]
      if (!c) return null
      const [key, ei, ...inner] = rest
      if (key === 'endpoints' && typeof ei === 'number' && c.endpoints?.[ei]) {
        const e = c.endpoints[ei]!
        const fromFlow = ws.flowSources?.get(`${c.id}/${e.id}`)
        const [sub, si] = inner
        const scenario = sub === 'scenarios' && typeof si === 'number' ? e.scenarios?.[si] : undefined
        const example = sub === 'examples' && typeof si === 'number' ? e.examples?.[si] : undefined
        return {
          file: fromFlow ?? connectorFile(c.id)!,
          pointer: fromFlow ? requestFlowPointer(inner) : rest,
          label: `${c.id}/${e.id}${scenario ? ` › cenário ${scenario.id}` : example ? ` › exemplo ${example.name} (${example.status})` : ''}`,
          target: scenario
            ? { kind: 'scenario', connectorId: c.id, endpointId: e.id, scenarioId: scenario.id }
            : { kind: 'endpoint', connectorId: c.id, endpointId: e.id }
        }
      }
      const fromFlow = ws.flowSources?.get(c.id)
      return { file: connectorFile(c.id)!, pointer: fromFlow ? (key === 'name' || key === 'description' ? rest : []) : rest, label: c.id, target: { kind: 'connector', connectorId: c.id } }
    }
    if (root === 'environments') {
      const env = environments[index]
      if (!env) return null
      const variable = rest[0] === 'variables' && typeof rest[1] === 'string' ? rest[1] : undefined
      return {
        file: ws.environmentFiles!.get(env.id)!,
        pointer: rest,
        label: `ambiente ${env.id}${variable ? `, variável ${variable}` : ''}`,
        target: { kind: 'environment', environmentId: env.id, ...(variable && { variable }) }
      }
    }
    if (root === 'flows') {
      const entry = flowEntries[index]
      if (!entry) return null
      return { file: entry.file, pointer: rest, label: `fluxo ${entry.flow.id}`, target: { kind: 'flow', flowId: entry.flow.id, file: entry.file } }
    }
    if (root === 'docs') {
      const page = docs[index]
      if (!page) return null
      return { file: page.file, label: page.title || page.file, target: { kind: 'doc', file: page.file } }
    }
    if (root === 'diagrams') {
      const d = diagrams[index]
      if (!d) return null
      const [key, i] = rest
      const item = key === 'elements' && typeof i === 'number' ? d.elements[i] : key === 'relations' && typeof i === 'number' ? d.relations[i] : key === 'bindings' && typeof i === 'number' ? d.bindings[i] : undefined
      const line = item?.line ?? d.line
      const label = item && 'alias' in item ? item.alias : item && 'from' in item ? `${item.from} → ${item.to}` : (d.title ?? d.type)
      return { file: d.file, ...(line !== undefined && { line }), label, target: { kind: 'doc', file: d.file, ...(line !== undefined && { line }) } }
    }
    if (root === 'auth') {
      // Achado de um endpoint ou cenário: o lugar dos headers dele; senão, o conector.
      const [key, ei, sub, si] = rest
      if (key !== 'endpoints' || typeof ei !== 'number') return locate(['connectors', index])
      const c = connectors[index]
      const scenario = sub === 'scenarios' && typeof si === 'number' ? (c?.endpoints?.[ei]?.scenarios ?? []).findIndex((x) => x.id === auth[index]?.endpoints[ei]?.scenarios[si]?.id) : -1
      return locate(['connectors', index, 'endpoints', ei, ...(scenario >= 0 ? ['scenarios', scenario, 'overrides', 'headers'] : ['headers'])])
    }
    if (root === 'tokens' || root === 'brand') {
      const item = root === 'tokens' ? tokens[index] : brand[index]
      if (!item) return null
      const label = 'label' in item && item.label ? item.label : 'name' in item ? item.name : undefined
      return {
        file: item.file,
        ...(item.line !== undefined && { line: item.line }),
        ...(label && { label }),
        target: { kind: 'doc', file: item.file, ...(item.line !== undefined && { line: item.line }) }
      }
    }
    if (root === 'drift') {
      const item = drift[index]
      if (!item) return null
      return {
        file: item.file,
        ...(item.line !== undefined && { line: item.line }),
        ...(item.label && { label: item.label }),
        target: { kind: 'doc', file: item.file, ...(item.line !== undefined && { line: item.line }) }
      }
    }
    return null
  }
  return { format: 'vvpost', data, locate }
}

/** Headers que levam credencial (sem os cookies, que muitas APIs usam para outra coisa). */
const CREDENTIAL_HEADERS = [...SENSITIVE_HEADERS].filter((h) => h !== 'cookie' && h !== 'set-cookie')

function connectorAuth(connectors: Connector[], catalog: ReadonlyMap<string, Connector>): LintConnectorAuth[] {
  return connectors.map((c) => {
    let resolved: ReturnType<typeof resolveConnector> | undefined
    try {
      resolved = resolveConnector(c.id, catalog)
    } catch {
      // Herança quebrada: o validate já acusa.
    }
    const config = resolved?.auth?.config
    const authHeader = config ? authHeaderName(config)?.toLowerCase() : undefined
    const credential = (headers: Record<string, string | null> | null | undefined) =>
      Object.entries(headers ?? {})
        .filter(([name, value]) => value !== null && (CREDENTIAL_HEADERS.includes(name.toLowerCase()) || name.toLowerCase() === authHeader))
        .map(([name]) => name.toLowerCase())
        .sort()
    return {
      connector: c.id,
      auth: config?.type ?? null,
      ...(resolved?.auth && { from: resolved.auth.from }),
      ...(authHeader && { authHeader }),
      endpoints: (c.endpoints ?? []).map((e) => ({
        id: e.id,
        credentialHeaders: credential(e.headers),
        scenarios: (e.scenarios ?? []).map((s) => ({ id: s.id, credentialHeaders: credential(s.overrides?.headers) }))
      }))
    }
  })
}

/** No fluxo de requisição, nome, descrição, cenários e exemplos ficam na raiz; a requisição, no nó. */
function requestFlowPointer(inner: JsonPathSegment[]): JsonPathSegment[] {
  const [key, ...rest] = inner
  if (key === 'name' || key === 'description' || key === 'requiresAuth' || key === 'scenarios' || key === 'examples') return inner
  if (key === 'path') return ['nodes', 0, 'request', 'url']
  if (typeof key === 'string' && ['method', 'headers', 'query', 'body', 'bodySchema', 'payload'].includes(key)) return ['nodes', 0, 'request', key, ...rest]
  return []
}

async function readDocPages(dir: string, connectors: Connector[]): Promise<{ pages: LintDocPage[]; diagramFiles: { file: string; text: string }[] }> {
  const files: string[] = []
  const mmd: string[] = []
  const walk = async (rel: string, depth: number) => {
    if (depth > 6 || files.length >= MAX_PAGES) return
    const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (path !== `${DOCS_DIR}/export` && !entry.name.startsWith('.') && entry.name !== 'node_modules') await walk(path, depth + 1)
      } else if (entry.isFile() && /\.md$/i.test(entry.name) && files.length < MAX_PAGES) files.push(path)
      else if (entry.isFile() && /\.mmd$/i.test(entry.name) && mmd.length < MAX_PAGES) mmd.push(path)
    }
  }
  await walk(DOCS_DIR, 0)

  const endpointKeys = connectors.flatMap((c) => (c.endpoints ?? []).map((e) => ({ connector: c.id, key: `${c.id}/${e.id}`, method: e.method, path: e.path })))
  const read = async (file: string): Promise<string | null> => {
    try {
      if ((await stat(join(dir, file))).size > MAX_PAGE_BYTES) return null
      return (await readFile(join(dir, file), 'utf8')).replace(/\r\n?/g, '\n')
    } catch {
      return null
    }
  }
  const diagramFiles: { file: string; text: string }[] = []
  for (const file of mmd) {
    const text = await read(file)
    if (text !== null) diagramFiles.push({ file, text })
  }
  const pages: LintDocPage[] = []
  for (const file of files) {
    const text = await read(file)
    if (text === null) continue
    const headings = [...text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) => m[1]!)
    const directives: string[] = []
    const refConnectors = new Set<string>()
    const refEndpoints = new Set<string>()
    for (const m of text.matchAll(DIRECTIVE)) {
      const kind = m[1]!
      const arg = m[2]!.trim()
      directives.push(kind)
      if (kind === 'reference' || kind === 'map' || kind === 'c4') for (const e of endpointKeys) refEndpoints.add(e.key)
      else if (kind === 'connector') {
        refConnectors.add(arg)
        for (const e of endpointKeys) if (e.connector === arg) refEndpoints.add(e.key)
      } else if (kind === 'endpoint' || kind === 'request') {
        const key = endpointKeys.find((e) => arg === e.key || arg.startsWith(`${e.key}/`))
        if (key) refEndpoints.add(key.key)
      }
    }
    for (const e of endpointKeys) if (text.includes(e.key)) refEndpoints.add(e.key)
    for (const m of text.matchAll(METHOD_PATH)) {
      for (const e of endpointKeys) if (e.method === m[1] && e.path === m[2]) refEndpoints.add(e.key)
    }
    for (const key of refEndpoints) refConnectors.add(key.slice(0, key.lastIndexOf('/')))
    pages.push({
      file,
      title: headings[0] ?? '',
      headings,
      text,
      directives,
      references: { connectors: [...refConnectors].sort(), endpoints: [...refEndpoints].sort() }
    })
  }
  return { pages, diagramFiles }
}
