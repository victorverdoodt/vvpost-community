import { marked } from 'marked'

// Puro (sem DOM), para os testes de unidade.

/**
 * HTML do Markdown com data-line (a linha do texto, de 0) no primeiro elemento de cada bloco de
 * primeiro nível: parágrafo, título, lista, tabela, código, citação. É o que a prévia de Markdown
 * do VS Code faz com o markdown-it: a prévia sabe de que linha veio cada bloco, para o clique levar
 * ao texto e a rolagem dos dois lados andar junto. O HTML sai igual ao do marked.parse (o parser
 * só concatena o HTML de cada bloco); falta passar pelo DOMPurify, que mantém os data-*.
 */
export function markdownWithLines(source: string): string {
  const tokens = marked.lexer(source, { gfm: true })
  let html = ''
  let from = 0
  let line = 0
  for (const token of tokens) {
    // O raw de cada bloco está no texto na ordem: a linha é a contagem de quebras antes dele.
    const at = token.raw ? source.indexOf(token.raw, from) : -1
    if (at >= 0) {
      line += countLines(source, from, at)
      from = at
    }
    const start = line + leadingBlankLines(token.raw ?? '')
    const part = marked.parser(Object.assign([token], { links: tokens.links }), { gfm: true }) as string
    html += token.type === 'space' ? part : part.replace(/^(\s*<[a-zA-Z][a-zA-Z0-9-]*)/, `$1 data-line="${start}"`)
    if (at >= 0) {
      line += countLines(source, from, from + token.raw.length)
      from += token.raw.length
    }
  }
  return html
}

function countLines(text: string, from: number, to: number): number {
  let n = 0
  for (let i = text.indexOf('\n', from); i >= 0 && i < to; i = text.indexOf('\n', i + 1)) n++
  return n
}

function leadingBlankLines(raw: string): number {
  const m = /^(?:[ \t]*\n)*/.exec(raw)
  return m ? countLines(m[0], 0, m[0].length) : 0
}
