/**
 * Tokens da marca e do produto (docs/brand.md): o arquivo `brand/<nome>.tokens.json` no formato do
 * W3C Design Tokens Community Group (DTCG), o mesmo do Style Dictionary, do Tokens Studio e das
 * variáveis do Figma. O que o DTCG não cobre fica em `$extensions.vvpost`, que as outras
 * ferramentas ignoram:
 *
 *   modes     valores por modo, por nome de token: { "light": { "color.bg": "#f6f7f9" } }
 *   contrast  pares que precisam de contraste: [{ "fg": "color.text", "bg": "color.bg", "min": 4.5 }]
 *   code      onde cada token vive no código: { "color.bg": ["--bg"], "color.primary": ["palette.primary.main"] }
 *   sources   arquivos do frontend que o lint confere (globs relativos ao projeto): ["../app/**\/*.tsx"]
 *   ignore    globs que ficam de fora (gen/, vendor/, testes...)
 *
 * Tudo aqui é puro: quem lê os arquivos é o load.ts.
 */

export type BrandCode =
  | 'tokens-invalid'
  | 'tokens-contrast'
  | 'brand-code-drift'
  | 'brand-hardcoded-color'
  | 'brand-unknown-color'
  | 'brand-font'

/** Um achado da marca, no formato que o lint lê ($.brand[*]). */
export interface BrandItem {
  code: BrandCode
  message: string
  hint?: string
  /** Arquivo relativo ao projeto, com "/". */
  file: string
  line?: number
  /** Onde, em palavras: o token, o par ou o trecho do código. */
  label?: string
  token?: string
}

export interface BrandToken {
  /** Nome com pontos: color.primary. */
  name: string
  type: string
  /** O valor como está no arquivo (pode ser alias). */
  value: unknown
  /** O valor com os alias resolvidos; undefined quando não resolve. */
  resolved: unknown
  /** O valor em cada modo, já resolvido (só os modos em que o token muda). */
  modes?: Record<string, unknown>
  description?: string
  file: string
  line?: number
}

export interface ContrastPair {
  fg: string
  bg: string
  min: number
}

export interface ContrastResult extends ContrastPair {
  mode: string
  /** Razão de contraste WCAG 2, com uma casa para baixo; null quando um dos lados não é cor. */
  ratio: number | null
  ok: boolean
  fgValue?: string
  bgValue?: string
}

export interface BrandFile {
  file: string
  /** O nome do arquivo sem `.tokens.json`. */
  name: string
  tokens: BrandToken[]
  /** "base" e os modos de $extensions.vvpost.modes. */
  modes: string[]
  contrast: ContrastResult[]
  code: Record<string, string[]>
  sources: string[]
  ignore: string[]
  problems: BrandItem[]
}

