import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { SecretBackend, SecretRecord } from './backend'
import { UNSAFE_KEYS } from './source'

const ACCOUNT = '000000000000'
const DEFAULT_REGION = 'us-east-1'

/**
 * AWS Secrets Manager (protocolo awsJson1.1: POST / com X-Amz-Target), o bastante
 * para o @aws-sdk/client-secrets-manager e os SDKs das outras linguagens apontados
 * para o engine (endpoint, ou AWS_ENDPOINT_URL_SECRETS_MANAGER). A assinatura
 * SigV4 não é conferida: qualquer credencial serve. Só SecretString: o arquivo de
 * segredos guarda texto.
 */
export function registerAwsSecretsManager(app: FastifyInstance, source: SecretBackend): void {
  app.addContentTypeParser('application/x-amz-json-1.1', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body === '' ? {} : JSON.parse(body as string))
    } catch {
      done(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }))
    }
  })

  const operations: Record<string, Operation> = {
    async GetSecretValue(input, region) {
      const s = await lookup(source, input.SecretId)
      if (input.VersionId && input.VersionId !== versionId(s)) throw notFound()
      if (input.VersionStage && input.VersionStage !== 'AWSCURRENT') throw notFound()
      return valueEntry(s, region)
    },

    async BatchGetSecretValue(input, region) {
      const ids = Array.isArray(input.SecretIdList) ? input.SecretIdList.map(String) : []
      const SecretValues: unknown[] = []
      const Errors: unknown[] = []
      if (ids.length === 0) {
        for (const s of await source.list()) SecretValues.push(valueEntry(s, region))
      }
      for (const id of ids) {
        try {
          SecretValues.push(valueEntry(await lookup(source, id), region))
        } catch (err) {
          const e = err as AwsError
          Errors.push({ SecretId: id, ErrorCode: e.type, Message: e.message })
        }
      }
      return { SecretValues, Errors }
    },

    async DescribeSecret(input, region) {
      const s = await lookup(source, input.SecretId)
      return {
        ...summary(s, region),
        VersionIdsToStages: { [versionId(s)]: ['AWSCURRENT'] }
      }
    },

    async ListSecrets(input, region) {
      const filters = Array.isArray(input.Filters) ? (input.Filters as Filter[]) : []
      const names = filters.filter((f) => f?.Key === 'name').flatMap((f) => f.Values ?? [])
      const all = (await source.list()).filter((s) => names.length === 0 || names.some((n) => s.name.startsWith(n)))
      const max = Math.min(Math.max(Number(input.MaxResults) || 100, 1), 100)
      const start = Number(input.NextToken) || 0
      const page = all.slice(start, start + max)
      return {
        SecretList: page.map((s) => summary(s, region)),
        NextToken: start + max < all.length ? String(start + max) : undefined
      }
    },

    async CreateSecret(input, region) {
      const name = String(input.Name ?? '')
      if (!/^[\w/+=.@-]{1,512}$/.test(name) || UNSAFE_KEYS.has(name)) {
        throw new AwsError('InvalidParameterException', 'Invalid name. Must be a valid name containing alphanumeric characters, or any of the following: -/_+=.@!')
      }
      if (await source.get(name)) {
        throw new AwsError('ResourceExistsException', `The operation failed because the secret ${name} already exists.`)
      }
      const saved = await source.set(name, secretString(input))
      return { ARN: arn(saved.name, region), Name: saved.name, VersionId: versionId(saved) }
    },

    async PutSecretValue(input, region) {
      const s = await lookup(source, input.SecretId)
      const saved = await source.set(s.name, secretString(input))
      return { ARN: arn(saved.name, region), Name: saved.name, VersionId: versionId(saved), VersionStages: ['AWSCURRENT'] }
    },

    async UpdateSecret(input, region) {
      const s = await lookup(source, input.SecretId)
      if (input.SecretString === undefined) return { ARN: arn(s.name, region), Name: s.name }
      const saved = await source.set(s.name, secretString(input))
      return { ARN: arn(saved.name, region), Name: saved.name, VersionId: versionId(saved) }
    },

    async DeleteSecret(input, region) {
      const s = await lookup(source, input.SecretId)
      await source.delete(s.name)
      return { ARN: arn(s.name, region), Name: s.name, DeletionDate: Date.now() / 1000 }
    }
  }

  app.post('/', async (req, reply) => {
    const target = String(req.headers['x-amz-target'] ?? '')
    const operation = target.startsWith('secretsmanager.') ? operations[target.slice('secretsmanager.'.length)] : undefined
    reply.type('application/x-amz-json-1.1')
    if (!operation) {
      return sendError(reply, new AwsError('UnknownOperationException', `Operation ${target || '(none)'} is not supported by the VVPost emulator.`))
    }
    try {
      const input = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Input
      return await operation(input, region(req))
    } catch (err) {
      if (err instanceof AwsError) return sendError(reply, err)
      throw err
    }
  })
}

