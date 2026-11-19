import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { composeDocumentation } from '@vvpost/core/docs'
import { codeMapDrift, readCodeMap } from '@vvpost/core/docs/codemap'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { lintWorkspace } from '../src/main/lint'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Um repositório com .git, o workspace em vvpost/ e as áreas em src/Api/Features. */
function repo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-codemap-'))
  dirs.push(dir)
  const all: Record<string, string> = {
    '.git/HEAD': 'ref: refs/heads/main\n',
    'vvpost/connectors/api.connector.vvpost.json': JSON.stringify({
      id: 'loja.api', name: 'API', version: '1.0.0', config: { baseUrl: 'https://api.exemplo.com' },
      endpoints: [{ id: 'listar', name: 'listar', method: 'GET', path: '/x' }]
    }),
    'src/Api/Features/Contas/Contas.cs': 'class Contas {}',
    'src/Api/Features/Contas/Senha.cs': 'class Senha {}',
    'src/Api/Features/Contas/notas.txt': 'não é código',
    'src/Api/Features/Stories/Stories.cs': 'class Stories {}',
    'src/Api/Features/Stories/obj/Gerado.cs': 'gerado',
    ...files
  }
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

const MAP = '# Regras\n\n<!-- vvpost:codemap src/Api/Features -->\n- Contas: `Contas.cs`, `Senha.cs`\n- Stories: `Stories.cs`\n\n## Depois\n'

describe('mapa do código', () => {
  it('lê as áreas com os arquivos de código, sem build nem outros arquivos', async () => {
    expect(await readCodeMap(repo(), 'src/Api/Features')).toEqual([
      { area: 'Contas', files: ['Contas.cs', 'Senha.cs'] },
      { area: 'Stories', files: ['Stories.cs'] }
    ])
    await expect(readCodeMap(repo(), '../fora')).rejects.toThrow(/fora do repositório/)
  })

  it('{{> codemap}} monta o mapa na documentação a partir do código', async () => {
    const dir = repo()
    const ws = await loadWorkspace(join(dir, 'vvpost'))
    const source = '# Mapa\n\n{{> codemap src/Api/Features}}\n\n{{> codemap src/Nada}}\n'
    const { markdown, diagnostics } = await composeDocumentation(ws, await loadFlows(join(dir, 'vvpost')), { projectName: 'Loja', source })
    expect(markdown).toContain('- Contas: `Contas.cs`, `Senha.cs`\n- Stories: `Stories.cs`')
    expect(diagnostics.map((d) => `${d.severity} ${d.line} ${d.message}`)).toEqual(['error 5 a pasta "src/Nada" não existe no repositório'])
  })

  it('a cópia escrita à mão em dia não tem achado', async () => {
    expect(await codeMapDrift(repo(), 'AGENTS.md', MAP)).toEqual([])
  })

  it('acusa arquivo e área fora da cópia, e o que não existe mais, com a linha certa no hint', async () => {
    const dir = repo({ 'src/Api/Features/Contas/Perfil.cs': 'x', 'src/Api/Features/Tarefas/Tarefas.cs': 'x' })
    const text = MAP.replace('`Stories.cs`', '`Stories.cs`, `Envio.cs`').replace('- Stories:', '- Velha: `Velha.cs`\n- Stories:')
    const items = await codeMapDrift(dir, 'AGENTS.md', text)
    expect(items.map((i) => `${i.line} ${i.message}`)).toEqual([
      '4 mapa do código de Contas desatualizado: faltam Perfil.cs',
      '6 mapa do código de Stories desatualizado: não existem mais Envio.cs',
      '6 área Tarefas de src/Api/Features fora do mapa do código',
      '5 área Velha do mapa do código não existe mais em src/Api/Features'
    ])
    expect(items[0]!.hint).toBe('Troque a linha por: - Contas: `Contas.cs`, `Perfil.cs`, `Senha.cs`')
    expect(items[2]!.hint).toBe('Acrescente a linha: - Tarefas: `Tarefas.cs`')
  })

  it('o lint confere o AGENTS.md da raiz e as páginas do workspace (doc-code-map)', async () => {
    const dir = repo({
      'AGENTS.md': MAP.replace(', `Senha.cs`', ''),
      'vvpost/docs/mapa.md': '# Mapa\n\n<!-- vvpost:codemap src/Api/Features -->\n- Contas: `Contas.cs`, `Senha.cs`\n'
    })
    const { findings } = await lintWorkspace(join(dir, 'vvpost'))
    expect(findings.filter((f) => f.code === 'doc-code-map').map((f) => `${f.severity} ${f.file}:${f.line} ${f.message}`)).toEqual([
      'warn ../AGENTS.md:4 mapa do código de Contas desatualizado: faltam Senha.cs',
      'warn docs/mapa.md:4 área Stories de src/Api/Features fora do mapa do código'
    ])
  })
})
