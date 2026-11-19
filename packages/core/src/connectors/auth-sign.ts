import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { HttpHeader } from '../types'

/**
 * Assinaturas e desafios das auths que dependem da requisição final (spec, fase 15): AWS SigV4
 * e OAuth 1.0 assinam método, URL e corpo; Digest e NTLM respondem ao 401 do servidor. Tudo
 * puro (sem rede), para os vetores de teste das RFCs e da AWS rodarem direto.
 */
export interface SignableRequest {
  method: string
  /** URL final, com a query da auth já aplicada. */
  url: string
  headers: HttpHeader[]
  body?: string | Buffer
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const hmac = (alg: string, key: string | Buffer, data: string | Buffer) => createHmac(alg, key).update(data).digest()
const header = (headers: HttpHeader[], name: string) => headers.find((h) => h.name.trim().toLowerCase() === name)?.value

/** Percent-encoding da RFC 3986 (tudo menos A-Z a-z 0-9 - _ . ~), usado por SigV4 e OAuth 1.0. */
export function rfc3986(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** Pares da query como foram escritos (sem o + virar espaço, que o URLSearchParams faria). */
function queryPairs(search: string): [string, string][] {
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  return search
    .replace(/^\?/, '')
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf('=')
      return i < 0 ? [decode(part), ''] : [decode(part.slice(0, i)), decode(part.slice(i + 1))]
    })
}

// ---------------------------------------------------------------- AWS SigV4

export interface SigV4Credentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
  service: string
}

/**
 * Assinatura AWS Signature Version 4 no header Authorization. Assina host, content-type e os
 * x-amz-*; o S3 ganha x-amz-content-sha256 (exigido por ele) e caminho codificado uma vez só.
 */
export function signSigV4(req: SignableRequest, creds: SigV4Credentials, now = new Date()): HttpHeader[] {
  const url = new URL(req.url)
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const s3 = creds.service === 's3'
  const payloadHash = sha256(req.body ?? '')

  const added: HttpHeader[] = [{ name: 'X-Amz-Date', value: amzDate }]
  if (s3) added.push({ name: 'X-Amz-Content-Sha256', value: payloadHash })
  if (creds.sessionToken) added.push({ name: 'X-Amz-Security-Token', value: creds.sessionToken })

  const signed = new Map<string, string>([['host', url.host]])
  for (const h of [...req.headers, ...added]) {
    const name = h.name.trim().toLowerCase()
    if (name === 'content-type' || (name.startsWith('x-amz-') && name !== 'x-amz-client-context')) {
      const value = h.value.trim().replace(/\s+/g, ' ')
      signed.set(name, signed.has(name) && name !== 'host' ? `${signed.get(name)},${value}` : value)
    }
  }
  const names = [...signed.keys()].sort()
  const segments = url.pathname.split('/').map((seg) => {
    const once = rfc3986(decodeSafe(seg))
    return s3 ? once : rfc3986(once)
  })
  const canonicalQuery = queryPairs(url.search)
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonical = [
    req.method.toUpperCase(),
    segments.join('/') || '/',
    canonicalQuery,
    names.map((n) => `${n}:${signed.get(n)}\n`).join(''),
    names.join(';'),
    payloadHash
  ].join('\n')
  const scope = `${day}/${creds.region}/${creds.service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  let key = hmac('sha256', `AWS4${creds.secretAccessKey}`, day)
  for (const part of [creds.region, creds.service, 'aws4_request']) key = hmac('sha256', key, part)
  const signature = hmac('sha256', key, toSign).toString('hex')
  return [
    ...added,
    {
      name: 'Authorization',
      value: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`
    }
  ]
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

// ---------------------------------------------------------------- OAuth 1.0

export interface OAuth1Credentials {
  consumerKey: string
  consumerSecret: string
  token?: string
  tokenSecret?: string
  signatureMethod?: 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT'
  realm?: string
}

/**
 * Assinatura OAuth 1.0 (RFC 5849) no header Authorization. Entram na base os parâmetros da
 * query e, num corpo application/x-www-form-urlencoded, os do corpo.
 */
