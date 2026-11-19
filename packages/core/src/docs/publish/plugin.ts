import { randomUUID } from 'node:crypto'
import { DocsError } from '../build'
import { toPluginBundle } from '../export/plugin'
import type { PluginPublisherAuth } from '../../plugins/manager'
import { isHttpMethod, type PluginHttpRequest, type PluginHttpResult } from '../../plugins/protocol'
import { createRequestGuard } from '../../policy/request-policy'
import type { HttpRequestInput, HttpResult } from '../../types'
import type {
  DocsPublisher,
  PublishAction,
  PublishApproval,
  PublishBundle,
  PublishContext,
  PublisherSession,
  PublishPlan,
  PublishPlanItem,
  PublishResult,
  PublishResultItem,
  PublishTargetRef
} from './types'

/** O publicador de um plugin, como o PluginManager o entrega (plugins/manager.ts). */
export interface PluginPublisherInfo {
  pluginId: string
  pluginName: string
  id: string
  title: string
  hosts: string[]
  auth: PluginPublisherAuth
  invoke(
    op: 'session' | 'plan' | 'publish',
    input: { target: unknown; bundle?: unknown; plan?: unknown; approval?: unknown },
    onHttp: (request: PluginHttpRequest, signal: AbortSignal) => Promise<PluginHttpResult>,
    signal?: AbortSignal
  ): Promise<unknown>
}

/** Onde a credencial da pessoa fica (no app, o cofre local): por publicador, nunca no workspace. */
export interface PublisherCredentials {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface PluginPublisherDeps {
  /** O cliente HTTP do app (proxy e CA da pessoa), sem histórico. */
  send(input: HttpRequestInput): Promise<HttpResult>
  cancel?(id: string): void
  credentials: PublisherCredentials
}

/** Requisições por chamada do plugin: publicar um espaço grande são milhares, um laço sem fim não. */
const MAX_REQUESTS = 5_000
const REDACTED = '[REDACTED]'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const ACTIONS = new Set<PublishAction>(['create', 'update', 'same', 'conflict', 'orphan'])
const OUTCOMES = new Set<PublishResultItem['outcome']>(['created', 'updated', 'unchanged', 'skipped', 'archived', 'failed'])
/** Headers que o plugin não escolhe: a auth é do VVPost, e cookie não é o jeito de entrar. */
const RESERVED = new Set(['authorization', 'proxy-authorization', 'cookie'])

/** O host da URL bate com um dos declarados ("api.x.com", "*.x.com", com ou sem porta)? */
export function publisherHostAllowed(url: URL, hosts: readonly string[]): boolean {
  const host = url.hostname.toLowerCase()
  const port = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(host))) return false
  return hosts.some((pattern) => {
    const m = /^(.*?)(?::(\d{1,5}))?$/.exec(pattern.toLowerCase())!
    const [name, wanted] = [m[1]!, m[2]]
    if (wanted ? wanted !== port : url.port !== '') return false
    return name.startsWith('*.') ? host.endsWith(name.slice(1)) : host === name
  })
}

/**
 * O DocsPublisher de um plugin (contributes.publishers). O plugin monta o plano e publica; o
 * VVPost guarda a credencial da pessoa, só deixa ctx.http ir aos hosts declarados (HTTPS), põe a
 * auth em cada requisição e tira o token do que volta: o plugin nunca vê a credencial. A
 * confirmação também é do VVPost: o que voltar mudado sem ela vira falha e não é gravado.
 */
