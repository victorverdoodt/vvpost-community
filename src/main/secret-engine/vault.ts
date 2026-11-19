import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { SecretBackend, SecretRecord } from './backend'
import { UNSAFE_KEYS } from './source'

/**
 * HashiCorp Vault (HTTP API v1), com o motor KV que os clientes usam no dia a dia:
 * KV v2 em /v1/<mount>/data e /v1/<mount>/metadata, e KV v1 em /v1/<mount>/<caminho>.
 * Todo mount enxerga o mesmo ambiente ativo. Qualquer token é aceito.
 *
 * Cada variável é um caminho: DATABASE_URL vira secret/DATABASE_URL com os dados
 * { "value": "..." }. Um valor que é um objeto JSON vira os próprios dados
 * (útil para guardar vários campos num caminho só), e a escrita faz o inverso.
 */
export function registerHashicorpVault(app: FastifyInstance, source: SecretBackend): void {
  app.get('/v1/sys/health', async () => ({
    initialized: true,
    sealed: false,
    standby: false,
    performance_standby: false,
    server_time_utc: Math.floor(Date.now() / 1000),
    version: '1.17.0+vvpost',
    cluster_name: 'vvpost-mock',
    cluster_id: '00000000-0000-0000-0000-000000000000'
  }))

  app.get('/v1/sys/seal-status', async () => ({
    type: 'shamir',
    initialized: true,
    sealed: false,
    t: 1,
    n: 1,
    progress: 0,
    version: '1.17.0+vvpost',
    cluster_name: 'vvpost-mock'
  }))

  app.get('/v1/auth/token/lookup-self', async (req) =>
    envelope({
      id: String(req.headers['x-vault-token'] ?? ''),
      accessor: 'vvpost-mock',
      display_name: 'token',
      policies: ['root'],
      ttl: 0,
      renewable: false,
      orphan: true,
      type: 'service'
    })
  )

  // Consultado pelo CLI e por clientes que detectam a versão do KV antes de ler.
  app.get<{ Params: { '*': string } }>('/v1/sys/internal/ui/mounts/*', async (req) => {
    const mount = req.params['*'].split('/')[0] || 'secret'
    return envelope({ path: `${mount}/`, type: 'kv', options: { version: '2' }, description: 'VVPost mock' })
  })

  app.get('/v1/sys/mounts', async () => {
    const mounts = { 'secret/': { type: 'kv', options: { version: '2' }, description: 'VVPost mock' } }
    return { ...mounts, ...envelope(mounts) }
  })

  type Wild = { Params: { mount: string; '*': string }; Querystring: { list?: string } }

  // KV v2: dados
  app.get<Wild>('/v1/:mount/data/*', async (req, reply) => {
    const s = await source.get(pathOf(req))
    return s ? envelope({ data: toData(s.value), metadata: versionMeta(s) }) : notFound(reply)
  })
  const writeV2 = async (req: FastifyRequest<Wild>, reply: FastifyReply) => {
    const body = req.body as { data?: unknown } | undefined
    if (!isObject(body?.data)) return badRequest(reply, 'no data provided')
    const path = pathOf(req)
    if (!validPath(path)) return badRequest(reply, 'invalid path')
    const saved = await source.set(path, fromData(body.data))
    return envelope(versionMeta(saved))
  }
  app.post<Wild>('/v1/:mount/data/*', writeV2)
  app.put<Wild>('/v1/:mount/data/*', writeV2)
  app.patch<Wild>('/v1/:mount/data/*', async (req, reply) => {
    const body = req.body as { data?: unknown } | undefined
    if (!isObject(body?.data)) return badRequest(reply, 'no data provided')
    const s = await source.get(pathOf(req))
    if (!s) return notFound(reply)
    const saved = await source.set(s.name, fromData({ ...toData(s.value), ...body.data }))
    return envelope(versionMeta(saved))
  })
  app.delete<Wild>('/v1/:mount/data/*', async (req, reply) => {
    await source.delete(pathOf(req))
    return reply.code(204).send()
  })

  // KV v2: metadados e listagem (GET ?list=true; o método LIST é convertido em server.ts)
  app.get<Wild>('/v1/:mount/metadata/*', async (req, reply) => {
    if (isList(req)) return list(source, pathOf(req), reply)
    const s = await source.get(pathOf(req))
    if (!s) return notFound(reply)
    const meta = versionMeta(s)
    return envelope({
      created_time: meta.created_time,
      updated_time: meta.created_time,
      current_version: 1,
      oldest_version: 1,
      max_versions: 0,
      cas_required: false,
      delete_version_after: '0s',
      custom_metadata: null,
      versions: { '1': { created_time: meta.created_time, deletion_time: '', destroyed: false } }
    })
  })
  // Raiz do mount: com ignoreTrailingSlash, "metadata/" chega aqui sem a barra.
  app.get<Wild>('/v1/:mount/metadata', async (req, reply) =>
    isList(req) ? list(source, '', reply) : notFound(reply)
  )
  app.delete<Wild>('/v1/:mount/metadata/*', async (req, reply) => {
    await source.delete(pathOf(req))
    return reply.code(204).send()
  })

  // KV v1: /v1/<mount>/<caminho>
  type V1 = { Params: { mount: string; '*': string }; Querystring: { list?: string } }
  const reserved = (req: FastifyRequest<V1>) => req.params.mount === 'sys' || req.params.mount === 'auth'
  app.get<V1>('/v1/:mount/*', async (req, reply) => {
    if (reserved(req)) return notFound(reply)
    if (isList(req)) return list(source, req.params['*'], reply)
    const s = await source.get(trimPath(req.params['*']))
    return s ? envelope(toData(s.value)) : notFound(reply)
  })
  const writeV1 = async (req: FastifyRequest<V1>, reply: FastifyReply) => {
    const path = trimPath(req.params['*'])
    if (reserved(req) || !validPath(path)) return badRequest(reply, 'invalid path')
    if (!isObject(req.body)) return badRequest(reply, 'no data provided')
    await source.set(path, fromData(req.body))
    return reply.code(204).send()
  }
  app.post<V1>('/v1/:mount/*', writeV1)
  app.put<V1>('/v1/:mount/*', writeV1)
  app.delete<V1>('/v1/:mount/*', async (req, reply) => {
    if (reserved(req)) return notFound(reply)
    await source.delete(trimPath(req.params['*']))
    return reply.code(204).send()
  })
}

