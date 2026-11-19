import { test } from 'node:test'
import { validateSecretsEngineConfig } from '../src/index.ts'
import { assertIssue, assertValid, fixture } from './helpers.ts'

const config = (): any => fixture('secrets-engine.json')

test('aceita o exemplo da documentação', () => {
  assertValid(validateSecretsEngineConfig(config()))
})

test('port é opcional (padrão 4460)', () => {
  const c = config()
  delete c.port
  assertValid(validateSecretsEngineConfig(c))
})

test('rejeita porta privilegiada ou fora do intervalo', () => {
  for (const port of [80, 70000, 4460.5]) {
    const c = config()
    c.port = port
    assertIssue(validateSecretsEngineConfig(c), '/port')
  }
})

test('rejeita modo desconhecido', () => {
  const c = config()
  c.mode = 'cloud'
  assertIssue(validateSecretsEngineConfig(c), '/mode')
})

test('modo localMock exige a seção localMock', () => {
  const c = config()
  delete c.localMock
  assertIssue(validateSecretsEngineConfig(c), '', /"localMock"/)
})

test('modo enterpriseProxy exige a seção enterpriseProxy', () => {
  const c = config()
  c.mode = 'enterpriseProxy'
  delete c.enterpriseProxy
  assertIssue(validateSecretsEngineConfig(c), '', /"enterpriseProxy"/)
})

test('modo enterpriseProxy funciona sem a seção localMock', () => {
  const c = config()
  c.mode = 'enterpriseProxy'
  delete c.localMock
  assertValid(validateSecretsEngineConfig(c))
})

test('storageFile precisa ser JSON relativo ao workspace', () => {
  for (const storageFile of ['/etc/secrets.json', 'C:\\secrets.json', '../fora.json', '.vvpost/secrets.txt']) {
    const c = config()
    c.localMock.storageFile = storageFile
    assertIssue(validateSecretsEngineConfig(c), '/localMock/storageFile')
  }
})

test('rejeita provedor desconhecido', () => {
  const c = config()
  c.enterpriseProxy.provider = 'gcpSecretManager'
  assertIssue(validateSecretsEngineConfig(c), '/enterpriseProxy/provider')
})

test('aceita os três provedores da spec', () => {
  for (const provider of ['azureKeyVault', 'awsSecretsManager', 'hashicorpVault']) {
    const c = config()
    c.enterpriseProxy.provider = provider
    assertValid(validateSecretsEngineConfig(c))
  }
})

test('upstreamVaultUrl precisa ser HTTPS', () => {
  const c = config()
  c.enterpriseProxy.upstreamVaultUrl = 'http://corp-vault.vault.azure.net'
  assertIssue(validateSecretsEngineConfig(c), '/enterpriseProxy/upstreamVaultUrl')
})

test('enforceMemoryOnly não pode ser desligado (Zero-Disk)', () => {
  const c = config()
  c.enterpriseProxy.enforceMemoryOnly = false
  assertIssue(validateSecretsEngineConfig(c), '/enterpriseProxy/enforceMemoryOnly')
})

test('cacheTtlSeconds aceita 0 e rejeita negativo', () => {
  const c = config()
  c.enterpriseProxy.cacheTtlSeconds = 0
  assertValid(validateSecretsEngineConfig(c))
  c.enterpriseProxy.cacheTtlSeconds = -1
  assertIssue(validateSecretsEngineConfig(c), '/enterpriseProxy/cacheTtlSeconds')
})