export function signOAuth1(
  req: SignableRequest,
  creds: OAuth1Credentials,
  {
    nonce = randomBytes(16).toString('hex'),
    timestamp = Math.floor(Date.now() / 1000),
    version = true
  }: { nonce?: string; timestamp?: number; /** oauth_version é opcional na RFC (o exemplo dela não manda). */ version?: boolean } = {}
): HttpHeader[] {
  const method = creds.signatureMethod ?? 'HMAC-SHA1'
  const oauth: [string, string][] = [
    ['oauth_consumer_key', creds.consumerKey],
    ['oauth_nonce', nonce],
    ['oauth_signature_method', method],
    ['oauth_timestamp', String(timestamp)],
    ...(creds.token ? ([['oauth_token', creds.token]] as [string, string][]) : []),
    ...(version ? ([['oauth_version', '1.0']] as [string, string][]) : [])
  ]
  const key = `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.tokenSecret ?? '')}`
  let signature: string
  if (method === 'PLAINTEXT') {
    signature = key
  } else {
    const url = new URL(req.url)
    const params = [...queryPairs(url.search), ...oauth]
    const type = header(req.headers, 'content-type') ?? ''
    if (req.body !== undefined && /^application\/x-www-form-urlencoded/i.test(type)) {
      params.push(...queryPairs(req.body.toString().replace(/\+/g, '%20')))
    }
    const normalized = params
      .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
      .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&')
    const defaultPort = (url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')
    const base = `${url.protocol}//${url.hostname.toLowerCase()}${url.port && !defaultPort ? `:${url.port}` : ''}${url.pathname}`
    const text = [req.method.toUpperCase(), rfc3986(base), rfc3986(normalized)].join('&')
    signature = hmac(method === 'HMAC-SHA256' ? 'sha256' : 'sha1', key, text).toString('base64')
  }
  const fields = [...(creds.realm !== undefined ? [['realm', creds.realm]] : []), ...oauth, ['oauth_signature', signature]]
  return [{ name: 'Authorization', value: `OAuth ${fields.map(([k, v]) => `${k}="${rfc3986(v!)}"`).join(', ')}` }]
}

// ---------------------------------------------------------------- Digest

/** Parâmetros de um desafio (`Digest realm="x", nonce="y"`), com aspas e vírgulas dentro de aspas. */
export function parseChallenge(text: string): { scheme: string; params: Record<string, string> } {
  const m = /^\s*([A-Za-z0-9_-]+)\s*/.exec(text)
  const scheme = m?.[1] ?? ''
  const params: Record<string, string> = {}
  const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g
  for (const p of text.slice(m?.[0].length ?? 0).matchAll(re)) {
    params[p[1]!.toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : (p[3] ?? '')
  }
  return { scheme, params }
}

/** Os desafios de um WWW-Authenticate do esquema pedido (o servidor pode mandar vários headers). */
export function challengesOf(headers: HttpHeader[], scheme: string): string[] {
  return headers
    .filter((h) => h.name.toLowerCase() === 'www-authenticate')
    .map((h) => h.value.trim())
    .filter((v) => v.toLowerCase() === scheme.toLowerCase() || v.toLowerCase().startsWith(`${scheme.toLowerCase()} `))
}

const DIGEST_HASH: Record<string, string> = { 'MD5': 'md5', 'SHA-256': 'sha256', 'SHA-512-256': 'sha512-256' }

/**
 * Resposta Digest (RFC 7616, compatível com a 2617) para um desafio. Entre vários, fica o de
 * algoritmo mais forte que o Node calcula; qop auth-int não é suportado (só auth).
 */
export function digestAuthorization(
  challenges: string[],
  req: { method: string; url: string },
  creds: { username: string; password: string },
  cnonce = randomBytes(8).toString('hex'),
  nc = 1
): string | null {
  const parsed = challenges
    .map((c) => parseChallenge(c).params)
    .filter((p) => p['nonce'] && DIGEST_HASH[(p['algorithm'] ?? 'MD5').replace(/-sess$/i, '').toUpperCase()])
  const rank = (p: Record<string, string>) => ((p['algorithm'] ?? 'MD5').toUpperCase().startsWith('SHA-256') ? 1 : 0)
  const params = parsed.sort((a, b) => rank(b) - rank(a))[0]
  if (!params) return null
  const algorithm = params['algorithm'] ?? 'MD5'
  const alg = DIGEST_HASH[algorithm.replace(/-sess$/i, '').toUpperCase()]!
  const H = (text: string) => createHash(alg).update(text, 'utf8').digest('hex')
  const url = new URL(req.url)
  const uri = `${url.pathname}${url.search}`
  const realm = params['realm'] ?? ''
  const nonce = params['nonce']!
  const qops = (params['qop'] ?? '').split(',').map((q) => q.trim().toLowerCase())
  const qop = qops.includes('auth') ? 'auth' : undefined
  if (params['qop'] && !qop) return null
  let ha1 = H(`${creds.username}:${realm}:${creds.password}`)
  if (/-sess$/i.test(algorithm)) ha1 = H(`${ha1}:${nonce}:${cnonce}`)
  const ha2 = H(`${req.method.toUpperCase()}:${uri}`)
  const count = nc.toString(16).padStart(8, '0')
  const response = qop ? H(`${ha1}:${nonce}:${count}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${nonce}:${ha2}`)
  const q = (v: string) => `"${v.replace(/(["\\])/g, '\\$1')}"`
  const parts = [`username=${q(creds.username)}`, `realm=${q(realm)}`, `nonce=${q(nonce)}`, `uri=${q(uri)}`]
  if (params['algorithm']) parts.push(`algorithm=${algorithm}`)
  parts.push(`response=${q(response)}`)
  if (params['opaque'] !== undefined) parts.push(`opaque=${q(params['opaque'])}`)
  if (qop) parts.push(`qop=${qop}`, `nc=${count}`, `cnonce=${q(cnonce)}`)
  return `Digest ${parts.join(', ')}`
}

// ---------------------------------------------------------------- NTLM

const NTLM_SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1')
// UNICODE | OEM | REQUEST_TARGET | NTLM | ALWAYS_SIGN | EXTENDED_SESSIONSECURITY | TARGET_INFO | 128 | 56
const NTLM_FLAGS = 0x1 | 0x2 | 0x4 | 0x200 | 0x8000 | 0x80000 | 0x800000 | 0x20000000 | 0x80000000

/** Mensagem 1 (negotiate) do NTLM, em base64 para `Authorization: NTLM ...`. */
export function ntlmNegotiate(): string {
  const msg = Buffer.alloc(32)
  NTLM_SIGNATURE.copy(msg, 0)
  msg.writeUInt32LE(1, 8)
  msg.writeUInt32LE(NTLM_FLAGS >>> 0, 12)
  return msg.toString('base64')
}

export interface NtlmChallenge {
  flags: number
  serverChallenge: Buffer
  targetInfo: Buffer
}

/** Lê a mensagem 2 (challenge) que o servidor mandou no WWW-Authenticate. */
export function parseNtlmChallenge(base64: string): NtlmChallenge | null {
  const msg = Buffer.from(base64, 'base64')
  if (msg.length < 32 || !msg.subarray(0, 8).equals(NTLM_SIGNATURE) || msg.readUInt32LE(8) !== 2) return null
  const flags = msg.readUInt32LE(20)
  const serverChallenge = Buffer.from(msg.subarray(24, 32))
  let targetInfo = Buffer.alloc(0)
  if (msg.length >= 48) {
    const len = msg.readUInt16LE(40)
    const offset = msg.readUInt32LE(44)
    if (offset + len <= msg.length) targetInfo = Buffer.from(msg.subarray(offset, offset + len))
  }
  return { flags, serverChallenge, targetInfo }
}

/** NTOWFv2 (MS-NLMP 3.3.2): HMAC-MD5 do hash NT sobre usuário em maiúsculas + domínio. */
export function ntowfv2(username: string, password: string, domain: string): Buffer {
  const ntHash = md4(Buffer.from(password, 'utf16le'))
  return hmac('md5', ntHash, Buffer.from(username.toUpperCase() + domain, 'utf16le'))
}

/** Valor do timestamp (MsvAvTimestamp, id 7) da target info, se o servidor mandou. */
function avTimestamp(info: Buffer): Buffer | undefined {
  for (let i = 0; i + 4 <= info.length; ) {
    const id = info.readUInt16LE(i)
    const len = info.readUInt16LE(i + 2)
    if (id === 0) return undefined
    if (id === 7 && len === 8) return Buffer.from(info.subarray(i + 4, i + 12))
    i += 4 + len
  }
  return undefined
}

/** Respostas NTLMv2 (MS-NLMP 3.3.2) para o desafio; separado para o vetor de teste da especificação. */
export function ntlmv2Responses(
  challenge: NtlmChallenge,
  creds: { username: string; password: string; domain?: string },
  clientChallenge: Buffer = randomBytes(8),
  time?: Buffer
): { nt: Buffer; lm: Buffer } {
  const key = ntowfv2(creds.username, creds.password, creds.domain ?? '')
  const serverTime = avTimestamp(challenge.targetInfo)
  const stamp = time ?? serverTime ?? filetime(Date.now())
  const blob = Buffer.concat([
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]),
    stamp,
    clientChallenge,
    Buffer.alloc(4),
    challenge.targetInfo,
    Buffer.alloc(4)
  ])
  const proof = hmac('md5', key, Buffer.concat([challenge.serverChallenge, blob]))
  // Com timestamp do servidor, a resposta LM vai zerada (MS-NLMP 3.1.5.1.2).
  const lm = serverTime
    ? Buffer.alloc(24)
    : Buffer.concat([hmac('md5', key, Buffer.concat([challenge.serverChallenge, clientChallenge])), clientChallenge])
  return { nt: Buffer.concat([proof, blob]), lm }
}

