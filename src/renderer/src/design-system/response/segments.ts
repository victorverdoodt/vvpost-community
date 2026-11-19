// Realce do corpo da resposta em segmentos de texto com classe de cor. A concatenação dos
// segmentos é sempre o texto mostrado, o que permite marcar as ocorrências da busca por cima.
import type { BodyLanguage } from './body'
import type { JsonPathKey } from './jsonpath'

export interface Segment {
  text: string
  cls?: string
  /** Índice em `paths`: o valor ou a chave pode ser escolhido no DataPicker. */
  pick?: number
  /** Nó recolhido (`{…}`): clicar expande. */
  folded?: boolean
}

export interface Highlight {
  text: string
  segments: Segment[]
  /** Caminho de cada valor clicável (DataPicker), relativo à raiz do JSON. */
  paths: JsonPathKey[][]
}

const C = {
  key: 'text-info',
  string: 'text-success',
  number: 'text-warning',
  literal: 'text-accent',
  punct: 'text-muted',
  comment: 'text-faint',
  tag: 'text-cyan',
  attr: 'text-info'
}

/**
 * JSON formatado com 2 espaços (o mesmo texto de JSON.stringify(v, null, 2)), com o caminho de cada
 * chave e valor. `base` é o caminho do valor na resposta (o filtro JSONPath mostra pedaços dela).
 */
export function jsonHighlight(
  value: unknown,
  base: JsonPathKey[][] | null = null,
  collapsed: ReadonlySet<string> = new Set()
): Highlight {
  const segments: Segment[] = []
  const paths: JsonPathKey[][] = []
  const push = (text: string, cls?: string, path?: JsonPathKey[], folded?: boolean) => {
    if (path) {
      paths.push(path)
      segments.push({ text, ...(cls && { cls }), pick: paths.length - 1, ...(folded && { folded }) })
    } else segments.push({ text, ...(cls && { cls }) })
  }
  const isCollapsed = (path: JsonPathKey[]) => collapsed.size > 0 && collapsed.has(pathKey(path))
  const walk = (v: unknown, path: JsonPathKey[], indent: string) => {
    if (v === null || typeof v === 'boolean') return push(String(v), C.literal, path)
    if (typeof v === 'number') return push(Number.isFinite(v) ? String(v) : 'null', C.number, path)
    if (typeof v === 'string') return push(JSON.stringify(v), C.string, path)
    const inner = indent + '  '
    if (Array.isArray(v)) {
      if (!v.length) return push('[]', C.punct, path)
      if (isCollapsed(path)) return push(`[… ${v.length}]`, C.punct, path, true)
      push('[', C.punct, path)
      v.forEach((item, i) => {
        push(`\n${inner}`)
        walk(item === undefined || typeof item === 'function' ? null : item, [...path, i], inner)
        if (i < v.length - 1) push(',', C.punct)
      })
      push(`\n${indent}]`, C.punct)
      return
    }
    const entries = Object.entries(v as Record<string, unknown>).filter(
      ([, x]) => x !== undefined && typeof x !== 'function'
    )
    if (!entries.length) return push('{}', C.punct, path)
    if (isCollapsed(path)) return push(`{… ${entries.length}}`, C.punct, path, true)
    push('{', C.punct, path)
    entries.forEach(([k, item], i) => {
      push(`\n${inner}`)
      push(JSON.stringify(k), C.key, [...path, k])
      push(': ', C.punct)
      walk(item, [...path, k], inner)
      if (i < entries.length - 1) push(',', C.punct)
    })
    push(`\n${indent}}`, C.punct)
  }
  if (base) {
    // Resultado do filtro: um array cujos itens apontam para o caminho original.
    const items = value as unknown[]
    if (!items.length) push('[]', C.punct)
    else {
      push('[', C.punct)
      items.forEach((item, i) => {
        push('\n  ')
        walk(item, base[i]!, '  ')
        if (i < items.length - 1) push(',', C.punct)
      })
      push('\n]', C.punct)
    }
  } else walk(value, [], '')
  return { text: segments.map((s) => s.text).join(''), segments, paths }
}

/** Chave de um caminho no conjunto de nós recolhidos. */
export function pathKey(path: JsonPathKey[]): string {
  return JSON.stringify(path)
}

