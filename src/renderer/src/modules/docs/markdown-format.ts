// Formatação do editor de Markdown simplificado (a barra de negrito, títulos, listas...): texto
// puro, sem Monaco nem DOM, para o mesmo comportamento no editor do projeto e na aba de um .md.

export type MarkdownAction =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'link'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'numbered'
  | 'task'
  | 'quote'
  | 'codeblock'
  | 'table'
  | 'rule'

/** Troca o trecho from..to por `insert`; `selection` já é no texto novo. */
export interface MarkdownEdit {
  from: number
  to: number
  insert: string
  selection: [number, number]
}

const INLINE: Partial<Record<MarkdownAction, { mark: string; placeholder: string }>> = {
  bold: { mark: '**', placeholder: 'negrito' },
  italic: { mark: '_', placeholder: 'itálico' },
  strike: { mark: '~~', placeholder: 'riscado' },
  code: { mark: '`', placeholder: 'código' }
}

const HEADING = /^(#{1,6})\s+/
const LIST = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/
const TASK = /^(\s*)[-*+]\s+\[[ xX]\]\s+/
const BULLET = /^(\s*)[-*+]\s+(?!\[[ xX]\])/
const NUMBERED = /^(\s*)\d+[.)]\s+/
const QUOTE = /^>\s?/

export const TABLE_TEMPLATE = '| Coluna | Coluna |\n| --- | --- |\n| valor | valor |'

/** A edição de uma ação da barra sobre a seleção start..end (posições no texto). */
export function formatMarkdown(text: string, start: number, end: number, action: MarkdownAction): MarkdownEdit {
  if (end < start) [start, end] = [end, start]
  const inline = INLINE[action]
  if (inline) return wrap(text, start, end, inline.mark, inline.placeholder)
  switch (action) {
    case 'link':
      return link(text, start, end)
    case 'h1':
    case 'h2':
    case 'h3':
      return lines(text, start, end, (all) => heading(all, Number(action[1])))
    case 'bullet':
      return lines(text, start, end, (all) => list(all, BULLET, () => '- '))
    case 'numbered':
      return lines(text, start, end, (all) => list(all, NUMBERED, (i) => `${i + 1}. `))
    case 'task':
      return lines(text, start, end, (all) => list(all, TASK, () => '- [ ] '))
    case 'quote':
      return lines(text, start, end, quote)
    case 'codeblock': {
      const body = text.slice(start, end) || 'código'
      return block(text, start, end, `\`\`\`\n${body}\n\`\`\``, 4, 4 + body.length)
    }
    case 'table':
      return block(text, start, end, TABLE_TEMPLATE, 2, 8)
    case 'rule':
      return block(text, start, end, '---', 3, 3)
    default:
      return { from: start, to: end, insert: text.slice(start, end), selection: [start, end] }
  }
}

/** Negrito, itálico, riscado e código: põe ou tira as marcas em volta da seleção. */
function wrap(text: string, start: number, end: number, mark: string, placeholder: string): MarkdownEdit {
  const m = mark.length
  const selected = text.slice(start, end)
  // As marcas estão em volta da seleção (**|texto|**): tira.
  if (text.slice(start - m, start) === mark && text.slice(end, end + m) === mark && start >= m) {
    return { from: start - m, to: end + m, insert: selected, selection: [start - m, end - m] }
  }
  // As marcas estão dentro da seleção (|**texto**|): tira.
  if (selected.length >= 2 * m && selected.startsWith(mark) && selected.endsWith(mark)) {
    const inner = selected.slice(m, -m)
    return { from: start, to: end, insert: inner, selection: [start, start + inner.length] }
  }
  // Espaços nas pontas ficam fora das marcas: "**texto **" não é negrito no Markdown.
  const lead = /^\s*/.exec(selected)![0].length
  const trail = selected.length > lead ? /\s*$/.exec(selected)![0].length : 0
  const core = selected.slice(lead, selected.length - trail) || placeholder
  const insert = `${selected.slice(0, lead)}${mark}${core}${mark}${selected.slice(selected.length - trail)}`
  const at = start + lead + m
  return { from: start, to: end, insert, selection: [at, at + core.length] }
}

