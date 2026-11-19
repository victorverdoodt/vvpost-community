import { LINT_FUNCTIONS } from './functions'
import { JsonPathError, parseJsonPath } from './jsonpath'
import { BUILTIN_RULESETS } from './builtin'

/**
 * Rulesets no formato do Spectral (`extends`, `rules`, `overrides`, `aliases`, `formats`), lidos de
 * `.vvpost/ruleset.yaml` ou embutidos (`vvpost:recommended`, `vvpost:all`, `spectral:oas`). Quem
 * chama lê os arquivos (YAML ou JSON) e passa o objeto: o motor não toca no disco.
 */

export type LintSeverity = 'error' | 'warn' | 'info' | 'hint'
export type RuleSeverity = LintSeverity | 'off'
/** O documento a que a regra se aplica: o workspace do VVPost ou a spec OpenAPI exportada dele. */
export type LintFormat = 'vvpost' | 'oas3'

export const SEVERITIES: readonly LintSeverity[] = ['error', 'warn', 'info', 'hint']

export interface LintThen {
  field?: string
  function: string
  functionOptions?: Record<string, unknown>
}

export interface LintRule {
  name: string
  description?: string
  message?: string
  /** Como corrigir, para quem lê o achado (pessoa ou agente). Campo do VVPost; o Spectral ignora. */
  hint?: string
  documentationUrl?: string
  /** Severidade da definição (a que `true` e o modo `all` ligam). */
  severity: LintSeverity
  given: string[]
  then: LintThen[]
  formats: LintFormat[]
  recommended: boolean
  /** De onde a definição veio: um ruleset embutido ou o arquivo do time. */
  origin: string
}

export interface RulesetOverride {
  files: string[]
  match: (file: string) => boolean
  severity: Map<string, RuleSeverity>
}

export interface ResolvedRuleset {
  rules: Map<string, LintRule>
  severity: Map<string, RuleSeverity>
  overrides: RulesetOverride[]
  /** Problemas do ruleset que não impedem o lint (regra desconhecida, função que não existe...). */
  issues: string[]
  /** Arquivos lidos (o do time e os que ele estende). */
  files: string[]
}

export class RulesetError extends Error {}

export interface RulesetLoader {
  /** Lê um ruleset citado em `extends` (caminho relativo a `from`); devolve o objeto e o nome do arquivo. */
  load(ref: string, from: string): Promise<{ data: unknown; origin: string }>
}

type ExtendsMode = 'recommended' | 'all' | 'off'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function normalizeSeverity(value: unknown, fallback: RuleSeverity = 'warn'): RuleSeverity | undefined {
  if (value === undefined) return fallback
  if (value === false || value === 'off' || value === -1) return 'off'
  if (typeof value === 'number') return SEVERITIES[value]
  if (typeof value === 'string') return (SEVERITIES as readonly string[]).includes(value) ? (value as LintSeverity) : undefined
  return undefined
}

const FORMAT_ALIASES: Record<string, LintFormat> = {
  vvpost: 'vvpost',
  oas3: 'oas3',
  'oas3.0': 'oas3',
  'oas3.1': 'oas3',
  oas3_0: 'oas3',
  oas3_1: 'oas3'
}

interface Layer {
  rules: Map<string, LintRule>
  severity: Map<string, RuleSeverity>
  overrides: RulesetOverride[]
  aliases: Map<string, string[]>
  issues: string[]
  files: string[]
  formats?: LintFormat[]
}

const emptyLayer = (): Layer => ({ rules: new Map(), severity: new Map(), overrides: [], aliases: new Map(), issues: [], files: [] })

/** O ruleset usado quando o workspace não tem um: o `vvpost:recommended`. */
export const DEFAULT_RULESET = { extends: ['vvpost:recommended'] }

/**
 * Monta o ruleset: resolve `extends` (embutidos ou arquivos pelo `loader`), aplica as mudanças de
 * severidade e as regras do próprio arquivo e compila os `overrides`. Formato inválido lança
 * RulesetError; regra com problema fica de fora e vira `issues`.
 */
export async function resolveRuleset(data: unknown, origin: string, loader?: RulesetLoader): Promise<ResolvedRuleset> {
  const layer = await build(data, origin, loader, new Set())
  return { rules: layer.rules, severity: layer.severity, overrides: layer.overrides, issues: layer.issues, files: layer.files }
}

