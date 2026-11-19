import { BASE_MODE, colorDistance, formatTokenValue, parseColor, parseDimension, toHex, type BrandFile, type BrandItem, type BrandToken, type Rgba } from './tokens'

/**
 * O código do frontend contra os tokens (docs/brand.md). Leitura de texto e de CSS, sem entender
 * JSX nem Razor a fundo: o objetivo é pegar o literal solto e o tema que divergiu, não validar a tela.
 *
 *   brand-code-drift       variável CSS (--bg: ...) ou chave do createTheme do MUI (palette.primary.main)
 *                          mapeada em $extensions.vvpost.code com valor diferente do token
 *   brand-hardcoded-color  cor literal no código que é o valor de um token: use o token
 *   brand-unknown-color    cor literal que não é da marca: o hint diz o token mais próximo
 *   brand-font             font-family / fontFamily fora das fontes dos tokens
 */

export interface BrandScanContext {
  colors: { token: BrandToken; color: Rgba; hex: string; mode: string; file: string }[]
  /** Famílias de fonte dos tokens, em minúsculas. */
  fonts: Set<string>
  /** Alvo no código (--var ou caminho do tema) → o token e os valores aceitos (padrão e modos). */
  targets: Map<string, { token: BrandToken; values: unknown[]; file: BrandFile }>
  /** Token → como usar no código (o primeiro alvo de code), para o hint. */
  usage: Map<string, string>
}

const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'inherit', 'initial', 'unset', 'revert', '-apple-system', 'blinkmacsystemfont'])
const NEAR = 6
const MAX_PER_FILE = 50

export function brandScanContext(files: BrandFile[]): BrandScanContext {
  const ctx: BrandScanContext = { colors: [], fonts: new Set(), targets: new Map(), usage: new Map() }
  for (const f of files) {
    for (const t of f.tokens) {
      if (t.resolved === undefined) continue
      const values: [string, unknown][] = [[BASE_MODE, t.resolved], ...Object.entries(t.modes ?? {})]
      if (t.type === 'color')
        for (const [mode, v] of values) {
          const color = parseColor(v)
          if (color) ctx.colors.push({ token: t, color, hex: toHex(color), mode, file: f.file })
        }
      if (t.type === 'fontFamily')
        for (const [, v] of values) for (const family of Array.isArray(v) ? v : [v]) if (typeof family === 'string') ctx.fonts.add(family.toLowerCase())
    }
    for (const [name, targets] of Object.entries(f.code)) {
      const token = f.tokens.find((t) => t.name === name)
      if (!token || token.resolved === undefined) continue
      for (const target of targets) ctx.targets.set(target, { token, values: [token.resolved, ...Object.values(token.modes ?? {})], file: f })
      ctx.usage.set(name, targets.map((t) => (t.startsWith('--') ? `var(${t})` : `theme.${t}`)).join(' ou '))
    }
  }
  return ctx
}

