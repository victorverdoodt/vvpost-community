import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isProjectDir } from '@vvpost/core/projects'
import type { MissingSecret, SecretInventory, SecretState, UnredactedSecrets } from '@shared/ipc'
import { validateEnvironment, type Environment } from '@vvpost/schemas'
import { isSensitiveName, SECRET_PLACEHOLDER, SECRETS_FILE } from '@vvpost/core/secrets'
import { readVault, updateVault, vaultInfo, type SecretsStore } from '@vvpost/core/vault'

/**
 * Vault local de segredos do workspace: ambientes versionados guardam
 * __REQUIRED_SECRET__ e os valores reais ficam no cofre local (@vvpost/core/vault), fora da
 * pasta e cifrado. SECRETS_FILE é o arquivo antigo, em texto puro, que migra sozinho.
 */
export { SECRETS_FILE }

/** Pasta dos ambientes versionados, relativa ao workspace. */
export const ENVIRONMENTS_DIR = 'environments'

export type { SecretsStore }

export interface SecretValue {
  environmentId: string
  variable: string
  value: string
}

export const readSecretsStore = (dir: string): Promise<SecretsStore> => readVault(dir)

/**
 * Mescla os valores no cofre local da pasta. O cofre fica fora do workspace, então nenhum
 * arquivo do workspace muda: devolve sempre [] (os chamadores juntam os caminhos mudados).
 */
export async function mergeSecrets(dir: string, values: SecretValue[]): Promise<string[]> {
  if (values.length === 0) return []
  await updateVault(dir, (store) => {
    for (const s of values) {
      if (UNSAFE_KEYS.has(s.environmentId) || UNSAFE_KEYS.has(s.variable)) continue
      const env = (store[s.environmentId] ??= {})
      env[s.variable] = s.value
    }
  })
  return []
}

