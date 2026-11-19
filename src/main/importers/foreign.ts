import type { ImportWarning, PostmanSource } from './postman'

/**
 * Peças comuns dos importadores de Insomnia, Bruno, HAR e WSDL. Cada um monta, em memória, uma
 * coleção Postman v2.1 (e ambientes do Postman) com o que leu e entrega ao `convertPostman`: assim
 * a hierarquia, a herança, a detecção de segredos, a ida dos valores para o vault, os scripts e a
 * revisão são os mesmos do importador do Postman, e cada formato só traduz a própria estrutura.
 */

export type ForeignFormat = 'insomnia' | 'bruno' | 'har' | 'wsdl'

export const FORMAT_NAMES: Record<ForeignFormat, string> = {
  insomnia: 'Insomnia',
  bruno: 'Bruno',
  har: 'HAR',
  wsdl: 'WSDL'
}

export interface ForeignConversion {
  format: ForeignFormat
  /** Nome da coleção, para a revisão. */
  name: string
  /** Coleções v2.1 e ambientes do Postman montados a partir do arquivo. */
  postman: PostmanSource[]
  warnings: ImportWarning[]
  errors: { file: string; message: string }[]
}

export interface KeyValue {
  key: string
  value: string
  disabled?: boolean
  type?: string
  src?: string
  description?: string
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Pasta lida do disco: o conteúdo dos arquivos por caminho relativo, com "/". */
export interface ImportFolder {
  $folder: Record<string, string>
  name: string
}

export const isImportFolder = (data: unknown): data is ImportFolder => isObject(data) && isObject(data['$folder'])

/** Texto de um arquivo que não é JSON nem YAML (`.bru`, WSDL), como o leitor de import entrega. */
export interface ImportText {
  $text: string
}

export const isImportText = (data: unknown): data is ImportText => isObject(data) && typeof data['$text'] === 'string'

export const asString = (v: unknown): string =>
  v === undefined || v === null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)

/** Separa a query string da URL, mantendo `{{x}}` como está. */
export function splitUrl(raw: string): { base: string; query: KeyValue[] } {
  const [beforeHash] = raw.split('#') as [string]
  const q = beforeHash.indexOf('?')
  if (q === -1) return { base: beforeHash, query: [] }
  const query = beforeHash
    .slice(q + 1)
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=')
      return eq === -1 ? { key: decode(pair), value: '' } : { key: decode(pair.slice(0, eq)), value: decode(pair.slice(eq + 1)) }
    })
  return { base: beforeHash.slice(0, q), query }
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s
  }
}

/** URL da coleção v2.1: o texto sem a query e a query como lista, junto com os parâmetros à parte. */
export function postmanUrl(raw: string, extra: KeyValue[] = []): { raw: string; query?: KeyValue[] } {
  const { base, query } = splitUrl(raw.trim())
  const all = [...query, ...extra.filter((p) => p.key)]
  return all.length ? { raw: base, query: all } : { raw: base }
}

/** Corpo cru com a linguagem que o importador do Postman usa para escolher o `Content-Type`. */
export function rawBody(text: string, mimeType: string | undefined): Record<string, unknown> {
  const mime = (mimeType ?? '').toLowerCase()
  const language = /json/.test(mime) ? 'json' : /xml/.test(mime) ? 'xml' : /html/.test(mime) ? 'html' : /javascript/.test(mime) ? 'javascript' : 'text'
  return { mode: 'raw', raw: text, options: { raw: { language } } }
}

/** O `Content-Type` que o importador do Postman põe para cada linguagem; outro tipo precisa de header. */
export function needsContentType(mimeType: string | undefined): boolean {
  const mime = (mimeType ?? '').split(';')[0]!.trim().toLowerCase()
  return !!mime && !['application/json', 'application/xml', 'text/html', 'application/javascript', 'text/plain'].includes(mime)
}

/** Auth da coleção v2.1, no formato de objeto (v2.0), que o importador do Postman também lê. */
export function postmanAuth(type: string, params: Record<string, unknown>): Record<string, unknown> {
  return { type, [type]: params }
}

export function hasHeader(headers: KeyValue[], name: string): boolean {
  return headers.some((h) => !h.disabled && h.key.toLowerCase() === name.toLowerCase())
}

export const baseName = (file: string): string => file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || file