/** Os achados da marca num arquivo do frontend. */
export function scanBrandSource(file: string, text: string, ctx: BrandScanContext): BrandItem[] {
  const items: BrandItem[] = []
  const lines = text.split(/\r?\n/)
  const starts: number[] = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  const lineAt = (offset: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const push = (item: BrandItem) => {
    if (items.length < MAX_PER_FILE) items.push(item)
  }

  // Linhas que definem o tema: a cor ali é a definição, não um literal solto.
  const themeLines = new Set<number>()

  // 1. Variáveis CSS mapeadas.
  for (const m of text.matchAll(/(?<![\w-])(--[A-Za-z0-9_-]+)\s*:\s*([^;}\n]+)/g)) {
    const line = lineAt(m.index)
    themeLines.add(line)
    const target = ctx.targets.get(m[1]!)
    if (!target) continue
    const value = m[2]!.trim().replace(/\s*!important$/, '')
    if (!sameValue(target.token.type, value, target.values)) push(drift(file, line, m[1]!, value, target))
  }

  // 2. createTheme do MUI: os caminhos mapeados e as linhas do tema.
  for (const m of text.matchAll(/\b(?:createTheme|extendTheme|createMuiTheme)\s*\(\s*\{/g)) {
    const open = m.index + m[0].length - 1
    const parsed = parseObjectLiteral(text, open)
    if (!parsed) continue
    for (let l = lineAt(open); l <= lineAt(parsed.end); l++) themeLines.add(l)
    for (const [path, entry] of parsed.values) {
      const target = ctx.targets.get(path)
      if (!target) continue
      if (!sameValue(target.token.type, entry.value, target.values)) push(drift(file, lineAt(entry.offset), path, entry.value, target))
    }
  }

  // 3. Cores e fontes soltas.
  for (const [i, raw] of lines.entries()) {
    const line = i + 1
    if (/^\s*(\/\/|\/\*|\*|<!--|#\s)/.test(raw)) continue
    const seen = new Set<string>()
    for (const m of themeLines.has(line) ? [] : raw.matchAll(/(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![\w-])|\brgba?\([^)]*\)/g)) {
      // Âncora de link (href="#bad"), não cor.
      if (/\b(?:href|to|src|action)\s*=\s*["'{]?\s*$/.test(raw.slice(0, m.index))) continue
      const color = parseColor(m[0])
      if (!color) continue
      // Preto ou branco translúcido é sombra ou véu, não cor da marca.
      if (color.a < 1 && ((color.r === 0 && color.g === 0 && color.b === 0) || (color.r === 255 && color.g === 255 && color.b === 255))) continue
      const hex = toHex(color)
      if (seen.has(hex)) continue
      seen.add(hex)
      const exact = ctx.colors.find((c) => c.hex === hex)
      if (exact) {
        const use = ctx.usage.get(exact.token.name)
        push({
          code: 'brand-hardcoded-color',
          message: `cor escrita à mão que é o token ${exact.token.name}${exact.mode === BASE_MODE ? '' : ` (modo ${exact.mode})`}`,
          hint: `Use ${use ?? `o token ${exact.token.name}`} em vez do literal: quando a marca mudar, esta tela muda junto.`,
          file,
          line,
          label: m[0],
          token: exact.token.name
        })
        continue
      }
      const near = nearest(color, ctx)
      push({
        code: 'brand-unknown-color',
        message: 'cor escrita à mão que não é da marca',
        hint: near
          ? `A cor da marca mais próxima é ${near.token.name} (${near.hex})${near.distance < NEAR ? ', quase igual' : ''}${ctx.usage.get(near.token.name) ? `: use ${ctx.usage.get(near.token.name)}` : ''}. Se a cor é nova de propósito, crie o token no brand/*.tokens.json.`
          : 'Crie o token no brand/*.tokens.json ou use um que já existe.',
        file,
        line,
        label: m[0],
        ...(near && { token: near.token.name })
      })
    }
    if (ctx.fonts.size) {
      for (const m of raw.matchAll(/\bfont-family\s*:\s*([^;}\n]+)|\bfontFamily\s*:\s*(['"`])([^'"`]+)\2/g)) {
        const value = (m[1] ?? m[3] ?? '').trim()
        if (/var\(|\$\{|theme\./.test(value)) continue
        const first = value.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '')
        if (!first || GENERIC_FONTS.has(first.toLowerCase()) || ctx.fonts.has(first.toLowerCase())) continue
        push({
          code: 'brand-font',
          message: `a fonte "${first}" não está nos tokens da marca`,
          hint: `As fontes da marca: ${[...ctx.fonts].slice(0, 6).join(', ')}. Use a do token (fontFamily) ou crie o token se a fonte é nova de propósito.`,
          file,
          line,
          label: first
        })
      }
    }
  }
  return items.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
}

function drift(file: string, line: number, target: string, value: string, entry: { token: BrandToken; values: unknown[]; file: BrandFile }): BrandItem {
  const expected = [...new Set(entry.values.map(formatTokenValue))]
  return {
    code: 'brand-code-drift',
    message: `vale ${value}, mas o token ${entry.token.name} é ${expected.join(' ou ')}`,
    hint: `Troque por ${expected[0]} (o valor de ${entry.token.name} em ${entry.file.file}), ou mude o token se a marca mudou: o arquivo de tokens é a fonte.`,
    file,
    line,
    label: target,
    token: entry.token.name
  }
}

function nearest(color: Rgba, ctx: BrandScanContext) {
  let best: { token: BrandToken; hex: string; distance: number } | undefined
  for (const c of ctx.colors) {
    const distance = colorDistance(color, c.color)
    if (!best || distance < best.distance) best = { token: c.token, hex: c.hex, distance }
  }
  return best
}

/** O valor no código é um dos valores do token (cores e dimensões normalizadas, fontes pela primeira família). */
function sameValue(type: string, value: string, accepted: unknown[]): boolean {
  if (type === 'color') {
    const c = parseColor(value)
    return !!c && accepted.some((a) => {
      const t = parseColor(a)
      return !!t && toHex(t) === toHex(c)
    })
  }
  if (type === 'dimension') {
    const d = parseDimension(value)
    return !!d && accepted.some((a) => {
      const t = parseDimension(a)
      return !!t && t.value === d.value && t.unit === d.unit
    })
  }
  if (type === 'fontFamily') {
    const first = (v: string) => v.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '').toLowerCase()
    return accepted.some((a) => first(Array.isArray(a) ? String(a[0] ?? '') : String(a)) === first(value))
  }
  const plain = value.replace(/^['"]|['"]$/g, '')
  return accepted.some((a) => formatTokenValue(a) === plain)
}

// --- Objeto literal do JavaScript (o argumento do createTheme) ------------------------------

interface ParsedObject {
  /** Caminho com pontos → o literal de texto ou número e onde ele está. */
  values: Map<string, { value: string; offset: number }>
  end: number
}

/**
 * Lê o objeto literal que começa em `start` ({) e devolve os valores de texto e número por caminho
 * (palette.primary.main). O resto (chamadas, variáveis, spreads) é pulado sem avaliar nada.
 */
export function parseObjectLiteral(text: string, start: number): ParsedObject | null {
  let i = start
  const values = new Map<string, { value: string; offset: number }>()
  const skipSpace = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++
      if (text.startsWith('//', i)) {
        const nl = text.indexOf('\n', i)
        i = nl < 0 ? text.length : nl + 1
      } else if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2)
        i = end < 0 ? text.length : end + 2
      } else return
    }
  }
  const readString = (): string | null => {
    const q = text[i]
    if (q !== '"' && q !== "'" && q !== '`') return null
    let out = ''
    i++
    while (i < text.length && text[i] !== q) {
      if (text[i] === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (q === '`' && text.startsWith('${', i)) return skipTemplateRest()
      out += text[i]
      i++
    }
    i++
    return out
  }
  const skipTemplateRest = (): null => {
    let depth = 0
    while (i < text.length) {
      const c = text[i]!
      if (c === '\\') i += 2
      else if (c === '{') {
        depth++
        i++
      } else if (c === '}') {
        depth--
        i++
      } else if (c === '`' && depth <= 0) {
        i++
        return null
      } else i++
    }
    return null
  }
  /** Pula uma expressão até a vírgula ou o fecha-chaves do nível atual. */
  const skipExpression = () => {
    let depth = 0
    while (i < text.length) {
      skipSpace()
      const c = text[i]
      if (c === undefined) return
      if (c === '"' || c === "'" || c === '`') {
        readString()
        continue
      }
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) return
        depth--
      } else if (c === ',' && depth === 0) return
      i++
    }
  }
  const parseObject = (prefix: string, depth: number): boolean => {
    if (text[i] !== '{' || depth > 12) return false
    i++
    for (;;) {
      skipSpace()
      if (text[i] === '}') {
        i++
        return true
      }
      if (i >= text.length) return false
      if (text.startsWith('...', i)) {
        i += 3
        skipExpression()
      } else {
        let key = readString()
        if (key === null) {
          const m = /^[A-Za-z_$][\w$]*|^\d+/.exec(text.slice(i, i + 200))
          if (!m) {
            skipExpression()
          } else {
            key = m[0]
            i += key.length
          }
        }
        skipSpace()
        if (key !== null && text[i] === ':') {
          i++
          skipSpace()
          const path = prefix ? `${prefix}.${key}` : key
          const at = i
          if (text[i] === '{') {
            if (!parseObject(path, depth + 1)) return false
          } else {
            const s = readString()
            skipSpace()
            if (s !== null && (text[i] === ',' || text[i] === '}')) values.set(path, { value: s, offset: at })
            else {
              const num = s === null ? /^-?\d*\.?\d+/.exec(text.slice(i, i + 40)) : null
              if (num) {
                i += num[0].length
                skipSpace()
                if (text[i] === ',' || text[i] === '}') values.set(path, { value: num[0], offset: at })
              }
              skipExpression()
            }
          }
        } else skipExpression()
      }
      skipSpace()
      if (text[i] === ',') i++
    }
  }
  if (!parseObject('', 0)) return null
  return { values, end: i - 1 }
}
