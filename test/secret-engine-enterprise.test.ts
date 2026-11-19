import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GetSecretValueCommand, ListSecretsCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ENTERPRISE_API_VERSION,
  EnterpriseModuleMissingError,
  loadEnterpriseModule,
  registerEnterpriseModule,
  setBundledEnterpriseModule,
  type EnterpriseContext,
  type EnterpriseSecretsModule,
  type SecretAuditEvent,
  type SecretBackend,
  type SecretRecord
} from '../src/main/secret-engine/backend'
import { readEngineModes } from '../src/main/secret-engine/modes'
import { startSecretEngine } from '../src/main/secret-engine/server'

let dir: string

const aws = (port: number) =>
  new SecretsManagerClient({
    endpoint: `http://localhost:${port}`,
    region: 'sa-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1
  })

const writeConfig = (config: unknown) => {
  mkdirSync(join(dir, '.vvpost'), { recursive: true })
  writeFileSync(join(dir, '.vvpost/secrets-engine.json'), JSON.stringify(config))
}

const enterpriseConfig = {
  mode: 'enterpriseProxy',
  enterpriseProxy: { provider: 'awsSecretsManager', upstreamVaultUrl: 'https://secretsmanager.sa-east-1.amazonaws.com' }
}

/** Módulo Enterprise de mentira: um "cofre remoto" em memória. */
function fakeModule(events: SecretAuditEvent[], seen: { context?: EnterpriseContext; closed: boolean }): EnterpriseSecretsModule {
  const values = new Map([['DATABASE_URL', 'postgres://cloud']])
  const record = (name: string, value: string): SecretRecord => ({ name, value, version: 'v1', updatedAt: 1 })
  return {
    apiVersion: ENTERPRISE_API_VERSION,
    async createBackend(context) {
      seen.context = context
      const backend: SecretBackend = {
        environment: 'cloud:aws',
        list: async () => [...values].map(([n, v]) => record(n, v)),
        get: async (name) => (values.has(name) ? record(name, values.get(name)!) : undefined),
        set: async (name, value) => (values.set(name, value), record(name, value)),
        delete: async (name) => values.delete(name),
        close: async () => {
          seen.closed = true
          values.clear()
        }
      }
      return backend
    },
    audit: (event) => {
      events.push(event)
    }
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vvpost-enterprise-'))
})