/** Os objetos e arrays não vazios abaixo de `root` (o "Recolher tudo" deixa só a raiz aberta). */
export function containerKeys(root: unknown, base: JsonPathKey[] = [], out = new Set<string>()): Set<string> {
  const walk = (v: unknown, path: JsonPathKey[], top: boolean) => {
    if (!v || typeof v !== 'object') return
    const entries: [JsonPathKey, unknown][] = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v)
    if (!entries.length) return
    if (!top) out.add(pathKey(path))
    for (const [k, x] of entries) walk(x, [...path, k], false)
  }
  walk(root, base, true)
  return out
}

/** Realce por linguagem (sem caminhos). Texto puro vira um segmento só. */
export function highlight(text: string, language: BodyLanguage): Highlight {
  const segments =
    language === 'xml' || language === 'html'
      ? markup(text)
      : language === 'javascript'
        ? javascript(text)
        : language === 'yaml'
          ? yaml(text)
          : language === 'json'
            ? jsonText(text)
            : [{ text }]
  return { text, segments, paths: [] }
}

function scan(text: string, re: RegExp, classify: (m: RegExpExecArray) => string | undefined): Segment[] {
  const out: Segment[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m[0] === '') {
      re.lastIndex++
      continue
    }
    const cls = classify(m)
    const last = out.at(-1)
    if (last && last.cls === cls) last.text += m[0]
    else out.push(cls ? { text: m[0], cls } : { text: m[0] })
  }
  return out
}

/** JSON inválido (não deu para formatar): realce só por tokens. */
function jsonText(text: string): Segment[] {
  return scan(
    text,
    /("(?:[^"\\\n]|\\.)*")(?=\s*:)|("(?:[^"\\\n]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|([^"{}[\],:\d\-tfn]+|.)/gy,
    (m) => (m[1] ? C.key : m[2] ? C.string : m[3] ? C.number : m[4] ? C.literal : m[5] ? C.punct : undefined)
  )
}

function markup(text: string): Segment[] {
  const out: Segment[] = []
  const re = /(<!--[\s\S]*?(?:-->|$))|(<!\[CDATA\[[\s\S]*?(?:\]\]>|$))|(<[!?/]?[\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?>|\?>)?|([^<]+)|(<)/gy
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m[1] || m[2]) out.push({ text: m[0], cls: C.comment })
    else if (m[3]) {
      out.push({ text: m[3], cls: C.tag })
      if (m[4]) out.push(...attributes(m[4]))
      if (m[5]) out.push({ text: m[5], cls: C.tag })
    } else out.push({ text: m[0] })
  }
  return out
}

function attributes(text: string): Segment[] {
  return scan(text, /([\w:.-]+)(?=\s*=)|("[^"]*"|'[^']*')|([=])|([^\w:.="']+|.)/gy, (m) =>
    m[1] ? C.attr : m[2] ? C.string : m[3] ? C.punct : undefined
  )
}

const JS_KEYWORDS =
  /^(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|try|catch|finally|throw|typeof|instanceof|in|of|async|await|yield|this|null|undefined|true|false|void|delete)$/

function javascript(text: string): Segment[] {
  return scan(
    text,
    /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.:?=+\-*/%<>!&|^~]+)|(\s+|.)/gy,
    (m) =>
      m[1] ? C.comment : m[2] ? C.string : m[3] ? C.number : m[4] ? (JS_KEYWORDS.test(m[4]) ? C.literal : undefined) : m[5] ? C.punct : undefined
  )
}

function yaml(text: string): Segment[] {
  return scan(
    text,
    /(#[^\n]*)|(^[ \t]*-?[ \t]*[^\s#:'"][^:\n]*?(?=:(?:\s|$)))|("(?:[^"\\\n]|\\.)*"|'[^'\n]*')|(\b(?:true|false|null|yes|no|~)\b)|(-?\b\d+(?:\.\d+)?\b)|([:\-[\]{},|>])|(\s+|.)/gmy,
    (m) =>
      m[1] ? C.comment : m[2] ? C.key : m[3] ? C.string : m[4] ? C.literal : m[5] ? C.number : m[6] ? C.punct : undefined
  )
}
