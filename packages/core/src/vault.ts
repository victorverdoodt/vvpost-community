import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { vaultKey, type KeyStoreKind } from './keychain'
import { defaultUserDataDir } from './paths'
import { SECRETS_FILE } from './secrets'

/**
 * Cofre local de segredos: os valores reais das variáveis isSecret, um objeto
 * { [id do ambiente]: { [variável]: valor } } por pasta de workspace (ou de projeto). Fica fora
 * da pasta do projeto, na pasta do cofre do usuário (`<userData>/vault`, ou `VVPOST_VAULT_DIR`),
 * cifrado com AES-256-GCM; a chave fica no cofre do sistema (keychain.ts). Nenhum backup, sync
 * ou `git add -f` da pasta do projeto leva os valores, e o arquivo sozinho não abre.
 *
 * O formato antigo, `.vvpost/secrets.local.json` em texto puro dentro do projeto, migra sozinho
 * na primeira leitura: os valores entram no cofre (vencendo os que já estavam) e o arquivo é
 * apagado.
 */
export type SecretsStore = Record<string, Record<string, string>>

/** O arquivo antigo, em texto puro dentro do projeto. Só a migração e o leak guard o procuram. */
export const LEGACY_SECRETS_FILE = SECRETS_FILE

/** Nome do cofre para quem lê uma mensagem. */
export const VAULT_LABEL = 'cofre local'

interface VaultFile {
  vault: 1
  /** Pasta do workspace, para achar o cofre de uma pasta movida. Não é segredo. */
  dir: string
  keyStore: KeyStoreKind
  keyId: string
  iv: string
  tag: string
  data: string
}

const KEY_STORE_LABEL: Record<KeyStoreKind, string> = {
  env: 'VVPOST_VAULT_KEY',
  'macos-keychain': 'Keychain do macOS',
  'windows-dpapi': 'DPAPI do Windows',
  libsecret: 'Secret Service (libsecret)',
  file: 'arquivo de chave da pasta do cofre'
}

export class VaultError extends Error {}

/** Pasta dos cofres e da chave em arquivo: fora de qualquer projeto. */
export function vaultDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['VVPOST_VAULT_DIR'] ?? join(defaultUserDataDir(env), 'vault')
}

async function canonical(dir: string): Promise<string> {
  return realpath(dir).catch(() => resolve(dir))
}

/** O arquivo do cofre de uma pasta de workspace. */
export async function vaultFile(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const id = createHash('sha256').update(await canonical(dir)).digest('hex').slice(0, 32)
  return join(vaultDir(env), `${id}.vault.json`)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Só strings, sem chaves de protótipo: o que vale como cofre. */
function clean(value: unknown): SecretsStore {
  const out: SecretsStore = {}
  if (!isObject(value)) return out
  for (const [env, vars] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(env) || !isObject(vars)) continue
    const entry: Record<string, string> = {}
    for (const [name, v] of Object.entries(vars)) if (!UNSAFE_KEYS.has(name) && typeof v === 'string') entry[name] = v
    out[env] = entry
  }
  return out
}

const decoded = new Map<string, { mtimeMs: number; size: number; store: SecretsStore }>()

async function readEncrypted(file: string, env: NodeJS.ProcessEnv): Promise<SecretsStore> {
  const info = await stat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  if (!info) return {}
  const hit = decoded.get(file)
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return structuredClone(hit.store)
  let doc: VaultFile
  try {
    doc = JSON.parse(await readFile(file, 'utf8')) as VaultFile
  } catch (err) {
    throw new VaultError(`O ${VAULT_LABEL} (${file}) não é um JSON válido: ${(err as Error).message}`)
  }
  if (doc?.vault !== 1) throw new VaultError(`O ${VAULT_LABEL} (${file}) está num formato desconhecido.`)
  const key = await vaultKey(vaultDir(env), env)
  if (key.id !== doc.keyId) {
    throw new VaultError(
      `O ${VAULT_LABEL} desta pasta foi cifrado com a chave do ${KEY_STORE_LABEL[doc.keyStore] ?? doc.keyStore}, que não está disponível ` +
        `aqui (agora vale a do ${KEY_STORE_LABEL[key.kind]}). Rode no mesmo usuário e sessão em que o cofre foi criado.`
    )
  }
  let store: SecretsStore
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, Buffer.from(doc.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(doc.tag, 'base64'))
    decipher.setAAD(Buffer.from(`vvpost-vault:${doc.dir}`))
    const plain = Buffer.concat([decipher.update(Buffer.from(doc.data, 'base64')), decipher.final()])
    store = clean(JSON.parse(plain.toString('utf8')))
  } catch {
    throw new VaultError(`O ${VAULT_LABEL} (${file}) não abriu: o arquivo foi alterado ou está corrompido.`)
  }
  decoded.set(file, { mtimeMs: info.mtimeMs, size: info.size, store })
  return structuredClone(store)
}

