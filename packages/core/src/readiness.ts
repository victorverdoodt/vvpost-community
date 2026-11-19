import { connect } from 'node:net'
import { resolveUrl } from './connectors/auth'
import { resolveConnector, type ResolvedConnector } from './connectors/resolve'
import { environmentValues, type LoadedWorkspace } from './connectors/workspace'
import { proxyFor, type ProxyConfig } from './http/proxy'

/**
 * Prontidão (docs/readiness.md): o que impede o workspace de rodar alguma coisa, de uma vez só.
 *
 * O estado mais enganoso é o catálogo que lê normal e não roda: o conector resolve, os endpoints
 * aparecem, e todo cenário falha minutos depois por um segredo sem valor ou uma API fora do ar.
 * Aqui isso aparece antes, por ambiente, com todos os bloqueios juntos e o próximo passo de cada um.
 * Nada é enviado para as APIs: a sondagem só abre a conexão TCP e fecha.
 */

export type ReadinessSeverity = 'blocker' | 'warning' | 'agent'

export interface ReadinessFinding {
  /** Estável: missing-secret, undefined-variable, invalid-url, unreachable, connector-error... */
  code: string
  /** blocker: nada roda; warning: roda, mas algo vai faltar; agent: só a IA fica limitada. */
  severity: ReadinessSeverity
  message: string
  hint?: string
  connector?: string
  variable?: string
  origin?: string
}

export interface ReadinessProbe {
  origin: string
  /** null: não verificada (passa por proxy). */
  ok: boolean | null
  ms?: number
  error?: string
}

export interface EnvironmentReadiness {
  /** '' é "sem ambiente", quando o workspace não tem nenhum. */
  id: string
  name?: string
  /** Sem bloqueio: os cenários e fluxos deste ambiente conseguem rodar. */
  canExecute: boolean
  findings: ReadinessFinding[]
  probes?: ReadinessProbe[]
}

export interface ReadinessReport {
  ready: boolean
  connectors: number
  environments: EnvironmentReadiness[]
  /** Achados que não são de um ambiente: arquivo ignorado, conector com herança quebrada. */
  workspace: ReadinessFinding[]
  /** O que esta verificação não confere, para ninguém ler "pronto" como mais do que é. */
  unverified: string[]
}

export interface ReadinessOptions {
  /** Só estes ambientes; padrão: todos (ou "sem ambiente", se o workspace não tem nenhum). */
  environmentIds?: readonly string[]
  /** Abre a conexão TCP com cada origem (baseUrl e URL do token ou do login). Padrão: true. */
  probe?: boolean
  probeTimeoutMs?: number
  /** Proxy do cliente HTTP: origem que passa por ele fica como não verificada. */
  proxy?: ProxyConfig
  /** Troca a sondagem (testes). */
  connectTo?: (host: string, port: number, timeoutMs: number) => Promise<void>
}

const REF = /\{\{\s*([^{}]+?)\s*\}\}/g
const DEFAULT_TIMEOUT_MS = 3000

/** Nomes de variáveis de um valor (strings, listas e objetos); dinâmicas ($uuid, $token) ficam de fora, $totp:VAR vale VAR. */
export function referencedVariables(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(REF)) {
      const name = m[1]!.trim()
      if (name.startsWith('$totp:')) into.add(name.slice('$totp:'.length).trim())
      else if (!name.startsWith('$')) into.add(name)
    }
  } else if (Array.isArray(value)) {
    for (const v of value) referencedVariables(v, into)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) referencedVariables(v, into)
  }
  return into
}

function fill(text: string, values: ReadonlyMap<string, string>): string | undefined {
  let missing = false
  const out = text.replace(REF, (whole, raw: string) => {
    const name = raw.trim()
    if (name.startsWith('$')) return whole
    const value = values.get(name)
    if (value === undefined) missing = true
    return value ?? whole
  })
  return missing ? undefined : out
}

function origins(connector: ResolvedConnector, values: ReadonlyMap<string, string>): { field: string; url?: string; error?: string }[] {
  const out: { field: string; url?: string; error?: string }[] = []
  const base = connector.baseUrl === undefined ? undefined : fill(connector.baseUrl, values)
  if (connector.baseUrl !== undefined && base !== undefined) out.push({ field: 'baseUrl', url: base })
  const auth = connector.auth?.config
  const raw = auth?.type === 'oauth2' ? auth.tokenUrl : auth?.type === 'login' ? auth.request.url : undefined
  const field = auth?.type === 'oauth2' ? 'tokenUrl' : 'loginUrl'
  const filled = raw === undefined ? undefined : fill(raw, values)
  if (filled !== undefined) {
    try {
      out.push({ field, url: resolveUrl(filled, base, field) })
    } catch (err) {
      out.push({ field, error: (err as Error).message })
    }
  }
  return out
}

