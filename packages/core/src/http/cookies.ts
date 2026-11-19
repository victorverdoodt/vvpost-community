/**
 * Cookie jar do cliente HTTP (RFC 6265, o subconjunto que um cliente de API precisa): guarda os
 * Set-Cookie recebidos por domínio e caminho e devolve o header Cookie de cada requisição. Fica
 * em memória; quem quer persistir (o app, em userData) lê `toJSON` depois de `onChange`. Nunca
 * vai para o workspace: valores de cookie são credenciais.
 */

export interface StoredCookie {
  name: string
  value: string
  /** Sem ponto na frente. */
  domain: string
  /** true: só o host exato (Set-Cookie sem Domain). */
  hostOnly: boolean
  path: string
  /** Epoch em ms; ausente: cookie de sessão (some ao fechar o app, se a persistência respeitar). */
  expires?: number
  secure: boolean
  httpOnly: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  /** Epoch em ms da criação, para a ordem do header. */
  created: number
}

/** Cookie para a tela: tudo menos o valor inteiro (o app mostra e edita pelo IPC). */
export type CookieInfo = StoredCookie

const MAX_COOKIES = 3000
const MAX_PER_DOMAIN = 180

export class CookieJar {
  private cookies: StoredCookie[] = []
  private listeners = new Set<() => void>()

  constructor(
    initial: StoredCookie[] = [],
    private readonly now: () => number = Date.now
  ) {
    this.cookies = initial.filter(isStoredCookie)
    this.purge()
  }

  /** Header Cookie para a URL (vazio: nenhum). Ordem: caminho mais longo primeiro, depois o mais antigo. */
  cookieHeader(url: URL): string {
    this.purge()
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const secure = url.protocol === 'https:' || isLoopback(host)
    return this.cookies
      .filter((c) => domainMatches(c, host) && pathMatches(url.pathname || '/', c.path) && (!c.secure || secure))
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ')
  }

  /** Guarda os Set-Cookie de uma resposta de `url`. Devolve quantos mudaram. */
  store(url: URL, setCookies: readonly string[]): number {
    let changed = 0
    for (const header of setCookies) {
      const parsed = parseSetCookie(header, url, this.now())
      if (!parsed) continue
      const i = this.cookies.findIndex((c) => c.name === parsed.name && c.domain === parsed.domain && c.path === parsed.path)
      if (i >= 0) parsed.created = this.cookies[i]!.created
      if (parsed.expires !== undefined && parsed.expires <= this.now()) {
        if (i >= 0) {
          this.cookies.splice(i, 1)
          changed++
        }
        continue
      }
      if (i >= 0) this.cookies[i] = parsed
      else this.cookies.push(parsed)
      changed++
    }
    if (changed) {
      this.enforceLimits()
      this.emit()
    }
    return changed
  }

  list(): StoredCookie[] {
    this.purge()
    return [...this.cookies].sort((a, b) => a.domain.localeCompare(b.domain) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name))
  }

  /** Cria ou troca um cookie pela tela (mesmo nome, domínio e caminho substitui). */
  set(cookie: Omit<StoredCookie, 'created'> & { created?: number }): void {
    const c: StoredCookie = { ...cookie, domain: cookie.domain.toLowerCase().replace(/^\./, ''), created: cookie.created ?? this.now() }
    if (!isStoredCookie(c)) throw new Error('cookie inválido')
    const i = this.cookies.findIndex((x) => x.name === c.name && x.domain === c.domain && x.path === c.path)
    if (i >= 0) this.cookies[i] = { ...c, created: this.cookies[i]!.created }
    else this.cookies.push(c)
    this.enforceLimits()
    this.emit()
  }

  /** Apaga por nome, domínio e caminho; sem nome, todos do domínio; sem nada, todos. */
  delete(filter: { domain?: string; name?: string; path?: string } = {}): number {
    const before = this.cookies.length
    const domain = filter.domain?.toLowerCase().replace(/^\./, '')
    this.cookies = this.cookies.filter(
      (c) => !((domain === undefined || c.domain === domain) && (filter.name === undefined || c.name === filter.name) && (filter.path === undefined || c.path === filter.path))
    )
    const removed = before - this.cookies.length
    if (removed) this.emit()
    return removed
  }

  /** Para persistir: só os que ainda valem. */
  toJSON(): StoredCookie[] {
    this.purge()
    return this.cookies.map((c) => ({ ...c }))
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }

  private purge(): void {
    const now = this.now()
    const before = this.cookies.length
    this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now)
    if (this.cookies.length !== before) this.emit()
  }

  private enforceLimits(): void {
    const byDomain = new Map<string, StoredCookie[]>()
    for (const c of this.cookies) byDomain.set(c.domain, [...(byDomain.get(c.domain) ?? []), c])
    const drop = new Set<StoredCookie>()
    for (const list of byDomain.values()) {
      if (list.length > MAX_PER_DOMAIN) for (const c of list.sort((a, b) => a.created - b.created).slice(0, list.length - MAX_PER_DOMAIN)) drop.add(c)
    }
    this.cookies = this.cookies.filter((c) => !drop.has(c))
    if (this.cookies.length > MAX_COOKIES) this.cookies = this.cookies.sort((a, b) => a.created - b.created).slice(-MAX_COOKIES)
  }
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host)
}