async function build(data: unknown, origin: string, loader: RulesetLoader | undefined, visiting: Set<string>): Promise<Layer> {
  if (!isObject(data)) throw new RulesetError(`${origin}: o ruleset precisa ser um objeto (extends, rules, overrides)`)
  if (visiting.has(origin)) throw new RulesetError(`${origin}: extends em ciclo`)
  visiting = new Set([...visiting, origin])
  const layer = emptyLayer()
  if (!origin.includes(':')) layer.files.push(origin)

  for (const key of Object.keys(data)) {
    if (['extends', 'rules', 'overrides', 'aliases', 'formats', 'documentationUrl', 'description', 'parserOptions'].includes(key)) continue
    if (key === 'functions' || key === 'functionsDir') layer.issues.push(`${origin}: ${key} (funções em JavaScript) não é suportado; use as funções nativas`)
    else layer.issues.push(`${origin}: campo "${key}" desconhecido no ruleset; ignorado`)
  }

  const formats = parseFormats(data['formats'], `${origin}: formats`, layer.issues)
  const extendsList = data['extends'] === undefined ? [] : Array.isArray(data['extends']) ? data['extends'] : [data['extends']]
  // [ruleset, modo] é uma entrada só; ['a', 'b'] são duas.
  const entries: [string, ExtendsMode][] = []
  if (extendsList.length === 2 && typeof extendsList[0] === 'string' && ['recommended', 'all', 'off'].includes(extendsList[1] as string)) {
    entries.push([extendsList[0], extendsList[1] as ExtendsMode])
  } else {
    for (const e of extendsList) {
      if (typeof e === 'string') entries.push([e, 'recommended'])
      else if (Array.isArray(e) && typeof e[0] === 'string' && (e[1] === undefined || ['recommended', 'all', 'off'].includes(e[1]))) entries.push([e[0], (e[1] ?? 'recommended') as ExtendsMode])
      else throw new RulesetError(`${origin}: extends aceita "ruleset" ou [ruleset, recommended | all | off]`)
    }
  }

  let inheritedFormats: LintFormat[] | undefined
  for (const [ref, mode] of entries) {
    let base: Layer
    const builtin = BUILTIN_RULESETS[ref]
    if (builtin) base = await build(builtin, ref, loader, visiting)
    else if (/^https?:\/\//.test(ref)) {
      layer.issues.push(`${origin}: extends "${ref}" por URL não é suportado (o lint não acessa a rede); copie o ruleset para o workspace`)
      continue
    } else if (ref.includes(':') && !/^[A-Za-z]:[\\/]/.test(ref)) {
      layer.issues.push(`${origin}: ruleset embutido "${ref}" não existe (use ${Object.keys(BUILTIN_RULESETS).join(', ')})`)
      continue
    } else {
      if (!loader) throw new RulesetError(`${origin}: extends "${ref}" precisa ler um arquivo`)
      const loaded = await loader.load(ref, origin)
      base = await build(loaded.data, loaded.origin, loader, visiting)
    }
    for (const [name, rule] of base.rules) layer.rules.set(name, rule)
    for (const [name, rule] of base.rules) {
      const sev = mode === 'off' ? 'off' : mode === 'all' ? rule.severity : (base.severity.get(name) ?? 'off')
      layer.severity.set(name, sev)
    }
    layer.overrides.push(...base.overrides)
    for (const [k, v] of base.aliases) layer.aliases.set(k, v)
    layer.issues.push(...base.issues)
    layer.files.push(...base.files)
    if (base.formats?.includes('oas3') || [...base.rules.values()].some((r) => r.formats.includes('oas3'))) inheritedFormats = ['oas3']
  }
  // Regra sem formats num ruleset que estende o spectral:oas é de OpenAPI, como no Spectral.
  layer.formats = formats ?? inheritedFormats

  if (data['aliases'] !== undefined) {
    if (!isObject(data['aliases'])) throw new RulesetError(`${origin}: aliases precisa ser um objeto`)
    for (const [name, value] of Object.entries(data['aliases'])) {
      const list = typeof value === 'string' ? [value] : Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : null
      if (!list) layer.issues.push(`${origin}: alias ${name}: use um JSONPath ou uma lista deles`)
      else layer.aliases.set(name, list)
    }
  }

  if (data['rules'] !== undefined) {
    if (!isObject(data['rules'])) throw new RulesetError(`${origin}: rules precisa ser um objeto { nome: regra }`)
    applyRules(layer, data['rules'], origin, layer.severity)
  }

  if (data['overrides'] !== undefined) {
    if (!Array.isArray(data['overrides'])) throw new RulesetError(`${origin}: overrides precisa ser uma lista`)
    for (const [i, o] of data['overrides'].entries()) {
      if (!isObject(o) || !Array.isArray(o['files']) || !o['files'].every((f) => typeof f === 'string')) {
        throw new RulesetError(`${origin}: overrides[${i}] precisa de files (lista de globs)`)
      }
      if (o['extends'] !== undefined) layer.issues.push(`${origin}: overrides[${i}].extends não é suportado; ignorado`)
      const severity = new Map<string, RuleSeverity>()
      if (isObject(o['rules'])) applyRules(layer, o['rules'], `${origin}: overrides[${i}]`, severity, true)
      const files = o['files'] as string[]
      const res = files.map((f) => globToRegExp(f.split('#')[0]!))
      layer.overrides.push({ files, match: (file) => res.some((re) => re.test(file)), severity })
    }
  }
  return layer
}

