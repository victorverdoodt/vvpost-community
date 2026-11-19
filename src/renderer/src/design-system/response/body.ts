// Funções puras do ResponseViewer: tipo do corpo, formatação, hex, cookies e busca.
import type { HttpHeader } from '@shared/ipc'

/** Linguagens do modo Pretty (como o seletor do Postman). */
export type BodyLanguage = 'json' | 'xml' | 'html' | 'javascript' | 'yaml' | 'markdown' | 'text'

/** O que o modo Preview sabe mostrar. */
export type MediaKind = 'image' | 'audio' | 'video' | 'pdf' | 'html' | 'markdown' | 'json' | 'xml' | 'text' | 'binary'

export const LANGUAGE_LABELS: Record<BodyLanguage, string> = {
  json: 'JSON',
  xml: 'XML',
  html: 'HTML',
  javascript: 'JavaScript',
  yaml: 'YAML',
  markdown: 'Markdown',
  text: 'Texto'
}

export function header(headers: HttpHeader[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name)?.value
}

/** O tipo sem parâmetros e em minúsculas ("application/json"). */
export function mimeOf(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase()
}

/** Detecção automática do Pretty: content-type primeiro, depois o começo do texto. */
export function detectLanguage(contentType: string | undefined, text: string): BodyLanguage {
  const mime = mimeOf(contentType)
  if (/json/.test(mime)) return 'json'
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (/xml/.test(mime)) return 'xml'
  if (/javascript|ecmascript/.test(mime)) return 'javascript'
  if (/yaml/.test(mime)) return 'yaml'
  if (/markdown/.test(mime)) return 'markdown'
  const start = text.trimStart().slice(0, 200)
  if (/^[{[]/.test(start)) return 'json'
  if (/^<!doctype html|^<html[\s>]/i.test(start)) return 'html'
  if (/^<\?xml|^<[a-z_][\w.:-]*[\s>/]/i.test(start)) return 'xml'
  return 'text'
}

/** O que a prévia mostra para o corpo; `binary` quando não há prévia (só hex e salvar). */
export function mediaKind(contentType: string | undefined, text: string, binary: boolean): MediaKind {
  const mime = mimeOf(contentType)
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'application/pdf' || (binary && text.startsWith('%PDF-'))) return 'pdf'
  if (binary) return sniffImage(text) ?? 'binary'
  const lang = detectLanguage(contentType, text)
  return lang === 'html' || lang === 'markdown' || lang === 'json' || lang === 'xml' ? lang : 'text'
}

/** PNG, JPEG, GIF e WebP sem content-type certo (o texto é o corpo decodificado em UTF-8). */
function sniffImage(text: string): MediaKind | null {
  if (text.startsWith('�PNG') || text.startsWith('GIF8') || /^RIFF.{4}WEBP/s.test(text)) return 'image'
  return null
}

/** Mime para a prévia quando o servidor não informa (ou manda octet-stream). */
export function previewMime(contentType: string | undefined, bytes: Uint8Array): string {
  const mime = mimeOf(contentType)
  if (mime && mime !== 'application/octet-stream') return mime
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif'
  if (bytes[0] === 0x25 && bytes[1] === 0x50) return 'application/pdf'
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp'
  return 'application/octet-stream'
}

export function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** Os bytes do corpo: os originais quando binário, senão o texto em UTF-8. */
export function bodyBytes(response: { body: string; bodyBase64?: string }): Uint8Array {
  return response.bodyBase64 !== undefined ? base64ToBytes(response.bodyBase64) : new TextEncoder().encode(response.body)
}

/** Dump hexadecimal (offset, 16 bytes, ASCII), como `xxd`. */
export function hexDump(bytes: Uint8Array, limit = bytes.length): string {
  const end = Math.min(bytes.length, limit)
  const lines: string[] = []
  for (let off = 0; off < end; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, end))
    let hex = ''
    let ascii = ''
    for (let i = 0; i < 16; i++) {
      if (i === 8) hex += ' '
      if (i < row.length) {
        const b = row[i]!
        hex += b.toString(16).padStart(2, '0') + ' '
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'
      } else hex += '   '
    }
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex} ${ascii}`)
  }
  return lines.join('\n')
}

/** Indenta XML (e HTML bem formado) com 2 espaços, sem mexer em texto, CDATA e comentários. */
export function formatXml(text: string): string {
  const tokens = text.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)
  if (!tokens) return text
  const out: string[] = []
  let depth = 0
  const pad = () => '  '.repeat(Math.max(0, depth))
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.startsWith('</')) {
      depth--
      out.push(pad() + t)
    } else if (t.startsWith('<') && !t.startsWith('<!') && !t.startsWith('<?') && !t.endsWith('/>')) {
      const name = /^<([\w:.-]+)/.exec(t)?.[1]?.toLowerCase() ?? ''
      // <a>texto</a> fica numa linha só.
      const text = tokens[i + 1]
      const close = tokens[i + 2]
      if (text !== undefined && !text.startsWith('<') && close?.startsWith('</')) {
        out.push(pad() + t + text.trim() + close)
        i += 2
      } else {
        out.push(pad() + t)
        if (!VOID_TAGS.has(name)) depth++
      }
    } else if (t.startsWith('<')) {
      out.push(pad() + t)
    } else if (t.trim()) {
      out.push(pad() + t.trim())
    }
  }
  return out.join('\n')
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

export interface Cookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: string
  maxAge?: string
  httpOnly: boolean
  secure: boolean
  sameSite?: string
}

/** Cookies da resposta (um por Set-Cookie), com os atributos. */
export function parseCookies(headers: HttpHeader[]): Cookie[] {
  return headers
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => {
      const [pair = '', ...attrs] = h.value.split(';')
      const eq = pair.indexOf('=')
      const cookie: Cookie = {
        name: (eq === -1 ? pair : pair.slice(0, eq)).trim(),
        value: eq === -1 ? '' : pair.slice(eq + 1).trim(),
        httpOnly: false,
        secure: false
      }
      for (const attr of attrs) {
        const i = attr.indexOf('=')
        const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase()
        const value = i === -1 ? '' : attr.slice(i + 1).trim()
        if (key === 'domain') cookie.domain = value
        else if (key === 'path') cookie.path = value
        else if (key === 'expires') cookie.expires = value
        else if (key === 'max-age') cookie.maxAge = value
        else if (key === 'httponly') cookie.httpOnly = true
        else if (key === 'secure') cookie.secure = true
        else if (key === 'samesite') cookie.sameSite = value
      }
      return cookie
    })
}

const EXTENSIONS: Record<string, string> = {
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'application/javascript': 'js',
  'text/javascript': 'js',
  'application/yaml': 'yaml',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
  'application/zip': 'zip'
}

/** Nome sugerido ao salvar: o do Content-Disposition, ou "resposta" com a extensão do tipo. */
export function suggestedFileName(headers: HttpHeader[]): string {
  const disposition = header(headers, 'content-disposition') ?? ''
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition)?.[1]
  if (star) {
    try {
      return decodeURIComponent(star.trim().replace(/^"|"$/g, ''))
    } catch {
      // segue para o filename simples
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)?.[1]
  if (plain) return plain.trim()
  const mime = mimeOf(header(headers, 'content-type'))
  const ext = EXTENSIONS[mime] ?? (/json/.test(mime) ? 'json' : /xml/.test(mime) ? 'xml' : mime.startsWith('text/') ? 'txt' : 'bin')
  return `resposta.${ext}`
}

export { findMatches } from '../find/find'

/**
 * HTML da prévia: um CSP que bloqueia scripts, rede e formulários vai no começo do documento
 * (o iframe também é sandbox sem allow-scripts). CSPs se somam, então o HTML da resposta não
 * consegue afrouxar este.
 */
export function sandboxedHtml(html: string): string {
  const csp =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'">`
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  return doctype ? doctype[0] + csp + html.slice(doctype[0].length) : csp + html
}
