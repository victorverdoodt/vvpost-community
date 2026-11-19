import { LINT_FUNCTIONS } from './functions'
import { formatJsonPath, queryJsonPath, type JsonPathSegment } from './jsonpath'
import { SEVERITIES, severityFor, type LintFormat, type LintRule, type LintSeverity, type ResolvedRuleset } from './ruleset'

/** Para onde o app leva quem clica no achado. */
export type LintTarget =
  | { kind: 'connector'; connectorId: string }
  | { kind: 'endpoint'; connectorId: string; endpointId: string }
  | { kind: 'scenario'; connectorId: string; endpointId: string; scenarioId: string }
  | { kind: 'environment'; environmentId: string; variable?: string }
  | { kind: 'flow'; flowId: string; file: string }
  | { kind: 'doc'; file: string; line?: number }

export interface LintLocation {
  /** Arquivo relativo ao workspace, com "/". */
  file: string
  /** Caminho dentro do arquivo, para achar a linha (o mais fundo que existir). */
  pointer?: JsonPathSegment[]
  /** Onde, em palavras: "pedidos/listar", "ambiente dev, variável TOKEN". */
  label?: string
  /** Linha no arquivo (1 em diante), quando quem monta o documento já sabe (páginas e diagramas). */
  line?: number
  target?: LintTarget
}

export interface LintDocument {
  format: LintFormat
  data: unknown
  /** Arquivo de origem de um caminho do documento; null deixa o achado de fora (é de outro projeto). */
  locate(path: JsonPathSegment[]): LintLocation | null
}

export interface LintFinding extends LintLocation {
  code: string
  message: string
  severity: LintSeverity
  /** Caminho no documento do lint ($.connectors[0].endpoints[2].description). */
  path: string
  format: LintFormat
  hint?: string
  documentationUrl?: string
}

export interface LintSummary {
  error: number
  warn: number
  info: number
  hint: number
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Roda as regras ligadas do ruleset nos documentos e devolve os achados, por arquivo e severidade. */
export function runLint(documents: LintDocument[], ruleset: ResolvedRuleset): LintFinding[] {
  const findings: LintFinding[] = []
  const seen = new Set<string>()
  for (const rule of ruleset.rules.values()) {
    if (!mayRun(ruleset, rule.name)) continue
    for (const doc of documents) {
      if (!rule.formats.includes(doc.format)) continue
      for (const given of rule.given) {
        let nodes
        try {
          nodes = queryJsonPath(doc.data, given)
        } catch {
          continue
        }
        for (const node of nodes) {
          for (const then of rule.then) {
            for (const target of targetsOf(node.value, node.path, then.field)) {
              const fn = LINT_FUNCTIONS[then.function]!
              const results = fn.run(target.value, then.functionOptions ?? {}, { path: target.path, document: doc.data })
              for (const r of results) {
                const path = [...target.path, ...(r.path ?? [])]
                const location = doc.locate(path)
                if (!location) continue
                const severity = severityFor(ruleset, rule.name, location.file)
                if (severity === 'off') continue
                const message = render(rule, r.message, path, target.value)
                const key = `${rule.name}\0${doc.format}\0${path.join('\0')}\0${message}`
                if (seen.has(key)) continue
                seen.add(key)
                findings.push({
                  code: rule.name,
                  message,
                  severity,
                  ...location,
                  path: formatJsonPath(path),
                  format: doc.format,
                  ...((r.hint ?? rule.hint ?? rule.description) !== undefined && { hint: r.hint ?? rule.hint ?? rule.description }),
                  ...(rule.documentationUrl && { documentationUrl: rule.documentationUrl })
                })
              }
            }
          }
        }
      }
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.path.localeCompare(b.path) || a.code.localeCompare(b.code))
}

/** Liga em algum lugar: no ruleset ou em algum override. */
function mayRun(ruleset: ResolvedRuleset, name: string): boolean {
  if ((ruleset.severity.get(name) ?? 'off') !== 'off') return true
  return ruleset.overrides.some((o) => {
    const s = o.severity.get(name)
    return s !== undefined && s !== 'off'
  })
}

function targetsOf(value: unknown, path: JsonPathSegment[], field: string | undefined): { value: unknown; path: JsonPathSegment[] }[] {
  if (field === undefined) return [{ value, path }]
  if (field === '@key') {
    if (Array.isArray(value)) return value.map((_, i) => ({ value: i, path: [...path, i] }))
    if (isObject(value)) return Object.keys(value).map((k) => ({ value: k, path: [...path, k] }))
    return []
  }
  if (field.startsWith('$')) return queryJsonPath(value, field).map((m) => ({ value: m.value, path: [...path, ...m.path] }))
  // Campo simples ou com pontos: o alvo existe mesmo ausente (undefined), para o truthy acusar.
  let current = value
  const out = [...path]
  for (const key of field.split('.')) {
    const k: JsonPathSegment = Array.isArray(current) && /^\d+$/.test(key) ? Number(key) : key
    current = Array.isArray(current) ? current[k as number] : isObject(current) && Object.hasOwn(current, key) ? current[key] : undefined
    out.push(k)
  }
  return [{ value: current, path: out }]
}

function render(rule: LintRule, error: string, path: JsonPathSegment[], value: unknown): string {
  const template = rule.message ?? '{{error}}'
  const short = (v: unknown) => {
    const text = typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v)
    return text.length > 80 ? `${text.slice(0, 77)}...` : text
  }
  const text = template.replace(/\{\{(error|description|path|property|value)\}\}/g, (_, key: string) => {
    switch (key) {
      case 'error':
        return error
      case 'description':
        return rule.description ?? ''
      case 'path':
        return formatJsonPath(path)
      case 'property':
        return String(path.at(-1) ?? '')
      default:
        return short(value)
    }
  })
  return text
}

export function summarize(findings: readonly LintFinding[]): LintSummary {
  const out: LintSummary = { error: 0, warn: 0, info: 0, hint: 0 }
  for (const f of findings) out[f.severity]++
  return out
}

/** Algum achado na severidade `failOn` ou mais grave. */
export function failsAt(findings: readonly LintFinding[], failOn: LintSeverity): boolean {
  const limit = SEVERITIES.indexOf(failOn)
  return findings.some((f) => SEVERITIES.indexOf(f.severity) <= limit)
}