export const BASE_MODE = 'base'
const TYPES = new Set([
  'color',
  'dimension',
  'fontFamily',
  'fontWeight',
  'duration',
  'cubicBezier',
  'number',
  'strokeStyle',
  'border',
  'transition',
  'shadow',
  'gradient',
  'typography'
])
const DIMENSION_UNITS = new Set(['px', 'rem', 'em'])
const FONT_WEIGHTS = new Set(['thin', 'hairline', 'extra-light', 'ultra-light', 'light', 'normal', 'regular', 'book', 'medium', 'semi-bold', 'demi-bold', 'bold', 'extra-bold', 'ultra-bold', 'black', 'heavy', 'extra-black', 'ultra-black'])
const ALIAS = /^\{([^{}]+)\}$/
const MAX_TOKENS = 2000
const MAX_DEPTH = 12

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Lê um arquivo DTCG (o texto, para achar as linhas) e devolve os tokens resolvidos, os modos, o contraste e os problemas. */
export function parseTokensFile(file: string, text: string): BrandFile {
  const name = file.split('/').pop()!.replace(/\.tokens\.json$/i, '')
  const out: BrandFile = { file, name, tokens: [], modes: [BASE_MODE], contrast: [], code: {}, sources: [], ignore: [], problems: [] }
  const problem = (message: string, extra: Partial<BrandItem> = {}) =>
    out.problems.push({ code: 'tokens-invalid', message, file, hint: 'Formato em docs/brand.md (W3C DTCG: $type, $value, alias {grupo.token}).', ...extra })
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    problem(`JSON inválido: ${(err as Error).message}`)
    return out
  }
  if (!isObject(data)) {
    problem('o arquivo precisa ser um objeto com grupos e tokens')
    return out
  }
  const lineOf = lineFinder(text)

  // 1. Tokens: objetos com $value; o $type vem do token ou do grupo mais próximo.
  const walk = (node: Record<string, unknown>, path: string[], inherited: string | undefined, depth: number) => {
    if (depth > MAX_DEPTH) {
      problem(`grupos aninhados demais em ${path.join('.')}`)
      return
    }
    const groupType = typeof node['$type'] === 'string' ? (node['$type'] as string) : inherited
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$')) continue
      const tokenPath = [...path, key]
      const tokenName = tokenPath.join('.')
      if (/[{}.]/.test(key)) {
        problem(`nome "${key}" não pode ter {, } nem ponto`, { line: lineOf(key), label: tokenName })
        continue
      }
      if (!isObject(child)) {
        problem(`${tokenName} precisa ser um grupo ou um token com $value`, { line: lineOf(key), label: tokenName, token: tokenName })
        continue
      }
      if ('$value' in child) {
        if (out.tokens.length >= MAX_TOKENS) {
          problem(`mais de ${MAX_TOKENS} tokens; o resto ficou de fora`)
          return
        }
        const type = typeof child['$type'] === 'string' ? (child['$type'] as string) : groupType
        out.tokens.push({
          name: tokenName,
          type: type ?? '',
          value: child['$value'],
          resolved: undefined,
          ...(typeof child['$description'] === 'string' && { description: child['$description'] }),
          file,
          ...(lineOf(key) !== undefined && { line: lineOf(key) })
        })
      } else walk(child, tokenPath, groupType, depth + 1)
    }
  }
  walk(data, [], undefined, 0)

  const byName = new Map(out.tokens.map((t) => [t.name, t]))
  const tokenProblem = (t: BrandToken, message: string) => problem(`${t.name}: ${message}`, { ...(t.line !== undefined && { line: t.line }), label: t.name, token: t.name })

  // 2. Alias e tipo de cada token.
  const resolve = (value: unknown, seen: string[]): { value?: unknown; error?: string } => {
    if (typeof value === 'string') {
      const m = ALIAS.exec(value)
      if (!m) return { value }
      const target = m[1]!
      if (seen.includes(target)) return { error: `alias circular (${[...seen, target].join(' → ')})` }
      const t = byName.get(target)
      if (!t) return { error: `alias {${target}} não aponta para um token` }
      return resolve(t.value, [...seen, target])
    }
    if (Array.isArray(value)) {
      const items = value.map((v) => resolve(v, seen))
      const error = items.find((i) => i.error)?.error
      return error ? { error } : { value: items.map((i) => i.value) }
    }
    if (isObject(value)) {
      const entries = Object.entries(value).map(([k, v]) => [k, resolve(v, seen)] as const)
      const error = entries.find(([, r]) => r.error)?.[1].error
      return error ? { error } : { value: Object.fromEntries(entries.map(([k, r]) => [k, r.value])) }
    }
    return { value }
  }
  for (const t of out.tokens) {
    if (!t.type) {
      // Alias sem tipo herda o tipo de quem ele aponta.
      const m = typeof t.value === 'string' ? ALIAS.exec(t.value) : null
      const target = m ? byName.get(m[1]!) : undefined
      if (target?.type) t.type = target.type
    }
    const r = resolve(t.value, [t.name])
    if (r.error) {
      tokenProblem(t, r.error)
      continue
    }
    if (!t.type) tokenProblem(t, 'sem $type (no token ou num grupo acima)')
    else if (!TYPES.has(t.type)) tokenProblem(t, `$type "${t.type}" não existe no DTCG`)
    else {
      const error = checkValue(t.type, r.value)
      if (error) {
        tokenProblem(t, error)
        continue
      }
    }
    t.resolved = r.value
  }

  // 3. $extensions.vvpost.
  const ext = isObject(data['$extensions']) && isObject(data['$extensions']['vvpost']) ? (data['$extensions']['vvpost'] as Record<string, unknown>) : {}
  const extLine = lineOf('vvpost')
  const extProblem = (message: string) => problem(`$extensions.vvpost: ${message}`, { ...(extLine !== undefined && { line: extLine }), label: '$extensions.vvpost' })

  if (ext['modes'] !== undefined) {
    if (!isObject(ext['modes'])) extProblem('modes precisa ser { "<modo>": { "<token>": valor } }')
    else
      for (const [mode, values] of Object.entries(ext['modes'])) {
        if (mode === BASE_MODE) {
          extProblem(`"${BASE_MODE}" é o nome reservado do modo padrão`)
          continue
        }
        if (!isObject(values)) {
          extProblem(`modes.${mode} precisa ser { "<token>": valor }`)
          continue
        }
        out.modes.push(mode)
        for (const [name, value] of Object.entries(values)) {
          const t = byName.get(name)
          if (!t) {
            extProblem(`modes.${mode}: "${name}" não é um token do arquivo`)
            continue
          }
          const r = resolve(value, [name])
          const error = r.error ?? (t.type && TYPES.has(t.type) ? checkValue(t.type, r.value) : undefined)
          if (error) extProblem(`modes.${mode}.${name}: ${error}`)
          else (t.modes ??= {})[mode] = r.value
        }
      }
  }

  const strings = (key: string): string[] => {
    const v = ext[key]
    if (v === undefined) return []
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
      extProblem(`${key} precisa ser uma lista de globs`)
      return []
    }
    return v as string[]
  }
  out.sources = strings('sources')
  out.ignore = strings('ignore')

  if (ext['code'] !== undefined) {
    if (!isObject(ext['code'])) extProblem('code precisa ser { "<token>": ["--var-css" ou "palette.caminho.no.tema"] }')
    else
      for (const [name, targets] of Object.entries(ext['code'])) {
        const list = typeof targets === 'string' ? [targets] : targets
        if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || !s)) {
          extProblem(`code.${name} precisa ser um texto ou uma lista de textos`)
          continue
        }
        if (!byName.has(name)) {
          extProblem(`code: "${name}" não é um token do arquivo`)
          continue
        }
        out.code[name] = list as string[]
      }
  }

  const pairs: ContrastPair[] = []
  if (ext['contrast'] !== undefined) {
    if (!Array.isArray(ext['contrast'])) extProblem('contrast precisa ser uma lista de { "fg", "bg", "min" }')
    else
      for (const item of ext['contrast']) {
        const pair = Array.isArray(item)
          ? { fg: item[0], bg: item[1], min: item[2] ?? 4.5 }
          : isObject(item)
            ? { fg: item['fg'], bg: item['bg'], min: item['min'] ?? 4.5 }
            : undefined
        if (!pair || typeof pair.fg !== 'string' || typeof pair.bg !== 'string' || typeof pair.min !== 'number' || pair.min < 1 || pair.min > 21) {
          extProblem(`contrast: ${JSON.stringify(item)} precisa de fg, bg (nomes de token) e min entre 1 e 21`)
          continue
        }
        const missing = [pair.fg, pair.bg].filter((n) => byName.get(n)?.type !== 'color')
        if (missing.length) {
          extProblem(`contrast: ${missing.map((n) => `"${n}"`).join(' e ')} não ${missing.length > 1 ? 'são tokens' : 'é token'} de cor`)
          continue
        }
        pairs.push(pair as ContrastPair)
      }
  }

  // 4. Contraste em cada modo.
  for (const mode of out.modes) {
    for (const pair of pairs) {
      const fg = colorIn(byName.get(pair.fg)!, mode)
      const bg = colorIn(byName.get(pair.bg)!, mode)
      const ratio = fg && bg ? contrastRatio(fg, bg) : null
      const result: ContrastResult = { ...pair, mode, ratio, ok: ratio === null || ratio >= pair.min, ...(fg && { fgValue: toHex(fg) }), ...(bg && { bgValue: toHex(bg) }) }
      out.contrast.push(result)
      if (!result.ok) {
        const t = byName.get(pair.fg)!
        out.problems.push({
          code: 'tokens-contrast',
          message: `contraste de ${formatRatio(ratio!)}:1${mode === BASE_MODE ? '' : ` no modo ${mode}`} (${pair.fg} ${result.fgValue} sobre ${pair.bg} ${result.bgValue}); o mínimo é ${formatRatio(pair.min)}:1`,
          hint: suggestContrast(fg!, bg!, pair.min),
          file,
          ...(t.line !== undefined && { line: t.line }),
          label: `${pair.fg} / ${pair.bg}${mode === BASE_MODE ? '' : ` (${mode})`}`,
          token: pair.fg
        })
      }
    }
  }
  return out
}

