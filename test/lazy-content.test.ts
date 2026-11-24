import { describe, expect, it } from 'vitest'
import { LruCache, wrapTables } from '../src/renderer/src/design-system/content/lazy-content'

describe('wrapTables', () => {
  it('envolve cada tabela de primeiro nível num div.md-table', () => {
    const html = '<p>a</p><table data-line="2"><tr><td>1</td></tr></table><table><tr><td>2</td></tr></table>'
    expect(wrapTables(html)).toBe(
      '<p>a</p><div class="md-table"><table data-line="2"><tr><td>1</td></tr></table></div><div class="md-table"><table><tr><td>2</td></tr></table></div>'
    )
  })

  it('não envolve a tabela de dentro de outra (HTML escrito à mão)', () => {
    const html = '<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>'
    expect(wrapTables(html)).toBe('<div class="md-table"><table><tr><td><table><tr><td>x</td></tr></table></td></tr></table></div>')
  })

  it('deixa o HTML sem tabela como está', () => {
    expect(wrapTables('<p>tablet</p><pre><code>&lt;table&gt;</code></pre>')).toBe('<p>tablet</p><pre><code>&lt;table&gt;</code></pre>')
  })
})

describe('LruCache', () => {
  it('descarta o usado há mais tempo quando passa do limite', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(1)
    expect(cache.get('c')).toBe(3)
    expect(cache.size).toBe(2)
  })
})