const trimPath = (p: string) => p.replace(/^\/+|\/+$/g, '')
const pathOf = (req: FastifyRequest<{ Params: { '*': string } }>) => trimPath(req.params['*'])
const isList = (req: FastifyRequest<{ Querystring: { list?: string } }>) =>
  req.query.list === 'true' || req.query.list === '1'
const validPath = (p: string) => p.length > 0 && !p.split('/').some((seg) => seg === '' || seg === '..' || UNSAFE_KEYS.has(seg))

/** Filhos imediatos do prefixo; pastas terminam em "/". */
async function list(source: SecretBackend, rawPrefix: string, reply: FastifyReply) {
  const trimmed = trimPath(rawPrefix)
  const prefix = trimmed ? `${trimmed}/` : ''
  const keys = new Set<string>()
  for (const s of await source.list()) {
    if (!s.name.startsWith(prefix)) continue
    const rest = s.name.slice(prefix.length)
    const slash = rest.indexOf('/')
    keys.add(slash === -1 ? rest : rest.slice(0, slash + 1))
  }
  keys.delete('')
  if (keys.size === 0) return notFound(reply)
  return envelope({ keys: [...keys].sort() })
}

function toData(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (isObject(parsed)) return parsed
  } catch {
    // Texto comum.
  }
  return { value }
}

function fromData(data: Record<string, unknown>): string {
  const keys = Object.keys(data)
  if (keys.length === 1 && keys[0] === 'value' && typeof data['value'] === 'string') return data['value']
  return JSON.stringify(data)
}

function versionMeta(s: SecretRecord) {
  return {
    created_time: new Date(s.updatedAt || Date.now()).toISOString(),
    custom_metadata: null,
    deletion_time: '',
    destroyed: false,
    version: 1
  }
}

function envelope(data: unknown) {
  return {
    request_id: randomUUID(),
    lease_id: '',
    renewable: false,
    lease_duration: 0,
    data,
    wrap_info: null,
    warnings: null,
    auth: null
  }
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ errors: [] })
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ errors: [message] })
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