async function writeEncrypted(dir: string, file: string, store: SecretsStore, env: NodeJS.ProcessEnv): Promise<void> {
  const key = await vaultKey(vaultDir(env), env)
  const where = await canonical(dir)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key.key, iv)
  cipher.setAAD(Buffer.from(`vvpost-vault:${where}`))
  const data = Buffer.concat([cipher.update(JSON.stringify(store), 'utf8'), cipher.final()])
  const doc: VaultFile = {
    vault: 1,
    dir: where,
    keyStore: key.kind,
    keyId: key.id,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
  await mkdir(vaultDir(env), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(doc)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600).catch(() => undefined)
  await rename(tmp, file)
  decoded.delete(file)
}

/** Uma escrita por vez em cada cofre, neste processo: duas gravações seguidas não se perdem. */
const queues = new Map<string, Promise<unknown>>()
function serialized<T>(file: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(file) ?? Promise.resolve()).then(task, task)
  queues.set(
    file,
    next.catch(() => undefined)
  )
  return next
}

/**
 * Leva o `.vvpost/secrets.local.json` da pasta para o cofre e apaga o arquivo, depois de
 * conferir que o cofre gravado abre com os valores. Arquivo que não é um objeto JSON fica onde
 * está, com o erro.
 */
async function migrateLegacy(dir: string, file: string, env: NodeJS.ProcessEnv): Promise<void> {
  const legacy = join(dir, LEGACY_SECRETS_FILE)
  let text: string
  try {
    text = await readFile(legacy, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new VaultError(`${LEGACY_SECRETS_FILE} não é um JSON válido (${(err as Error).message}); corrija para ele migrar para o ${VAULT_LABEL}.`)
  }
  if (!isObject(parsed)) throw new VaultError(`${LEGACY_SECRETS_FILE} deve ser um objeto { "<id do ambiente>": { "VAR": "valor" } }.`)
  const store = await readEncrypted(file, env)
  for (const [envId, vars] of Object.entries(clean(parsed))) store[envId] = { ...store[envId], ...vars }
  await writeEncrypted(dir, file, store, env)
  const check = await readEncrypted(file, env)
  if (JSON.stringify(check) !== JSON.stringify(store)) throw new VaultError(`O ${VAULT_LABEL} não confirmou a migração; ${LEGACY_SECRETS_FILE} foi mantido.`)
  await unlink(legacy)
}

/** Os valores do cofre da pasta (migrando o arquivo antigo, se houver). Sem cofre, {}. */
export async function readVault(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<SecretsStore> {
  const file = await vaultFile(dir, env)
  // Sem o arquivo antigo, a leitura não espera a fila: carregar o workspace fica rápido.
  const legacy = await stat(join(dir, LEGACY_SECRETS_FILE)).catch(() => null)
  if (!legacy) return readEncrypted(file, env)
  return serialized(file, async () => {
    await migrateLegacy(dir, file, env)
    return readEncrypted(file, env)
  })
}

/** Muda o cofre da pasta e devolve o que ficou gravado. */
export async function updateVault(
  dir: string,
  change: (store: SecretsStore) => void,
  env: NodeJS.ProcessEnv = process.env
): Promise<SecretsStore> {
  const file = await vaultFile(dir, env)
  return serialized(file, async () => {
    await migrateLegacy(dir, file, env)
    const store = await readEncrypted(file, env)
    change(store)
    const next = clean(store)
    await writeEncrypted(dir, file, next, env)
    return next
  })
}

/** Onde está o cofre da pasta e onde fica a chave, para a interface (sem nenhum valor). */
export async function vaultInfo(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<{ file: string; keyStore: string }> {
  const key = await vaultKey(vaultDir(env), env)
  return { file: await vaultFile(dir, env), keyStore: KEY_STORE_LABEL[key.kind] }
}
