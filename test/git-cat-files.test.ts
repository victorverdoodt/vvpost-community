import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catFiles, parseBatch } from '../src/main/workspace/git'

describe('git cat-file --batch', () => {
  it('lê o conteúdo pelo tamanho em bytes, com acento e quebra de linha', () => {
    const body = Buffer.from('olá\nmundo\n')
    const out = Buffer.concat([
      Buffer.from(`abc123 blob ${body.length}\n`),
      body,
      Buffer.from('\nmissing:x missing\ndef456 tree 10\n'),
      Buffer.alloc(10),
      Buffer.from('\n')
    ])
    expect(parseBatch(out, 3)).toEqual(['olá\nmundo\n', null, null])
  })

  it('busca vários arquivos de um commit num processo só', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'catfiles-'))
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    mkdirSync(join(dir, 'pasta'))
    writeFileSync(join(dir, 'pasta', 'ação.md'), 'primeiro')
    writeFileSync(join(dir, 'b.txt'), '')
    git('add', '.')
    git('commit', '-qm', 'x')
    const head = git('rev-parse', 'HEAD').trim()
    const got = await catFiles(dir, [`${head}:pasta/ação.md`, `${head}:b.txt`, `${head}:nada`])
    expect(got).toEqual(['primeiro', '', null])
  })
})
