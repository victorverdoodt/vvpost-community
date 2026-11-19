import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { contrastRatio, loadBrand, parseColor, parseObjectLiteral, parseTokensFile } from '@vvpost/core/brand'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { composeDocumentation } from '@vvpost/core/docs'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { lintWorkspace } from '../src/main/lint'
import { createMcpServer } from '../src/main/mcp/server'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workspace(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-brand-'))
  dirs.push(dir)
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}

const color = (v: string) => ({ $type: 'color', $value: v })
const px = (n: number) => ({ $type: 'dimension', $value: { value: n, unit: 'px' } })

/** O padrão visual VV, como está no vv-ui.css do VVCloud e do VVBuilder (escuro padrão, claro como modo). */
const VV = {
  color: {
    bg: color('#0b0c0f'),
    panel: color('#11141a'),
    elevated: color('#171b23'),
    text: { ...color('#e7eaf0'), $description: 'Texto principal' },
    muted: color('#929bad'),
    faint: color('#7d8498'),
    accent: { ...color('#8b7cff'), $description: 'Ação primária, seleção e foco' },
    'on-accent': color('#0b0c0f'),
    info: color('#6aa9ff'),
    warn: color('#e8b45b'),
    link: color('{color.info}')
  },
  font: { ui: { $type: 'fontFamily', $value: ['Inter Variable', 'Inter', 'system-ui', 'sans-serif'] }, mono: { $type: 'fontFamily', $value: ['JetBrains Mono Variable', 'monospace'] } },
  space: { '1': px(4), '2': px(8), '4': px(16) },
  $extensions: {
    vvpost: {
      modes: { light: { 'color.bg': '#f6f7f9', 'color.panel': '#ffffff', 'color.text': '#1b1f24', 'color.faint': '#8a93a0', 'color.accent': '#6d5dfc', 'color.on-accent': '#ffffff', 'color.warn': '#b26b00' } },
      contrast: [
        { fg: 'color.text', bg: 'color.bg', min: 4.5 },
        { fg: 'color.on-accent', bg: 'color.accent', min: 4.5 },
        { fg: 'color.faint', bg: 'color.panel', min: 4.5 },
        ['color.warn', 'color.panel', 4.5]
      ],
      code: { 'color.bg': ['--bg'], 'color.accent': ['--accent'], 'color.info': '--info' },
      sources: ['web/**/*.{css,html}'],
      ignore: ['web/vendor-copy/**']
    }
  }
}

/** Marca de uma clínica fictícia (rosé), no formato de um theme.tsx de MUI real. */
const ROSE = {
  color: {
    $type: 'color',
    primary: { $value: '#bd948a', $description: 'Rosé da clínica: botões e destaques' },
    'primary-light': { $value: '#f5eeed' },
    secondary: { $value: '#d4b6b2' },
    'on-primary': { $value: '#ffffff' },
    text: { $value: '#262626' },
    bg: { $value: '#ffffff' }
  },
  font: { ui: { $type: 'fontFamily', $value: ['Quicksand', 'sans-serif'] } },
  $extensions: {
    vvpost: {
      contrast: [
        { fg: 'color.on-primary', bg: 'color.primary' },
        { fg: 'color.text', bg: 'color.bg' }
      ],
      code: { 'color.primary': ['palette.primary.main', 'palette.secondary.dark'], 'color.secondary': ['palette.primary.dark', 'palette.secondary.main'] },
      sources: ['app/**/*.tsx']
    }
  }
}

const THEME_TSX = `import { createTheme } from '@mui/material/styles'

const theme = createTheme({
  palette: {
    primary: {
      main: '#bd948a',
      light: '#f5eeed',
      dark: '#d4b6b2', // mais claro que o main
      contrastText: '#fff',
    },
    secondary: { main: '#d4b6b2', dark: '#bd948b' },
    error: { main: '#EF5350' },
  },
  typography: { fontFamily: 'Roboto, sans-serif', button: { textTransform: 'none' } },
})
export default theme
`

