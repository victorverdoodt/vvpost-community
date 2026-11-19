import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = 'packages/core/src'
/**
 * O que o motor pode importar: Node, o próprio pacote, os schemas, o undici e o marked (o
 * Markdown do "Enviar para…", JS puro e sem dependências).
 */
const ALLOWED = /^(node:|\.{1,2}\/|@vvpost\/schemas$|undici$|marked$)/

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('@vvpost/core', () => {
  it('só importa Node, o próprio pacote, @vvpost/schemas, undici e marked (nada do app, do Electron ou do renderer)', () => {
    const offenders: string[] = []
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/(?:from\s+|(?:^|[\s;(=])import\s*\(?\s*|require\(\s*)['"]([^'"]+)['"]/gm)) {
        const spec = m[1]!
        if (!ALLOWED.test(spec)) offenders.push(`${file}: ${spec}`)
        // Um caminho relativo não pode sair do pacote.
        if (spec.startsWith('.') && !join(file, '..', spec).startsWith(join(ROOT))) offenders.push(`${file}: ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
