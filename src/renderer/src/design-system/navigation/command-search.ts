/**
 * Busca da Command Palette: cada palavra digitada precisa aparecer no título, no grupo ou nas
 * palavras-chave do comando, valendo os sinônimos ("rodar teste" acha "Executar os cenários").
 */
const SYNONYMS: readonly (readonly string[])[] = [
  ['rodar', 'executar', 'run', 'enviar', 'disparar', 'testar', 'reproduzir'],
  ['teste', 'testes', 'testar', 'cenario', 'scenario', 'test'],
  ['endpoint', 'request', 'requisicao', 'chamada', 'rota'],
  ['excluir', 'apagar', 'remover', 'deletar', 'descartar'],
  ['copiar', 'copy'],
  ['novo', 'nova', 'criar', 'new', 'adicionar'],
  ['abrir', 'ir', 'open', 'ver', 'mostrar'],
  ['renomear', 'rename', 'nome'],
  ['segredo', 'secret', 'senha', 'token', 'credencial'],
  ['fluxo', 'flow'],
  ['conector', 'connector', 'api'],
  ['historico', 'history'],
  ['procurar', 'buscar', 'search', 'pesquisar']
]

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

const byWord = new Map<string, string[]>()
for (const group of SYNONYMS) {
  for (const word of group) byWord.set(word, [...new Set([...(byWord.get(word) ?? []), ...group])])
}

/** As formas que valem para uma palavra digitada (ela mesma e os sinônimos). */
export function synonymsOf(word: string): string[] {
  const w = normalize(word)
  // "cenarios", "testes": o plural acha o grupo do singular.
  return byWord.get(w) ?? byWord.get(w.replace(/s$/, '')) ?? [w]
}

export interface Searchable {
  title: string
  group: string
  keywords?: readonly string[]
}

/** O comando corresponde à busca (vazia: todos). */
export function matchesQuery(query: string, c: Searchable): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = normalize([c.title, c.group, ...(c.keywords ?? [])].join(' '))
  return words.every((w) => text.includes(w) || synonymsOf(w).some((s) => text.includes(s)))
}
