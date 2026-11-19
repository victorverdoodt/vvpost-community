import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { validateSecretsEngineConfig, type EnterpriseProxyConfig, type SecretsEngineConfig, type SecretsEngineMode } from '@vvpost/schemas'
import { readVault, updateVault, vaultFile } from '@vvpost/core/vault'
import { ENVIRONMENTS_DIR, ensureGitignored, listEnvironmentFiles, readEnvironment } from '../workspace/vault'
import type { SecretBackend, SecretRecord } from './backend'

export type { SecretRecord } from './backend'

/** Configuração do engine no workspace. É opcional: sem ela valem os padrões. */
export const ENGINE_CONFIG_FILE = '.vvpost/secrets-engine.json'
export const DEFAULT_PORT = 4460

export interface ResolvedEngineConfig {
  port: number
  mode: SecretsEngineMode
  /** Presente quando mode é enterpriseProxy (o schema exige). */
  enterpriseProxy?: EnterpriseProxyConfig
  /** Ambiente cujos segredos são servidos; null quando o workspace não tem nenhum. */
  environment: string | null
  /** Arquivo com os valores, relativo ao workspace; null é o cofre local (o mesmo do Git Workspace). */
  storageFile: string | null
}

/**
 * Lê .vvpost/secrets-engine.json e completa o que faltar. Arquivo inválido é erro.
 * `mode` troca o modo do arquivo (toggle Mock/Proxy da barra de status), sem gravar nada.
 */
export async function resolveEngineConfig(dir: string, overrides: { mode?: SecretsEngineMode } = {}): Promise<ResolvedEngineConfig> {
  let config: SecretsEngineConfig | null = null
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, ENGINE_CONFIG_FILE), 'utf8'))
    const check = validateSecretsEngineConfig(parsed)
    if (!check.ok) {
      const issue = check.issues[0]
      throw new Error(`${ENGINE_CONFIG_FILE} inválido: ${issue ? `${issue.path || '/'} ${issue.message}` : ''}`)
    }
    config = check.value
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const storageFile = config?.localMock?.storageFile ?? null
  const environment = config?.localMock?.activeEnvironment ?? (await defaultEnvironment(dir, storageFile))
  const mode = overrides.mode ?? config?.mode ?? 'localMock'
  if (mode === 'enterpriseProxy' && !config?.enterpriseProxy) {
    throw new Error(`O Cloud Proxy precisa do bloco enterpriseProxy em ${ENGINE_CONFIG_FILE} (provedor e cofre da organização).`)
  }
  return {
    port: config?.port ?? DEFAULT_PORT,
    mode,
    ...(config?.enterpriseProxy ? { enterpriseProxy: config.enterpriseProxy } : {}),
    environment,
    storageFile
  }
}

/** Sem configuração: o primeiro ambiente versionado, ou o primeiro que tiver valores no arquivo local. */
async function defaultEnvironment(dir: string, storageFile: string | null): Promise<string | null> {
  for (const file of await listEnvironmentFiles(dir)) {
    const env = await readEnvironment(dir, file)
    if (env) return env.id
  }
  const store = await (storageFile ? readStore(join(dir, storageFile)) : readVault(dir)).catch(() => ({}))
  return Object.keys(store).sort()[0] ?? null
}

/**
 * Backend do modo localMock: segredos do ambiente ativo no cofre local (o mesmo do Git
 * Workspace), ou no arquivo de `localMock.storageFile`. É lido a cada chamada, então edições
 * feitas fora do engine (wizard de onboarding, módulo Secrets) valem na hora. Escritas dos SDKs
 * vão para o mesmo lugar, em fila, para duas escritas simultâneas não se perderem.
 */
export class SecretSource implements SecretBackend {
  private readonly file: string | null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly config: ResolvedEngineConfig
  ) {
    this.file = config.storageFile === null ? null : join(dir, config.storageFile)
  }

  get environment(): string | null {
    return this.config.environment
  }

  async list(): Promise<SecretRecord[]> {
    const { values, updatedAt } = await this.snapshot()
    return Object.keys(values)
      .sort()
      .map((name) => record(name, values[name]!, updatedAt))
  }

  async get(name: string): Promise<SecretRecord | undefined> {
    const { values, updatedAt } = await this.snapshot()
    return Object.hasOwn(values, name) ? record(name, values[name]!, updatedAt) : undefined
  }

  /** Cria ou troca o valor. Devolve o registro gravado. */
  set(name: string, value: string): Promise<SecretRecord> {
    return this.mutate((env) => {
      env[name] = value
    }).then(() => record(name, value, Date.now()))
  }

  /** Apaga; devolve false se o segredo não existia. */
  delete(name: string): Promise<boolean> {
    let existed = false
    return this.mutate((env) => {
      existed = Object.hasOwn(env, name)
      delete env[name]
    }).then(() => existed)
  }

  private async snapshot(): Promise<{ values: Record<string, string>; updatedAt: number }> {
    const env = this.config.environment
    if (!env) return { values: {}, updatedAt: 0 }
    const file = this.file ?? (await vaultFile(this.dir))
    const [store, info] = await Promise.all([this.file ? readStore(this.file) : readVault(this.dir), stat(file).catch(() => null)])
    const values: Record<string, string> = {}
    for (const [k, v] of Object.entries(store[env] ?? {})) if (typeof v === 'string') values[k] = v
    return { values, updatedAt: info?.mtimeMs ?? 0 }
  }

  private mutate(change: (env: Record<string, string>) => void): Promise<void> {
    const run = async () => {
      const env = this.config.environment
      if (!env) throw new NoEnvironmentError()
      if (UNSAFE_KEYS.has(env)) throw new Error('Ambiente inválido.')
      if (this.file === null) {
        await updateVault(this.dir, (store) => change((store[env] ??= {})))
        return
      }
      const store = await readStore(this.file)
      const values = (store[env] ??= {}) as Record<string, string>
      change(values)
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
      await ensureGitignored(this.dir, this.config.storageFile!.replaceAll('\\', '/'))
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }
}

export class NoEnvironmentError extends Error {
  constructor() {
    super(`Nenhum ambiente ativo: crie um em ${ENVIRONMENTS_DIR}/ ou defina localMock.activeEnvironment em ${ENGINE_CONFIG_FILE}.`)
  }
}

/** Nomes que nunca viram chave de objeto (protótipo). */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

type Store = Record<string, Record<string, unknown>>

async function readStore(file: string): Promise<Store> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('O arquivo de segredos não contém um objeto JSON.')
  }
  return parsed as Store
}

function record(name: string, value: string, updatedAt: number): SecretRecord {
  return { name, value, version: createHash('sha256').update(value).digest('hex').slice(0, 32), updatedAt }
}
