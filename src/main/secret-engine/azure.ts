import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { SecretBackend, SecretRecord } from './backend'
import { UNSAFE_KEYS } from './source'

/**
 * Azure Key Vault (data plane de segredos, api-version 7.x), o bastante para o
 * SecretClient de @azure/keyvault-secrets e equivalentes em outras linguagens:
 * get/set/list/versões/delete (com soft delete em memória), recover e purge.
 *
 * Nomes de segredo no Key Vault só aceitam letras, números e "-", e não
 * diferenciam maiúsculas; variáveis do VVPost costumam usar "_". A busca trata
 * "database-url" e "DATABASE_URL" como o mesmo segredo.
 *
 * Autenticação: o SDK manda a primeira requisição sem token (e sem corpo) e espera
 * um 401 com o desafio Bearer; qualquer token é aceito depois.
 */
export function registerAzureKeyVault(app: FastifyInstance, source: SecretBackend): void {
  /** Metadados que o arquivo de segredos não guarda: ficam em memória enquanto o engine roda. */
  const meta = new Map<string, { contentType?: string; tags?: Record<string, string>; enabled: boolean }>()
  /** Segredos apagados (soft delete), recuperáveis até o purge ou o fim do engine. */
  const deleted = new Map<string, { record: SecretRecord; deletedAt: number }>()

  const find = async (name: string) => {
    const key = normalize(name)
    return (await source.list()).find((s) => normalize(s.name) === key)
  }

  app.register(
    async (scope) => {
      scope.addHook('onRequest', async (req, reply) => {
        if (req.headers.authorization) return
        reply
          .code(401)
          .header('www-authenticate', challenge(req))
          .send({ error: { code: 'Unauthorized', message: 'AKV10000: Request is missing a Bearer or PoP token.' } })
        return reply
      })

      scope.get<{ Params: { name: string; version?: string } }>('/secrets/:name/:version', async (req, reply) => {
        const found = await find(req.params.name)
        if (!found || (req.params.version && req.params.version !== found.version)) {
          return notFound(reply, req.params.name, req.params.version)
        }
        return bundle(req, found, meta.get(found.name))
      })

      scope.get<{ Params: { name: string } }>('/secrets/:name', async (req, reply) => {
        const found = await find(req.params.name)
        return found ? bundle(req, found, meta.get(found.name)) : notFound(reply, req.params.name)
      })

      scope.put<{ Params: { name: string }; Body: SetSecretBody }>('/secrets/:name', async (req, reply) => {
        const body = req.body
        if (!isObject(body) || typeof body.value !== 'string') {
          return badParameter(reply, 'The request body must contain a string "value".')
        }
        if (!/^[0-9a-zA-Z_-]{1,127}$/.test(req.params.name) || UNSAFE_KEYS.has(req.params.name)) {
          return badParameter(reply, 'Secret names may only contain letters, digits, "-" and "_".')
        }
        const name = (await find(req.params.name))?.name ?? req.params.name
        const saved = await source.set(name, body.value)
        meta.set(name, { contentType: body.contentType, tags: body.tags, enabled: body.attributes?.enabled ?? true })
        deleted.delete(normalize(name))
        return bundle(req, saved, meta.get(name))
      })

      scope.patch<{ Params: { name: string; version?: string }; Body: SetSecretBody }>(
        '/secrets/:name/:version',
        async (req, reply) => {
          const found = await find(req.params.name)
          if (!found) return notFound(reply, req.params.name)
          const body = isObject(req.body) ? req.body : {}
          const current = meta.get(found.name) ?? { enabled: true }
          meta.set(found.name, {
            contentType: body.contentType ?? current.contentType,
            tags: body.tags ?? current.tags,
            enabled: body.attributes?.enabled ?? current.enabled
          })
          return { ...bundle(req, found, meta.get(found.name)), value: undefined }
        }
      )

      scope.get('/secrets', async (req) => ({
        value: (await source.list()).map((s) => item(req, s, meta.get(s.name))),
        nextLink: null
      }))

      scope.get<{ Params: { name: string } }>('/secrets/:name/versions', async (req, reply) => {
        const found = await find(req.params.name)
        if (!found) return notFound(reply, req.params.name)
        return { value: [{ ...item(req, found, meta.get(found.name)), id: secretId(req, found, true) }], nextLink: null }
      })

      scope.delete<{ Params: { name: string } }>('/secrets/:name', async (req, reply) => {
        const found = await find(req.params.name)
        if (!found) return notFound(reply, req.params.name)
        await source.delete(found.name)
        const entry = { record: found, deletedAt: Date.now() }
        deleted.set(normalize(found.name), entry)
        return deletedBundle(req, entry, meta.get(found.name))
      })

      scope.get<{ Params: { name: string } }>('/deletedsecrets/:name', async (req, reply) => {
        const entry = deleted.get(normalize(req.params.name))
        if (!entry) return deletedNotFound(reply, req.params.name)
        return deletedBundle(req, entry, meta.get(entry.record.name))
      })

      scope.get('/deletedsecrets', async (req) => ({
        value: [...deleted.values()].map((entry) => ({
          ...deletedBundle(req, entry, meta.get(entry.record.name)),
          value: undefined
        })),
        nextLink: null
      }))

      scope.delete<{ Params: { name: string } }>('/deletedsecrets/:name', async (req, reply) => {
        const key = normalize(req.params.name)
        const entry = deleted.get(key)
        if (!entry) return deletedNotFound(reply, req.params.name)
        deleted.delete(key)
        meta.delete(entry.record.name)
        return reply.code(204).send()
      })

      scope.post<{ Params: { name: string } }>('/deletedsecrets/:name/recover', async (req, reply) => {
        const key = normalize(req.params.name)
        const entry = deleted.get(key)
        if (!entry) return deletedNotFound(reply, req.params.name)
        const restored = await source.set(entry.record.name, entry.record.value)
        deleted.delete(key)
        return bundle(req, restored, meta.get(restored.name))
      })
    },
    { prefix: '' }
  )
}

