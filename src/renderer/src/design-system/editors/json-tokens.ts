/** Tipos de token do realce de JSON, mapeados para cores do design system no CodeEditor. */
export type JsonToken = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'space'

const TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|(\s+)|(.)/gy

/** Quebra o texto em tokens sem perder nenhum caractere (a concatenação devolve o original). */
export function tokenizeJson(text: string): { type: JsonToken; text: string }[] {
  const out: { type: JsonToken; text: string }[] = []
  TOKEN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(text))) {
    if (m[1] !== undefined) {
      out.push({ type: m[2] ? 'key' : 'string', text: m[1] })
      if (m[2]) out.push({ type: 'punct', text: m[2] })
    } else if (m[3] !== undefined) out.push({ type: 'number', text: m[3] })
    else if (m[4] !== undefined) out.push({ type: 'literal', text: m[4] })
    else if (m[5] !== undefined) out.push({ type: 'punct', text: m[5] })
    else if (m[6] !== undefined) out.push({ type: 'space', text: m[6] })
    else out.push({ type: 'punct', text: m[7]! })
  }
  return out
}

/** Erro de JSON com linha e coluna (1-based), ou null quando o texto é JSON válido ou vazio. */
export function jsonError(text: string): { message: string; line: number; column: number } | null {
  if (!text.trim()) return null
  try {
    JSON.parse(text)
    return null
  } catch (err) {
    const message = (err as Error).message
    const pos = Number(/position (\d+)/.exec(message)?.[1] ?? NaN)
    if (Number.isNaN(pos)) return { message, line: 1, column: 1 }
    const before = text.slice(0, pos).split('\n')
    return { message, line: before.length, column: before.at(-1)!.length + 1 }
  }
}
