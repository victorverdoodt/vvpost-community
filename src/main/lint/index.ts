import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml, parseDocument } from 'yaml'
import { joinPath, resolveConnector } from '@vvpost/core/connectors/resolve'
import { PROJECT_FILE } from '@vvpost/core/projects'
import type { FlowCatalog } from '@vvpost/core/types'
import { loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { loadFlows } from '@vvpost/core/flows/workspace'
import {
  buildLintDocument,
  DEFAULT_RULESET,
  resolveRuleset,
  RulesetError,
  runLint,
  SEVERITIES,
  summarize,
  type JsonPathSegment,
  type LintDocument,
  type LintFinding,
  type LintLocation,
  type LintSummary,
  type LintWorkspaceDocument,
  type ResolvedRuleset
} from '@vvpost/core/lint'
import type { DriftItem } from '@vvpost/core/docs/architecture'

/**
 * O lint do workspace como o app, o CLI e o MCP rodam: acha o ruleset do time (ou usa o
 * `vvpost:recommended`), monta o documento do workspace e, quando alguma regra é de OpenAPI, a spec
 * exportada, e devolve os achados com a linha no arquivo de origem.
 */

/** Onde o ruleset do time fica, na ordem em que é procurado (o .spectral.* para quem já tem um). */
export const RULESET_FILES = ['.vvpost/ruleset.yaml', '.vvpost/ruleset.yml', '.vvpost/ruleset.json', '.spectral.yaml', '.spectral.yml', '.spectral.json']

export interface WorkspaceLintResult {
  findings: LintFinding[]
  summary: LintSummary
  /** Arquivo do ruleset usado, relativo ao workspace; ausente: o vvpost:recommended. */
  ruleset?: string
  /** Problemas do ruleset e da spec exportada que não impedem o lint. */
  issues: string[]
  /** Quantos achados de diagrama o VVPost sabe corrigir sozinho (fix_diagrams, vvpost lint --fix). */
  fixable: number
  /** O drift entre a documentação e o catálogo, com as correções (para quem corrige). */
  drift: DriftItem[]
}

export interface WorkspaceLintOptions {
  /** Ruleset fora do lugar padrão (o --ruleset do CLI), absoluto ou relativo ao workspace. */
  ruleset?: string
  /** O workspace e os fluxos já lidos, para não ler de novo. */
  ws?: LoadedWorkspace
  flows?: FlowCatalog
  /** Sem o histórico do Git (doc-stale-since-change). */
  noHistory?: boolean
}

/** O ruleset do projeto, ou o da raiz do workspace quando o projeto não tem um. */
export function findRulesetFile(dir: string, root?: string): string | undefined {
  for (const base of root && resolve(root) !== resolve(dir) ? [dir, root] : [dir]) {
    for (const name of RULESET_FILES) if (existsSync(join(base, name))) return join(base, name)
  }
  return undefined
}

async function readRulesetFile(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    throw new RulesetError(`não deu para ler o ruleset ${path}: ${(err as Error).message}`)
  }
  try {
    return parseYaml(text, { maxAliasCount: 100 })
  } catch (err) {
    throw new RulesetError(`${path}: YAML/JSON inválido (${(err as Error).message})`)
  }
}

export async function loadRuleset(dir: string, options: { ruleset?: string; root?: string } = {}): Promise<{ ruleset: ResolvedRuleset; file?: string }> {
  const file = options.ruleset ? resolve(dir, options.ruleset) : findRulesetFile(dir, options.root)
  const rel = (path: string) => {
    const r = relative(dir, path).split(sep).join('/')
    return r.startsWith('..') && !options.root ? path : r
  }
  if (!file) return { ruleset: await resolveRuleset(DEFAULT_RULESET, 'vvpost:padrão') }
  const data = await readRulesetFile(file)
  const origins = new Map<string, string>([[rel(file), file]])
  const ruleset = await resolveRuleset(data, rel(file), {
    async load(ref, from) {
      const base = origins.get(from) ?? file
      const target = isAbsolute(ref) ? ref : resolve(dirname(base), ref)
      const origin = rel(target)
      origins.set(origin, target)
      return { data: await readRulesetFile(target), origin }
    }
  })
  return { ruleset, file: rel(file) }
}

export async function lintWorkspace(dir: string, options: WorkspaceLintOptions = {}): Promise<WorkspaceLintResult> {
  const ws = options.ws ?? (await loadWorkspace(dir))
  const flows = options.flows ?? (await loadFlows(dir))
  const { ruleset, file } = await loadRuleset(dir, { ...(options.ruleset && { ruleset: options.ruleset }), ...(ws.root && { root: ws.root }) })
  const issues = [...ruleset.issues]
  const documents: LintDocument[] = [await buildLintDocument(ws, flows)]
  const data = documents[0]!.data as LintWorkspaceDocument
  if (!options.noHistory && mayRun(ruleset, 'doc-stale-since-change')) {
    try {
      data.drift.push(...(await (await import('./architecture')).historyDrift(dir, ws, flows, data)))
    } catch (err) {
      issues.push(`o histórico do Git não foi lido para doc-stale-since-change (${(err as Error).message})`)
    }
  }
  const wantsOpenApi = [...ruleset.rules.values()].some(
    (r) => r.formats.includes('oas3') && (ruleset.severity.get(r.name) !== 'off' || ruleset.overrides.some((o) => (o.severity.get(r.name) ?? 'off') !== 'off'))
  )
  if (wantsOpenApi) {
    try {
      documents.push(await openApiDocument(dir, ws))
    } catch (err) {
      issues.push(`as regras de OpenAPI não rodaram: a spec não foi exportada (${(err as Error).message})`)
    }
  }
  const findings = runLint(documents, ruleset)
  await addLines(dir, findings)
  // Na ordem do arquivo: quem lê o relatório desce o arquivo uma vez.
  findings.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
  const reported = new Set(findings.filter((f) => f.path.startsWith('$.drift[')).map((f) => Number(/^\$\.drift\[(\d+)\]/.exec(f.path)?.[1])))
  const fixable = data.drift.filter((d, i) => d.fix && reported.has(i)).length
  return { findings, summary: summarize(findings), ...(file && { ruleset: file }), issues, fixable, drift: data.drift.filter((_, i) => reported.has(i)) }
}