describe('tokens DTCG', () => {
  it('resolve grupos, $type herdado, alias e modos', () => {
    const f = parseTokensFile('brand/vv.tokens.json', JSON.stringify(VV, null, 2))
    expect(f.problems.filter((p) => p.code === 'tokens-invalid')).toEqual([])
    const byName = new Map(f.tokens.map((t) => [t.name, t]))
    expect(byName.get('color.link')).toMatchObject({ type: 'color', value: '{color.info}', resolved: '#6aa9ff' })
    expect(byName.get('color.bg')?.modes).toEqual({ light: '#f6f7f9' })
    expect(byName.get('space.2')?.line).toBeGreaterThan(1)
    expect(f.modes).toEqual(['base', 'light'])
    const u = parseTokensFile('brand/clinica.tokens.json', JSON.stringify(ROSE))
    expect(u.tokens.find((t) => t.name === 'color.primary')).toMatchObject({ type: 'color', description: 'Rosé da clínica: botões e destaques' })
  })

  it('acusa formato, alias quebrado, ciclo, tipo e valor inválidos', () => {
    const f = parseTokensFile(
      'brand/x.tokens.json',
      JSON.stringify({
        color: { a: color('{color.b}'), b: color('{color.a}'), c: color('{color.nada}'), d: color('azul'), 'e.f': color('#fff') },
        size: { s: { $type: 'dimension', $value: { value: 8, unit: 'pt' } }, t: { $type: 'tamanho', $value: 1 }, u: { $value: 3 } },
        $extensions: { vvpost: { contrast: [{ fg: 'size.s', bg: 'color.d' }], code: { 'color.zz': '--zz' }, modes: { dark: { 'color.nada': '#000' } } } }
      })
    )
    const messages = f.problems.map((p) => p.message).join('\n')
    expect(messages).toMatch(/color\.a: alias circular/)
    expect(messages).toMatch(/color\.c: alias \{color\.nada\} não aponta para um token/)
    expect(messages).toMatch(/color\.d: cor inválida/)
    expect(messages).toMatch(/"e\.f" não pode ter/)
    expect(messages).toMatch(/size\.s: dimensão inválida/)
    expect(messages).toMatch(/size\.t: \$type "tamanho" não existe/)
    expect(messages).toMatch(/size\.u: sem \$type/)
    expect(messages).toMatch(/contrast: "size\.s" não é token de cor/)
    expect(messages).toMatch(/code: "color\.zz" não é um token/)
    expect(messages).toMatch(/modes\.dark: "color\.nada" não é um token/)
    expect(parseTokensFile('brand/y.tokens.json', '{ nada').problems[0]!.message).toMatch(/JSON inválido/)
  })

  it('contraste WCAG por modo: os achados reais da VV e da marca rosé', () => {
    expect(contrastRatio(parseColor('#ffffff')!, parseColor('#bd948a')!)).toBe(2.7)
    expect(contrastRatio(parseColor('#000')!, parseColor('#fff')!)).toBe(21)
    expect(parseColor({ colorSpace: 'srgb', components: [1, 0, 0], alpha: 0.5 })).toEqual({ r: 255, g: 0, b: 0, a: 0.5 })

    const vv = parseTokensFile('brand/vv.tokens.json', JSON.stringify(VV))
    const failing = vv.contrast.filter((c) => !c.ok).map((c) => `${c.fg}/${c.bg} ${c.mode} ${c.ratio}`)
    // O escuro passa; no claro, o texto terciário e o aviso ficam abaixo de 4,5:1.
    expect(failing).toEqual(['color.faint/color.panel light 3.1', 'color.warn/color.panel light 4.2'])

    const rose = parseTokensFile('brand/clinica.tokens.json', JSON.stringify(ROSE))
    const problem = rose.problems.find((p) => p.code === 'tokens-contrast')!
    expect(problem.message).toBe('contraste de 2,7:1 (color.on-primary #ffffff sobre color.primary #bd948a); o mínimo é 4,5:1')
    expect(problem.hint).toContain('texto #262626 sobre o mesmo fundo dá 5,5:1')
  })
})

