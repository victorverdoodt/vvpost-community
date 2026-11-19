import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isWatchedPath, watchWorkspace, type WorkspaceWatcher } from '../src/main/workspace/watch'

describe('watcher do workspace', () => {
  let dir = ''
  let watcher: WorkspaceWatcher | null = null
  afterEach(() => {
    watcher?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('só os arquivos que o VVPost lê, fora de pastas de build, dependências e Git', () => {
    expect(isWatchedPath('docs/arquitetura.md')).toBe(true)
    expect(isWatchedPath('flows/erp/consultar.flow.vvpost.json')).toBe(true)
    expect(isWatchedPath('docs/diagramas/fila.mmd')).toBe(true)
    expect(isWatchedPath('src/index.ts')).toBe(false)
    expect(isWatchedPath('node_modules/x/package.json')).toBe(false)
    expect(isWatchedPath('.git/config.json')).toBe(false)
    expect(isWatchedPath('.vvpost/history.json')).toBe(false)
    expect(isWatchedPath('estoque/out/app.json')).toBe(false)
  })

  it('avisa, num lote só, o que mudou no disco, inclusive em pasta criada depois', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vvpost-watch-'))
    mkdirSync(join(dir, 'docs'))
    mkdirSync(join(dir, 'node_modules/pacote'), { recursive: true })
    writeFileSync(join(dir, 'docs/a.md'), '# A\n')
    const batches: string[][] = []
    watcher = watchWorkspace(dir, (files) => batches.push(files))
    await new Promise((r) => setTimeout(r, 100))
    writeFileSync(join(dir, 'docs/a.md'), '# A mudou\n')
    writeFileSync(join(dir, 'node_modules/pacote/package.json'), '{}')
    writeFileSync(join(dir, 'leia.txt'), 'x')
    await new Promise((r) => setTimeout(r, 400))
    expect(batches).toEqual([['docs/a.md']])

    mkdirSync(join(dir, 'flows/erp'), { recursive: true })
    await new Promise((r) => setTimeout(r, 200))
    writeFileSync(join(dir, 'flows/erp/erp.flow.vvpost.json'), '{}')
    await expect.poll(() => batches.flat(), { timeout: 2000 }).toContain('flows/erp/erp.flow.vvpost.json')
  })
})
