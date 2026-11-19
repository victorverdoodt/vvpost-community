// Acha o valor JSON sob o cursor de um texto (o body da request no editor): o caminho do valor ou
// da chave que contém a posição. Parser próprio porque o JSON.parse não devolve posições.
import type { JsonPathKey } from './jsonpath'

interface Span {
  path: JsonPathKey[]
  start: number
  end: number
}

/** O valor mais interno que contém `offset` (a chave conta como o valor dela); null se o texto não é JSON. */
export function jsonPathAt(text: string, offset: number): JsonPathKey[] | null {
  const spans: Span[] = []
  let i = 0
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++
  }
  const fail = (): never => {
    throw new SyntaxError(`posição ${i}`)
  }
  const string = () => {
    if (text[i] !== '"') fail()
    i++
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    if (text[i] !== '"') fail()
    i++
  }
  const value = (path: JsonPathKey[]) => {
    ws()
    const start = i
    const c = text[i]
    if (c === '{') {
      i++
      ws()
      if (text[i] === '}') i++
      else {
        for (;;) {
          ws()
          const keyStart = i
          string()
          const key = JSON.parse(text.slice(keyStart, i)) as string
          spans.push({ path: [...path, key], start: keyStart, end: i })
          ws()
          if (text[i] !== ':') fail()
          i++
          value([...path, key])
          ws()
          if (text[i] === ',') i++
          else if (text[i] === '}') {
            i++
            break
          } else fail()
        }
      }
    } else if (c === '[') {
      i++
      ws()
      if (text[i] === ']') i++
      else {
        for (let n = 0; ; n++) {
          value([...path, n])
          ws()
          if (text[i] === ',') i++
          else if (text[i] === ']') {
            i++
            break
          } else fail()
        }
      }
    } else if (c === '"') string()
    else {
      const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400))
      if (!m) fail()
      i += m![0].length
    }
    spans.push({ path, start, end: i })
  }
  try {
    value([])
    ws()
    if (i !== text.length) return null
  } catch {
    return null
  }
  let best: Span | null = null
  for (const s of spans) {
    if (offset >= s.start && offset <= s.end && (!best || s.end - s.start < best.end - best.start)) best = s
  }
  return best?.path ?? null
}

/** Nome de variável sugerido pelo caminho: $.data.accessToken vira ACCESS_TOKEN, $.items[0] vira ITEMS_0. */
export function variableNameFor(path: JsonPathKey[]): string {
  const last = path.findLastIndex((k) => typeof k === 'string')
  const parts = last === -1 ? ['valor'] : path.slice(last).map(String)
  const name = parts
    .join('_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
  return /^[A-Z_]/.test(name) ? name : `_${name}`
}

/** Valor do JSON no caminho. */
export function valueAt(root: unknown, path: JsonPathKey[]): unknown {
  let v = root
  for (const k of path) v = (v as Record<string | number, unknown> | null)?.[k]
  return v
}
