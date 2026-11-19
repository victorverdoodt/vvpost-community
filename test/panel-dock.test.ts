import { describe, expect, it } from 'vitest'
import { dropSide } from '../src/renderer/src/design-system/layout/dock'

const rect = { left: 100, top: 50, width: 900, height: 600 }
const at = (fx: number, fy: number) => [rect.left + rect.width * fx, rect.top + rect.height * fy] as const

describe('onde um painel arrastado cai (drop overlay como no VS Code)', () => {
  it('esquerda, direita e embaixo: o terço de baixo é embaixo; no resto, a metade', () => {
    const sides = ['left', 'right', 'bottom'] as const
    expect(dropSide(...at(0.2, 0.5), rect, sides)).toBe('left')
    expect(dropSide(...at(0.8, 0.5), rect, sides)).toBe('right')
    expect(dropSide(...at(0.2, 0.9), rect, sides)).toBe('bottom')
    expect(dropSide(...at(0.8, 0.2), rect, sides)).toBe('right')
  })

  it('em cima, esquerda e direita: o terço de cima é em cima', () => {
    const sides = ['top', 'left', 'right'] as const
    expect(dropSide(...at(0.5, 0.1), rect, sides)).toBe('top')
    expect(dropSide(...at(0.3, 0.6), rect, sides)).toBe('left')
    expect(dropSide(...at(0.7, 0.9), rect, sides)).toBe('right')
  })

  it('só em cima e embaixo: a área se divide ao meio', () => {
    expect(dropSide(...at(0.5, 0.4), rect, ['top', 'bottom'])).toBe('top')
    expect(dropSide(...at(0.5, 0.6), rect, ['top', 'bottom'])).toBe('bottom')
  })

  it('fora da área, ou na metade sem lado, não move', () => {
    expect(dropSide(50, 60, rect, ['left', 'right'])).toBeNull()
    expect(dropSide(...at(0.8, 0.5), rect, ['left'])).toBeNull()
    expect(dropSide(...at(0.2, 0.5), rect, ['left'])).toBe('left')
    expect(dropSide(...at(0.5, 0.5), rect, [])).toBeNull()
  })
})