/** Mensagem 3 (authenticate) do NTLM, em base64. */
export function ntlmAuthenticate(
  challenge: NtlmChallenge,
  creds: { username: string; password: string; domain?: string; workstation?: string }
): string {
  const { nt, lm } = ntlmv2Responses(challenge, creds)
  const unicode = (challenge.flags & 0x1) !== 0
  const text = (s: string) => Buffer.from(s, unicode ? 'utf16le' : 'latin1')
  const fields = [lm, nt, text(creds.domain ?? ''), text(creds.username), text(creds.workstation ?? ''), Buffer.alloc(0)]
  const head = Buffer.alloc(64)
  NTLM_SIGNATURE.copy(head, 0)
  head.writeUInt32LE(3, 8)
  let offset = 64
  fields.forEach((field, i) => {
    const at = 12 + i * 8
    head.writeUInt16LE(field.length, at)
    head.writeUInt16LE(field.length, at + 2)
    head.writeUInt32LE(offset, at + 4)
    offset += field.length
  })
  head.writeUInt32LE((challenge.flags & NTLM_FLAGS) >>> 0, 60)
  return Buffer.concat([head, ...fields]).toString('base64')
}

function filetime(ms: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE((BigInt(ms) + 11644473600000n) * 10000n)
  return buf
}