function checkValue(type: string, value: unknown): string | undefined {
  switch (type) {
    case 'color':
      return parseColor(value) ? undefined : `cor inválida (${short(value)}): use #rrggbb, #rrggbbaa ou { "colorSpace": "srgb", "components": [r, g, b] }`
    case 'dimension':
      return parseDimension(value) ? undefined : `dimensão inválida (${short(value)}): use { "value": 8, "unit": "px" } (px, rem ou em)`
    case 'fontFamily':
      return typeof value === 'string' || (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string'))
        ? undefined
        : `fontFamily precisa ser um texto ou uma lista de textos (${short(value)})`
    case 'fontWeight':
      return (typeof value === 'number' && value >= 1 && value <= 1000) || (typeof value === 'string' && FONT_WEIGHTS.has(value))
        ? undefined
        : `fontWeight precisa ser um número de 1 a 1000 ou um nome (bold, regular...) (${short(value)})`
    case 'number':
      return typeof value === 'number' ? undefined : `number precisa ser um número (${short(value)})`
    case 'duration':
      return (isObject(value) && typeof value['value'] === 'number' && (value['unit'] === 'ms' || value['unit'] === 's')) || (typeof value === 'string' && /^\d+(\.\d+)?m?s$/.test(value))
        ? undefined
        : `duração inválida (${short(value)}): use { "value": 200, "unit": "ms" }`
    default:
      return undefined
  }
}

const short = (v: unknown) => {
  const text = JSON.stringify(v) ?? String(v)
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

/** A linha (1 em diante) da primeira chave com esse nome no texto. */
function lineFinder(text: string): (key: string) => number | undefined {
  const lines = text.split(/\r?\n/)
  const cache = new Map<string, number | undefined>()
  return (key) => {
    if (cache.has(key)) return cache.get(key)
    const needle = `${JSON.stringify(key)}`
    const i = lines.findIndex((l) => l.includes(needle) && /^\s*:/.test(l.slice(l.indexOf(needle) + needle.length)))
    const line = i < 0 ? undefined : i + 1
    cache.set(key, line)
    return line
  }
}

// --- Cores ---------------------------------------------------------------------------------

/** Cor sRGB com os canais de 0 a 255 e alfa de 0 a 1. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() ou o objeto do DTCG em srgb. */
export function parseColor(value: unknown): Rgba | null {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v)
    if (hex) {
      let h = hex[1]!
      if (h.length <= 4) h = [...h].map((c) => c + c).join('')
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? Math.round((parseInt(h.slice(6, 8), 16) / 255) * 1000) / 1000 : 1 }
    }
    const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v)
    if (fn) {
      const alpha = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : parseFloat(fn[4])
      const [r, g, b] = [fn[1], fn[2], fn[3]].map((c) => Number(c))
      if ([r, g, b].some((c) => !(c! >= 0 && c! <= 255)) || !(alpha >= 0 && alpha <= 1)) return null
      return { r: r!, g: g!, b: b!, a: alpha }
    }
    return null
  }
  if (isObject(value)) {
    if (typeof value['hex'] === 'string' && value['colorSpace'] === undefined) return parseColor(value['hex'])
    const components = value['components']
    if (value['colorSpace'] !== 'srgb' || !Array.isArray(components) || components.length !== 3) {
      return typeof value['hex'] === 'string' ? parseColor(value['hex']) : null
    }
    if (components.some((c) => typeof c !== 'number' || c < 0 || c > 1)) return null
    const alpha = value['alpha'] === undefined ? 1 : value['alpha']
    if (typeof alpha !== 'number' || alpha < 0 || alpha > 1) return null
    const [r, g, b] = (components as number[]).map((c) => Math.round(c * 255))
    return { r: r!, g: g!, b: b!, a: alpha }
  }
  return null
}