function link(text: string, start: number, end: number): MarkdownEdit {
  const selected = text.slice(start, end)
  if (/^https?:\/\/\S+$/.test(selected)) {
    // Selecionou a URL: ela vira o destino, e o texto do link fica selecionado.
    const insert = `[texto](${selected})`
    return { from: start, to: end, insert, selection: [start + 1, start + 6] }
  }
  const label = selected || 'texto'
  const insert = `[${label}](https://)`
  // Com texto selecionado, o que falta é a URL; sem, o texto do link.
  const at = selected ? start + label.length + 3 : start + 1
  return { from: start, to: end, insert, selection: selected ? [at, at + 8] : [at, at + label.length] }
}

/** Aplica `change` nas linhas inteiras que a seleção toca e seleciona o bloco resultante. */
function lines(text: string, start: number, end: number, change: (lines: string[]) => string[]): MarkdownEdit {
  const from = text.lastIndexOf('\n', start - 1) + 1
  // A seleção que termina no começo de uma linha não inclui essa linha.
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end
  const stop = text.indexOf('\n', last)
  const to = stop < 0 ? text.length : stop
  const insert = change(text.slice(from, to).split('\n')).join('\n')
  if (start === end && !text.slice(from, to).trim()) {
    // Linha vazia: o cursor fica depois do prefixo, pronto para digitar.
    return { from, to, insert, selection: [from + insert.length, from + insert.length] }
  }
  return { from, to, insert, selection: [from, from + insert.length] }
}

function heading(all: string[], level: number): string[] {
  const prefix = '#'.repeat(level)
  const filled = all.filter((l) => l.trim())
  // Todas já são desse nível: o botão desliga o título.
  const same = filled.length > 0 && filled.every((l) => HEADING.exec(l)?.[1] === prefix)
  return all.map((l) => {
    if (!l.trim() && all.length > 1) return l
    const plain = l.replace(HEADING, '')
    return same ? plain : `${prefix} ${plain.replace(LIST, '')}`
  })
}

function list(all: string[], kind: RegExp, prefix: (i: number) => string): string[] {
  const filled = all.filter((l) => l.trim())
  const same = filled.length > 0 && filled.every((l) => kind.test(l))
  let n = 0
  return all.map((l) => {
    if (!l.trim() && all.length > 1) return l
    const indent = /^\s*/.exec(l)![0]
    const plain = l.replace(LIST, '$1').replace(HEADING, '').slice(indent.length)
    return same ? `${indent}${plain}` : `${indent}${prefix(n++)}${plain}`
  })
}

function quote(all: string[]): string[] {
  const filled = all.filter((l) => l.trim())
  const same = filled.length > 0 && filled.every((l) => QUOTE.test(l))
  return all.map((l) => (same ? l.replace(QUOTE, '') : !l.trim() && all.length > 1 ? '>' : `> ${l}`))
}

/**
 * Um bloco (código, tabela, linha) em parágrafo próprio no lugar da seleção, com uma linha em
 * branco antes e depois; selStart..selEnd é o trecho do bloco que fica selecionado.
 */
function block(text: string, start: number, end: number, content: string, selStart: number, selEnd: number): MarkdownEdit {
  const before = text.slice(0, start)
  const after = text.slice(end)
  const head = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const tail = !after ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
  const insert = `${head}${content}${tail}`
  const at = start + head.length
  return { from: start, to: end, insert, selection: [at + selStart, at + selEnd] }
}

/** A linha (1 em diante) do título com esse texto no Markdown, ignorando a numeração e as âncoras {#id}. */
export function headingLine(source: string, title: string): number | null {
  const want = plainTitle(title)
  if (!want) return null
  const all = source.split('\n')
  let fence = false
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) fence = !fence
    if (fence) continue
    const m = /^\s{0,3}#{1,6}\s+(.*?)\s*(?:\{#[^}]*\})?\s*#*\s*$/.exec(line)
    if (m && plainTitle(m[1]!) === want) return i + 1
  }
  return null
}

/** O texto de um título sem numeração ("1.2. "), sem marcas de ênfase e com espaços normais. */
export function plainTitle(title: string): string {
  return title
    .replace(/^\s*\d+(\.\d+)*\.?\s+/, '')
    .replace(/[*_`~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