/**
 * MD4 (RFC 1320) em JS: o hash NT do NTLM depende dele, e o OpenSSL 3 do Node só o tem no
 * provider legado (que o Electron não carrega).
 */
export function md4(input: Buffer): Buffer {
  const len = input.length
  const padded = Buffer.alloc(((len + 8) >> 6) * 64 + 64)
  input.copy(padded)
  padded[len] = 0x80
  padded.writeUInt32LE((len * 8) >>> 0, padded.length - 8)
  padded.writeUInt32LE(Math.floor((len * 8) / 0x100000000), padded.length - 4)
  let a = 0x67452301
  let b = 0xefcdab89
  let c = 0x98badcfe
  let d = 0x10325476
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n))
  const x = new Array<number>(16)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) x[i] = padded.readUInt32LE(off + i * 4)
    const [aa, bb, cc, dd] = [a, b, c, d]
    const F = (p: number, q: number, r: number) => (p & q) | (~p & r)
    const G = (p: number, q: number, r: number) => (p & q) | (p & r) | (q & r)
    const H = (p: number, q: number, r: number) => p ^ q ^ r
    for (const i of [0, 4, 8, 12]) {
      a = rotl((a + F(b, c, d) + x[i]!) | 0, 3)
      d = rotl((d + F(a, b, c) + x[i + 1]!) | 0, 7)
      c = rotl((c + F(d, a, b) + x[i + 2]!) | 0, 11)
      b = rotl((b + F(c, d, a) + x[i + 3]!) | 0, 19)
    }
    for (const i of [0, 1, 2, 3]) {
      a = rotl((a + G(b, c, d) + x[i]! + 0x5a827999) | 0, 3)
      d = rotl((d + G(a, b, c) + x[i + 4]! + 0x5a827999) | 0, 5)
      c = rotl((c + G(d, a, b) + x[i + 8]! + 0x5a827999) | 0, 9)
      b = rotl((b + G(c, d, a) + x[i + 12]! + 0x5a827999) | 0, 13)
    }
    for (const i of [0, 2, 1, 3]) {
      a = rotl((a + H(b, c, d) + x[i]! + 0x6ed9eba1) | 0, 3)
      d = rotl((d + H(a, b, c) + x[i + 8]! + 0x6ed9eba1) | 0, 9)
      c = rotl((c + H(d, a, b) + x[i + 4]! + 0x6ed9eba1) | 0, 11)
      b = rotl((b + H(c, d, a) + x[i + 12]! + 0x6ed9eba1) | 0, 15)
    }
    a = (a + aa) | 0
    b = (b + bb) | 0
    c = (c + cc) | 0
    d = (d + dd) | 0
  }
  const out = Buffer.alloc(16)
  out.writeInt32LE(a, 0)
  out.writeInt32LE(b, 4)
  out.writeInt32LE(c, 8)
  out.writeInt32LE(d, 12)
  return out
}
