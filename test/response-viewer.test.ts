import { describe, expect, it } from 'vitest'
import {
  base64ToBytes,
  bytesToBase64,
  detectLanguage,
  findMatches,
  formatXml,
  hexDump,
  mediaKind,
  parseCookies,
  sandboxedHtml,
  suggestedFileName
} from '../src/renderer/src/design-system/response/body'
import { evaluateJsonPath, JsonPathError, toJsonPath } from '../src/renderer/src/design-system/response/jsonpath'
import { containerKeys, highlight, jsonHighlight, pathKey } from '../src/renderer/src/design-system/response/segments'
import { jsonPathAt, valueAt, variableNameFor } from '../src/renderer/src/design-system/response/json-locate'
import { renderTemplate, TemplateError } from '../src/renderer/src/design-system/response/template'

const store = {
  store: {
    book: [
      { category: 'reference', author: 'Nigel Rees', title: 'Sayings', price: 8.95 },
      { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword', price: 12.99 },
      { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553', price: 8.99 }
    ],
    bicycle: { color: 'red', price: 19.95 },
    'com espaço': 1
  }
}

describe('ResponseViewer: tipo do corpo', () => {
  it('detecta a linguagem do Pretty pelo content-type e pelo texto', () => {
    expect(detectLanguage('application/json; charset=utf-8', '')).toBe('json')
    expect(detectLanguage('application/vnd.api+json', '')).toBe('json')
    expect(detectLanguage('text/html', '')).toBe('html')
    expect(detectLanguage('application/xml', '')).toBe('xml')
    expect(detectLanguage('application/javascript', '')).toBe('javascript')
    expect(detectLanguage('application/yaml', '')).toBe('yaml')
    expect(detectLanguage('text/markdown', '')).toBe('markdown')
    expect(detectLanguage(undefined, '  {"a":1}')).toBe('json')
    expect(detectLanguage('text/plain', '<!DOCTYPE html><html>')).toBe('html')
    expect(detectLanguage(undefined, '<?xml version="1.0"?><a/>')).toBe('xml')
    expect(detectLanguage('text/plain', 'olá')).toBe('text')
  })

  it('escolhe a prévia pelo tipo', () => {
    expect(mediaKind('image/png', '', true)).toBe('image')
    expect(mediaKind('application/pdf', '', true)).toBe('pdf')
    expect(mediaKind('application/octet-stream', '%PDF-1.7', true)).toBe('pdf')
    expect(mediaKind('audio/mpeg', '', true)).toBe('audio')
    expect(mediaKind('video/mp4', '', true)).toBe('video')
    expect(mediaKind('application/octet-stream', 'xx', true)).toBe('binary')
    expect(mediaKind('text/html', '<p>', false)).toBe('html')
    expect(mediaKind('application/json', '{}', false)).toBe('json')
    expect(mediaKind('text/plain', 'oi', false)).toBe('text')
  })

  it('faz o dump hexadecimal como o xxd e converte base64 sem perder bytes', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 65, 66, 67, 255, 127, 0x41])
    const dump = hexDump(bytes).split('\n')
    expect(dump[0]).toBe('00000000  89 50 4e 47 0d 0a 1a 0a  00 01 02 41 42 43 ff 7f  .PNG.......ABC..')
    expect(dump[1]!.startsWith('00000010  41 ')).toBe(true)
    expect(hexDump(bytes, 4).split('\n')).toHaveLength(1)
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes])
  })

  it('indenta XML', () => {
    expect(formatXml('<a><b x="1">t</b><c/><!-- n --></a>')).toBe('<a>\n  <b x="1">t</b>\n  <c/>\n  <!-- n -->\n</a>')
  })

  it('lê os cookies dos Set-Cookie', () => {
    const cookies = parseCookies([
      { name: 'Set-Cookie', value: 'sid=abc; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60' },
      { name: 'set-cookie', value: 'tema=escuro; Domain=example.com; Expires=Wed, 21 Oct 2026 07:28:00 GMT' },
      { name: 'content-type', value: 'text/plain' }
    ])
    expect(cookies).toEqual([
      { name: 'sid', value: 'abc', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: '60' },
      { name: 'tema', value: 'escuro', domain: 'example.com', expires: 'Wed, 21 Oct 2026 07:28:00 GMT', httpOnly: false, secure: false }
    ])
  })

  it('sugere o nome do arquivo ao salvar', () => {
    expect(suggestedFileName([{ name: 'Content-Disposition', value: 'attachment; filename="nota.pdf"' }])).toBe('nota.pdf')
    expect(suggestedFileName([{ name: 'Content-Disposition', value: "attachment; filename*=UTF-8''rel%C3%A1torio.csv" }])).toBe('relátorio.csv')
    expect(suggestedFileName([{ name: 'content-type', value: 'image/png' }])).toBe('resposta.png')
    expect(suggestedFileName([{ name: 'content-type', value: 'application/problem+json' }])).toBe('resposta.json')
    expect(suggestedFileName([])).toBe('resposta.bin')
  })

  it('busca com e sem diferenciar maiúsculas', () => {
    expect(findMatches('Abc abc ABC', 'abc', false)).toEqual([[0, 3], [4, 7], [8, 11]])
    expect(findMatches('Abc abc ABC', 'abc', true)).toEqual([[4, 7]])
    expect(findMatches('aaaa', 'aa', false)).toEqual([[0, 2], [2, 4]])
  })

  it('a prévia de HTML leva um CSP que bloqueia scripts e rede, depois do doctype', () => {
    const out = sandboxedHtml('<!DOCTYPE html><html><script>alert(1)</script></html>')
    expect(out.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src \'none\';')).toBe(true)
    expect(sandboxedHtml('<p>oi</p>').startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
  })
})

