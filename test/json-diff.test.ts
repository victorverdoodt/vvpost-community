import { describe, expect, it } from 'vitest'
import { diffLines, jsonSideBySide, normalizeJson, sideBySide } from '@shared/json-diff'

const apply = (ops: ReturnType<typeof diffLines>) => ({
  a: ops.filter((o) => o.type !== 'added').map((o) => o.text),
  b: ops.filter((o) => o.type !== 'removed').map((o) => o.text)
})

describe('diffLines', () => {
  it('reconstrói os dois lados e acha a menor edição', () => {
    const a = ['a', 'b', 'c', 'a', 'b', 'b', 'a']
    const b = ['c', 'b', 'a', 'b', 'a', 'c']
    const ops = diffLines(a, b)
    expect(apply(ops)).toEqual({ a, b })
    expect(ops.filter((o) => o.type !== 'same')).toHaveLength(5)
  })

  it('cobre lados vazios e entradas aleatórias', () => {
    expect(diffLines([], ['x'])).toEqual([{ type: 'added', text: 'x' }])
    expect(diffLines(['x'], [])).toEqual([{ type: 'removed', text: 'x' }])
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 12) }, () => 'abc'[Math.floor(rnd() * 3)]!)
      const b = Array.from({ length: Math.floor(rnd() * 12) }, () => 'abc'[Math.floor(rnd() * 3)]!)
      expect(apply(diffLines(a, b))).toEqual({ a, b })
    }
  })
})

describe('sideBySide', () => {
  it('pareia remoção e adição como linha alterada e numera cada lado', () => {
    const rows = sideBySide(diffLines(['a', 'b', 'c'], ['a', 'B', 'c', 'd']))
    expect(rows).toEqual([
      { kind: 'same', left: { line: 1, text: 'a' }, right: { line: 1, text: 'a' } },
      { kind: 'changed', left: { line: 2, text: 'b' }, right: { line: 2, text: 'B' } },
      { kind: 'same', left: { line: 3, text: 'c' }, right: { line: 3, text: 'c' } },
      { kind: 'added', left: undefined, right: { line: 4, text: 'd' } }
    ])
  })

  it('esconde trechos iguais longos, mantendo contexto', () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`)
    const b = [...a]
    b[10] = 'mudou'
    const rows = sideBySide(diffLines(a, b), 2)
    expect(rows[0]).toEqual({ kind: 'gap', hidden: 8 })
    expect(rows.filter((r) => r.kind === 'changed')).toHaveLength(1)
    expect(rows.at(-1)).toEqual({ kind: 'gap', hidden: 7 })
  })
})

describe('jsonSideBySide', () => {
  it('ignora diferença só de formatação no JSON', () => {
    expect(normalizeJson('{"a":1,\n "b": [1,2]}')).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}')
    const rows = jsonSideBySide('{"a":1}', '{\n    "a": 1\n}\n')
    expect(rows).toEqual([{ kind: 'gap', hidden: 3 }])
  })

  it('arquivo novo tem só o lado direito', () => {
    const rows = jsonSideBySide(null, '{"a":1}')
    expect(rows.map((r) => r.kind)).toEqual(['added', 'added', 'added'])
  })
})
