import { describe, expect, it } from 'vitest'
import { findMatches, locateMatches, wrapIndex } from '../src/renderer/src/design-system/find/find'

/** Recorta cada ocorrência de volta dos pedaços, como o Range faria no DOM. */
function cut(pieces: string[], query: string, caseSensitive = false): string[] {
  const matches = findMatches(pieces.join(''), query, caseSensitive)
  return locateMatches(
    pieces.map((p) => p.length),
    matches
  ).map(([s, e]) => {
    if (s.piece === e.piece) return pieces[s.piece]!.slice(s.offset, e.offset)
    return pieces[s.piece]!.slice(s.offset) + pieces.slice(s.piece + 1, e.piece).join('') + pieces[e.piece]!.slice(0, e.offset)
  })
}

describe('busca (Ctrl+F)', () => {
  it('acha as ocorrências sem diferenciar maiúsculas, ou diferenciando', () => {
    expect(findMatches('Token token TOKEN', 'token', false)).toEqual([
      [0, 5],
      [6, 11],
      [12, 17]
    ])
    expect(findMatches('Token token TOKEN', 'token', true)).toEqual([[6, 11]])
    expect(findMatches('abc', '', false)).toEqual([])
    expect(findMatches('aaaa', 'aa', false)).toHaveLength(2)
  })

  it('próxima e anterior dão a volta', () => {
    expect(wrapIndex(0, 3)).toBe(0)
    expect(wrapIndex(3, 3)).toBe(0)
    expect(wrapIndex(-1, 3)).toBe(2)
    expect(wrapIndex(5, 0)).toBe(-1)
  })

  it('localiza ocorrências que atravessam vários nós de texto (realce de sintaxe)', () => {
    const pieces = ['{"', 'access', '_token', '": "', 'abc', '"}']
    expect(cut(pieces, 'access_token')).toEqual(['access_token'])
    expect(cut(pieces, '"')).toEqual(['"', '"', '"', '"'])
    expect(cut(pieces, 'token": "abc')).toEqual(['token": "abc'])
  })

  it('o fim de uma ocorrência fica no nó em que ela termina, e a próxima começa no seguinte', () => {
    const points = locateMatches([3, 3], findMatches('abcabc', 'abc', false))
    expect(points).toEqual([
      [
        { piece: 0, offset: 0 },
        { piece: 0, offset: 3 }
      ],
      [
        { piece: 1, offset: 0 },
        { piece: 1, offset: 3 }
      ]
    ])
  })

  it('pula pedaços vazios', () => {
    expect(cut(['ab', '', 'c', '', 'd'], 'bcd')).toEqual(['bcd'])
  })
})