function applyRules(layer: Layer, rules: Record<string, unknown>, origin: string, severity: Map<string, RuleSeverity>, override = false): void {
  for (const [name, def] of Object.entries(rules)) {
    const existing = layer.rules.get(name)
    if (typeof def === 'string' || typeof def === 'number' || typeof def === 'boolean') {
      if (!existing) {
        layer.issues.push(`${origin}: a regra "${name}" não existe nos rulesets estendidos`)
        continue
      }
      const sev = def === true ? existing.severity : normalizeSeverity(def)
      if (sev === undefined) layer.issues.push(`${origin}: ${name}: severidade "${String(def)}" inválida (use error, warn, info, hint ou off)`)
      else severity.set(name, sev)
      continue
    }
    if (!isObject(def)) {
      layer.issues.push(`${origin}: ${name}: a regra precisa ser um objeto ou uma severidade`)
      continue
    }
    if (!existing && (def['given'] === undefined || def['then'] === undefined)) {
      layer.issues.push(`${origin}: ${name}: regra nova precisa de given e then`)
      continue
    }
    const rule = normalizeRule(name, existing, def, origin, layer)
    if (typeof rule === 'string') {
      layer.issues.push(rule)
      continue
    }
    layer.rules.set(name, rule)
    // Regra nova dentro de um override só vale nos arquivos dele.
    if (override && !existing) layer.severity.set(name, 'off')
    severity.set(name, rule.recommended ? rule.severity : 'off')
  }
}