export function toHex(c: Rgba): string {
  const h = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a < 1 ? h(c.a * 255) : ''}`
}

/** A cor do token no modo (a do modo, senão a padrão). */
function colorIn(t: BrandToken, mode: string): Rgba | null {
  return parseColor(mode !== BASE_MODE && t.modes && mode in t.modes ? t.modes[mode] : t.resolved)
}

const channel = (c: number) => {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = (c: Rgba) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)

/** Cor com alfa por cima de outra (o fundo sem alfa vai por cima do branco). */
function over(top: Rgba, bottom: Rgba): Rgba {
  const base = bottom.a < 1 ? over(bottom, { r: 255, g: 255, b: 255, a: 1 }) : bottom
  const mix = (a: number, b: number) => a * top.a + b * (1 - top.a)
  return { r: mix(top.r, base.r), g: mix(top.g, base.g), b: mix(top.b, base.b), a: 1 }
}

/** Razão de contraste do WCAG 2 (1 a 21), com uma casa. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const back = bg.a < 1 ? over(bg, { r: 255, g: 255, b: 255, a: 1 }) : bg
  const front = fg.a < 1 ? over(fg, back) : fg
  const [hi, lo] = [luminance(front), luminance(back)].sort((a, b) => b - a)
  // Uma casa, sempre para baixo: 4,49 não arredonda para passar em 4,5.
  return Math.floor(((hi! + 0.05) / (lo! + 0.05)) * 10 + 1e-9) / 10
}

const formatRatio = (n: number) => String(n).replace('.', ',')

/** Como passar: o texto em preto ou branco, ou o fundo escurecido/clareado até o mínimo. */
function suggestContrast(fg: Rgba, bg: Rgba, min: number): string {
  const options: string[] = []
  for (const text of [
    { r: 0x26, g: 0x26, b: 0x26, a: 1 },
    { r: 255, g: 255, b: 255, a: 1 }
  ]) {
    const r = contrastRatio(text, bg)
    if (r >= min && toHex(text) !== toHex(fg)) options.push(`texto ${toHex(text)} sobre o mesmo fundo dá ${formatRatio(r)}:1`)
  }
  const darker = luminance(fg) > luminance(bg)
  for (let step = 1; step <= 20; step++) {
    const k = darker ? 1 - step * 0.04 : 1 + step * 0.04
    const scale = (c: number) => Math.max(0, Math.min(255, darker ? c * k : c + (255 - c) * (k - 1)))
    const candidate = { r: scale(bg.r), g: scale(bg.g), b: scale(bg.b), a: 1 }
    const r = contrastRatio(fg, candidate)
    if (r >= min) {
      options.push(`ou o fundo ${toHex(candidate)} com o mesmo texto dá ${formatRatio(r)}:1`)
      break
    }
  }
  return options.length ? `Para passar: ${options.join('; ')}. Se a cor é da marca do cliente, a escolha é dele.` : 'Troque o texto ou o fundo por um par com mais contraste.'
}

/** Distância perceptual aproximada (CIE76 no Lab) entre duas cores. */
export function colorDistance(a: Rgba, b: Rgba): number {
  const lab = (c: Rgba) => {
    const [r, g, bl] = [channel(c.r), channel(c.g), channel(c.b)]
    const x = (r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047
    const y = r * 0.2126 + g * 0.7152 + bl * 0.0722
    const z = (r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
  }
  const [l1, a1, b1] = lab(a)
  const [l2, a2, b2] = lab(b)
  return Math.hypot(l1! - l2!, a1! - a2!, b1! - b2!) + Math.abs(a.a - b.a) * 50
}

// --- Dimensões ---------------------------------------------------------------------------------

export function parseDimension(value: unknown): { value: number; unit: string } | null {
  if (isObject(value) && typeof value['value'] === 'number' && typeof value['unit'] === 'string' && DIMENSION_UNITS.has(value['unit'])) {
    return { value: value['value'], unit: value['unit'] }
  }
  if (typeof value === 'string') {
    const m = /^(-?\d*\.?\d+)(px|rem|em)$/.exec(value.trim())
    if (m) return { value: Number(m[1]), unit: m[2]! }
  }
  if (value === 0) return { value: 0, unit: 'px' }
  return null
}

/** O valor do token como texto curto, para o agente e para as tabelas: #bd948a, 8px, "Inter", 600. */
export function formatTokenValue(value: unknown): string {
  const color = parseColor(value)
  if (color) return toHex(color)
  const dim = parseDimension(value)
  if (dim) return `${dim.value}${dim.unit}`
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(', ')
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return JSON.stringify(value) ?? ''
}
