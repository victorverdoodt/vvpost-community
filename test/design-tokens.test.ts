import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Critérios de aceite do design system que não dependem do app
// rodando: contraste dos pares de tokens e nenhuma cor fora dos tokens nos módulos.
const renderer = join(__dirname, '../src/renderer/src')
const tokens = Object.fromEntries(
  [
    ...readFileSync(join(renderer, 'design-system/tokens/tokens.css'), 'utf8').matchAll(
      /--color-([\w-]+):\s*(#[0-9a-f]{6})/gi
    )
  ].map((m) => [m[1], m[2]])
)

function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const channel = (i: number) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  }
  const [x, y] = [lum(a), lum(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.tsx') ? [path] : []
  })
}

describe('tokens do design system', () => {
  it('todo texto sobre as superfícies passa no WCAG AA (4,5:1)', () => {
    for (const text of ['fg', 'muted', 'faint', 'accent', 'cyan', 'success', 'warning', 'danger', 'info']) {
      for (const surface of ['surface', 'panel', 'elevated']) {
        expect(contrast(tokens[text], tokens[surface]), `${text} sobre ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('o texto do botão primário passa no AA em todos os estados', () => {
    for (const state of ['accent', 'accent-hover', 'accent-pressed']) {
      expect(contrast(tokens.surface, tokens[state]), state).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('os módulos e o shell só usam cores dos tokens', () => {
    const raw =
      /\b(?:bg|text|border|ring|outline|from|to|fill|stroke)-(?:white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan-\d|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d+)?\b/
    const offenders = [...files(join(renderer, 'modules')), ...files(join(renderer, 'app'))]
      .map((path) => [path, readFileSync(path, 'utf8').match(raw)?.[0]] as const)
      .filter(([, match]) => match)
      .map(([path, match]) => `${path.slice(renderer.length + 1)}: ${match}`)
    expect(offenders).toEqual([])
  })
})
