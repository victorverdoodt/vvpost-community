import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

/** Segredos que o workspace espera (__REQUIRED_SECRET__) e ainda não têm valor local. */
export async function findMissingSecrets(dir: string): Promise<MissingSecret[]> {
  const store = await readSecretsStore(dir).catch(() => ({}) as SecretsStore)
  const out: MissingSecret[] = []
  for (const file of await listEnvironmentFiles(dir)) {
    const env = await readEnvironment(dir, file)
    if (!env) continue
    for (const [variable, v] of Object.entries(env.variables)) {
      if (!isObject(v) || v.isSecret !== true || v.value !== SECRET_PLACEHOLDER) continue
      if (store[env.id]?.[variable]) continue
      out.push({
        environmentId: env.id,
        environmentName: env.name || env.id,
        file,
        variable,
        description: v.description,
        placeholder: v.placeholder
      })
    }
  }
  return out
}

/**
 * Estado de cada segredo por ambiente, sem nenhum valor: configurado no vault local, pendente,
 * em texto puro no arquivo versionado, ou com nome sensível sem `isSecret`. Para o módulo Secrets.
 */
export async function secretInventory(dir: string): Promise<SecretInventory> {
  const store = await readSecretsStore(dir).catch(() => ({}) as SecretsStore)
  const keyStore = await vaultInfo(dir).then((i) => i.keyStore).catch(() => null)
  const environments: SecretInventory['environments'] = []
  for (const file of await listEnvironmentFiles(dir)) {
    const env = await readEnvironment(dir, file)
    if (!env) continue
    const secrets: SecretInventory['environments'][number]['secrets'] = []
    for (const [variable, v] of Object.entries(env.variables)) {
      if (!isObject(v)) continue
      let state: SecretState
      if (v.isSecret === true) {
        if (v.value !== SECRET_PLACEHOLDER) state = 'plaintext'
        else state = store[env.id]?.[variable] ? 'configured' : 'missing'
      } else if (isSensitiveName(variable) && v.value !== '' && v.value !== SECRET_PLACEHOLDER) {
        state = 'unmarked'
      } else continue
      secrets.push({ variable, state, description: v.description, placeholder: v.placeholder })
    }
    const variables: SecretInventory['environments'][number]['variables'] = []
    for (const [name, v] of Object.entries(env.variables)) {
      if (!isObject(v)) continue
      const hidden = v.isSecret === true || isSensitiveName(name)
      variables.push({
        name,
        type: v.type === 'number' || v.type === 'boolean' ? v.type : 'string',
        isSecret: v.isSecret === true,
        ...(!hidden && { value: v.value }),
        ...(v.description !== undefined && { description: v.description })
      })
    }
    const valid = validateEnvironment(env)
    const problem = valid.ok ? undefined : valid.issues.map((x) => `${x.path} ${x.message}`).join('; ')
    environments.push({ id: env.id, name: env.name || env.id, file, secrets, variables, ...(problem && { problem }) })
  }
  return { dir, storeFile: keyStore ? `cofre local (chave: ${keyStore})` : 'cofre local', environments }
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const serialize = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
