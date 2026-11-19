import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage, session } from 'electron'
import type { HttpSettings, HttpSettingsInput, CookieEntry, CookieInput } from '@shared/ipc'
import type { HttpClientConfig } from '@vvpost/core/http/dispatcher'
import { CookieJar, type StoredCookie } from '@vvpost/core/http/cookies'

/**
 * Configurações do cliente HTTP do app (spec, fase 12): proxy, verificação TLS, CAs extras e o
 * cookie jar, em userData (nunca no workspace, que vai para o Git). A senha do proxy é cifrada
 * pelo cofre do sistema (safeStorage: DPAPI no Windows, Keychain no macOS, libsecret no Linux);
 * sem cofre disponível ela fica só em memória até o app fechar.
 */

interface StoredSettings {
  proxy: { mode: HttpSettings['proxy']['mode']; url: string; bypass: string; username: string; password?: string }
  verifyTls: boolean
  caFiles: string[]
  cookies: boolean
}

const DEFAULTS: StoredSettings = {
  proxy: { mode: 'system', url: '', bypass: '', username: '' },
  verifyTls: true,
  caFiles: [],
  cookies: true
}
const MODES = new Set(['off', 'env', 'manual', 'system'])

const settingsFile = () => join(app.getPath('userData'), 'http-settings.json')
const cookiesFile = () => join(app.getPath('userData'), 'cookies.json')

let settings: Promise<StoredSettings> | null = null
/** Senha do proxy quando o cofre do sistema não está disponível. */
let memoryPassword: string | undefined
let jar: Promise<CookieJar> | null = null

async function writeAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  await rename(tmp, file)
}

function loadSettings(): Promise<StoredSettings> {
  return (settings ??= readFile(settingsFile(), 'utf8')
    .then((raw) => normalize(JSON.parse(raw) as Partial<StoredSettings>))
    .catch(() => structuredClone(DEFAULTS)))
}

function normalize(raw: Partial<StoredSettings> | null | undefined): StoredSettings {
  const proxy = (raw?.proxy ?? {}) as Partial<StoredSettings['proxy']>
  return {
    proxy: {
      mode: MODES.has(proxy.mode as string) ? proxy.mode! : DEFAULTS.proxy.mode,
      url: typeof proxy.url === 'string' ? proxy.url.trim() : '',
      bypass: typeof proxy.bypass === 'string' ? proxy.bypass : '',
      username: typeof proxy.username === 'string' ? proxy.username : '',
      ...(typeof proxy.password === 'string' && proxy.password && { password: proxy.password })
    },
    verifyTls: raw?.verifyTls !== false,
    caFiles: Array.isArray(raw?.caFiles) ? raw.caFiles.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : [],
    cookies: raw?.cookies !== false
  }
}

function proxyPassword(s: StoredSettings): string | undefined {
  if (!s.proxy.password) return memoryPassword
  try {
    return safeStorage.decryptString(Buffer.from(s.proxy.password, 'base64'))
  } catch {
    return undefined
  }
}

function publicView(s: StoredSettings): HttpSettings {
  const { password: _, ...proxy } = s.proxy
  return {
    proxy: { ...proxy, hasPassword: !!proxyPassword(s) },
    verifyTls: s.verifyTls,
    caFiles: s.caFiles,
    cookies: s.cookies,
    vault: safeStorage.isEncryptionAvailable()
  }
}

export async function getHttpSettings(): Promise<HttpSettings> {
  return publicView(await loadSettings())
}

export async function setHttpSettings(input: unknown): Promise<HttpSettings> {
  const raw = (input ?? {}) as HttpSettingsInput
  const current = await loadSettings()
  const next = normalize({ ...raw, proxy: { ...raw.proxy, password: current.proxy.password } as StoredSettings['proxy'] })
  if (next.proxy.mode === 'manual' && next.proxy.url && !/^(https?|socks5h?|socks4):\/\/[^\s/]+/i.test(next.proxy.url) && !/^[^\s:/]+:\d+$/.test(next.proxy.url)) {
    throw new Error('Proxy: use http://host:porta, https://host:porta ou socks5://host:porta')
  }
  const password = raw.proxy?.password
  if (password === null || password === '') {
    delete next.proxy.password
    memoryPassword = undefined
  } else if (typeof password === 'string') {
    if (safeStorage.isEncryptionAvailable()) {
      next.proxy.password = safeStorage.encryptString(password).toString('base64')
      memoryPassword = undefined
    } else {
      delete next.proxy.password
      memoryPassword = password
    }
  }
  for (const file of next.caFiles) {
    const pem = await readFile(file, 'utf8').catch(() => null)
    if (pem === null) throw new Error(`CA: não foi possível ler ${file}`)
    if (!pem.includes('-----BEGIN CERTIFICATE-----')) throw new Error(`CA: ${file} não é um certificado PEM`)
  }
  await writeAtomic(settingsFile(), next)
  settings = Promise.resolve(next)
  return publicView(next)
}

