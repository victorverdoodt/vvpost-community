import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  BatchGetSecretValueCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  SecretsManagerClient
} from '@aws-sdk/client-secrets-manager'
import { SecretClient } from '@azure/keyvault-secrets'
import nodeVault from 'node-vault'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startSecretEngine, type RunningEngine } from '../src/main/secret-engine/server'
import { resolveEngineConfig } from '../src/main/secret-engine/source'
import { readVault } from '@vvpost/core/vault'

const SECRETS = '.vvpost/secrets.local.json'

let dir: string
let engine: RunningEngine
let base: string

const seed = {
  'env.dev': {
    DATABASE_URL: 'postgres://dev:pw@localhost/app',
    'payments/STRIPE_KEY': 'sk_test_123',
    'payments/config': JSON.stringify({ user: 'svc', password: 'hunter2' })
  },
  'env.prod': { DATABASE_URL: 'postgres://prod' }
}

const readStore = () => readVault(dir)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vvpost-engine-'))
  mkdirSync(join(dir, 'environments'))
  writeFileSync(
    join(dir, 'environments/dev.env.json'),
    JSON.stringify({ id: 'env.dev', name: 'Dev', variables: {} })
  )
  engine = await startSecretEngine(dir, { port: 0 })
  base = `http://localhost:${engine.port}`
})

beforeEach(() => {
  mkdirSync(join(dir, '.vvpost'), { recursive: true })
  writeFileSync(join(dir, SECRETS), JSON.stringify(seed))
})

