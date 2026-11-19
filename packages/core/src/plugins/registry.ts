import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

/**
 * Registro de plugins: um JSON estático (vvpost-registry.json) servido por HTTPS, com os
 * plugins, as versões e, para cada versão, a URL do pacote (.zip/.tgz), o SHA-256 dele e,
 * opcionalmente, a chave pública que precisa ter assinado o plugin. O app baixa o índice e o
 * pacote, confere o hash e segue pela mesma prévia da instalação de arquivo.
 */

export interface RegistryVersion {
  version: string
  /** URL do pacote, absoluta ou relativa ao índice. */
  url: string
  /** SHA-256 do pacote em hex. */
  sha256: string
  /** Chave pública Ed25519 (base64) que tem de ter assinado esta versão. */
  publicKey?: string
}

export interface RegistryPlugin {
  id: string
  name: string
  description?: string
  author?: string
  homepage?: string
  /** Chave pública padrão das versões deste plugin. */
  publicKey?: string
  versions: RegistryVersion[]
}

export interface RegistryIndex {
  version: 1
  name: string
  plugins: RegistryPlugin[]
}

export type Fetcher = (url: string, options: { maxBytes: number; signal?: AbortSignal }) => Promise<Buffer>

export class RegistryError extends Error {}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256 = /^[0-9a-f]{64}$/
const MAX_INDEX_BYTES = 5 * 1024 * 1024

/** HTTPS, ou HTTP só para o próprio computador (um registro local de desenvolvimento). */
export function checkRegistryUrl(text: string): URL {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new RegistryError(`URL inválida: ${text}`)
  }
  if (url.username || url.password) throw new RegistryError('a URL do registro não pode ter usuário e senha')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const local = host === 'localhost' || (isIP(host) === 4 && host.startsWith('127.')) || host === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new RegistryError(`o registro precisa de https:// (http:// só em localhost): ${text}`)
  }
  return url
}

/** Ordem do semver (pré-lançamentos antes da versão final). */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a)
  const pb = SEMVER.exec(b)
  if (!pa || !pb) return a.localeCompare(b)
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d) return d
  }
  if (pa[4] === pb[4]) return 0
  if (pa[4] === undefined) return 1
  if (pb[4] === undefined) return -1
  const xa = pa[4].split('.')
  const xb = pb[4].split('.')
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const x = xa[i]
    const y = xb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y)
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** A versão mais nova que não é pré-lançamento (ou a mais nova, se só houver pré-lançamentos). */
export function latestVersion(plugin: RegistryPlugin): RegistryVersion | undefined {
  const sorted = [...plugin.versions].sort((a, b) => compareVersions(b.version, a.version))
  return sorted.find((v) => !v.version.includes('-')) ?? sorted[0]
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const optionalText = (v: unknown) => v === undefined || typeof v === 'string'
const isKey = (v: unknown) => v === undefined || (typeof v === 'string' && Buffer.from(v, 'base64').length === 32)

/** Valida o índice e resolve as URLs dos pacotes contra a URL dele. */
export function parseRegistryIndex(text: string, indexUrl: string): RegistryIndex {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new RegistryError('o índice do registro não é JSON')
  }
  if (!data || data['version'] !== 1 || !Array.isArray(data['plugins'])) throw new RegistryError('o índice do registro não está no formato 1 ({ "version": 1, "plugins": [...] })')
  const plugins: RegistryPlugin[] = []
  const ids = new Set<string>()
  for (const [i, raw] of (data['plugins'] as unknown[]).entries()) {
    const p = raw as Record<string, unknown>
    const where = `plugins[${i}]`
    if (!p || !isText(p['id']) || !ID.test(p['id'])) throw new RegistryError(`${where}: id inválido`)
    if (ids.has(p['id'])) throw new RegistryError(`${where}: id ${p['id']} repetido`)
    ids.add(p['id'])
    if (!isText(p['name']) || !optionalText(p['description']) || !optionalText(p['author']) || !optionalText(p['homepage'])) throw new RegistryError(`${where}: name, description, author e homepage são textos`)
    if (!isKey(p['publicKey'])) throw new RegistryError(`${where}: publicKey precisa ser uma chave Ed25519 de 32 bytes em base64`)
    if (!Array.isArray(p['versions']) || !p['versions'].length) throw new RegistryError(`${where}: versions vazio`)
    const versions: RegistryVersion[] = []
    for (const [j, rawVersion] of (p['versions'] as unknown[]).entries()) {
      const v = rawVersion as Record<string, unknown>
      const at = `${where}.versions[${j}]`
      if (!v || !isText(v['version']) || !SEMVER.test(v['version'])) throw new RegistryError(`${at}: version não é semver`)
      if (!isText(v['url'])) throw new RegistryError(`${at}: url vazia`)
      if (!isText(v['sha256']) || !SHA256.test(v['sha256'].toLowerCase())) throw new RegistryError(`${at}: sha256 precisa ter 64 hex`)
      if (!isKey(v['publicKey'])) throw new RegistryError(`${at}: publicKey precisa ser uma chave Ed25519 de 32 bytes em base64`)
      let url: string
      try {
        url = new URL(v['url'], indexUrl).toString()
      } catch {
        throw new RegistryError(`${at}: url inválida`)
      }
      checkRegistryUrl(url)
      const publicKey = (v['publicKey'] as string | undefined) ?? (p['publicKey'] as string | undefined)
      versions.push({ version: v['version'], url, sha256: v['sha256'].toLowerCase(), ...(publicKey && { publicKey }) })
    }
    plugins.push({
      id: p['id'],
      name: p['name'],
      ...(isText(p['description']) && { description: p['description'] }),
      ...(isText(p['author']) && { author: p['author'] }),
      ...(isText(p['homepage']) && { homepage: p['homepage'] }),
      ...(isText(p['publicKey']) && { publicKey: p['publicKey'] }),
      versions
    })
  }
  return { version: 1, name: isText(data['name']) ? data['name'] : new URL(indexUrl).host, plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)) }
}

/** Baixa pelo fetch do runtime, sem seguir para fora de HTTPS e com teto de tamanho. */
export const defaultFetcher: Fetcher = async (url, { maxBytes, signal }) => {
  checkRegistryUrl(url)
  let res: Response
  try {
    res = await fetch(url, { redirect: 'follow', ...(signal && { signal }), headers: { accept: 'application/json, application/octet-stream;q=0.9, */*;q=0.1' } })
  } catch (err) {
    throw new RegistryError(`não foi possível baixar ${url}: ${(err as Error).message}`)
  }
  checkRegistryUrl(res.url || url)
  if (!res.ok) throw new RegistryError(`${url} respondeu HTTP ${res.status}`)
  const length = Number(res.headers.get('content-length') ?? 0)
  if (length > maxBytes) throw new RegistryError(`${url} passa de ${Math.round(maxBytes / 1024 / 1024)} MB`)
  const chunks: Buffer[] = []
  let total = 0
  const reader = res.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      throw new RegistryError(`${url} passa de ${Math.round(maxBytes / 1024 / 1024)} MB`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

export async function fetchRegistryIndex(url: string, fetcher: Fetcher = defaultFetcher): Promise<RegistryIndex> {
  checkRegistryUrl(url)
  return parseRegistryIndex((await fetcher(url, { maxBytes: MAX_INDEX_BYTES })).toString('utf8'), url)
}

export const sha256Hex = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