export function pluginPublisher(info: PluginPublisherInfo, deps: PluginPublisherDeps): DocsPublisher {
  const key = `${info.pluginId}/${info.id}`
  const credential = { label: info.auth.label, ...(info.auth.help && { help: info.auth.help }) }
  const signedOut = (message?: string): PublisherSession => ({
    status: 'signedOut',
    message: message ?? `Cole ${info.auth.label.toLowerCase()} para publicar com a sua conta em ${info.title}.`,
    credential
  })

  function authHeader(token: string): { name: string; value: string } {
    if (info.auth.type === 'bearer') return { name: 'Authorization', value: `Bearer ${token}` }
    if (info.auth.type === 'basic') return { name: 'Authorization', value: `Basic ${Buffer.from(token).toString('base64')}` }
    return { name: info.auth.header ?? 'X-API-Key', value: token }
  }

  /** O token e as formas em que ele pode voltar (eco do header) saem do que o plugin recebe. */
  function scrubber(token: string): (text: string) => string {
    const forms = [token, Buffer.from(token).toString('base64'), ...token.split(':').filter((p) => p.length >= 8)].filter((f) => f.length >= 4)
    return (text) => forms.reduce((out, f) => out.split(f).join(REDACTED), text)
  }

  async function call<T>(op: 'session' | 'plan' | 'publish', input: { target: PublishTargetRef; bundle?: unknown; plan?: unknown; approval?: unknown }, token: string, signal?: AbortSignal): Promise<T> {
    const auth = authHeader(token)
    const scrub = scrubber(token)
    const guard = createRequestGuard({ actor: `o publicador ${info.id}`, maxRequests: MAX_REQUESTS, maxConcurrent: 6, maxTimeoutMs: 120_000 })
    const onHttp = async (request: PluginHttpRequest, callSignal: AbortSignal): Promise<PluginHttpResult> => {
      if (!isHttpMethod(request.method)) return { ok: false, error: { code: 'INVALID_REQUEST', message: `método HTTP inválido: ${request.method}` } }
      let url: URL
      try {
        url = new URL(request.url)
      } catch {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: 'URL inválida' } }
      }
      if (!publisherHostAllowed(url, info.hosts)) {
        return { ok: false, error: { code: 'POLICY_DENIED', message: `o publicador ${info.id} só fala com ${info.hosts.join(', ')} (HTTPS)` } }
      }
      const slot = await guard.admit({ method: request.method, url: url.href, ...(request.timeoutMs && { timeoutMs: request.timeoutMs }) }, callSignal)
      if (!slot.ok) return { ok: false, error: { code: 'POLICY_DENIED', message: slot.message } }
      const id = randomUUID()
      const onAbort = () => deps.cancel?.(id)
      callSignal.addEventListener('abort', onAbort, { once: true })
      try {
        const reserved = new Set([...RESERVED, auth.name.toLowerCase()])
        const result = await deps.send({
          id,
          method: request.method,
          url: url.href,
          headers: [...request.headers.filter((h) => !reserved.has(h.name.toLowerCase())), auth],
          ...(request.body !== undefined && { body: request.body }),
          ...(slot.timeoutMs && { timeoutMs: slot.timeoutMs }),
          // Um redirecionamento levaria a auth para outro host: o plugin segue, se quiser, pelo Location.
          followRedirects: false
        })
        if (!result.ok) return { ok: false, error: { code: result.error.code, message: scrub(result.error.message) } }
        const r = result.response
        return {
          ok: true,
          response: {
            status: r.status,
            statusText: r.statusText,
            headers: headerRecord(r.headers, scrub),
            body: scrub(r.body),
            truncated: r.truncated,
            durationMs: r.timings.totalMs
          }
        }
      } finally {
        slot.release()
        callSignal.removeEventListener('abort', onAbort)
      }
    }
    return (await info.invoke(op, input, onHttp, signal)) as T
  }

  async function token(): Promise<string> {
    const t = await deps.credentials.get(key)
    if (!t) throw new DocsError(`Entre em ${info.title} primeiro: cole ${info.auth.label.toLowerCase()} no "Enviar para…".`)
    return t
  }

  async function session(target: PublishTargetRef, t: string): Promise<PublisherSession> {
    try {
      const value = await call<unknown>('session', { target }, t)
      const v = isObject(value) ? value : {}
      const account = text(v['account'])
      const destination = text(v['destination'])
      return { status: 'signedIn', ...(account && { account }), ...(destination && { destination }) }
    } catch (err) {
      return signedOut(`${info.title} recusou a credencial: ${(err as Error).message}`)
    }
  }

  return {
    id: info.id,
    title: info.title,
    async session(target) {
      const t = await deps.credentials.get(key)
      return t ? session(target, t) : signedOut()
    },
    async signIn(target, ctx: PublishContext) {
      const value = ctx.credential?.trim()
      if (!value) return signedOut()
      await deps.credentials.set(key, value)
      const result = await session(target, value)
      // Credencial que o destino recusou não fica guardada, e a recusa vai para quem entrou.
      if (result.status !== 'signedIn') {
        await deps.credentials.delete(key)
        throw new DocsError(result.message ?? `${info.title} recusou a credencial.`)
      }
      return result
    },
    async signOut() {
      await deps.credentials.delete(key)
    },
    async plan(bundle, ctx) {
      const value = await call<unknown>('plan', { target: bundle.target, bundle: toPluginBundle(bundle) }, await token(), ctx.signal)
      return checkPlan(value, bundle, info.id)
    },
    async publish(bundle, plan, approval, ctx) {
      const value = await call<unknown>('publish', { target: bundle.target, bundle: toPluginBundle(bundle), plan, approval }, await token(), ctx.signal)
      return checkResult(value, bundle, plan, approval, info.id)
    }
  }
}

/** Headers da resposta por nome em minúsculas, repetidos juntados (como nos nós de plugin), sem o token. */
function headerRecord(headers: readonly { name: string; value: string }[], scrub: (text: string) => string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { name, value } of headers) {
    const key = name.toLowerCase()
    out[key] = key in out ? `${out[key]}, ${scrub(value)}` : scrub(value)
  }
  return out
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max = 300): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined)
const httpsUrl = (v: unknown): string | undefined => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v.slice(0, 2000) : undefined)

