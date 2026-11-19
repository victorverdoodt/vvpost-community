import { describe, expect, it } from 'vitest'
import { formatMarkdown, headingLine, type MarkdownAction } from '../src/renderer/src/modules/docs/markdown-format'

/** Aplica a ação sobre o texto com a seleção marcada por | (um | é o cursor; dois, a seleção). */
function apply(marked: string, action: MarkdownAction): string {
  const start = marked.indexOf('|')
  const second = marked.indexOf('|', start + 1)
  const end = second < 0 ? start : second - 1
  const text = marked.replace(/\|/g, '')
  const e = formatMarkdown(text, start, end, action)
  const out = text.slice(0, e.from) + e.insert + text.slice(e.to)
  const [a, b] = e.selection
  return a === b ? `${out.slice(0, a)}|${out.slice(a)}` : `${out.slice(0, a)}|${out.slice(a, b)}|${out.slice(b)}`
}

describe('editor de Markdown simplificado', () => {
  it('negrito, itálico, riscado e código envolvem a seleção e ligam e desligam', () => {
    expect(apply('um |texto| aqui', 'bold')).toBe('um **|texto|** aqui')
    expect(apply('um **|texto|** aqui', 'bold')).toBe('um |texto| aqui')
    expect(apply('um |**texto**| aqui', 'bold')).toBe('um |texto| aqui')
    expect(apply('a |b| c', 'italic')).toBe('a _|b|_ c')
    expect(apply('a |b| c', 'strike')).toBe('a ~~|b|~~ c')
    expect(apply('a |b| c', 'code')).toBe('a `|b|` c')
  })

  it('sem seleção, entra um texto de exemplo já selecionado', () => {
    expect(apply('fim |', 'bold')).toBe('fim **|negrito|**')
  })

  it('espaços nas pontas da seleção ficam fora das marcas', () => {
    expect(apply('|palavra |x', 'bold')).toBe('**|palavra|** x')
  })

  it('link: o texto selecionado vira o rótulo e a URL fica selecionada', () => {
    expect(apply('veja |a doc|', 'link')).toBe('veja [a doc](|https://|)')
    expect(apply('|https://vvpost.dev|', 'link')).toBe('[|texto|](https://vvpost.dev)')
  })

  it('títulos trocam de nível e o mesmo nível desliga', () => {
    expect(apply('Vis|ão geral', 'h2')).toBe('|## Visão geral|')
    expect(apply('## Vis|ão geral', 'h3')).toBe('|### Visão geral|')
    expect(apply('## Vis|ão geral', 'h2')).toBe('|Visão geral|')
    expect(apply('- item|', 'h1')).toBe('|# item|')
  })

  it('listas valem para todas as linhas selecionadas, sem tocar nas vazias', () => {
    expect(apply('|um\ndois\n\ntrês|', 'bullet')).toBe('|- um\n- dois\n\n- três|')
    expect(apply('|- um\n- dois|', 'bullet')).toBe('|um\ndois|')
    expect(apply('|um\n- dois|', 'numbered')).toBe('|1. um\n2. dois|')
    expect(apply('|- um|', 'task')).toBe('|- [ ] um|')
    expect(apply('|- [ ] um|', 'bullet')).toBe('|- um|')
    expect(apply('|um\ndois|', 'quote')).toBe('|> um\n> dois|')
    expect(apply('|> um\n> dois|', 'quote')).toBe('|um\ndois|')
  })

  it('numa linha vazia, o cursor fica depois do prefixo', () => {
    expect(apply('a\n|\nb', 'bullet')).toBe('a\n- |\nb')
  })

  it('a seleção que termina no começo de uma linha não leva essa linha', () => {
    expect(apply('|um\n|dois', 'bullet')).toBe('|- um|\ndois')
  })

  it('código, tabela e linha entram em parágrafo próprio', () => {
    expect(apply('antes |x| depois', 'codeblock')).toBe('antes \n\n```\n|x|\n```\n\n depois')
    expect(apply('texto\n|', 'table')).toBe('texto\n\n| |Coluna| | Coluna |\n| --- | --- |\n| valor | valor |\n')
    expect(apply('|', 'rule')).toBe('---|\n')
  })

  it('acha a linha de um título pelo texto, ignorando numeração, ênfase e blocos de código', () => {
    const source = '# Doc\n\n```\n## Falso\n```\n\n## Visão **geral** {#visao}\n\n### Falso'
    expect(headingLine(source, '1. Visão geral')).toBe(7)
    expect(headingLine(source, 'Falso')).toBe(9)
    expect(headingLine(source, 'Não existe')).toBeNull()
  })
})
