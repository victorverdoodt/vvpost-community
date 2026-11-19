/**
 * Teto de tamanho de uma resposta de ferramenta. Os clientes cortam o que passa do deles no meio do texto (o Codex, em
 * 10 mil tokens), o que quebra o JSON e some com a parte do meio sem a IA saber o que pedir. Aqui o corte é por item
 * inteiro, no fim das listas e dos textos maiores, e a resposta diz o que cortou e como pedir o resto.
 */

/** Caracteres do JSON de uma resposta (cerca de 10 mil tokens, a 4 caracteres por token). */
export const MAX_RESPONSE_CHARS = 40_000

/** Teto de um texto longo devolvido inteiro (página, documento-fonte); o resto vem com offset. */
export const MAX_TEXT_CHARS = 30_000

const HINT = 'resposta grande demais: peça menos (id ou endpoint em get_source, termos mais específicos, view: "summary") ou continue com offset onde a ferramenta aceita'

/** Um trecho de texto a partir de offset, com o que falta para continuar. */
export function sliceText(text: string, offset = 0, max = MAX_TEXT_CHARS): { text: string; truncated?: { total: number; from: number; to: number; next?: { offset: number } } } {
  const from = Math.min(Math.max(0, Math.floor(offset)), text.length)
  if (from === 0 && text.length <= max) return { text }
  const to = Math.min(text.length, from + max)
  return { text: text.slice(from, to), truncated: { total: text.length, from, to, ...(to < text.length && { next: { offset: to } }) } }
}

type Path = (string | number)[]

/** O maior array ou texto do payload, pelo tamanho serializado. */
function largest(value: unknown, path: Path = [], best: { path: Path; size: number } | null = null): { path: Path; size: number } | null {
  if (typeof value === 'string') {
    const size = value.length
    return !best || size > best.size ? { path, size } : best
  }
  if (!value || typeof value !== 'object') return best
  if (Array.isArray(value)) {
    const size = JSON.stringify(value).length
    if (value.length > 1 && (!best || size > best.size)) best = { path, size }
    value.forEach((v, i) => (best = largest(v, [...path, i], best)))
    return best
  }
  for (const [k, v] of Object.entries(value)) best = largest(v, [...path, k], best)
  return best
}

const at = (root: unknown, path: Path): unknown => path.reduce<unknown>((v, k) => (v as Record<string | number, unknown>)[k], root)

function set(root: unknown, path: Path, value: unknown) {
  const parent = at(root, path.slice(0, -1)) as Record<string | number, unknown>
  parent[path[path.length - 1]!] = value
}

/**
 * Faz o payload caber em max caracteres de JSON: corta o fim do maior array (itens inteiros) ou do maior texto, até
 * caber, e acrescenta truncated com o tamanho original, os campos cortados e a dica. Payload que cabe volta igual.
 */
export function fitPayload(payload: unknown, max = MAX_RESPONSE_CHARS): unknown {
  const original = JSON.stringify(payload) ?? ''
  if (original.length <= max || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const copy = JSON.parse(original) as Record<string, unknown>
  // Campo cortado e o tamanho dele antes do corte (texto: caracteres; lista: itens).
  const cut = new Map<string, { path: Path; before: number }>()
  // A nota do corte ocupa espaço: reserva para ela.
  const budget = max - 600
  for (let i = 0; i < 50; i++) {
    const size = JSON.stringify(copy).length
    if (size <= budget) break
    const target = largest(copy)
    if (!target || !target.path.length) break
    const excess = size - budget
    const value = at(copy, target.path)
    const name = target.path.join('.')
    if (typeof value === 'string') {
      const keep = Math.max(0, value.length - excess - 40)
      if (!cut.has(name)) cut.set(name, { path: target.path, before: value.length })
      set(copy, target.path, `${value.slice(0, keep)}… [cortado]`)
    } else if (Array.isArray(value)) {
      // Itens inteiros do fim, pelo tamanho médio; ao menos um sai por volta.
      const avg = target.size / value.length
      const drop = Math.min(value.length - 1, Math.max(1, Math.ceil(excess / avg)))
      if (!cut.has(name)) cut.set(name, { path: target.path, before: value.length })
      set(copy, target.path, value.slice(0, value.length - drop))
    } else break
  }
  const fields = [...cut].map(([name, { path, before }]) => {
    let now: unknown
    try {
      now = at(copy, path)
    } catch {
      now = undefined
    }
    if (now === undefined) return `${name}: saiu junto com a lista de fora`
    return typeof now === 'string'
      ? `${name}: ${now.length - '… [cortado]'.length} de ${before} caracteres`
      : `${name}: ${(now as unknown[]).length} de ${before} itens`
  })
  return { ...copy, truncated: { originalChars: original.length, cut: fields, hint: HINT } }
}
