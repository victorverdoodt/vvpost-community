import { describe, expect, it } from 'vitest'
import { fitPayload, MAX_RESPONSE_CHARS, sliceText } from '../src/main/mcp/budget'

// O teto de resposta do MCP: corta por item inteiro e diz o que cortou, em vez de o cliente cortar no meio do JSON.

describe('teto de resposta do MCP', () => {
  it('payload que cabe volta igual (o mesmo objeto)', () => {
    const small = { ok: true, items: [1, 2, 3] }
    expect(fitPayload(small)).toBe(small)
  })

  it('lista grande perde itens inteiros do fim, e truncated diz quantos ficaram', () => {
    const items = Array.from({ length: 2000 }, (_, i) => ({ id: `item-${i}`, text: 'x'.repeat(40) }))
    const fitted = fitPayload({ ok: true, items }) as { ok: boolean; items: typeof items; truncated: { originalChars: number; cut: string[]; hint: string } }
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS)
    expect(fitted.ok).toBe(true)
    expect(fitted.items[0]).toEqual(items[0])
    expect(fitted.items.length).toBeLessThan(2000)
    expect(fitted.truncated.originalChars).toBe(JSON.stringify({ ok: true, items }).length)
    expect(fitted.truncated.cut).toEqual([`items: ${fitted.items.length} de 2000 itens`])
    expect(fitted.truncated.hint).toContain('offset')
  })

  it('texto grande é cortado no fim, com a marca', () => {
    const fitted = fitPayload({ markdown: 'a'.repeat(100_000), file: 'docs/x.md' }) as { markdown: string; file: string; truncated: { cut: string[] } }
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS)
    expect(fitted.file).toBe('docs/x.md')
    expect(fitted.markdown.endsWith('… [cortado]')).toBe(true)
    expect(fitted.truncated.cut[0]).toMatch(/^markdown: \d+ de 100000 caracteres$/)
  })

  it('sliceText devolve o trecho e o offset para continuar, e nada a mais quando cabe', () => {
    expect(sliceText('curto')).toEqual({ text: 'curto' })
    const long = 'x'.repeat(25) + 'y'.repeat(25)
    expect(sliceText(long, 0, 30)).toEqual({ text: long.slice(0, 30), truncated: { total: 50, from: 0, to: 30, next: { offset: 30 } } })
    expect(sliceText(long, 30, 30)).toEqual({ text: long.slice(30), truncated: { total: 50, from: 30, to: 50 } })
  })
})