function mayRun(ruleset: ResolvedRuleset, name: string): boolean {
  if ((ruleset.severity.get(name) ?? 'off') !== 'off') return true
  return ruleset.overrides.some((o) => (o.severity.get(name) ?? 'off') !== 'off')
}

/** A spec OpenAPI que o `vvpost export --format openapi` gravaria, com cada operação apontando de volta ao endpoint. */
async function openApiDocument(dir: string, ws: LoadedWorkspace): Promise<LintDocument> {
  const { exportAs } = await import('../bundle/export')
  const result = await exportAs(dir, { format: 'openapi' })
  const spec = result.files[0].data as Record<string, unknown>
  const own = (id: string) => {
    const file = ws.flowSources?.get(id) ?? ws.connectorFiles.get(id)
    return !ws.shared?.has(id) && file !== undefined && !file.startsWith('../') && !file.startsWith('shared:') ? file : undefined
  }
  const operations = new Map<string, LintLocation>()
  const byName = new Map<string, LintLocation>()
  let rootLocation: LintLocation | undefined
  for (const c of ws.connectors.values()) {
    const file = own(c.id)
    if (!file) continue
    const fromFlow = ws.flowSources?.has(c.id)
    byName.set(c.name, { file, ...(!fromFlow && { pointer: ['description'] }), label: c.id, target: { kind: 'connector', connectorId: c.id } })
    if (!c.extends && !rootLocation) rootLocation = { file, label: c.id, target: { kind: 'connector', connectorId: c.id } }
    let basePath = ''
    try {
      basePath = resolveConnector(c.id, ws.connectors).basePath
    } catch {
      // herança quebrada: o validate já acusa
    }
    for (const [i, e] of (c.endpoints ?? []).entries()) {
      const flowFile = ws.flowSources?.get(`${c.id}/${e.id}`)
      operations.set(`${joinPath(basePath, e.path) || '/'} ${e.method.toLowerCase()}`, {
        file: flowFile ?? file,
        ...(!flowFile && { pointer: ['endpoints', i] }),
        label: `${c.id}/${e.id}`,
        target: { kind: 'endpoint', connectorId: c.id, endpointId: e.id }
      })
    }
  }
  if (!rootLocation && existsSync(join(dir, PROJECT_FILE))) rootLocation = { file: PROJECT_FILE, label: 'spec OpenAPI' }
  const locate = (path: JsonPathSegment[]): LintLocation | null => {
    if (path[0] === 'paths' && typeof path[1] === 'string') {
      const op = typeof path[2] === 'string' ? operations.get(`${path[1]} ${path[2]}`) : undefined
      if (op) return { ...op, label: `${op.label} (OpenAPI ${String(path[2]).toUpperCase()} ${path[1]})` }
      // O caminho inteiro: o primeiro endpoint dele.
      for (const [key, loc] of operations) if (key.startsWith(`${path[1]} `)) return loc
      return null
    }
    if (path[0] === 'tags' && typeof path[1] === 'number') {
      const tag = (spec['tags'] as { name?: string }[] | undefined)?.[path[1]]
      return (tag?.name && byName.get(tag.name)) || null
    }
    return rootLocation ? { ...rootLocation, label: `${rootLocation.label} (OpenAPI)` } : null
  }
  return { format: 'oas3', data: spec, locate }
}

/** A linha de cada achado no arquivo: o nó mais fundo do caminho que existe nele. */
async function addLines(dir: string, findings: LintFinding[]): Promise<void> {
  const docs = new Map<string, ReturnType<typeof parseDocument> | null>()
  const texts = new Map<string, string>()
  for (const f of findings) {
    // Quem montou o documento já sabe a linha (tokens da marca): fica a dele.
    if (!/\.json$/i.test(f.file) || (f.line !== undefined && !f.pointer)) continue
    if (!docs.has(f.file)) {
      const text = await readFile(join(dir, f.file), 'utf8').catch(() => null)
      docs.set(f.file, text === null ? null : parseDocument(text, { keepSourceTokens: false, uniqueKeys: false }))
      if (text !== null) texts.set(f.file, text)
    }
    const doc = docs.get(f.file)
    const text = texts.get(f.file)
    if (!doc || text === undefined) continue
    const pointer = f.pointer ?? []
    let line = 1
    for (let n = pointer.length; n >= 0; n--) {
      const node = doc.getIn(pointer.slice(0, n), true) as { range?: [number, number, number] } | undefined
      if (node?.range) {
        line = text.slice(0, node.range[0]).split('\n').length
        break
      }
    }
    f.line = line
  }
}

/** Conta por severidade, para a linha final do CLI e o resumo do MCP. */
export function summaryLine(summary: LintSummary): string {
  const part = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  return [part(summary.error, 'erro', 'erros'), part(summary.warn, 'aviso', 'avisos'), part(summary.info, 'info', 'infos'), part(summary.hint, 'dica', 'dicas')].join(', ')
}
