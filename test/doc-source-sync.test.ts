import { marked } from 'marked'
import { describe, expect, it } from 'vitest'
import { markdownWithLines } from '../src/renderer/src/design-system/content/markdown-lines'
import {
  inlinePreviews,
  lineForPreviewTop,
  placePreviews,
  previewTopForLine,
  sourceRange,
  syncAnchors
} from '../src/renderer/src/modules/docs/source-sync'

describe('blocos da prévia com a linha do texto', () => {
  it('marca o primeiro elemento de cada bloco com a linha dele, sem mudar o HTML', () => {
    const md = ['# Título', '', 'Um parágrafo', 'em duas linhas.', '', '- a', '- b', '', '```js', 'x()', '```', '', '| a | b |', '|---|---|', '| 1 | 2 |'].join('\n')
    const html = markdownWithLines(md)
    expect(html).toContain('<h1 data-line="0">')
    expect(html).toContain('<p data-line="2">Um parágrafo')
    expect(html).toContain('<ul data-line="5">')
    expect(html).toContain('<pre data-line="8">')
    expect(html).toContain('<table data-line="12">')
    // Sem os data-line, é o mesmo HTML do marked.parse.
    expect(html.replace(/ data-line="\d+"/g, '')).toBe(marked.parse(md, { async: false, gfm: true }))
  })

  it('conta as linhas em branco do começo e os links de referência', () => {
    const html = markdownWithLines('\n\nTexto com [link][x].\n\n[x]: https://exemplo.com\n\n## Depois')
    expect(html).toContain('<p data-line="2">Texto com <a href="https://exemplo.com">link</a>')
    expect(html).toContain('<h2 data-line="6">')
  })
})

describe('rolagem sincronizada', () => {
  // Texto montado: sumário (0), título (1), parágrafo (3), include na linha 5 com três blocos, fim (7).
  const sourceLines = [0, 0, 1, 1, 3, 3, 5, 5, 5, 5, 5, 7, 7]
  const blocks = [
    { line: 0, top: 0 },
    { line: 2, top: 40 },
    { line: 4, top: 80 },
    { line: 6, top: 120 },
    { line: 8, top: 200 },
    { line: 10, top: 300 },
    { line: 11, top: 400 }
  ]
  const anchors = syncAnchors(blocks, sourceLines).map(({ line, top }) => ({ line, top }))

  it('amarra cada linha do fonte no primeiro bloco dela', () => {
    expect(anchors).toEqual([
      { line: 1, top: 40 },
      { line: 3, top: 80 },
      { line: 5, top: 120 },
      { line: 7, top: 400 }
    ])
  })

  it('interpola dentro do trecho de um include e volta para a mesma linha', () => {
    expect(previewTopForLine(anchors, 5)).toBe(120)
    expect(previewTopForLine(anchors, 6)).toBe(260)
    expect(lineForPreviewTop(anchors, 260)).toBe(6)
    expect(lineForPreviewTop(anchors, 80)).toBe(3)
    expect(lineForPreviewTop(anchors, 10)).toBe(1)
    expect(previewTopForLine(anchors, 9)).toBe(400)
  })

  it('o bloco clicado vira o trecho do texto, sem as linhas em branco', () => {
    const text = ['# T', '', 'Parágrafo', 'continua', '', '{{> include x.md}}', '', 'Fim'].join('\n')
    const map = [1, 1, 3, 3, 6, 6, 8]
    expect(sourceRange(map, 2, text)).toEqual({ from: 3, to: 4 })
    expect(sourceRange(map, 5, text)).toEqual({ from: 6, to: 6 })
    expect(sourceRange([0, 1], 0, text)).toBeNull()
  })
})

describe('prévias inline das diretivas', () => {
  const source = ['## Guia', '', '{{> include docs/a.md#auth}}', '', '```md', '{{> connector falso}}', '```', '{{> connector billing}}'].join('\n')
  const printMarkdown = ['## Guia', '', '### Auth', 'Peça o token.', '', '```md', '{{> connector falso}}', '```', '### Billing', 'Herda de http.'].join('\n')
  const sourceLines = [1, 1, 3, 3, 3, 5, 6, 7, 8, 8]

  it('tira o trecho de cada diretiva do documento montado, fora dos blocos de código', () => {
    expect(inlinePreviews(source, printMarkdown, sourceLines)).toEqual([
      { line: 3, directive: '{{> include docs/a.md#auth}}', kind: 'include', markdown: '### Auth\nPeça o token.' },
      { line: 8, directive: '{{> connector billing}}', kind: 'connector', markdown: '### Billing\nHerda de http.' }
    ])
  })

  it('acompanha a diretiva quando o texto muda antes da próxima montagem', () => {
    const previews = inlinePreviews(source, printMarkdown, sourceLines)
    const edited = ['Linha nova.', '', ...source.split('\n')].join('\n').replace('{{> include docs/a.md#auth}}', '{{> include docs/b.md}}')
    expect(placePreviews(previews, edited)).toEqual([{ ...previews[1], line: 10 }])
  })
})