describe('ResponseViewer: filtro JSONPath', () => {
  const values = (expr: string) => evaluateJsonPath(store, expr).map((m) => m.value)

  it('cobre os seletores do Postman', () => {
    expect(values('$.store.book[0].author')).toEqual(['Nigel Rees'])
    expect(values('$.store.book[*].author')).toEqual(['Nigel Rees', 'Evelyn Waugh', 'Herman Melville'])
    expect(values('$..price')).toEqual([8.95, 12.99, 8.99, 19.95])
    expect(values('$.store.book[-1].title')).toEqual(['Moby Dick'])
    expect(values('$.store.book[0:2].title')).toEqual(['Sayings', 'Sword'])
    expect(values('$.store.book[0,2].title')).toEqual(['Sayings', 'Moby Dick'])
    expect(values("$.store['com espaço']")).toEqual([1])
    expect(values("$['store']['bicycle'].color")).toEqual(['red'])
    expect(values('$.store.bicycle.*')).toEqual(['red', 19.95])
    expect(values('$.store.book[?(@.price < 9)].title')).toEqual(['Sayings', 'Moby Dick'])
    expect(values("$.store.book[?(@.category == 'fiction' && @.price > 10)].title")).toEqual(['Sword'])
    expect(values('$.store.book[?(@.isbn)].title')).toEqual(['Moby Dick'])
    expect(values('$.store.book[?(@.author =~ /^H/)].title')).toEqual(['Moby Dick'])
    expect(values('$..book[?(@.price > $.store.bicycle.price)]')).toEqual([])
    expect(values('$.nada')).toEqual([])
  })

  it('devolve o caminho de cada resultado e o escreve em JSONPath', () => {
    const [m] = evaluateJsonPath(store, '$..book[?(@.isbn)]')
    expect(m!.path).toEqual(['store', 'book', 2])
    expect(toJsonPath(['store', 'book', 2, 'title'])).toBe('$.store.book[2].title')
    expect(toJsonPath(['com espaço', "it's"])).toBe("$['com espaço']['it\\'s']")
  })

  it('recusa sintaxe inválida', () => {
    expect(() => evaluateJsonPath(store, 'store.book')).toThrow(JsonPathError)
    expect(() => evaluateJsonPath(store, '$.store.book[')).toThrow(JsonPathError)
    expect(() => evaluateJsonPath(store, '$.store.book[?(@.price <)]')).toThrow(JsonPathError)
  })
})

describe('ResponseViewer: realce e DataPicker', () => {
  it('o Pretty de JSON é o texto do JSON.stringify e cada valor tem o caminho', () => {
    const value = { a: [1, { b: 'x' }], c: null, d: {}, e: [] }
    const h = jsonHighlight(value)
    expect(h.text).toBe(JSON.stringify(value, null, 2))
    const pickOf = (text: string) => h.paths[h.segments.find((s) => s.text === text && s.pick !== undefined)!.pick!]
    expect(pickOf('"x"')).toEqual(['a', 1, 'b'])
    expect(pickOf('"b"')).toEqual(['a', 1, 'b'])
    expect(pickOf('null')).toEqual(['c'])
    expect(pickOf('{')).toEqual([])
  })

  it('o resultado do filtro aponta para o caminho original', () => {
    const matches = evaluateJsonPath(store, '$.store.book[*].price')
    const h = jsonHighlight(
      matches.map((m) => m.value),
      matches.map((m) => m.path)
    )
    expect(h.text).toBe(JSON.stringify([8.95, 12.99, 8.99], null, 2))
    expect(h.paths).toEqual([
      ['store', 'book', 0, 'price'],
      ['store', 'book', 1, 'price'],
      ['store', 'book', 2, 'price']
    ])
  })

  it('o realce de cada linguagem não perde nenhum caractere', () => {
    const samples = {
      xml: '<?xml version="1.0"?>\n<a x="1" y=\'2\'><!-- c --><![CDATA[<x>]]>t &amp; u</a>',
      html: '<!doctype html><p class="a">oi<br></p> 1 < 2',
      javascript: 'const a = "x" // c\n/* b */ let n = 1.5e3; `t${a}`',
      yaml: 'a: 1\n- b: "x" # c\nlist:\n  - true\n',
      json: '{"a": [1, true, null, "s"], bad',
      markdown: '# título',
      text: 'texto'
    } as const
    for (const [lang, text] of Object.entries(samples)) {
      const h = highlight(text, lang as keyof typeof samples)
      expect(h.segments.map((s) => s.text).join(''), lang).toBe(text)
    }
    expect(highlight('<a x="1">', 'xml').segments).toContainEqual({ text: 'x', cls: 'text-info' })
    expect(highlight('const x', 'javascript').segments[0]).toEqual({ text: 'const', cls: 'text-accent' })
  })
})