function normalizeRule(name: string, existing: LintRule | undefined, def: Record<string, unknown>, origin: string, layer: Layer): LintRule | string {
  const where = `${origin}: ${name}`
  const severity = normalizeSeverity(def['severity'], existing?.severity ?? 'warn')
  if (severity === undefined) return `${where}: severidade "${String(def['severity'])}" inválida`
  const givenRaw = def['given'] ?? existing?.given
  const givenList = typeof givenRaw === 'string' ? [givenRaw] : Array.isArray(givenRaw) && givenRaw.every((g) => typeof g === 'string') ? (givenRaw as string[]) : null
  if (!givenList || !givenList.length) return `${where}: given precisa ser um JSONPath ou uma lista deles`
  const given: string[] = []
  for (const g of givenList) {
    const expanded = expandAlias(g, layer.aliases)
    if (!expanded) return `${where}: alias "${g}" não existe`
    for (const path of expanded) {
      try {
        parseJsonPath(path)
      } catch (err) {
        return `${where}: ${err instanceof JsonPathError ? err.message : String(err)}`
      }
      given.push(path)
    }
  }
  const thenRaw = def['then'] ?? existing?.then
  const thenList = Array.isArray(thenRaw) ? thenRaw : [thenRaw]
  const then: LintThen[] = []
  for (const t of thenList) {
    if (!isObject(t) || typeof t['function'] !== 'string') return `${where}: then precisa de function`
    const fn = LINT_FUNCTIONS[t['function']]
    if (!fn) return `${where}: a função "${t['function']}" não existe (use ${Object.keys(LINT_FUNCTIONS).join(', ')})`
    if (t['field'] !== undefined && typeof t['field'] !== 'string') return `${where}: then.field precisa ser texto`
    const options = t['functionOptions'] ?? {}
    const problem = fn.checkOptions?.(options)
    if (problem) return `${where}: ${problem}`
    then.push({ function: t['function'], ...(t['field'] !== undefined && { field: t['field'] as string }), functionOptions: options as Record<string, unknown> })
  }
  const formats = def['formats'] !== undefined ? parseFormats(def['formats'], `${where}: formats`, layer.issues) : undefined
  const text = (key: string) => (typeof def[key] === 'string' ? (def[key] as string) : (existing?.[key as 'message'] ?? undefined))
  const description = text('description')
  const message = text('message')
  const hint = text('hint')
  const documentationUrl = text('documentationUrl')
  return {
    name,
    ...(description !== undefined && { description }),
    ...(message !== undefined && { message }),
    ...(hint !== undefined && { hint }),
    ...(documentationUrl !== undefined && { documentationUrl }),
    severity: severity === 'off' ? (existing?.severity ?? 'warn') : severity,
    given,
    then,
    formats: formats ?? existing?.formats ?? formatsOfGiven(given) ?? layer.formats ?? ['vvpost'],
    recommended: severity !== 'off' && (def['recommended'] === undefined ? (existing?.recommended ?? true) : def['recommended'] !== false),
    origin: existing && def['given'] === undefined && def['then'] === undefined ? existing.origin : origin
  }
}

const VVPOST_ROOTS = /^\$(\.|\[')(connectors|environments|flows|docs)\b/
const OAS_ROOTS = /^\$(\.|\[')(openapi|info|paths|components|servers|tags|security|webhooks)\b/

/** Regra sem formats: o documento sai da raiz do given ($.connectors é do VVPost, $.paths é OpenAPI). */
function formatsOfGiven(given: string[]): LintFormat[] | undefined {
  if (given.every((g) => VVPOST_ROOTS.test(g))) return ['vvpost']
  if (given.every((g) => OAS_ROOTS.test(g))) return ['oas3']
  return undefined
}

function parseFormats(value: unknown, where: string, issues: string[]): LintFormat[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    issues.push(`${where} precisa ser uma lista`)
    return undefined
  }
  const out = new Set<LintFormat>()
  for (const f of value) {
    const format = typeof f === 'string' ? FORMAT_ALIASES[f] : undefined
    if (format) out.add(format)
    else issues.push(`${where}: formato "${String(f)}" não suportado (use vvpost ou oas3)`)
  }
  return [...out]
}

function expandAlias(given: string, aliases: Map<string, string[]>): string[] | null {
  if (!given.startsWith('#')) return [given]
  const m = /^#([A-Za-z0-9_-]+)(.*)$/s.exec(given)
  const base = m ? aliases.get(m[1]!) : undefined
  if (!m || !base) return null
  const out: string[] = []
  for (const b of base) {
    const expanded = expandAlias(b, aliases)
    if (!expanded) return null
    out.push(...expanded.map((e) => e + m[2]!))
  }
  return out
}

/** Glob dos overrides (`*`, `**`, `?`, `{a,b}`), relativo à pasta do workspace. Sem "/", vale o nome do arquivo em qualquer pasta. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, '')
  if (g.endsWith('/')) g += '**'
  const anywhere = !g.includes('/')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i++
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = g.indexOf('}', i)
      if (end < 0) re += '\\{'
      else {
        re += `(?:${g
          .slice(i + 1, end)
          .split(',')
          .map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
          .join('|')})`
        i = end
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(anywhere ? `(?:^|/)${re}$` : `^${re}(?:/.*)?$`)
}

/** A severidade da regra num arquivo: a do ruleset, trocada pelos overrides que casam com ele, na ordem. */
export function severityFor(ruleset: ResolvedRuleset, rule: string, file: string): RuleSeverity {
  let sev = ruleset.severity.get(rule) ?? 'off'
  for (const o of ruleset.overrides) {
    const s = o.severity.get(rule)
    if (s !== undefined && o.match(file)) sev = s
  }
  return sev
}