/** O plano como o diálogo o mostra: campo a campo, só com as chaves do pacote ou já publicadas. */
function checkPlan(value: unknown, bundle: PublishBundle, id: string): PublishPlan {
  if (!isObject(value) || !Array.isArray(value['items'])) throw new DocsError(`o publicador ${id} não devolveu { items: [...] } no plano`)
  const known = new Set(Object.keys(bundle.published))
  const walk = (nodes: PublishBundle['nodes']) => nodes.forEach((n) => (known.add(n.key), walk(n.children)))
  walk(bundle.nodes)
  const seen = new Set<string>()
  const items: PublishPlanItem[] = []
  for (const raw of value['items'].slice(0, 10_000)) {
    if (!isObject(raw)) continue
    const key = text(raw['key'], 500)
    const action = raw['action'] as PublishAction
    if (!key || !known.has(key) || seen.has(key) || !ACTIONS.has(action)) continue
    seen.add(key)
    const remote = isObject(raw['remote']) && text(raw['remote']['id']) ? raw['remote'] : null
    items.push({
      key,
      kind: raw['kind'] === 'folder' ? 'folder' : 'page',
      title: text(raw['title']) ?? key,
      path: Array.isArray(raw['path']) ? raw['path'].filter((p): p is string => typeof p === 'string').map((p) => p.slice(0, 300)) : [],
      action,
      ...(remote && {
        remote: {
          id: text(remote['id'])!,
          ...(typeof remote['version'] === 'number' && { version: remote['version'] }),
          ...(httpsUrl(remote['url']) && { url: httpsUrl(remote['url']) }),
          ...(text(remote['editedBy']) && { editedBy: text(remote['editedBy']) }),
          ...(text(remote['editedAt']) && { editedAt: text(remote['editedAt']) })
        }
      }),
      ...((action === 'update' || action === 'conflict') && {
        ...(typeof raw['before'] === 'string' && { before: raw['before'].slice(0, 500_000) }),
        ...(typeof raw['after'] === 'string' && { after: raw['after'].slice(0, 500_000) })
      })
    })
  }
  const dest = isObject(value['destination']) ? value['destination'] : {}
  return {
    items,
    destination: { label: text(dest['label']) ?? bundle.target.destination, ...(httpsUrl(dest['url']) && { url: httpsUrl(dest['url']) }) },
    warnings: Array.isArray(value['warnings']) ? value['warnings'].filter((w): w is string => typeof w === 'string').map((w) => w.slice(0, 1000)).slice(0, 100) : []
  }
}

/**
 * O resultado, campo a campo e só com as chaves do plano. O que o plugin diz ter mudado sem a
 * confirmação da pessoa vira falha: não entra no vvpost.publish.json e aparece no resultado. O hash
 * gravado é o do pacote, não o que o plugin disser.
 */
function checkResult(value: unknown, bundle: PublishBundle, plan: PublishPlan, approval: PublishApproval, id: string): PublishResult {
  const hashes = new Map<string, string>()
  const walk = (nodes: PublishBundle['nodes']) => nodes.forEach((n) => (hashes.set(n.key, n.hash), walk(n.children)))
  walk(bundle.nodes)
  if (!isObject(value) || !Array.isArray(value['items'])) throw new DocsError(`o publicador ${id} não devolveu { items: [...] } no resultado`)
  const planned = new Map(plan.items.map((i) => [i.key, i]))
  const allowed = (item: PublishPlanItem, outcome: PublishResultItem['outcome']) => {
    if (outcome === 'updated') return item.action === 'update' ? approval.update.includes(item.key) : item.action === 'conflict' ? approval.conflicts.includes(item.key) : item.action === 'create'
    if (outcome === 'archived') return item.action === 'orphan' && approval.archive.includes(item.key)
    if (outcome === 'created') return item.action === 'create'
    return true
  }
  const seen = new Set<string>()
  const items: PublishResultItem[] = []
  for (const raw of value['items']) {
    if (!isObject(raw)) continue
    const key = text(raw['key'], 500)
    const item = key ? planned.get(key) : undefined
    const outcome = raw['outcome'] as PublishResultItem['outcome']
    if (!key || !item || seen.has(key) || !OUTCOMES.has(outcome)) continue
    seen.add(key)
    if (!allowed(item, outcome)) {
      items.push({ key, kind: item.kind, title: item.title, outcome: 'failed', error: `o publicador ${id} devolveu "${outcome}" sem a confirmação da pessoa; nada foi gravado no vvpost.publish.json` })
      continue
    }
    items.push({
      key,
      kind: item.kind,
      title: item.title,
      outcome,
      ...(text(raw['id']) && { id: text(raw['id']) }),
      ...(typeof raw['version'] === 'number' && { version: raw['version'] }),
      ...(httpsUrl(raw['url']) && { url: httpsUrl(raw['url']) }),
      ...(outcome !== 'archived' && outcome !== 'failed' && outcome !== 'skipped' && hashes.has(key) && { hash: hashes.get(key) }),
      ...(text(raw['error'], 1000) && { error: text(raw['error'], 1000) })
    })
  }
  const dest = isObject(value['destination']) ? value['destination'] : {}
  return { items, destination: { label: text(dest['label']) ?? plan.destination.label, ...(httpsUrl(dest['url']) && { url: httpsUrl(dest['url']) }) } }
}
