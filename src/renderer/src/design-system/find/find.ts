/** Ocorrências de `query` em `text`, como pares [início, fim). Para em `max` para não travar a interface. */
export function findMatches(text: string, query: string, caseSensitive: boolean, max = 5000): [number, number][] {
  if (!query) return []
  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const out: [number, number][] = []
  for (let i = hay.indexOf(needle); i !== -1 && out.length < max; i = hay.indexOf(needle, i + needle.length)) {
    out.push([i, i + needle.length])
  }
  return out
}

/** A ocorrência atual a partir de um índice que só cresce ou diminui (próxima/anterior dão a volta). */
export function wrapIndex(index: number, count: number): number {
  return count ? ((index % count) + count) % count : -1
}

/** Um ponto dentro de uma lista de pedaços de texto: o pedaço e a posição nele. */
export interface TextPoint {
  piece: number
  offset: number
}

/**
 * Converte ocorrências no texto concatenado em pontos dos pedaços (os nós de texto do DOM),
 * para montar os `Range` da busca: uma ocorrência pode começar num nó e terminar em outro (o
 * realce de sintaxe quebra o texto em vários spans).
 */
export function locateMatches(lengths: readonly number[], matches: readonly [number, number][]): [TextPoint, TextPoint][] {
  const out: [TextPoint, TextPoint][] = []
  let piece = 0
  let base = 0
  const advance = (pos: number, end: boolean): TextPoint => {
    // O fim de uma ocorrência fica no pedaço onde ela termina (não no começo do seguinte).
    while (piece < lengths.length - 1 && (end ? pos > base + lengths[piece]! : pos >= base + lengths[piece]!)) {
      base += lengths[piece]!
      piece++
    }
    return { piece, offset: pos - base }
  }
  for (const [s, e] of matches) {
    // As ocorrências vêm em ordem e sem sobreposição: a próxima segue de onde esta terminou.
    const start = advance(s, false)
    out.push([start, advance(e, true)])
  }
  return out
}
