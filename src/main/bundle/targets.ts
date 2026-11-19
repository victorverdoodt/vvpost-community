import { REQUIRED_SECRET, type Bundle, type Connector, type ConnectorAuth, type Environment, type HttpHeaders } from '@vvpost/schemas'
import { resolveConnector, type ResolvedConnector } from '@vvpost/core/connectors/resolve'

/**
 * O que os exportadores para formatos de fora (Postman e OpenAPI) leem do pacote do VVPost:
 * o pacote já saiu de exportBundle, então não tem valor de segredo; eles só traduzem.
 */
export interface BundleView {
  connectors: Connector[]
  byId: Map<string, Connector>
  environments: Environment[]
  docs: Record<string, string>
  /** Herança aplicada, por id; ausente quando a cadeia tem erro (avisado). */
  resolved: Map<string, ResolvedConnector>
  /** Filhos diretos de cada conector, na ordem do pacote. */
  children: Map<string, Connector[]>
  roots: Connector[]
  warnings: string[]
}

export function viewBundle(bundle: Bundle): BundleView {
  const connectors = (bundle.connectors ?? []) as Connector[]
  const byId = new Map(connectors.map((c) => [c.id, c]))
  const warnings: string[] = []
  const resolved = new Map<string, ResolvedConnector>()
  for (const c of connectors) {
    try {
      resolved.set(c.id, resolveConnector(c.id, byId))
    } catch (err) {
      warnings.push(`${c.id}: ${(err as Error).message} (fora da exportação)`)
    }
  }
  const children = new Map<string, Connector[]>()
  const roots: Connector[] = []
  for (const c of connectors) {
    if (!resolved.has(c.id)) continue
    if (c.extends && byId.has(c.extends)) children.set(c.extends, [...(children.get(c.extends) ?? []), c])
    else roots.push(c)
  }
  return {
    connectors,
    byId,
    environments: (bundle.environments ?? []) as Environment[],
    docs: bundle.docs ?? {},
    resolved,
    children,
    roots,
    warnings
  }
}

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g

/** Nomes das variáveis {{VAR}} de um valor qualquer (sem as dinâmicas, que começam com $). */
export function templateVars(value: unknown): string[] {
  const names = new Set<string>()
  for (const m of JSON.stringify(value ?? null).matchAll(TEMPLATE)) if (!m[1]!.startsWith('$')) names.add(m[1]!)
  return [...names]
}

/** Valor de uma variável que pode ir para fora: de um ambiente, e só se não for segredo. */
export function publicValue(env: Environment | undefined, name: string): string | undefined {
  const v = env?.variables[name]
  if (!v || v.isSecret || v.value === REQUIRED_SECRET) return undefined
  return String(v.value)
}

/** Troca as {{VAR}} que têm valor público no ambiente; o resto fica como está. */
export function fillPublic(text: string, env: Environment | undefined): string {
  return text.replace(TEMPLATE, (all, name: string) => publicValue(env, name) ?? all)
}

/** Campos da auth com {{VAR}}, como "token {{BILLING_TOKEN}}": o que quem importa precisa definir. */
export function authVariables(auth: ConnectorAuth): string[] {
  const out: string[] = []
  const walk = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      if (/\{\{[^{}]+\}\}/.test(value)) out.push(`${path} ${value}`)
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k)
    }
  }
  const { type: _, ...rest } = auth
  walk(rest, '')
  return out
}

/** Header pelo nome, sem diferenciar maiúsculas. */
export function headerValue(headers: HttpHeaders | undefined, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === lower) return v
  return undefined
}

/** Headers do conector (herdados) com os do endpoint por cima, sem diferenciar maiúsculas. */
export function mergeHeaders(base: HttpHeaders, over: HttpHeaders | undefined): HttpHeaders {
  const out: HttpHeaders = { ...base }
  for (const [name, value] of Object.entries(over ?? {})) {
    for (const k of Object.keys(out)) if (k.toLowerCase() === name.toLowerCase()) delete out[k]
    out[name] = value
  }
  return out
}

/** Nome em maiúsculas para variáveis criadas na exportação, ex.: connector.billing → BILLING. */
export function varPrefix(id: string): string {
  const base = id.replace(/^connector\./, '')
  return (
    base
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase() || 'API'
  )
}
