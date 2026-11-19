import { describe, expect, it } from 'vitest'
import { matchesQuery, synonymsOf } from '../src/renderer/src/design-system/navigation/command-search'
import { cleanEntries, flattenItems, itemForShortcut, menuHeader, separator, type ContextMenuEntries } from '../src/renderer/src/design-system/navigation/menu-entries'
import { formatShortcut, isTextEditingShortcut, matchesShortcut, Shortcut } from '../src/renderer/src/design-system/navigation/shortcuts'
import { copyName, freeId } from '../src/renderer/src/lib/clipboard'
import { parseCurl, toCode } from '../src/renderer/src/lib/request-code'
import { parseQuery, pathParams, withQuery } from '../src/renderer/src/modules/quick-request/draft'

const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods
})

describe('atalhos', () => {
  it('Mod é Ctrl no Windows e Linux e Cmd no macOS', () => {
    expect(matchesShortcut(key('c', { ctrlKey: true, shiftKey: true }), Shortcut.copyAsCurl, false)).toBe(true)
    expect(matchesShortcut(key('C', { metaKey: true, shiftKey: true }), Shortcut.copyAsCurl, true)).toBe(true)
    // Modificador a mais não casa: Ctrl+Shift+C não é Ctrl+C.
    expect(matchesShortcut(key('c', { ctrlKey: true, shiftKey: true }), Shortcut.copy, false)).toBe(false)
    expect(matchesShortcut(key('c', { metaKey: true }), Shortcut.copy, false)).toBe(false)
    expect(matchesShortcut(key('F2'), Shortcut.rename, false)).toBe(true)
  })

  it('mostra o atalho no formato de cada sistema', () => {
    expect(formatShortcut(Shortcut.copyAsCurl, false)).toBe('Ctrl+Shift+C')
    expect(formatShortcut(Shortcut.copyAsCurl, true)).toBe('⌘⇧C')
    expect(formatShortcut(Shortcut.remove, false)).toBe('Del')
    expect(formatShortcut(Shortcut.searchProject, false)).toBe('Ctrl+Shift+F')
    expect(formatShortcut(Shortcut.newRequest, true)).toBe('⌘N')
  })

  it('atalhos de edição de texto ficam com o campo', () => {
    expect(isTextEditingShortcut(Shortcut.copy)).toBe(true)
    expect(isTextEditingShortcut(Shortcut.remove)).toBe(true)
    expect(isTextEditingShortcut(Shortcut.copyAsCurl)).toBe(false)
    expect(isTextEditingShortcut(Shortcut.reopenTab)).toBe(false)
  })
})

describe('itens de menu', () => {
  const run = () => {}
  const entries: ContextMenuEntries = [
    separator,
    menuHeader('Endpoint'),
    { id: 'a', label: 'Abrir', run },
    false,
    null,
    '',
    separator,
    separator,
    { id: 'b', label: 'Copiar como código', items: [{ id: 'py', label: 'Python', run, shortcut: 'Mod+Alt+P' }] },
    { id: 'c', label: 'Excluir', run, disabled: true, shortcut: Shortcut.remove },
    { id: 'd', label: 'Duplicar', run, shortcut: Shortcut.duplicate },
    separator
  ]

  it('limpa os itens condicionais e os separadores sobrando', () => {
    const clean = cleanEntries(entries)
    expect(clean.map((e) => ('type' in e ? e.type : e.id))).toEqual(['header', 'a', 'separator', 'b', 'c', 'd'])
    // Título sem itens logo embaixo some.
    expect(cleanEntries([menuHeader('Vazio'), separator, { id: 'x', label: 'X', run }]).length).toBe(1)
  })

  it('a paleta recebe os itens habilitados, com o caminho dos submenus', () => {
    expect(flattenItems(entries).map((i) => i.path)).toEqual(['Abrir', 'Copiar como código: Python', 'Duplicar'])
  })

  it('acha o item pelo atalho, sem os desabilitados', () => {
    expect(itemForShortcut(entries, key('d', { ctrlKey: true }))?.id).toBe('d')
    expect(itemForShortcut(entries, key('Delete'))).toBeUndefined()
  })
})

describe('busca da paleta', () => {
  it('cada palavra precisa aparecer, com acento ou sem', () => {
    expect(matchesQuery('fechar outras', { title: 'Fechar as outras', group: 'Quick Request' })).toBe(true)
    expect(matchesQuery('historico', { title: 'Abrir Histórico', group: 'Módulo' })).toBe(true)
    expect(matchesQuery('fechar todas', { title: 'Fechar as outras', group: 'Quick Request' })).toBe(false)
  })

  it('sinônimos: "rodar teste", "executar cenário", "testar endpoint"', () => {
    const runScenarios = { title: 'Rodar os cenários de Usuários', group: 'Tests', keywords: ['testar', 'endpoint'] }
    expect(matchesQuery('rodar teste', runScenarios)).toBe(true)
    expect(matchesQuery('executar cenário', runScenarios)).toBe(true)
    expect(matchesQuery('testar endpoint', runScenarios)).toBe(true)
    expect(matchesQuery('testar endpoint', { title: 'Enviar', group: 'Quick Request', keywords: ['request'] })).toBe(true)
    expect(matchesQuery('apagar', { title: 'Excluir…', group: 'Catálogo' })).toBe(true)
    expect(synonymsOf('cenários')).toContain('teste')
  })
})

