// Puro (sem DOM), para os testes de unidade. O lado do DOM está em lazy-diagrams.ts.

/** SVGs de diagrama guardados por fonte; o resto é desenhado de novo quando volta. */
export const DIAGRAM_CACHE_LIMIT = 120

/** Cache com limite, do mais antigo para o mais novo; get renova o lugar. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>()
  constructor(private readonly limit: number) {}
  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }
  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as K)
  }
  delete(key: K): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
  get size(): number {
    return this.map.size
  }
}

/**
 * Envolve cada tabela de primeiro nível do HTML num `div.md-table`: o content-visibility (que poupa o
 * estilo e o layout das tabelas fora da tela) não vale numa caixa display: table.
 */
export function wrapTables(html: string): string {
  let depth = 0
  return html.replace(/<table\b[^>]*>|<\/table\s*>/gi, (tag) => {
    if (tag[1] === '/') {
      depth = Math.max(0, depth - 1)
      return depth === 0 ? `${tag}</div>` : tag
    }
    depth++
    return depth === 1 ? `<div class="md-table">${tag}` : tag
  })
}
