import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Onde fica a chave do cofre local (vault.ts): no cofre do sistema, para que o arquivo cifrado
 * sozinho não sirva para nada. É uma chave por usuário do sistema, a mesma no app, no CLI e no
 * servidor MCP, que rodam em Node; por isso o acesso é pelas ferramentas do sistema, sem módulo
 * nativo:
 *
 * - macOS: Keychain, pelo `security`;
 * - Windows: DPAPI do usuário (a proteção do Gerenciador de Credenciais), pelo PowerShell;
 * - Linux: Secret Service (GNOME Keyring, KWallet), pelo `secret-tool` da libsecret.
 *
 * Sem cofre do sistema (Linux sem libsecret, contêiner), a chave fica num arquivo só do dono na
 * pasta do cofre, fora do projeto. `VVPOST_VAULT_KEY` (base64, 32 bytes) dá a chave direto, e
 * `VVPOST_VAULT_KEYSTORE=file` força o arquivo (testes, CI).
 */
export type KeyStoreKind = 'env' | 'macos-keychain' | 'windows-dpapi' | 'libsecret' | 'file'

export interface VaultKey {
  key: Buffer
  kind: KeyStoreKind
  /** Impressão da chave, gravada no cofre: outra chave não é confundida com cofre vazio. */
  id: string
}

const SERVICE = 'vvpost'
const ACCOUNT = 'vault-key'
const TIMEOUT_MS = 20_000

/** O cofre do sistema não está disponível aqui: vale o arquivo. */
class Unavailable extends Error {}

interface Backend {
  kind: KeyStoreKind
  /** A chave guardada, ou null se ainda não há uma. */
  get(): Promise<Buffer | null>
  set(key: Buffer): Promise<void>
  remove?(): Promise<void>
}

function run(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null
      if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) return reject(new Unavailable(`${cmd} não encontrado`))
      if (e && typeof e.code !== 'number') return reject(new Unavailable(e.message))
      resolve({ code: e ? (e.code as unknown as number) : 0, stdout, stderr })
    })
    child.stdin?.end(input ?? '')
  })
}

const decode = (text: string): Buffer | null => {
  const key = Buffer.from(text.trim(), 'base64')
  return key.length === 32 ? key : null
}

const macos: Backend = {
  kind: 'macos-keychain',
  async get() {
    const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'])
    if (r.code === 44) return null // não achou
    if (r.code !== 0) throw new Unavailable(r.stderr.trim())
    return decode(r.stdout)
  },
  async set(key) {
    const r = await run('security', ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-l', 'VVPost: chave do cofre local', '-U', '-w', key.toString('base64')])
    if (r.code !== 0) throw new Unavailable(r.stderr.trim())
  }
}

const libsecret: Backend = {
  kind: 'libsecret',
  async get() {
    const r = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT])
    // Sem o item, o secret-tool sai com 1 e nada no stderr; sem D-Bus ou sem keyring, explica no stderr.
    if (r.code !== 0) {
      if (r.stderr.trim()) throw new Unavailable(r.stderr.trim())
      return null
    }
    return decode(r.stdout)
  },
  async set(key) {
    const r = await run('secret-tool', ['store', '--label', 'VVPost: chave do cofre local', 'service', SERVICE, 'account', ACCOUNT], key.toString('base64'))
    if (r.code !== 0) throw new Unavailable(r.stderr.trim() || 'secret-tool store falhou')
  }
}

const powershell = (script: string, input: string) =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Security; ${script}`], input)

function dpapi(dir: string): Backend {
  const file = join(dir, 'vault.key.dpapi')
  return {
    kind: 'windows-dpapi',
    async get() {
      const blob = await readFile(file, 'utf8').catch(() => null)
      if (blob === null) return null
      const r = await powershell(
        "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))",
        blob
      )
      if (r.code !== 0) throw new Error(`A chave do cofre não abriu com o DPAPI deste usuário: ${r.stderr.trim()}`)
      return decode(r.stdout)
    },
    async set(key) {
      const r = await powershell(
        "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))",
        key.toString('base64')
      )
      if (r.code !== 0) throw new Unavailable(r.stderr.trim())
      await writeAtomic(file, `${r.stdout.trim()}\n`)
    }
  }
}

function keyFile(dir: string): Backend {
  const file = join(dir, 'vault.key')
  return {
    kind: 'file',
    async get() {
      const text = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null
        throw err
      })
      return text === null ? null : decode(text)
    },
    async set(key) {
      await writeAtomic(file, `${key.toString('base64')}\n`)
    },
    async remove() {
      await rm(file, { force: true })
    }
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, text, { mode: 0o600 })
  await chmod(tmp, 0o600).catch(() => undefined)
  await rename(tmp, file)
}

export const keyId = (key: Buffer) => createHash('sha256').update('vvpost-vault').update(key).digest('hex').slice(0, 16)

function backendFor(dir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Backend {
  const forced = env['VVPOST_VAULT_KEYSTORE']
  if (forced === 'file') return keyFile(dir)
  if (platform === 'darwin') return macos
  if (platform === 'win32') return dpapi(dir)
  return libsecret
}

/**
 * A chave guardada, ou uma nova guardada agora. Duas criações ao mesmo tempo ficam com a que foi
 * gravada. Uma chave em arquivo de quando o cofre do sistema não estava disponível (uma sessão
 * SSH, antes de instalar a libsecret) passa para o cofre do sistema, em vez de nascer outra.
 */
async function getOrCreate(backend: Backend, fromFile?: Backend): Promise<Buffer> {
  const found = await backend.get()
  if (found) return found
  const adopted = fromFile ? await fromFile.get().catch(() => null) : null
  await backend.set(adopted ?? randomBytes(32))
  const stored = await backend.get()
  if (!stored) throw new Unavailable('a chave gravada não voltou na leitura')
  // Adotada pelo cofre do sistema, a cópia em arquivo não fica para trás.
  if (adopted && stored.equals(adopted)) await fromFile?.remove?.()
  return stored
}

async function load(dir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<VaultKey> {
  const given = env['VVPOST_VAULT_KEY']
  if (given) {
    const key = decode(given)
    if (!key) throw new Error('VVPOST_VAULT_KEY precisa ser 32 bytes em base64.')
    return { key, kind: 'env', id: keyId(key) }
  }
  const backend = backendFor(dir, env, platform)
  try {
    const key = await getOrCreate(backend, backend.kind === 'file' ? undefined : keyFile(dir))
    return { key, kind: backend.kind, id: keyId(key) }
  } catch (err) {
    if (!(err instanceof Unavailable) || backend.kind === 'file') throw err
    const file = keyFile(dir)
    const key = await getOrCreate(file)
    return { key, kind: 'file', id: keyId(key) }
  }
}

const cache = new Map<string, Promise<VaultKey>>()

/** A chave do cofre deste usuário, lida uma vez por processo (e por pasta do cofre). */
export function vaultKey(dir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<VaultKey> {
  const cacheKey = `${dir}\0${env['VVPOST_VAULT_KEY'] ?? ''}\0${env['VVPOST_VAULT_KEYSTORE'] ?? ''}`
  let p = cache.get(cacheKey)
  if (!p) {
    p = load(dir, env, platform)
    p.catch(() => cache.delete(cacheKey))
    cache.set(cacheKey, p)
  }
  return p
}

/** Para testes: esquece as chaves lidas. */
export function clearVaultKeyCache(): void {
  cache.clear()
}