describe('ResponseViewer: template do Visualize', () => {
  const data = { title: 'Lista <1>', items: [{ name: 'a', tags: ['x'] }, { name: 'b', tags: [] }], ok: true }

  it('interpola com escape e sem escape', () => {
    expect(renderTemplate('<h1>{{title}}</h1>{{{title}}}', data)).toBe('<h1>Lista &#60;1&#62;</h1>Lista <1>')
  })

  it('tem each, if, unless, with, else, @index, @key, ../ e this', () => {
    expect(renderTemplate('{{#each items}}{{@index}}:{{name}}({{#each tags}}{{this}}{{else}}-{{/each}}) {{/each}}', data)).toBe(
      '0:a(x) 1:b(-) '
    )
    expect(renderTemplate('{{#each items}}{{../title}}{{/each}}', { title: 'T', items: [1, 2] })).toBe('TT')
    expect(renderTemplate('{{#if ok}}sim{{else}}não{{/if}}{{#unless ok}}!{{/unless}}', data)).toBe('sim')
    expect(renderTemplate('{{#with items.[0]}}{{name}}{{/with}}', data)).toBe('a')
    expect(renderTemplate('{{#each this}}{{@key}}={{this}};{{/each}}', { a: 1, b: 'x' })).toBe('a=1;b=x;')
    expect(renderTemplate('{{! comentário }}{{items.1.name}}', data)).toBe('b')
  })

  it('aponta blocos mal fechados', () => {
    expect(() => renderTemplate('{{#each items}}', data)).toThrow(TemplateError)
    expect(() => renderTemplate('{{/if}}', data)).toThrow(TemplateError)
    expect(() => renderTemplate('{{#loop x}}{{/loop}}', data)).toThrow(TemplateError)
  })
})

describe('Menu de valores do JSON', () => {
  it('acha o valor sob o cursor no body da request', () => {
    const body = '{\n  "user": { "name": "Ana", "tags": ["a", "b"] },\n  "n": 1\n}'
    expect(jsonPathAt(body, body.indexOf('"Ana"') + 2)).toEqual(['user', 'name'])
    expect(jsonPathAt(body, body.indexOf('"name"') + 1)).toEqual(['user', 'name'])
    expect(jsonPathAt(body, body.indexOf('"b"'))).toEqual(['user', 'tags', 1])
    expect(jsonPathAt(body, body.indexOf('1\n'))).toEqual(['n'])
    expect(jsonPathAt(body, 0)).toEqual([])
    expect(jsonPathAt('{ "a": ', 3)).toBeNull()
    expect(valueAt(JSON.parse(body), ['user', 'tags', 1])).toBe('b')
  })

  it('sugere o nome da variável pelo caminho', () => {
    expect(variableNameFor(['data', 'accessToken'])).toBe('ACCESS_TOKEN')
    expect(variableNameFor(['items', 0])).toBe('ITEMS_0')
    expect(variableNameFor(['items', 0, 'user-id'])).toBe('USER_ID')
    expect(variableNameFor([])).toBe('VALOR')
    expect(variableNameFor(['2fa'])).toBe('_2FA')
  })

  it('recolhe nós e o "Recolher tudo" deixa só a raiz aberta', () => {
    const value = { a: { b: [1, 2] }, c: [], d: 1 }
    const all = containerKeys(value)
    expect([...all]).toEqual([pathKey(['a']), pathKey(['a', 'b'])])
    expect(jsonHighlight(value, null, all).text).toBe('{\n  "a": {… 1},\n  "c": [],\n  "d": 1\n}')
    const open = new Set(all)
    open.delete(pathKey(['a']))
    expect(jsonHighlight(value, null, open).text).toBe('{\n  "a": {\n    "b": [… 2]\n  },\n  "c": [],\n  "d": 1\n}')
    const folded = jsonHighlight(value, null, all).segments.find((s) => s.folded)
    expect(folded?.text).toBe('{… 1}')
  })
})