afterEach(() => {
  registerEnterpriseModule(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('trilha de auditoria', () => {
  it('no localMock, cada operação de uma API emulada vira evento, sem o valor do segredo', async () => {
    mkdirSync(join(dir, 'environments'))
    writeFileSync(join(dir, 'environments/dev.env.json'), JSON.stringify({ id: 'env.dev', name: 'Dev', variables: {} }))
    mkdirSync(join(dir, '.vvpost'))
    writeFileSync(join(dir, '.vvpost/secrets.local.json'), JSON.stringify({ 'env.dev': { API_KEY: 'sk_live_abc' } }))
    const events: SecretAuditEvent[] = []
    const engine = await startSecretEngine(dir, { port: 0, audit: (e) => void events.push(e) })
    try {
      expect(engine.mode).toBe('localMock')
      const out = await aws(engine.port).send(new GetSecretValueCommand({ SecretId: 'API_KEY' }))
      expect(out.SecretString).toBe('sk_live_abc')
      await expect(aws(engine.port).send(new GetSecretValueCommand({ SecretId: 'NOPE' }))).rejects.toThrow()
      const gets = events.filter((e) => e.action === 'get')
      expect(gets).toEqual([
        expect.objectContaining({ mode: 'localMock', api: 'awsSecretsManager', secret: 'API_KEY', environment: 'env.dev', outcome: 'ok' }),
        expect.objectContaining({ secret: 'NOPE', outcome: 'notFound' })
      ])
      expect(JSON.stringify(events)).not.toContain('sk_live_abc')
    } finally {
      await engine.close()
    }
  })
})

describe('modo enterpriseProxy', () => {
  it('sem o módulo Enterprise instalado, não liga e explica por quê', async () => {
    writeConfig(enterpriseConfig)
    await expect(startSecretEngine(dir, { port: 0 })).rejects.toBeInstanceOf(EnterpriseModuleMissingError)
  })

  it('serve as APIs emuladas a partir do backend do módulo, audita e descarta tudo ao desligar', async () => {
    writeConfig(enterpriseConfig)
    const events: SecretAuditEvent[] = []
    const seen: { context?: EnterpriseContext; closed: boolean } = { closed: false }
    registerEnterpriseModule(fakeModule(events, seen))
    const engine = await startSecretEngine(dir, { port: 0 })
    expect(engine).toMatchObject({ mode: 'enterpriseProxy', environment: 'cloud:aws' })
    expect(seen.context).toMatchObject({ workspaceDir: dir, config: enterpriseConfig.enterpriseProxy })
    const c = aws(engine.port)
    expect((await c.send(new GetSecretValueCommand({ SecretId: 'DATABASE_URL' }))).SecretString).toBe('postgres://cloud')
    expect((await c.send(new ListSecretsCommand({}))).SecretList?.map((s) => s.Name)).toEqual(['DATABASE_URL'])
    expect(events.map((e) => [e.mode, e.action, e.outcome])).toContainEqual(['enterpriseProxy', 'get', 'ok'])
    await engine.close()
    expect(seen.closed).toBe(true)
  })

  it('auditoria que falha barra a entrega do segredo (fail-closed)', async () => {
    writeConfig(enterpriseConfig)
    const mod = fakeModule([], { closed: false })
    registerEnterpriseModule({
      ...mod,
      audit: () => {
        throw new Error('trilha indisponível')
      }
    })
    const engine = await startSecretEngine(dir, { port: 0 })
    try {
      const res = await fetch(`http://localhost:${engine.port}/`, {
        method: 'POST',
        headers: { 'X-Amz-Target': 'secretsmanager.GetSecretValue', 'Content-Type': 'application/x-amz-json-1.1' },
        body: JSON.stringify({ SecretId: 'DATABASE_URL' })
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(await res.text()).not.toContain('postgres://cloud')
    } finally {
      await engine.close()
    }
  })
})

describe('carregamento do módulo', () => {
  it('carrega de VVPOST_ENTERPRISE_MODULE e recusa contrato de outra versão', async () => {
    const good = join(dir, 'good.mjs')
    writeFileSync(good, `export default { apiVersion: ${ENTERPRISE_API_VERSION}, createBackend: async () => ({}), audit: () => {} }`)
    const mod = await loadEnterpriseModule({ VVPOST_ENTERPRISE_MODULE: good })
    expect(mod.apiVersion).toBe(ENTERPRISE_API_VERSION)

    const old = join(dir, 'old.mjs')
    writeFileSync(old, `export const apiVersion = 0; export async function createBackend() {}; export function audit() {}`)
    await expect(loadEnterpriseModule({ VVPOST_ENTERPRISE_MODULE: old })).rejects.toThrow(/versão 0/)

    await expect(loadEnterpriseModule({ VVPOST_ENTERPRISE_MODULE: join(dir, 'missing.mjs') })).rejects.toThrow(/Falha ao carregar/)
    await expect(loadEnterpriseModule({})).rejects.toBeInstanceOf(EnterpriseModuleMissingError)
  })

  it('carrega o módulo do instalador, com VVPOST_ENTERPRISE_MODULE na frente', async () => {
    const bundled = join(dir, 'bundled.mjs')
    writeFileSync(bundled, `export default { apiVersion: ${ENTERPRISE_API_VERSION}, createBackend: async () => ({}), audit: () => {}, from: 'bundled' }`)
    const explicit = join(dir, 'explicit.mjs')
    writeFileSync(explicit, `export default { apiVersion: ${ENTERPRISE_API_VERSION}, createBackend: async () => ({}), audit: () => {}, from: 'explicit' }`)
    setBundledEnterpriseModule(bundled)
    try {
      expect(((await loadEnterpriseModule({})) as unknown as { from: string }).from).toBe('bundled')
      expect(((await loadEnterpriseModule({ VVPOST_ENTERPRISE_MODULE: explicit })) as unknown as { from: string }).from).toBe('explicit')
      setBundledEnterpriseModule(join(dir, 'missing.mjs'))
      await expect(loadEnterpriseModule({})).rejects.toThrow(/Falha ao carregar/)
    } finally {
      setBundledEnterpriseModule(null)
    }
  })
})

describe('toggle Mock/Proxy', () => {
  const setup = (config: unknown) => {
    mkdirSync(join(dir, 'environments'), { recursive: true })
    writeFileSync(join(dir, 'environments/dev.env.json'), JSON.stringify({ id: 'env.dev', name: 'Dev', variables: {} }))
    mkdirSync(join(dir, '.vvpost'), { recursive: true })
    writeFileSync(join(dir, '.vvpost/secrets.local.json'), JSON.stringify({ 'env.dev': { DATABASE_URL: 'postgres://local' } }))
    writeFileSync(join(dir, '.vvpost/secrets-engine.json'), JSON.stringify(config))
  }

  it('o modo escolhido troca o do arquivo, nos dois sentidos, sem gravar nada', async () => {
    setup({ ...enterpriseConfig, mode: 'localMock', localMock: { activeEnvironment: 'env.dev' } })
    const before = readFileSync(join(dir, '.vvpost/secrets-engine.json'), 'utf8')
    expect(await readEngineModes(dir)).toEqual({ configured: 'localMock', proxy: true })
    registerEnterpriseModule(fakeModule([], { closed: false }))

    const proxy = await startSecretEngine(dir, { port: 0, mode: 'enterpriseProxy' })
    expect(proxy).toMatchObject({ mode: 'enterpriseProxy', environment: 'cloud:aws' })
    expect((await aws(proxy.port).send(new GetSecretValueCommand({ SecretId: 'DATABASE_URL' }))).SecretString).toBe('postgres://cloud')
    await proxy.close()
    expect(readFileSync(join(dir, '.vvpost/secrets-engine.json'), 'utf8')).toBe(before)

    setup({ ...enterpriseConfig, localMock: { activeEnvironment: 'env.dev' } })
    expect((await readEngineModes(dir)).configured).toBe('enterpriseProxy')
    const mock = await startSecretEngine(dir, { port: 0, mode: 'localMock' })
    expect(mock).toMatchObject({ mode: 'localMock', environment: 'env.dev' })
    expect((await aws(mock.port).send(new GetSecretValueCommand({ SecretId: 'DATABASE_URL' }))).SecretString).toBe('postgres://local')
    await mock.close()
  })

  it('Proxy sem o bloco enterpriseProxy é erro claro, e o toggle nem aparece', async () => {
    setup({ mode: 'localMock', localMock: { activeEnvironment: 'env.dev' } })
    expect(await readEngineModes(dir)).toEqual({ configured: 'localMock', proxy: false })
    await expect(startSecretEngine(dir, { port: 0, mode: 'enterpriseProxy' })).rejects.toThrow(/precisa do bloco enterpriseProxy/)
    rmSync(join(dir, '.vvpost/secrets-engine.json'))
    expect(await readEngineModes(dir)).toEqual({ configured: 'localMock', proxy: false })
    writeFileSync(join(dir, '.vvpost/secrets-engine.json'), '{')
    expect(await readEngineModes(dir)).toEqual({ configured: 'localMock', proxy: false })
  })
})
