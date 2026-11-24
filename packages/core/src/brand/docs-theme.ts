import { dirname } from 'node:path'
import type { DocsConfig, DocsThemeTokens } from '@vvpost/schemas'
import { isProjectDir } from '../projects'
import { findTokenFiles, loadBrand } from './load'
import { BASE_MODE, parseColor, type BrandFile, type BrandToken, type Rgba } from './tokens'

/**
 * As cores e as fontes da documentação (PDF, visualização e site) lidas dos tokens da marca, quando
 * o modelo pede com `theme.tokens` (docs/brand.md). As cores saem como #RRGGBB e as fontes como uma
 * pilha de CSS já segura, prontas para o printLayout.
 */
export interface DocsBrandTheme {
  primary?: string
  heading?: string
  text?: string
  /** Pilha de CSS da fonte do texto ("Quicksand", sans-serif). */
  font?: string
  headingFont?: string
  /** O arquivo de tokens de onde vieram, relativo ao projeto. */
  file: string
}

export interface DocsBrandResult {
  /** null: o projeto não tem arquivo de tokens. */
  theme: DocsBrandTheme | null
  /** Token pedido que não existe, de outro tipo ou com valor que não serve; o resto vale. */
  issues: { file: string; message: string }[]
}

type Field = keyof Omit<DocsThemeTokens, 'mode'>

/** Os nomes de costume de cada campo, na ordem em que são procurados. */
const CONVENTIONS: Record<Field, string[]> = {
  primary: ['color.primary', 'color.accent', 'color.brand'],
  heading: ['color.heading', 'color.title'],
  text: ['color.text', 'color.fg', 'color.foreground'],
  font: ['font.body', 'font.text', 'font.ui', 'font.sans', 'font.base'],
  headingFont: ['font.heading', 'font.display', 'font.title']
}

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji'])
/** O que fica atrás da fonte da marca, para a máquina que não a tem instalada. */
const FALLBACK = 'Inter, "Segoe UI", system-ui, -apple-system, Roboto, sans-serif'
/** Nome de família que entra no CSS: letras, números, espaço, ponto, hífen e sublinhado. */
const FAMILY = /^[\p{L}\p{N} ._-]{1,80}$/u

/** O modelo pede os tokens da marca? */
export const docsUsesTokens = (config: DocsConfig): boolean => !!config.theme?.tokens

/** Cor com alfa vai por cima do branco (o papel); sai #rrggbb. */
function opaqueHex(c: Rgba): string {
  const mix = (v: number) => Math.round(v * c.a + 255 * (1 - c.a))
  return `#${[c.r, c.g, c.b].map((v) => mix(v).toString(16).padStart(2, '0')).join('')}`
}

/** Pilha de CSS a partir do valor de um fontFamily (texto ou lista); null se nenhum nome serve. */
export function fontStack(value: unknown): string | null {
  const names = (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.trim().replace(/^["']|["']$/g, '').trim())
    .filter((n) => FAMILY.test(n))
  if (!names.length) return null
  const css = names.map((n) => (GENERIC.has(n.toLowerCase()) ? n.toLowerCase() : `"${n}"`))
  return names.some((n) => GENERIC.has(n.toLowerCase())) ? css.join(', ') : `${css.join(', ')}, ${FALLBACK}`
}

const valueIn = (t: BrandToken, mode: string): unknown => (mode !== BASE_MODE && t.modes && mode in t.modes ? t.modes[mode] : t.resolved)

/**
 * Resolve `theme.tokens` contra os arquivos de tokens: o primeiro arquivo que tem o token vale. Sem
 * `theme.tokens` no modelo, usa os nomes de costume (para o editor mostrar o que viria).
 */
export function resolveDocsBrand(config: DocsConfig, files: BrandFile[]): DocsBrandResult {
  const valid = files.filter((f) => f.tokens.length)
  if (!valid.length) return { theme: null, issues: [] }
  const wanted = config.theme?.tokens ?? {}
  const mode = wanted.mode ?? BASE_MODE
  const issues: DocsBrandResult['issues'] = []
  if (mode !== BASE_MODE && !valid.some((f) => f.modes.includes(mode))) {
    issues.push({ file: valid[0]!.file, message: `o modo "${mode}" não existe nos tokens; valem os valores padrão` })
  }
  const find = (name: string) => {
    for (const f of valid) {
      const t = f.tokens.find((x) => x.name === name)
      if (t) return { token: t, file: f.file }
    }
    return null
  }
  const used = new Set<string>()
  const pick = (field: Field, type: 'color' | 'fontFamily'): string | undefined => {
    const explicit = wanted[field]
    const names = explicit ? [explicit] : CONVENTIONS[field]
    for (const name of names) {
      const hit = find(name)
      if (!hit) continue
      const value = valueIn(hit.token, mode)
      const out = type === 'color' ? (parseColor(value) && opaqueHex(parseColor(value)!)) : hit.token.type === 'fontFamily' ? fontStack(value) : null
      if (out) {
        used.add(hit.file)
        return out
      }
      if (explicit) issues.push({ file: hit.file, message: `o token ${name} não é ${type === 'color' ? 'uma cor' : 'uma fonte (fontFamily)'} que dê para usar na documentação` })
      return undefined
    }
    if (explicit) issues.push({ file: valid[0]!.file, message: `theme.tokens.${field}: o token ${explicit} não existe nos tokens da marca` })
    return undefined
  }
  const theme: DocsBrandTheme = { file: valid[0]!.file }
  const primary = pick('primary', 'color')
  const text = pick('text', 'color')
  const heading = pick('heading', 'color') ?? text
  const font = pick('font', 'fontFamily')
  const headingFont = pick('headingFont', 'fontFamily') ?? font
  if (primary) theme.primary = primary
  if (text) theme.text = text
  if (heading) theme.heading = heading
  if (font) theme.font = font
  if (headingFont) theme.headingFont = headingFont
  if (used.size) theme.file = [...used][0]!
  return { theme, issues }
}

/**
 * Lê os tokens do projeto (brand/ do projeto, senão o da raiz do workspace), sem conferir o código,
 * e resolve o tema da documentação.
 */
export async function loadDocsBrand(dir: string, config: DocsConfig): Promise<DocsBrandResult> {
  const root = isProjectDir(dir) ? dirname(dir) : dir
  const { files } = await findTokenFiles(dir, root)
  if (!files.length) return { theme: null, issues: [] }
  const brand = await loadBrand(dir, { root })
  return resolveDocsBrand(config, brand.files)
}