interface SetSecretBody {
  value?: unknown
  contentType?: string
  tags?: Record<string, string>
  attributes?: { enabled?: boolean }
}

type Meta = { contentType?: string; tags?: Record<string, string>; enabled: boolean } | undefined

/**
 * Desafio Bearer do Key Vault. O SDK confere se o recurso do desafio é um domínio
 * pai do host do cofre; para http://meu-cofre.localhost:4460 o recurso vira
 * https://localhost e a verificação passa. Em http://localhost:4460 não há domínio
 * pai, e o cliente precisa de disableChallengeResourceVerification: true.
 */
function challenge(req: FastifyRequest): string {
  const host = req.hostname.replace(/:\d+$/, '')
  const dot = host.indexOf('.')
  const resource = dot > 0 && !/^[\d.]+$/.test(host) ? `https://${host.slice(dot + 1)}` : 'https://vault.azure.net'
  return `Bearer authorization="https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000", resource="${resource}"`
}

const normalize = (name: string) => name.toLowerCase().replaceAll('_', '-')

const seconds = (ms: number) => Math.floor(ms / 1000)

function base(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}`
}

function secretId(req: FastifyRequest, s: SecretRecord, withVersion: boolean): string {
  return `${base(req)}/secrets/${s.name}${withVersion ? `/${s.version}` : ''}`
}

function attributes(s: SecretRecord, m: Meta) {
  const at = seconds(s.updatedAt)
  return { enabled: m?.enabled ?? true, created: at, updated: at, recoveryLevel: 'Recoverable+Purgeable', recoverableDays: 90 }
}

function bundle(req: FastifyRequest, s: SecretRecord, m: Meta) {
  return {
    value: s.value,
    id: secretId(req, s, true),
    contentType: m?.contentType,
    attributes: attributes(s, m),
    tags: m?.tags ?? {}
  }
}

function item(req: FastifyRequest, s: SecretRecord, m: Meta) {
  return { id: secretId(req, s, false), contentType: m?.contentType, attributes: attributes(s, m), tags: m?.tags ?? {} }
}

function deletedBundle(req: FastifyRequest, entry: { record: SecretRecord; deletedAt: number }, m: Meta) {
  return {
    ...bundle(req, entry.record, m),
    recoveryId: `${base(req)}/deletedsecrets/${entry.record.name}`,
    deletedDate: seconds(entry.deletedAt),
    scheduledPurgeDate: seconds(entry.deletedAt) + 90 * 24 * 3600
  }
}

function notFound(reply: FastifyReply, name: string, version?: string) {
  const what = version ? `A secret with (name/id) ${name}/${version}` : `A secret with (name/id) ${name}`
  return reply.code(404).send({ error: { code: 'SecretNotFound', message: `${what} was not found in this key vault.` } })
}

function deletedNotFound(reply: FastifyReply, name: string) {
  return reply
    .code(404)
    .send({ error: { code: 'SecretNotFound', message: `Deleted Secret not found: ${name}` } })
}

function badParameter(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: { code: 'BadParameter', message } })
}

function isObject(v: unknown): v is SetSecretBody {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
