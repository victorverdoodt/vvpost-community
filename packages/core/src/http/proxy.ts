/**
 * Proxy do cliente HTTP (spec, fase 12). `env` segue o padrão do curl (HTTPS_PROXY, HTTP_PROXY,
 * ALL_PROXY e NO_PROXY, em maiúsculas ou minúsculas); `manual` usa a URL e a lista de exceções
 * das configurações; `system` pergunta ao sistema (o app usa o resolvedor do Chromium, que lê
 * o proxy do Windows, do macOS, do GNOME/KDE e o PAC). Loopback nunca passa pelo proxy.
 */
export interface ProxyConfig {
  mode: 'off' | 'env' | 'manual' | 'system'
  /** manual: http://host:porta, https://..., socks5://... (com usuário e senha na URL, se houver). */
  url?: string
  /** manual: hosts que não usam o proxy, separados por vírgula (como o NO_PROXY). */
  bypass?: string
  /** Usuário e senha do proxy, no lugar dos da URL (a senha vem do cofre do sistema no app). */
  username?: string
  password?: string
  /** system: URL do proxy para a requisição, ou null para conexão direta. */
  resolveSystem?: (url: string) => Promise<string | null>
  /** env: as variáveis (padrão: process.env). */
  env?: Readonly<Record<string, string | undefined>>
}

export async function proxyFor(url: URL, config: ProxyConfig | undefined): Promise<string | null> {
  if (!config || config.mode === 'off') return null
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (isLoopback(host)) return null
  let proxy: string | null = null
  let bypass = ''
  if (config.mode === 'manual') {
    proxy = config.url?.trim() || null
    bypass = config.bypass ?? ''
  } else if (config.mode === 'env') {
    const env = config.env ?? process.env
    const get = (name: string) => env[name.toLowerCase()] ?? env[name.toUpperCase()]
    proxy = (url.protocol === 'https:' ? get('https_proxy') : get('http_proxy')) || get('all_proxy') || null
    bypass = get('no_proxy') ?? ''
  } else {
    proxy = config.resolveSystem ? await config.resolveSystem(url.href) : null
  }
  if (!proxy || bypasses(host, url.port || (url.protocol === 'https:' ? '443' : '80'), bypass)) return null
  return withCredentials(proxy, config.username, config.password)
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host)
}

/** NO_PROXY: `*`, hosts e sufixos (`.empresa.com`, `*.empresa.com`, `empresa.com`), host:porta e faixas CIDR IPv4. */
export function bypasses(host: string, port: string, list: string): boolean {
  for (const raw of list.split(/[,\s]+/)) {
    let entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    const cidr = entry.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
    if (cidr) {
      if (inCidr(host, cidr[1]!, Number(cidr[2]))) return true
      continue
    }
    const at = entry.lastIndexOf(':')
    if (at > 0 && !entry.includes(']') && /^\d+$/.test(entry.slice(at + 1)) && entry.indexOf(':') === at) {
      if (entry.slice(at + 1) !== port) continue
      entry = entry.slice(0, at)
    }
    entry = entry.replace(/^\*?\./, '').replace(/^\[|\]$/g, '')
    if (host === entry || host.endsWith(`.${entry}`)) return true
  }
  return false
}

function inCidr(host: string, base: string, bits: number): boolean {
  const ip = toInt(host)
  const net = toInt(base)
  if (ip === null || net === null || bits > 32) return false
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ip & mask) >>> 0 === (net & mask) >>> 0
}

function toInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null
    n = n * 256 + Number(p)
  }
  return n
}

/** A URL do proxy com usuário e senha (os das configurações vencem os da URL). */
function withCredentials(proxy: string, username: string | undefined, password: string | undefined): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(proxy) ? proxy : `http://${proxy}`
  if (!username) return withScheme
  try {
    const url = new URL(withScheme)
    url.username = encodeURIComponent(username)
    url.password = password ? encodeURIComponent(password) : ''
    return url.href
  } catch {
    return withScheme
  }
}