function defaultConnect(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    const done = (err?: Error) => {
      socket.destroy()
      if (err) reject(err)
      else resolve()
    }
    socket.setTimeout(timeoutMs, () => done(new Error(`sem resposta em ${timeoutMs} ms`)))
    socket.once('connect', () => done())
    socket.once('error', (err: NodeJS.ErrnoException) => done(new Error(err.code ?? err.message)))
  })
}

function describeConnectError(error: string): string {
  if (error === 'ECONNREFUSED') return 'conexão recusada: nada escutando nessa porta (a API está rodando?)'
  if (error === 'ENOTFOUND' || error === 'EAI_AGAIN') return 'o host não resolve no DNS'
  if (error === 'EHOSTUNREACH' || error === 'ENETUNREACH') return 'rede sem rota para o host'
  return error
}

export async function checkReadiness(ws: LoadedWorkspace, options: ReadinessOptions = {}): Promise<ReadinessReport> {
  const workspace: ReadinessFinding[] = ws.issues.map((i) => ({
    code: 'file-ignored',
    severity: 'warning' as const,
    message: `${i.file}: ${i.message}`,
    hint: 'o arquivo ficou de fora do catálogo; vvpost validate mostra o problema'
  }))
  const resolved: ResolvedConnector[] = []
  for (const id of [...ws.connectors.keys()].sort()) {
    try {
      resolved.push(resolveConnector(id, ws.connectors))
    } catch (err) {
      workspace.push({ code: 'connector-error', severity: 'blocker', connector: id, message: (err as Error).message, hint: 'corrija a herança (extends) do conector; nada dele roda até lá' })
    }
  }
  if (!ws.connectors.size) {
    workspace.push({ code: 'empty-catalog', severity: 'blocker', message: 'o projeto não tem conectores: não há o que rodar', hint: 'importe a spec (import_openapi) ou crie um conector' })
  }

  const envIds = options.environmentIds?.length ? [...options.environmentIds] : ws.environments.size ? [...ws.environments.keys()] : ['']
  const probe = options.probe !== false
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const connectTo = options.connectTo ?? defaultConnect
  const probeCache = new Map<string, Promise<ReadinessProbe>>()
  const probeOrigin = (url: URL): Promise<ReadinessProbe> => {
    const origin = url.origin
    let pending = probeCache.get(origin)
    if (!pending) {
      pending = (async () => {
        if (await proxyFor(url, options.proxy)) return { origin, ok: null, error: 'passa pelo proxy: a conexão direta não diz nada' }
        const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
        const started = Date.now()
        try {
          await connectTo(url.hostname.replace(/^\[|\]$/g, ''), port, timeoutMs)
          return { origin, ok: true, ms: Date.now() - started }
        } catch (err) {
          return { origin, ok: false, ms: Date.now() - started, error: (err as Error).message }
        }
      })()
      probeCache.set(origin, pending)
    }
    return pending
  }

  const environments: EnvironmentReadiness[] = []
  for (const envId of envIds) {
    const env = envId ? ws.environments.get(envId) : undefined
    if (envId && !env) {
      environments.push({
        id: envId,
        canExecute: false,
        findings: [{ code: 'unknown-environment', severity: 'blocker', message: `o ambiente "${envId}" não existe`, hint: `ambientes: ${[...ws.environments.keys()].join(', ') || '(nenhum)'}` }]
      })
      continue
    }
    const { values, missingSecrets } = environmentValues(ws, envId || undefined)
    const findings: ReadinessFinding[] = []
    const urls = new Map<string, { url: URL; connectors: string[] }>()
    const reportedSecret = new Set<string>()
    for (const connector of resolved) {
      // O que todo request do conector usa: baseUrl, headers e auth. Variável de endpoint ou cenário depende do teste.
      const refs = referencedVariables([connector.baseUrl ?? '', connector.basePath, connector.headers, connector.auth?.config ?? {}])
      for (const name of refs) {
        if (values.has(name)) continue
        if (missingSecrets.has(name)) {
          if (reportedSecret.has(name)) {
            findings.find((f) => f.code === 'missing-secret' && f.variable === name)!.message += `, ${connector.id}`
            continue
          }
          reportedSecret.add(name)
          findings.push({
            code: 'missing-secret',
            severity: 'blocker',
            variable: name,
            message: `o segredo {{${name}}} não tem valor${envId ? ` em "${envId}"` : ''}; usado por ${connector.id}`,
            hint: `vvpost secrets set ${envId || '<ambiente>'} ${name}, ou VVPOST_SECRET_${name} no CI (o valor nunca passa pela IA)`
          })
        } else {
          findings.push({
            code: 'undefined-variable',
            severity: 'blocker',
            connector: connector.id,
            variable: name,
            message: envId ? `${connector.id} usa {{${name}}}, que "${envId}" não define` : `${connector.id} usa {{${name}}}, e o workspace não tem ambiente`,
            hint: envId ? `acrescente ${name} ao ambiente (upsertEnvironment no edit_project)` : 'crie um ambiente com as variáveis do conector'
          })
        }
      }
      if (connector.baseUrl === undefined && connector.endpoints.some((e) => !/^https?:\/\//i.test(e.path))) {
        findings.push({ code: 'no-base-url', severity: 'blocker', connector: connector.id, message: `${connector.id} não tem baseUrl e os endpoints usam caminho relativo`, hint: 'defina config.baseUrl no conector (patchConnector)' })
      }
      for (const o of origins(connector, values)) {
        if (o.error) {
          findings.push({ code: 'invalid-url', severity: 'blocker', connector: connector.id, message: `${connector.id}: ${o.error}` })
          continue
        }
        let url: URL
        try {
          url = new URL(o.url!)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`protocolo ${url.protocol}`)
        } catch {
          findings.push({ code: 'invalid-url', severity: 'blocker', connector: connector.id, message: `${connector.id}: ${o.field} "${o.url}" não é uma URL http(s)`, hint: 'confira a variável do ambiente que monta a URL' })
          continue
        }
        const entry = urls.get(url.origin) ?? { url, connectors: [] }
        if (!entry.connectors.includes(connector.id)) entry.connectors.push(connector.id)
        urls.set(url.origin, entry)
      }
    }
    for (const name of missingSecrets) {
      if (reportedSecret.has(name)) continue
      findings.push({
        code: 'missing-secret',
        severity: 'warning',
        variable: name,
        message: `o segredo {{${name}}} não tem valor${envId ? ` em "${envId}"` : ''}; nenhum conector o usa na auth, nos headers ou na baseUrl, mas um cenário ou fluxo pode usar`,
        hint: `vvpost secrets set ${envId || '<ambiente>'} ${name}`
      })
    }
    let probes: ReadinessProbe[] | undefined
    if (probe && urls.size) {
      probes = await Promise.all([...urls.values()].map(({ url }) => probeOrigin(url)))
      for (const p of probes) {
        if (p.ok !== false) continue
        const used = urls.get(p.origin)!.connectors.join(', ')
        findings.push({
          code: 'unreachable',
          severity: 'blocker',
          origin: p.origin,
          message: `${p.origin} não responde: ${describeConnectError(p.error ?? '')} (usado por ${used})`,
          hint: /localhost|127\.0\.0\.1|\[::1\]/.test(p.origin) ? 'suba a API local antes de rodar os cenários' : 'confira a URL no ambiente, a VPN e o firewall'
        })
      }
    }
    environments.push({
      id: envId,
      ...(env?.name && { name: env.name }),
      canExecute: !findings.some((f) => f.severity === 'blocker'),
      findings,
      ...(probes && { probes })
    })
  }

  const unverified = [
    'a auth (credencial aceita, token emitido) só é conferida rodando um cenário',
    ...(probe ? ['a sondagem só abre a conexão TCP: TLS, rota e status ficam para o cenário'] : ['a conexão com as APIs (probe: false)'])
  ]
  if (environments.some((e) => e.probes?.some((p) => p.ok === null))) unverified.push('as origens que passam pelo proxy')
  const ready = !workspace.some((f) => f.severity === 'blocker') && environments.every((e) => e.canExecute)
  return { ready, connectors: ws.connectors.size, environments, workspace, unverified }
}