/** Acrescenta a linha ao .gitignore se ela ainda não estiver lá. Devolve true se mudou o arquivo. */
export async function ensureGitignored(dir: string, entry: string): Promise<boolean> {
  const path = join(dir, '.gitignore')
  let current = ''
  try {
    current = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const lines = current.split(/\r?\n/).map((l) => l.trim())
  if (lines.includes(entry) || lines.includes(`/${entry}`)) return false
  await appendFile(path, `${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`)
  return true
}

/** Ambiente versionado: arquivo *.env.json dentro de environments/ (caminho relativo com "/"). */
export function isEnvironmentFile(path: string): boolean {
  return path.startsWith(`${ENVIRONMENTS_DIR}/`) && path.endsWith('.env.json')
}

/** Caminhos relativos de todos os ambientes do workspace. */
export async function listEnvironmentFiles(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(join(dir, ENVIRONMENTS_DIR), { recursive: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return entries
    .map((e) => `${ENVIRONMENTS_DIR}/${e.replaceAll('\\', '/')}`)
    .filter(isEnvironmentFile)
    .sort()
}

/** Lê um ambiente; null se o arquivo não existe ou não tem a forma de um ambiente. */
export async function readEnvironment(dir: string, path: string): Promise<Environment | null> {
  let text: string
  try {
    text = await readFile(join(dir, path), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return parseEnvironment(text)
}

export function parseEnvironment(text: string): Environment | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(parsed) || typeof parsed['id'] !== 'string' || !isObject(parsed['variables'])) return null
  return parsed as unknown as Environment
}

/**
 * Troca por __REQUIRED_SECRET__ o valor de toda variável isSecret que ainda está
 * em texto puro. Não muda o documento recebido. `secrets` traz os valores tirados.
 */
export function redactEnvironment(env: Environment): { env: Environment; secrets: SecretValue[] } {
  const secrets: SecretValue[] = []
  const variables: Environment['variables'] = {}
  for (const [name, v] of Object.entries(env.variables)) {
    if (isObject(v) && v.isSecret === true && v.value !== SECRET_PLACEHOLDER) {
      secrets.push({ environmentId: env.id, variable: name, value: String(v.value ?? '') })
      variables[name] = { ...v, type: 'string', value: SECRET_PLACEHOLDER }
    } else {
      variables[name] = v
    }
  }
  return { env: secrets.length ? { ...env, variables } : env, secrets }
}

/** Texto do ambiente como será commitado: com os segredos redigidos. Outros textos passam iguais. */
export function redactedText(text: string): string {
  const env = parseEnvironment(text)
  if (!env) return text
  const out = redactEnvironment(env)
  return out.secrets.length ? serialize(out.env) : text
}

type RedactionReport = UnredactedSecrets

/** Lista os ambientes com segredo em texto puro, sem mudar nada. */
export async function findUnredacted(dir: string, paths?: string[]): Promise<RedactionReport[]> {
  const files = (paths ?? (await listEnvironmentFiles(dir))).filter(isEnvironmentFile)
  const out: RedactionReport[] = []
  for (const file of files) {
    const env = await readEnvironment(dir, file)
    if (!env) continue
    const { secrets } = redactEnvironment(env)
    if (secrets.length) out.push({ file, variables: secrets.map((s) => s.variable) })
  }
  return out
}

/**
 * Redige os ambientes indicados no disco: grava os valores no vault primeiro e
 * só então reescreve o arquivo versionado, para nunca perder um valor.
 */
export async function redactFiles(
  dir: string,
  paths: string[]
): Promise<{ redacted: RedactionReport[]; changed: string[] }> {
  const redacted: RedactionReport[] = []
  const changed = new Set<string>()
  for (const file of paths.filter(isEnvironmentFile)) {
    const env = await readEnvironment(dir, file)
    if (!env) continue
    const out = redactEnvironment(env)
    if (!out.secrets.length) continue
    for (const p of await mergeSecrets(dir, out.secrets)) changed.add(p)
    await writeFile(join(dir, file), serialize(out.env))
    changed.add(file)
    redacted.push({ file, variables: out.secrets.map((s) => s.variable) })
  }
  return { redacted, changed: [...changed] }
}

/**
 * A pasta do Compartilhado quando `dir` é um projeto (docs/git-workspace.md, Projetos): a raiz,
 * cujos ambientes e cofre o projeto herda. null na raiz.
 */
export function sharedDirOf(dir: string): string | null {
  return isProjectDir(dir) ? dirname(dir) : null
}

/** Um ambiente como a pasta o vê: o do projeto (`own`) complementando o do Compartilhado (`base`). */
interface LayeredEnvironment {
  id: string
  own?: { env: Environment; file: string }
  /** `file` relativo a `dir`, com o "../" da raiz. */
  base?: { env: Environment; file: string }
}

/**
 * Os ambientes de `dir` com a herança do Compartilhado, na mesma regra do core (loadWorkspace): o
 * ambiente do projeto complementa o da raiz com o mesmo id, e as variáveis do projeto vencem. Os do
 * projeto vêm primeiro, na ordem dos arquivos; depois os que só a raiz tem.
 */
async function layeredEnvironments(dir: string): Promise<LayeredEnvironment[]> {
  const byId = new Map<string, LayeredEnvironment>()
  for (const file of await listEnvironmentFiles(dir)) {
    const env = await readEnvironment(dir, file)
    if (env && !byId.has(env.id)) byId.set(env.id, { id: env.id, own: { env, file } })
  }
  const shared = sharedDirOf(dir)
  if (shared) {
    for (const file of await listEnvironmentFiles(shared)) {
      const env = await readEnvironment(shared, file)
      if (!env) continue
      const entry = byId.get(env.id) ?? { id: env.id }
      if (entry.base) continue
      entry.base = { env, file: `../${file}` }
      byId.set(env.id, entry)
    }
  }
  return [...byId.values()]
}

/** As variáveis do ambiente com a herança; `shared` marca as que só o Compartilhado declara. */
function layeredVariables(e: LayeredEnvironment): [string, unknown, boolean][] {
  const own = e.own?.env.variables ?? {}
  const out: [string, unknown, boolean][] = []
  for (const [name, v] of Object.entries(e.base?.env.variables ?? {})) if (!(name in own)) out.push([name, v, true])
  for (const [name, v] of Object.entries(own)) out.push([name, v, false])
  return out
}

/** Os cofres que valem para `dir`: o do Compartilhado e o da pasta, que vence (como no core). */
async function layeredStores(dir: string): Promise<{ own: SecretsStore; shared: SecretsStore }> {
  const sharedDir = sharedDirOf(dir)
  const [own, shared] = await Promise.all([
    readSecretsStore(dir).catch(() => ({}) as SecretsStore),
    sharedDir ? readSecretsStore(sharedDir).catch(() => ({}) as SecretsStore) : ({} as SecretsStore)
  ])
  return { own, shared }
}

const hasValue = (stores: { own: SecretsStore; shared: SecretsStore }, envId: string, variable: string) =>
  !!(stores.own[envId]?.[variable] || stores.shared[envId]?.[variable])

/**
 * Segredos que o workspace espera (__REQUIRED_SECRET__) e ainda não têm valor local. Num projeto,
 * entram também os do Compartilhado que o projeto herda, que é o que as requisições dele pedem.
 */
export async function findMissingSecrets(dir: string): Promise<MissingSecret[]> {
  const stores = await layeredStores(dir)
  const out: MissingSecret[] = []
  for (const e of await layeredEnvironments(dir)) {
    const env = e.own?.env ?? e.base!.env
    for (const [variable, v, shared] of layeredVariables(e)) {
      if (!isObject(v) || v.isSecret !== true || v.value !== SECRET_PLACEHOLDER) continue
      if (hasValue(stores, e.id, variable)) continue
      out.push({
        environmentId: e.id,
        environmentName: env.name || e.id,
        file: shared ? e.base!.file : e.own!.file,
        variable,
        description: typeof v.description === 'string' ? v.description : undefined,
        placeholder: typeof v.placeholder === 'string' ? v.placeholder : undefined
      })
    }
  }
  return out
}

/**
 * Onde fica o valor de um segredo de `dir`: no cofre da pasta, se o ambiente do projeto o declara
 * ou o cofre dela já tem valor; senão no do Compartilhado, que declara. null se ninguém declara.
 */
export async function secretVaultDir(dir: string, environmentId: string, variable: string): Promise<string | null> {
  const e = (await layeredEnvironments(dir)).find((x) => x.id === environmentId)
  const declared = layeredVariables(e ?? { id: environmentId }).find(([name, v]) => name === variable && isObject(v) && v.isSecret === true)
  if (!declared) return null
  if (!declared[2]) return dir
  const stores = await layeredStores(dir)
  return stores.own[environmentId]?.[variable] ? dir : sharedDirOf(dir)
}

/** O valor de um segredo como `dir` o vê: o cofre da pasta e, num projeto, o do Compartilhado. */
export async function readSecretValue(dir: string, environmentId: string, variable: string): Promise<string | undefined> {
  const stores = await layeredStores(dir)
  const value = stores.own[environmentId]?.[variable] || stores.shared[environmentId]?.[variable]
  return value === undefined || value === SECRET_PLACEHOLDER ? undefined : value
}

/**
 * Estado de cada segredo por ambiente, sem nenhum valor: configurado no vault local, pendente,
 * em texto puro no arquivo versionado, ou com nome sensível sem `isSecret`. Para o módulo Secrets.
 * Num projeto, os ambientes e segredos herdados do Compartilhado aparecem também (marcados
 * `shared`), porque as requisições do projeto os usam.
 */
export async function secretInventory(dir: string): Promise<SecretInventory> {
  const stores = await layeredStores(dir)
  const keyStore = await vaultInfo(dir).then((i) => i.keyStore).catch(() => null)
  const environments: SecretInventory['environments'] = []
  for (const e of await layeredEnvironments(dir)) {
    const env = e.own?.env ?? e.base!.env
    const secrets: SecretInventory['environments'][number]['secrets'] = []
    const variables: SecretInventory['environments'][number]['variables'] = []
    for (const [variable, v, shared] of layeredVariables(e)) {
      if (!isObject(v)) continue
      let state: SecretState | null = null
      if (v.isSecret === true) {
        if (v.value !== SECRET_PLACEHOLDER) state = 'plaintext'
        else state = hasValue(stores, e.id, variable) ? 'configured' : 'missing'
      } else if (isSensitiveName(variable) && v.value !== '' && v.value !== SECRET_PLACEHOLDER) {
        state = 'unmarked'
      }
      if (state) {
        secrets.push({
          variable,
          state,
          ...(typeof v.description === 'string' && { description: v.description }),
          ...(typeof v.placeholder === 'string' && { placeholder: v.placeholder }),
          ...(shared && { shared: true as const })
        })
      }
      const hidden = v.isSecret === true || isSensitiveName(variable)
      variables.push({
        name: variable,
        type: v.type === 'number' || v.type === 'boolean' ? v.type : 'string',
        isSecret: v.isSecret === true,
        ...(!hidden && { value: v.value as string | number | boolean }),
        ...(v.description !== undefined && { description: v.description as string }),
        ...(shared && { shared: true as const })
      })
    }
    // O arquivo que o app edita é o do projeto; o do Compartilhado só quando o projeto não tem um.
    const valid = validateEnvironment(env)
    const problem = valid.ok ? undefined : valid.issues.map((x) => `${x.path} ${x.message}`).join('; ')
    environments.push({
      id: e.id,
      name: env.name || e.id,
      file: e.own?.file ?? e.base!.file,
      ...(!e.own && { shared: true as const }),
      secrets,
      variables,
      ...(problem && { problem })
    })
  }
  return { dir, storeFile: keyStore ? `cofre local (chave: ${keyStore})` : 'cofre local', environments }
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const serialize = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
