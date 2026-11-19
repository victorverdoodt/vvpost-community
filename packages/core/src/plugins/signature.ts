import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Assinatura de plugins: `vvpost-plugin.sig.json` na raiz do plugin lista o SHA-256 de cada
 * arquivo e traz uma assinatura Ed25519 sobre essa lista, o id e a versão. Conferir é
 * recalcular os hashes (nenhum arquivo a mais, a menos ou diferente) e checar a assinatura
 * com a chave pública que vem no arquivo; confiar na chave é com o usuário (ou com o
 * registro, que pode fixar a chave de cada plugin).
 */

export const SIGNATURE_FILE = 'vvpost-plugin.sig.json'
/** O que o app grava na pasta instalada (origem e assinatura conferida); fora da assinatura. */
export const INSTALL_RECORD = '.vvpost-install.json'
const CONTEXT = 'vvpost-plugin-signature:v1\n'

export interface SignatureFile {
  version: 1
  algorithm: 'ed25519'
  /** Chave pública Ed25519 crua (32 bytes) em base64. */
  publicKey: string
  plugin: { id: string; version: string }
  /** Caminho relativo com "/" → SHA-256 em hex. */
  files: Record<string, string>
  /** Ed25519 sobre CONTEXT + JSON canônico dos campos acima, em base64. */
  signature: string
}

export type SignatureCheck =
  | { status: 'unsigned' }
  | { status: 'invalid'; reason: string }
  | { status: 'valid'; publicKey: string; fingerprint: string }

/** Impressão digital de uma chave pública: SHA-256 da chave crua, 16 bytes em grupos de 4 hex. */
export function fingerprintOf(publicKey: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32)
  return hex.match(/.{4}/g)!.join(':')
}

function canonical(file: Omit<SignatureFile, 'signature'>): Buffer {
  const files = Object.fromEntries(Object.keys(file.files).sort().map((k) => [k, file.files[k]]))
  return Buffer.from(
    CONTEXT + JSON.stringify({ version: file.version, algorithm: file.algorithm, publicKey: file.publicKey, plugin: { id: file.plugin.id, version: file.plugin.version }, files }),
    'utf8'
  )
}

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function publicKeyObject(raw: string): KeyObject {
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.length !== 32) throw new Error('chave pública Ed25519 precisa ter 32 bytes')
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, bytes]), format: 'der', type: 'spki' })
}

function rawPublicKey(key: KeyObject): string {
  return (key.export({ format: 'der', type: 'spki' }) as Buffer).subarray(SPKI_PREFIX.length).toString('base64')
}

/** Par de chaves novo: a privada em PEM (PKCS#8), a pública crua em base64. */
export function generateSigningKey(): { privateKeyPem: string; publicKey: string; fingerprint: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const raw = rawPublicKey(publicKey)
  return { privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, publicKey: raw, fingerprint: fingerprintOf(raw) }
}

/** Os arquivos do plugin (sem .git e sem o próprio arquivo de assinatura), com "/". */
export async function listPluginFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (path: string, prefix: string): Promise<void> => {
    for (const e of await readdir(path, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) await walk(join(path, e.name), rel)
      else if (e.isFile() && rel !== SIGNATURE_FILE && rel !== INSTALL_RECORD) out.push(rel)
      else if (!e.isFile() && !e.isDirectory()) throw new Error(`${rel}: só arquivos e pastas podem ser assinados`)
    }
  }
  await walk(dir, '')
  return out.sort()
}

async function digests(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const rel of await listPluginFiles(dir)) files[rel] = createHash('sha256').update(await readFile(join(dir, ...rel.split('/')))).digest('hex')
  return files
}

/** Assina a pasta com a chave privada (PEM) e devolve o conteúdo de vvpost-plugin.sig.json. */
export async function signPluginDir(dir: string, privateKeyPem: string, plugin: { id: string; version: string }): Promise<SignatureFile> {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('a chave de assinatura precisa ser Ed25519 (vvpost plugin keygen)')
  const body: Omit<SignatureFile, 'signature'> = {
    version: 1,
    algorithm: 'ed25519',
    publicKey: rawPublicKey(createPublicKey(key)),
    plugin: { id: plugin.id, version: plugin.version },
    files: await digests(dir)
  }
  return { ...body, signature: sign(null, canonical(body), key).toString('base64') }
}

/** Confere a assinatura de uma pasta contra o id e a versão do manifesto. */
export async function verifyPluginDir(dir: string, plugin: { id: string; version: string }): Promise<SignatureCheck> {
  let text: string
  try {
    text = await readFile(join(dir, SIGNATURE_FILE), 'utf8')
  } catch {
    return { status: 'unsigned' }
  }
  let file: SignatureFile
  try {
    file = JSON.parse(text) as SignatureFile
  } catch {
    return { status: 'invalid', reason: `${SIGNATURE_FILE} não é JSON` }
  }
  if (file?.version !== 1 || file.algorithm !== 'ed25519' || typeof file.publicKey !== 'string' || typeof file.signature !== 'string' || !file.files || typeof file.files !== 'object') {
    return { status: 'invalid', reason: `${SIGNATURE_FILE} num formato desconhecido` }
  }
  if (file.plugin?.id !== plugin.id || file.plugin?.version !== plugin.version) {
    return { status: 'invalid', reason: `a assinatura é de ${file.plugin?.id}@${file.plugin?.version}, não de ${plugin.id}@${plugin.version}` }
  }
  let ok: boolean
  try {
    ok = verify(null, canonical(file), publicKeyObject(file.publicKey), Buffer.from(file.signature, 'base64'))
  } catch (err) {
    return { status: 'invalid', reason: `assinatura ilegível (${(err as Error).message})` }
  }
  if (!ok) return { status: 'invalid', reason: 'a assinatura não confere com a chave' }
  const actual = await digests(dir)
  const signed = new Set(Object.keys(file.files))
  for (const [rel, hash] of Object.entries(actual)) {
    if (!signed.has(rel)) return { status: 'invalid', reason: `${rel} não está na assinatura (arquivo acrescentado)` }
    if (file.files[rel] !== hash) return { status: 'invalid', reason: `${rel} mudou depois da assinatura` }
    signed.delete(rel)
  }
  const [missing] = signed
  if (missing !== undefined) return { status: 'invalid', reason: `${missing} está na assinatura mas falta no plugin` }
  return { status: 'valid', publicKey: file.publicKey, fingerprint: fingerprintOf(file.publicKey) }
}