type Input = Record<string, unknown> & { SecretId?: unknown; VersionId?: unknown; VersionStage?: unknown }
type Operation = (input: Input, region: string) => Promise<unknown>
type Filter = { Key?: string; Values?: string[] }

class AwsError extends Error {
  constructor(
    readonly type: string,
    message: string
  ) {
    super(message)
  }
}

const notFound = () => new AwsError('ResourceNotFoundException', "Secrets Manager can't find the specified secret.")

function sendError(reply: FastifyReply, err: AwsError) {
  return reply.code(400).header('x-amzn-errortype', err.type).send({ __type: err.type, message: err.message })
}

/** Região do escopo da credencial SigV4 (Credential=AKID/data/região/serviço/aws4_request). */
function region(req: FastifyRequest): string {
  const match = /Credential=[^/]+\/\d{8}\/([a-z0-9-]+)\//.exec(String(req.headers.authorization ?? ''))
  return match?.[1] ?? DEFAULT_REGION
}

/** Sufixo de 6 caracteres que a AWS acrescenta ao nome no ARN. */
function suffix(name: string): string {
  return createHash('sha256').update(name).digest('base64url').replace(/[-_]/g, 'x').slice(0, 6)
}

const arn = (name: string, region: string) => `arn:aws:secretsmanager:${region}:${ACCOUNT}:secret:${name}-${suffix(name)}`

/** O id aceita nome ou ARN (com ou sem o sufixo). */
async function lookup(source: SecretBackend, id: unknown): Promise<SecretRecord> {
  let name = String(id ?? '')
  const marker = ':secret:'
  if (name.startsWith('arn:') && name.includes(marker)) {
    name = name.slice(name.indexOf(marker) + marker.length)
    if (!(await source.get(name))) {
      const dash = name.lastIndexOf('-')
      if (dash > 0 && name.slice(dash + 1) === suffix(name.slice(0, dash))) name = name.slice(0, dash)
    }
  }
  const found = await source.get(name)
  if (!found) throw notFound()
  return found
}

/** VersionId no formato UUID, derivado do hash do valor. */
function versionId(s: SecretRecord): string {
  const h = s.version
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

function secretString(input: Input): string {
  if (input['SecretBinary'] !== undefined) {
    throw new AwsError('InvalidParameterException', 'SecretBinary is not supported by the VVPost emulator; use SecretString.')
  }
  if (typeof input['SecretString'] !== 'string') {
    throw new AwsError('InvalidParameterException', 'You must provide SecretString.')
  }
  return input['SecretString']
}

function valueEntry(s: SecretRecord, region: string) {
  return {
    ARN: arn(s.name, region),
    Name: s.name,
    VersionId: versionId(s),
    SecretString: s.value,
    VersionStages: ['AWSCURRENT'],
    CreatedDate: s.updatedAt / 1000
  }
}

function summary(s: SecretRecord, region: string) {
  return {
    ARN: arn(s.name, region),
    Name: s.name,
    CreatedDate: s.updatedAt / 1000,
    LastChangedDate: s.updatedAt / 1000
  }
}
