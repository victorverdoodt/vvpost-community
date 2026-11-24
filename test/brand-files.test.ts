import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandCodeFindings, listBrandFiles, readBrandFile, writeBrandFile } from '@vvpost/core/brand'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workspace(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-brand-files-'))
  dirs.push(dir)
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}

const TOKENS = {
  color: {
    $type: 'color',
    bg: { $value: '#0b0c0f' },
    text: { $value: '#e7eaf0', $description: 'Texto principal' },
    link: { $value: '{color.text}' },
    quebrado: { $value: '{color.nada}' }
  },
  space: { '2': { $type: 'dimension', $value: { value: 8, unit: 'px' } } },
  $extensions: {
    vvpost: {
      modes: { light: { 'color.bg': '#ffffff', 'color.text': '#1b1f24' } },
      contrast: [{ fg: 'color.text', bg: 'color.bg' }],
      code: { 'color.bg': ['--bg'] },
      sources: ['web/**/*.css']
    }
  }
}
const noLeak = () => false

describe('arquivo de tokens na aba do app', () => {
  it('lista e lê formatado para a tela: valor, alias, modos, amostra, código e contraste', async () => {
    const dir = workspace({ 'brand/vv.tokens.json': TOKENS })
    expect(await listBrandFiles(dir)).toEqual(['brand/vv.tokens.json'])
    const view = await readBrandFile(dir, 'brand/vv.tokens.json')
    expect(view.name).toBe('vv')
    expect(view.modes).toEqual(['base', 'light'])
    const byName = Object.fromEntries(view.tokens.map((t) => [t.name, t]))
    expect(byName['color.bg']).toMatchObject({ value: '#0b0c0f', modes: { light: '#ffffff' }, swatch: { base: '#0b0c0f', light: '#ffffff' }, code: ['--bg'] })
    expect(byName['color.link']).toMatchObject({ value: '#e7eaf0', alias: '{color.text}' })
    expect(byName['color.text']!.description).toBe('Texto principal')
    expect(byName['space.2']).toMatchObject({ value: '8px', type: 'dimension' })
    expect(byName['color.quebrado']!.value).toBe('')
    expect(view.problems.map((p) => p.code)).toContain('tokens-invalid')
    expect(view.contrast.map((c) => `${c.mode} ${c.ok}`)).toEqual(['base true', 'light true'])
    expect(view.sources).toEqual(['web/**/*.css'])
  })

  it('o brand/ da raiz do workspace aparece para o projeto sem um próprio', async () => {
    const root = workspace({ 'brand/vv.tokens.json': TOKENS, 'api/vvpost.project.json': { name: 'API' } })
    const project = join(root, 'api')
    expect(await listBrandFiles(project)).toEqual(['../brand/vv.tokens.json'])
    expect((await readBrandFile(project, '../brand/vv.tokens.json')).tokens.length).toBeGreaterThan(0)
  })

  it('só abre e grava arquivos da lista', async () => {
    const dir = workspace({ 'brand/vv.tokens.json': TOKENS, 'segredo.json': '{}' })
    await expect(readBrandFile(dir, 'segredo.json')).rejects.toThrow('não é um arquivo de tokens')
    await expect(readBrandFile(dir, '../../etc/passwd')).rejects.toThrow('não é um arquivo de tokens')
    await expect(writeBrandFile(dir, { file: 'segredo.json', text: '{}' }, noLeak)).rejects.toThrow('não é um arquivo de tokens')
  })

  it('grava JSON válido, recusa JSON quebrado, segredo e mudança feita fora', async () => {
    const dir = workspace({ 'brand/vv.tokens.json': TOKENS })
    const file = 'brand/vv.tokens.json'
    const path = join(dir, file)
    const before = readFileSync(path, 'utf8')
    await expect(writeBrandFile(dir, { file, text: '{ "color": ', previous: before }, noLeak)).rejects.toThrow('JSON inválido')
    await expect(writeBrandFile(dir, { file, text: '{"x": "s3cr3t"}', previous: before }, (t) => t.includes('s3cr3t'))).rejects.toThrow('segredo')
    await expect(writeBrandFile(dir, { file, text: '{}', previous: '{"outro": 1}' }, noLeak)).rejects.toThrow('mudou fora do app')
    expect(readFileSync(path, 'utf8')).toBe(before)
    const next = JSON.stringify({ color: { $type: 'color', bg: { $value: '#111111' } } }, null, 2)
    expect(await writeBrandFile(dir, { file, text: next, previous: before }, noLeak)).toEqual({ file })
    expect(readFileSync(path, 'utf8')).toBe(`${next}\n`)
    expect((await readBrandFile(dir, file)).tokens.map((t) => t.value)).toEqual(['#111111'])
  })

  it('a conferência do código traz só os achados brand-*', async () => {
    const dir = workspace({ 'brand/vv.tokens.json': TOKENS, 'web/ui.css': ':root { --bg: #000000; }\n.a { color: #0b0c0f; }\n' })
    const { items, scanned } = await brandCodeFindings(dir)
    expect(scanned).toBe(1)
    expect(items.map((i) => `${i.code} ${i.file}:${i.line}`)).toEqual(['brand-code-drift web/ui.css:1', 'brand-hardcoded-color web/ui.css:2'])
  })
})
