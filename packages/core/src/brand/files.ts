import { readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, sep } from 'node:path'
import { isProjectDir } from '../projects'
import { findTokenFiles, loadBrand } from './load'
import { BASE_MODE, formatTokenValue, parseColor, parseTokensFile, toHex, type BrandItem, type ContrastResult } from './tokens'

/**
 * O arquivo de tokens na aba própria do app: a leitura já formatada para a tela (o renderer não
 * resolve alias nem converte cor), a conferência do código sob pedido e a gravação do JSON.
 */
export interface BrandTokenView {
  name: string
  type: string
  /** O valor resolvido, curto (#bd948a, 8px, Inter, sans-serif); vazio quando não resolve. */
  value: string
  /** O alias como está no arquivo ({color.primary}). */
  alias?: string
  /** O valor em cada modo em que o token muda. */
  modes?: Record<string, string>
  /** Cor em #rrggbb(aa) por modo ("base" e os outros), para a amostra. */
  swatch?: Record<string, string>
  description?: string
  line?: number
  /** Onde o token vive no código ($extensions.vvpost.code). */
  code?: string[]
}

export interface BrandFileView {
  /** Relativo ao projeto, com "/". Pode começar com ../ (o brand/ da raiz do workspace). */
  file: string
  name: string
  text: string
  modes: string[]
  tokens: BrandTokenView[]
  contrast: ContrastResult[]
  sources: string[]
  /** Formato, alias e tipos (tokens-invalid). */
  problems: BrandItem[]
}

const MAX_BYTES = 1024 * 1024
const rel = (base: string, path: string) => relative(base, path).split(sep).join('/')
export const brandRoot = (dir: string): string => (isProjectDir(dir) ? dirname(dir) : dir)

/** Os arquivos de tokens do projeto (ou da raiz do workspace), relativos ao projeto. */
export async function listBrandFiles(dir: string): Promise<string[]> {
  const { files } = await findTokenFiles(dir, brandRoot(dir))
  return files.map((f) => rel(dir, f))
}

/** O caminho de um arquivo da lista; qualquer outro nome é recusado (nada fora do brand/). */
async function resolveBrandFile(dir: string, file: string): Promise<string> {
  const { files } = await findTokenFiles(dir, brandRoot(dir))
  const path = files.find((f) => rel(dir, f) === file)
  if (!path) throw new Error(`"${file}" não é um arquivo de tokens do projeto (brand/*.tokens.json)`)
  return path
}

const swatch = (value: unknown) => {
  const c = parseColor(value)
  return c ? toHex(c) : undefined
}

export async function readBrandFile(dir: string, file: string): Promise<BrandFileView> {
  const text = await readFile(await resolveBrandFile(dir, file), 'utf8')
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('arquivo de tokens acima de 1 MB')
  const parsed = parseTokensFile(file, text)
  const tokens = parsed.tokens.map((t): BrandTokenView => {
    const view: BrandTokenView = { name: t.name, type: t.type, value: t.resolved === undefined ? '' : formatTokenValue(t.resolved) }
    if (typeof t.value === 'string' && /^\{[^}]+\}$/.test(t.value.trim())) view.alias = t.value.trim()
    if (t.modes && Object.keys(t.modes).length) view.modes = Object.fromEntries(Object.entries(t.modes).map(([m, v]) => [m, formatTokenValue(v)]))
    if (t.type === 'color') {
      const colors: Record<string, string> = {}
      const base = swatch(t.resolved)
      if (base) colors[BASE_MODE] = base
      for (const [m, v] of Object.entries(t.modes ?? {})) {
        const c = swatch(v)
        if (c) colors[m] = c
      }
      if (Object.keys(colors).length) view.swatch = colors
    }
    if (t.description) view.description = t.description
    if (t.line) view.line = t.line
    if (parsed.code[t.name]?.length) view.code = parsed.code[t.name]!
    return view
  })
  return { file, name: parsed.name, text, modes: parsed.modes, tokens, contrast: parsed.contrast, sources: parsed.sources, problems: parsed.problems }
}

/** O código do frontend conferido contra os tokens (os achados brand-*), sob pedido: pode ler milhares de arquivos. */
export async function brandCodeFindings(dir: string): Promise<{ items: BrandItem[]; scanned: number }> {
  const { items, scanned } = await loadBrand(dir, { root: brandRoot(dir), scan: true })
  return { items: items.filter((i) => i.code.startsWith('brand-')), scanned }
}

/**
 * Grava o arquivo de tokens pela aba: JSON válido, até 1 MB, sem o valor de um segredo
 * (`leaks`) e sem sobrescrever o que mudou no disco desde a abertura (`previous`).
 */
export async function writeBrandFile(
  dir: string,
  input: { file: string; text: string; previous?: string },
  leaks: (text: string) => boolean
): Promise<{ file: string }> {
  const path = await resolveBrandFile(dir, input.file)
  if (Buffer.byteLength(input.text) > MAX_BYTES) throw new Error('arquivo de tokens acima de 1 MB')
  try {
    JSON.parse(input.text)
  } catch (err) {
    throw new Error(`JSON inválido: ${(err as Error).message}; nada foi gravado`)
  }
  if (leaks(input.text)) throw new Error('o arquivo tem o valor de um segredo do workspace; nada foi gravado')
  const current = await readFile(path, 'utf8')
  const norm = (t: string) => t.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  if (input.previous !== undefined && norm(current) !== norm(input.previous)) {
    throw new Error(`"${input.file}" mudou fora do app desde que foi aberto; recarregue`)
  }
  await writeFile(path, input.text.endsWith('\n') ? input.text : `${input.text}\n`)
  return { file: input.file }
}