function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

function domainMatches(c: StoredCookie, host: string): boolean {
  if (c.hostOnly) return host === c.domain
  return host === c.domain || (host.endsWith(`.${c.domain}`) && !isIp(host))
}

/** RFC 6265 5.1.4. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'
}

function defaultPath(url: URL): string {
  const path = url.pathname || '/'
  if (!path.startsWith('/') || path === '/') return '/'
  const last = path.lastIndexOf('/')
  return last <= 0 ? '/' : path.slice(0, last)
}

/** Sufixos públicos óbvios em que um Domain= não é aceito (sem a lista pública inteira). */
const PUBLIC_SUFFIX = /^(com|net|org|gov|edu|io|dev|app|br|com\.br|net\.br|org\.br|gov\.br|co\.uk|localhost)$/

export function parseSetCookie(header: string, url: URL, now: number): StoredCookie | null {
  const [pair = '', ...attrs] = header.split(';')
  const eq = pair.indexOf('=')
  if (eq < 0) return null
  const name = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1')
  if (!name || /[\s,;=]/.test(name)) return null

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  let domain = host
  let hostOnly = true
  let path = defaultPath(url)
  let expires: number | undefined
  let maxAge: number | undefined
  let secure = false
  let httpOnly = false
  let sameSite: StoredCookie['sameSite']

  for (const attr of attrs) {
    const i = attr.indexOf('=')
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase()
    const val = i < 0 ? '' : attr.slice(i + 1).trim()
    switch (key) {
      case 'domain': {
        const d = val.toLowerCase().replace(/^\./, '')
        if (!d) break
        if (PUBLIC_SUFFIX.test(d) && d !== host) return null
        if (host !== d && !(host.endsWith(`.${d}`) && !isIp(host))) return null
        domain = d
        hostOnly = false
        break
      }
      case 'path':
        if (val.startsWith('/')) path = val
        break
      case 'expires': {
        const t = Date.parse(val)
        if (!Number.isNaN(t)) expires = t
        break
      }
      case 'max-age':
        if (/^-?\d+$/.test(val)) maxAge = Number(val)
        break
      case 'secure':
        secure = true
        break
      case 'httponly':
        httpOnly = true
        break
      case 'samesite': {
        const s = val.toLowerCase()
        sameSite = s === 'strict' ? 'Strict' : s === 'lax' ? 'Lax' : s === 'none' ? 'None' : undefined
        break
      }
    }
  }
  if (secure && url.protocol !== 'https:' && !isLoopback(host)) return null
  if (maxAge !== undefined) expires = maxAge <= 0 ? 0 : now + maxAge * 1000
  return {
    name,
    value,
    domain,
    hostOnly,
    path,
    ...(expires !== undefined && { expires }),
    secure,
    httpOnly,
    ...(sameSite && { sameSite }),
    created: now
  }
}

function isStoredCookie(c: unknown): c is StoredCookie {
  const x = c as StoredCookie
  return (
    !!x &&
    typeof x.name === 'string' &&
    x.name.length > 0 &&
    !/[\s,;=]/.test(x.name) &&
    typeof x.value === 'string' &&
    !/[;\r\n]/.test(x.value) &&
    typeof x.domain === 'string' &&
    x.domain.length > 0 &&
    typeof x.path === 'string' &&
    x.path.startsWith('/') &&
    typeof x.hostOnly === 'boolean' &&
    typeof x.secure === 'boolean' &&
    typeof x.httpOnly === 'boolean' &&
    typeof x.created === 'number' &&
    (x.expires === undefined || typeof x.expires === 'number')
  )
}