afterAll(async () => {
  await engine.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('configuração', () => {
  it('sem secrets-engine.json usa a porta 4460 e o primeiro ambiente versionado', async () => {
    expect(engine.environment).toBe('env.dev')
    expect(await resolveEngineConfig(dir)).toMatchObject({ port: 4460, environment: 'env.dev' })
  })

  it('respeita activeEnvironment e porta do secrets-engine.json, e recusa arquivo inválido', async () => {
    const other = mkdtempSync(join(tmpdir(), 'vvpost-engine-cfg-'))
    try {
      mkdirSync(join(other, '.vvpost'))
      const file = join(other, '.vvpost/secrets-engine.json')
      writeFileSync(file, JSON.stringify({ port: 5000, mode: 'localMock', localMock: { activeEnvironment: 'env.prod' } }))
      expect(await resolveEngineConfig(other)).toMatchObject({ port: 5000, environment: 'env.prod' })
      writeFileSync(file, JSON.stringify({ mode: 'localMock' }))
      await expect(resolveEngineConfig(other)).rejects.toThrow(/localMock/)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('Azure Key Vault com @azure/keyvault-secrets', () => {
  const credential = {
    getToken: async () => ({ token: 'qualquer', expiresOnTimestamp: Date.now() + 3600_000 })
  }
  // As duas opções que o SDK exige para um cofre em http://localhost (ver docs/secret-engine.md).
  const client = () =>
    new SecretClient(base, credential, { allowInsecureConnection: true, disableChallengeResourceVerification: true })

  it('lê um segredo (nome com "-" acha a variável com "_")', async () => {
    const secret = await client().getSecret('database-url')
    expect(secret.value).toBe(seed['env.dev'].DATABASE_URL)
    expect(secret.properties.version).toMatch(/^[0-9a-f]{32}$/)
    expect((await client().getSecret('DATABASE_URL')).value).toBe(seed['env.dev'].DATABASE_URL)
  })

  it('erro 404 do SDK para segredo inexistente', async () => {
    await expect(client().getSecret('nao-existe')).rejects.toMatchObject({ statusCode: 404, code: 'SecretNotFound' })
  })

  it('grava, lista, apaga e recupera', async () => {
    const c = client()
    const saved = await c.setSecret('API-TOKEN', 'abc', { contentType: 'text/plain', tags: { team: 'core' } })
    expect(saved.value).toBe('abc')
    expect((await readStore())['env.dev']!['API-TOKEN']).toBe('abc')

    const names: string[] = []
    for await (const p of c.listPropertiesOfSecrets()) names.push(p.name)
    expect(names).toContain('API-TOKEN')
    expect(names).toContain('DATABASE_URL')

    const versions: string[] = []
    for await (const v of c.listPropertiesOfSecretVersions('API-TOKEN')) versions.push(v.version!)
    expect(versions).toEqual([saved.properties.version])

    const poller = await c.beginDeleteSecret('API-TOKEN')
    const deleted = await poller.pollUntilDone()
    expect(deleted.name).toBe('API-TOKEN')
    expect((await readStore())['env.dev']!['API-TOKEN']).toBeUndefined()

    await (await c.beginRecoverDeletedSecret('API-TOKEN')).pollUntilDone()
    expect((await c.getSecret('API-TOKEN')).value).toBe('abc')

    await (await c.beginDeleteSecret('API-TOKEN')).pollUntilDone()
    await c.purgeDeletedSecret('API-TOKEN')
    await expect(c.getDeletedSecret('API-TOKEN')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('DefaultAzureCredential pega token no endpoint de identidade gerenciada do engine', async () => {
    const saved = { endpoint: process.env['IDENTITY_ENDPOINT'], header: process.env['IDENTITY_HEADER'] }
    process.env['IDENTITY_ENDPOINT'] = `${base}/msi/token`
    process.env['IDENTITY_HEADER'] = 'vvpost'
    try {
      const { DefaultAzureCredential } = await import('@azure/identity')
      const c = new SecretClient(base, new DefaultAzureCredential(), {
        allowInsecureConnection: true,
        disableChallengeResourceVerification: true
      })
      expect((await c.getSecret('DATABASE-URL')).value).toBe(seed['env.dev'].DATABASE_URL)
    } finally {
      for (const [key, value] of [['IDENTITY_ENDPOINT', saved.endpoint], ['IDENTITY_HEADER', saved.header]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('responde ao primeiro pedido sem token com o desafio Bearer', async () => {
    const res = await fetch(`${base}/secrets/DATABASE_URL?api-version=7.4`)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer authorization=".+", resource=".+"$/)
  })
})

describe('AWS Secrets Manager com @aws-sdk/client-secrets-manager', () => {
  const client = () =>
    new SecretsManagerClient({
      endpoint: base,
      region: 'sa-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
    })

  it('GetSecretValue por nome e por ARN', async () => {
    const c = client()
    const byName = await c.send(new GetSecretValueCommand({ SecretId: 'DATABASE_URL' }))
    expect(byName.SecretString).toBe(seed['env.dev'].DATABASE_URL)
    expect(byName.ARN).toMatch(/^arn:aws:secretsmanager:sa-east-1:000000000000:secret:DATABASE_URL-\w{6}$/)
    expect(byName.CreatedDate).toBeInstanceOf(Date)
    const byArn = await c.send(new GetSecretValueCommand({ SecretId: byName.ARN }))
    expect(byArn.SecretString).toBe(byName.SecretString)
  })

  it('AWS_ENDPOINT_URL_SECRETS_MANAGER aponta o SDK para o engine sem mudar código', async () => {
    const saved = process.env['AWS_ENDPOINT_URL_SECRETS_MANAGER']
    process.env['AWS_ENDPOINT_URL_SECRETS_MANAGER'] = base
    try {
      const c = new SecretsManagerClient({ region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 'b' } })
      const out = await c.send(new GetSecretValueCommand({ SecretId: 'DATABASE_URL' }))
      expect(out.SecretString).toBe(seed['env.dev'].DATABASE_URL)
    } finally {
      if (saved === undefined) delete process.env['AWS_ENDPOINT_URL_SECRETS_MANAGER']
      else process.env['AWS_ENDPOINT_URL_SECRETS_MANAGER'] = saved
    }
  })

  it('ResourceNotFoundException tipada', async () => {
    await expect(client().send(new GetSecretValueCommand({ SecretId: 'nada' }))).rejects.toMatchObject({
      name: 'ResourceNotFoundException',
      $metadata: { httpStatusCode: 400 }
    })
  })

  it('cria, atualiza, descreve, lista e apaga', async () => {
    const c = client()
    await c.send(new CreateSecretCommand({ Name: 'app/api-key', SecretString: 'v1' }))
    await expect(c.send(new CreateSecretCommand({ Name: 'app/api-key', SecretString: 'x' }))).rejects.toMatchObject({
      name: 'ResourceExistsException'
    })
    const put = await c.send(new PutSecretValueCommand({ SecretId: 'app/api-key', SecretString: 'v2' }))
    expect((await readStore())['env.dev']!['app/api-key']).toBe('v2')
    const described = await c.send(new DescribeSecretCommand({ SecretId: 'app/api-key' }))
    expect(described.VersionIdsToStages).toEqual({ [put.VersionId!]: ['AWSCURRENT'] })

    const listed = await c.send(new ListSecretsCommand({ Filters: [{ Key: 'name', Values: ['app/'] }] }))
    expect(listed.SecretList?.map((s) => s.Name)).toEqual(['app/api-key'])

    const batch = await c.send(new BatchGetSecretValueCommand({ SecretIdList: ['app/api-key', 'nada'] }))
    expect(batch.SecretValues?.map((s) => s.SecretString)).toEqual(['v2'])
    expect(batch.Errors?.[0]).toMatchObject({ SecretId: 'nada', ErrorCode: 'ResourceNotFoundException' })

    await c.send(new DeleteSecretCommand({ SecretId: 'app/api-key', ForceDeleteWithoutRecovery: true }))
    expect((await readStore())['env.dev']!['app/api-key']).toBeUndefined()
  })
})

describe('HashiCorp Vault', () => {
  const vault = () => nodeVault({ endpoint: base, token: 'root' })

  it('KV v2 com node-vault: lê texto como { value } e JSON como os próprios campos', async () => {
    const v = vault()
    const plain = await v.read('secret/data/DATABASE_URL')
    expect(plain.data.data).toEqual({ value: seed['env.dev'].DATABASE_URL })
    expect(plain.data.metadata.version).toBe(1)
    const json = await v.read('secret/data/payments/config')
    expect(json.data.data).toEqual({ user: 'svc', password: 'hunter2' })
  })

  it('KV v2: grava, lista com LIST e apaga', async () => {
    const v = vault()
    await v.write('secret/data/payments/WEBHOOK', { data: { value: 'whsec' } })
    await v.write('secret/data/payments/db', { data: { host: 'h', port: 5432 } })
    expect((await readStore())['env.dev']!['payments/WEBHOOK']).toBe('whsec')
    expect(JSON.parse((await readStore())['env.dev']!['payments/db']!)).toEqual({ host: 'h', port: 5432 })

    const listed = await v.list('secret/metadata/payments')
    expect(listed.data.keys).toEqual(['STRIPE_KEY', 'WEBHOOK', 'config', 'db'])
    const root = await v.list('secret/metadata/')
    expect(root.data.keys).toEqual(['DATABASE_URL', 'payments/'])

    await v.delete('secret/data/payments/WEBHOOK')
    await expect(v.read('secret/data/payments/WEBHOOK')).rejects.toMatchObject({ response: { statusCode: 404 } })
  })

  it('KV v1, health e lookup-self', async () => {
    const v = vault()
    expect((await v.read('kv/DATABASE_URL')).data).toEqual({ value: seed['env.dev'].DATABASE_URL })
    expect((await v.health()).sealed).toBe(false)
    expect((await v.tokenLookupSelf()).data.policies).toEqual(['root'])
  })

  it.skipIf(!hasPython('hvac'))('hvac (cliente Python) lê, grava e lista', async () => {
    const script = `
import hvac, json, sys
c = hvac.Client(url=sys.argv[1], token='root')
assert c.is_authenticated()
r = c.secrets.kv.v2.read_secret_version(path='DATABASE_URL', raise_on_deleted_version=True)
c.secrets.kv.v2.create_or_update_secret(path='py/token', secret={'value': 'from-python'})
keys = c.secrets.kv.v2.list_secrets(path='py')['data']['keys']
print(json.dumps({'value': r['data']['data']['value'], 'keys': keys}))
`
    // Assíncrono: o engine roda neste mesmo processo e precisa do event loop livre.
    const { stdout } = await promisify(execFile)('python3', ['-c', script, base])
    const out = JSON.parse(stdout)
    expect(out).toEqual({ value: seed['env.dev'].DATABASE_URL, keys: ['token'] })
    expect((await readStore())['env.dev']!['py/token']).toBe('from-python')
  })
})

describe('segurança', () => {
  it('recusa requisições de navegador (Origin) e Host que não é local', async () => {
    const withOrigin = await fetch(`${base}/v1/secret/data/DATABASE_URL`, { headers: { origin: 'https://evil.example' } })
    expect(withOrigin.status).toBe(403)
    // fetch não deixa trocar o Host; http.get deixa.
    const status = await new Promise<number>((resolve, reject) =>
      get(`${base}/v1/secret/data/DATABASE_URL`, { headers: { host: 'evil.example' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }).on('error', reject)
    )
    expect(status).toBe(403)
  })

  it('não grava fora do ambiente nem em chaves de protótipo', async () => {
    const res = await fetch(`${base}/v1/secret/data/__proto__`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { value: 'x' } })
    })
    expect(res.status).toBe(400)
    expect((await readStore())['env.prod']).toEqual(seed['env.prod'])
  })
})

function hasPython(module: string): boolean {
  try {
    execFileSync('python3', ['-c', `import ${module}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