describe('código do frontend contra os tokens', () => {
  it('lê o objeto do createTheme sem avaliar nada', () => {
    const at = THEME_TSX.indexOf('createTheme(') + 'createTheme('.length
    const parsed = parseObjectLiteral(THEME_TSX, at)!
    expect(parsed.values.get('palette.primary.main')?.value).toBe('#bd948a')
    expect(parsed.values.get('palette.secondary.dark')?.value).toBe('#bd948b')
    expect(parsed.values.get('typography.fontFamily')?.value).toBe('Roboto, sans-serif')
    expect(parseObjectLiteral('{ a: { b: `x${y}`, ...rest, c: fn({ d: 1 }), e: "ok" } }', 0)!.values).toEqual(new Map([['a.e', { value: 'ok', offset: 48 }]]))
  })

  it('Marca rosé: tema divergente, fonte fora da marca e cores soltas', async () => {
    const dir = workspace({
      'brand/clinica.tokens.json': ROSE,
      'app/components/theme.tsx': THEME_TSX,
      'app/monitor/page.tsx': "const cor = '#bd948a'\nconst linha = '#0088fe'; const sombra = 'rgba(0, 0, 0, 0.12)'\n<a href=\"#bad\">x</a>\n// '#123456' em comentário não conta\n",
      'app/gen/api.tsx': "const gerado = '#abcdef'\n"
    })
    const { items, scanned } = await loadBrand(dir, { scan: true })
    expect(scanned).toBe(2)
    const found = items.filter((i) => i.code !== 'tokens-contrast').map((i) => `${i.code} ${i.file}:${i.line} ${i.label}`)
    expect(found).toEqual([
      'brand-code-drift app/components/theme.tsx:11 palette.secondary.dark',
      'brand-font app/components/theme.tsx:14 Roboto',
      'brand-hardcoded-color app/monitor/page.tsx:1 #bd948a',
      'brand-unknown-color app/monitor/page.tsx:2 #0088fe'
    ])
    const driftItem = items.find((i) => i.code === 'brand-code-drift')!
    expect(driftItem.message).toBe('vale #bd948b, mas o token color.primary é #bd948a')
    expect(items.find((i) => i.code === 'brand-hardcoded-color')!.hint).toContain('theme.palette.primary.main')
  })

  it('VV: variáveis CSS conferidas, literal com o token no hint e nada fora do repositório', async () => {
    const css = ':root { --bg: #0b0c0f; --accent: #8b7cff; --info: #6aa9ff; }\n:root[data-theme="light"] { --bg: #f6f7f9; --accent: #6d5dfd; }\n.x { font-family: "Comic Sans MS", cursive; }\n.y { font-family: var(--font); }\n'
    const html = '<style>.term { background: #0b0d10 }</style>\n<script>const SERIES = [["cpu", "CPU", "#6aa9ff"], ["mem", "Memória", "#8b7cff"]]</script>\n'
    const dir = workspace({
      'brand/vv.tokens.json': { ...VV, $extensions: { vvpost: { ...VV.$extensions.vvpost, sources: [...VV.$extensions.vvpost.sources, '../**/*.css'] } } },
      'web/vv-ui.css': css,
      'web/index.html': html,
      'web/vendor-copy/lib.css': '.z { color: #123456 }'
    })
    const { items, scanned } = await loadBrand(dir, { scan: true })
    expect(scanned).toBe(2)
    const code = items.filter((i) => i.file.startsWith('web/')).map((i) => `${i.code} ${i.file}:${i.line} ${i.label}`)
    expect(code).toEqual([
      'brand-unknown-color web/index.html:1 #0b0d10',
      'brand-hardcoded-color web/index.html:2 #6aa9ff',
      'brand-hardcoded-color web/index.html:2 #8b7cff',
      'brand-code-drift web/vv-ui.css:2 --accent',
      'brand-font web/vv-ui.css:3 Comic Sans MS'
    ])
    expect(items.find((i) => i.label === '#0b0d10')!.hint).toMatch(/color\.bg \(#0b0c0f\), quase igual: use var\(--bg\)/)
    expect(items.find((i) => i.label === '#6aa9ff')!.hint).toContain('var(--info)')
  })
})

describe('lint, documentação e MCP', () => {
  const seeded = () =>
    workspace({
      'brand/clinica.tokens.json': ROSE,
      'app/components/theme.tsx': THEME_TSX,
      'docs/marca.md': '# Marca\n\nO rosé é da clínica.\n\n## Cores\n\n{{> tokens color}}\n\n## Contraste\n\n{{> contrast}}\n\n{{> tokens nada}}\n'
    })

  it('as regras do vvpost:recommended reportam a marca com arquivo, linha e severidade', async () => {
    const dir = seeded()
    const result = await lintWorkspace(dir, { noHistory: true })
    const brand = result.findings.filter((f) => f.path.startsWith('$.brand')).map((f) => `${f.severity} ${f.code} ${f.file}:${f.line}`)
    expect(brand).toEqual([
      'error brand-code-drift app/components/theme.tsx:11',
      'warn brand-font app/components/theme.tsx:14',
      expect.stringMatching(/^error tokens-contrast brand\/clinica\.tokens\.json:\d+$/)
    ])
  })

  it('o ruleset do time desliga uma regra da marca e lê $.tokens', async () => {
    const dir = seeded()
    mkdirSync(join(dir, '.vvpost'))
    writeFileSync(
      join(dir, '.vvpost/ruleset.yaml'),
      [
        'extends: [vvpost:recommended]',
        'rules:',
        '  brand-font: off',
        '  cor-com-uso:',
        '    description: Toda cor da marca diz onde se usa',
        '    severity: warn',
        "    given: \"$.tokens[?(@.type == 'color')]\"",
        '    then: { field: description, function: truthy }',
        ''
      ].join('\n')
    )
    const result = await lintWorkspace(dir, { noHistory: true })
    expect(result.issues).toEqual([])
    expect(result.findings.some((f) => f.code === 'brand-font')).toBe(false)
    const custom = result.findings.filter((f) => f.code === 'cor-com-uso').map((f) => f.label)
    expect(custom).toEqual(['color.primary-light', 'color.secondary', 'color.on-primary', 'color.text', 'color.bg'])
  })

  it('{{> tokens}} e {{> contrast}} viram tabelas; grupo vazio é erro na linha', async () => {
    const dir = seeded()
    const ws = await loadWorkspace(dir)
    const composed = await composeDocumentation(ws, await loadFlows(dir), { source: '{{> include docs/marca.md}}' })
    expect(composed.markdown).toContain('| `color.primary` | color | `#bd948a` | Rosé da clínica: botões e destaques |')
    expect(composed.markdown).toContain('| `color.on-primary` sobre `color.primary` | padrão | `#ffffff` / `#bd948a` | 2,7:1 | 4,5:1 | **não passa** |')
    expect(composed.diagnostics).toEqual([expect.objectContaining({ file: 'docs/marca.md', line: 13, severity: 'error', message: 'nenhum token no grupo "nada" nos arquivos de brand/' })])
    expect(composed.includes).toContain('brand/clinica.tokens.json')
  })

  it('get_brand devolve uma linha por token, no modo pedido, com o uso no código', async () => {
    const http = { cancel() {}, send: async () => ({ ok: false, error: { code: 'NETWORK', message: 'sem rede' } }) as never }
    const call = async (dir: string, args: Record<string, unknown>) => {
      const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine() })
      const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_brand', arguments: args } })) as {
        result: { isError: boolean; content: { text: string }[] }
      }
      return { isError: res.result.isError, data: JSON.parse(res.result.content[0]!.text) }
    }
    const rose = await call(seeded(), { group: 'color', withDescriptions: true })
    expect(rose.data.tokens.split('\n')[0]).toBe('color.primary=#bd948a (theme.palette.primary.main | theme.palette.secondary.dark) # Rosé da clínica: botões e destaques')
    expect(rose.data.contrastFailing).toEqual(['color.on-primary / color.primary: 2.7:1 < 4.5:1'])

    const vv = await call(workspace({ 'brand/vv.tokens.json': VV }), { mode: 'light' })
    expect(vv.data.modes).toEqual(['base', 'light'])
    expect(vv.data.tokens).toContain('color.bg=#f6f7f9 (var(--bg))')
    expect(vv.data.tokens).toContain('font.ui=Inter Variable, Inter, system-ui, sans-serif')
    // A marca inteira cabe em poucas centenas de tokens do modelo.
    expect(vv.data.tokens.length).toBeLessThan(900)
    expect((await call(workspace({ 'brand/vv.tokens.json': VV }), { mode: 'sepia' })).data.code).toBe('UNKNOWN_MODE')
    expect((await call(workspace({}), {})).data.code).toBe('NO_BRAND')
  })
})