/** Proxy do sistema pelo resolvedor do Chromium (PAC, WPAD, configurações do SO), com cache curto por origem. */
const systemCache = new Map<string, { at: number; value: string | null }>()
async function resolveSystem(url: string): Promise<string | null> {
  const origin = new URL(url).origin
  const hit = systemCache.get(origin)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  let value: string | null = null
  try {
    const rule = (await session.defaultSession.resolveProxy(url)).split(';')[0]!.trim()
    const [kind, hostPort] = rule.split(/\s+/)
    if (hostPort && kind !== 'DIRECT') {
      const scheme = kind === 'HTTPS' ? 'https' : kind === 'SOCKS' || kind === 'SOCKS4' ? 'socks4' : kind === 'SOCKS5' ? 'socks5' : 'http'
      value = `${scheme}://${hostPort}`
    }
  } catch {
    value = null
  }
  systemCache.set(origin, { at: Date.now(), value })
  return value
}

export function getCookieJar(): Promise<CookieJar> {
  return (jar ??= readFile(cookiesFile(), 'utf8')
    .then((raw) => JSON.parse(raw) as StoredCookie[])
    .catch(() => [] as StoredCookie[])
    .then((stored) => {
      const loaded = new CookieJar(Array.isArray(stored) ? stored : [])
      let timer: NodeJS.Timeout | null = null
      loaded.onChange(() => {
        if (timer) return
        timer = setTimeout(() => {
          timer = null
          // Cookies de sessão (sem Expires/Max-Age) não passam de uma execução do app, como num navegador.
          void writeAtomic(cookiesFile(), loaded.toJSON().filter((c) => c.expires !== undefined)).catch((err) =>
            console.error('Falha ao gravar cookies:', err)
          )
        }, 500)
      })
      return loaded
    }))
}

/** A configuração do dispatcher a partir das configurações salvas. */
export async function httpClientConfig(): Promise<HttpClientConfig> {
  const s = await loadSettings()
  const ca: string[] = []
  for (const file of s.caFiles) {
    const pem = await readFile(file, 'utf8').catch(() => null)
    if (pem) ca.push(pem)
    else console.error(`CA extra não encontrada: ${file}`)
  }
  const password = proxyPassword(s)
  return {
    proxy: {
      mode: s.proxy.mode,
      ...(s.proxy.url && { url: s.proxy.url }),
      ...(s.proxy.bypass && { bypass: s.proxy.bypass }),
      ...(s.proxy.username && { username: s.proxy.username }),
      ...(password && { password }),
      resolveSystem
    },
    verifyTls: s.verifyTls,
    ...(ca.length && { ca }),
    cookies: s.cookies ? await getCookieJar() : null
  }
}

const toEntry = (c: StoredCookie): CookieEntry => ({ ...c })

export async function listCookies(): Promise<CookieEntry[]> {
  return (await getCookieJar()).list().map(toEntry)
}

export async function setCookie(input: unknown): Promise<CookieEntry[]> {
  const c = (input ?? {}) as CookieInput
  const j = await getCookieJar()
  j.set({
    name: String(c.name ?? '').trim(),
    value: String(c.value ?? ''),
    domain: String(c.domain ?? '').trim(),
    path: String(c.path || '/'),
    hostOnly: c.hostOnly === true,
    secure: c.secure === true,
    httpOnly: c.httpOnly === true,
    ...(typeof c.expires === 'number' && { expires: c.expires })
  })
  return j.list().map(toEntry)
}

export async function deleteCookies(filter: unknown): Promise<CookieEntry[]> {
  const f = (filter ?? {}) as { domain?: unknown; name?: unknown; path?: unknown }
  const j = await getCookieJar()
  j.delete({
    ...(typeof f.domain === 'string' && { domain: f.domain }),
    ...(typeof f.name === 'string' && { name: f.name }),
    ...(typeof f.path === 'string' && { path: f.path })
  })
  return j.list().map(toEntry)
}