describe('copiar e colar como código', () => {
  const req = {
    method: 'POST' as const,
    url: 'https://api.test/users?q=a b',
    headers: [{ name: 'Authorization', value: "Bearer {{TOKEN}}'x" }],
    body: '{"nome":"VV"}'
  }

  it('cURL ida e volta', () => {
    const curl = toCode('curl', req)
    expect(curl.startsWith("curl -X POST 'https://api.test/users?q=a b'")).toBe(true)
    expect(parseCurl(curl)).toEqual(req)
  })

  it('GET simples sai sem -X', () => {
    expect(toCode('curl', { method: 'GET', url: 'http://x/y', headers: [] })).toBe("curl 'http://x/y'")
  })

  it('cola os formatos comuns de cURL', () => {
    expect(parseCurl(`curl https://a.test/x -H "Accept: application/json" -d 'a=1'`)).toMatchObject({
      method: 'POST',
      url: 'https://a.test/x',
      headers: [{ name: 'Accept', value: 'application/json' }],
      body: 'a=1'
    })
    expect(parseCurl('curl -I https://a.test')?.method).toBe('HEAD')
    expect(parseCurl('não é curl')).toBeNull()
  })

  it('fetch, Python e HTTPie levam método, headers e corpo', () => {
    expect(toCode('fetch', req)).toContain('method: "POST"')
    expect(toCode('python', req)).toContain('requests.request("POST", "https://api.test/users?q=a b", headers=headers, data=data.encode("utf-8"))')
    expect(toCode('httpie', req)).toContain("http POST 'https://api.test/users?q=a b'")
  })
})

describe('corpo estruturado como código', () => {
  const multipart = {
    method: 'POST',
    url: 'https://api.test/up',
    headers: [],
    payload: {
      mode: 'multipart' as const,
      fields: [
        { name: 'nome', value: 'Ana' },
        { name: 'foto', file: '/tmp/foto.png', contentType: 'image/png' }
      ]
    }
  }

  it('form-data vira -F no cURL e volta', () => {
    const curl = toCode('curl', multipart)
    expect(curl).toContain("-F 'nome=Ana'")
    expect(curl).toContain("-F 'foto=@/tmp/foto.png;type=image/png'")
    expect(parseCurl(curl)).toEqual(multipart)
  })

  it('urlencoded, binário e os outros alvos', () => {
    const form = { method: 'POST', url: 'https://api.test/f', headers: [], payload: { mode: 'urlencoded' as const, fields: [{ name: 'a', value: '1 2' }] } }
    expect(parseCurl(toCode('curl', form))).toEqual(form)
    const binary = { method: 'PUT', url: 'https://api.test/b', headers: [], payload: { mode: 'binary' as const, file: '/tmp/x.bin' } }
    expect(toCode('curl', binary)).toContain("--data-binary '@/tmp/x.bin'")
    expect(parseCurl(toCode('curl', binary))).toEqual(binary)
    expect(toCode('python', multipart)).toContain('files=files')
    expect(toCode('fetch', multipart)).toContain('new FormData()')
    expect(toCode('httpie', multipart)).toContain("--multipart POST 'https://api.test/up' 'nome=Ana' 'foto@/tmp/foto.png'")
  })
})

describe('parâmetros da URL (aba Params)', () => {
  it('lê e reescreve a query, mantendo {{VAR}} legível', () => {
    const url = '{{BASE}}/users/{id}?page=2&q=a%20b#topo'
    expect(parseQuery(url)).toEqual([
      { name: 'page', value: '2' },
      { name: 'q', value: 'a b' }
    ])
    expect(withQuery(url, [{ name: 'page', value: '{{PAGE}}' }, { name: '', value: 'x' }])).toBe('{{BASE}}/users/{id}?page={{PAGE}}#topo')
    expect(withQuery('http://x/y?a=1', [])).toBe('http://x/y')
  })

  it('parâmetros de rota: {id} e :id, sem confundir com {{VAR}}', () => {
    expect(pathParams('{{BASE}}/users/{id}/posts/:postId?x={y}')).toEqual(['id', 'postId'])
  })
})

describe('nomes de cópia', () => {
  it('ids e nomes livres', () => {
    expect(freeId('Cenário da request', [])).toBe('cenario-da-request')
    expect(freeId('ok', ['ok', 'ok-2'])).toBe('ok-3')
    expect(copyName('Cobrança', ['Cobrança (cópia)'])).toBe('Cobrança (cópia 2)')
  })
})
