import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateConnector, validateEnvironment, validateFlow } from '@vvpost/schemas'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { resolveConnector } from '@vvpost/core/connectors/resolve'
import { createFromTemplate, isProjectTemplate, PROJECT_TEMPLATES } from '../src/main/workspace/templates'

const dirs: string[] = []
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vvpost-template-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('modelos de projeto', () => {
  it('cada modelo grava só os arquivos que anuncia, dentro do schema e com o vault fora do Git', async () => {
    for (const t of PROJECT_TEMPLATES) {
      const dir = await temp()
      expect(await createFromTemplate(dir, t.id)).toEqual(t.files)
      expect((await readdir(dir, { recursive: true })).map((f) => f.replaceAll('\\', '/')).filter((f) => f.includes('.')).sort()).toEqual(
        [...t.files].sort()
      )
      expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('.vvpost/secrets.local.json\n')
      for (const f of t.files) {
        const text = await readFile(join(dir, f), 'utf8')
        if (f.endsWith('.connector.vvpost.json')) expect(validateConnector(JSON.parse(text)).ok, f).toBe(true)
        if (f.endsWith('.flow.vvpost.json')) expect(validateFlow(JSON.parse(text)).ok, f).toBe(true)
        if (f.endsWith('.env.json')) {
          const env = JSON.parse(text)
          expect(validateEnvironment(env).ok, f).toBe(true)
          // Segredo só como pendente: nenhum valor real sai de um modelo.
          for (const v of Object.values(env.variables) as { isSecret?: boolean; value: unknown }[]) {
            if (v.isSecret) expect(v.value).toBe('__REQUIRED_SECRET__')
          }
        }
      }
    }
  })

  it('a API REST nasce em fluxos: a base com URL e Bearer, e uma requisição por arquivo que herda dela', async () => {
    const dir = await temp()
    const files = await createFromTemplate(dir, 'rest-api')
    expect(files.filter((f) => f.startsWith('flows/')).sort()).toEqual([
      'flows/api/api.flow.vvpost.json',
      'flows/api/create_item.flow.vvpost.json',
      'flows/api/get_item.flow.vvpost.json',
      'flows/api/list_items.flow.vvpost.json'
    ])
    expect(files.some((f) => f.startsWith('connectors/'))).toBe(false)
    const ws = await loadWorkspace(dir)
    expect(ws.issues).toEqual([])
    const api = resolveConnector('api', ws.connectors)
    expect(api.baseUrl).toBe('{{BASE_URL}}')
    expect(api.auth?.config).toEqual({ type: 'bearer', token: '{{API_TOKEN}}' })
    // Na ordem do modelo, não na alfabética dos arquivos.
    expect(api.endpoints.map((e) => e.id)).toEqual(['list_items', 'get_item', 'create_item'])
    expect(api.endpoints[0]!.scenarios?.map((s) => s.id)).toEqual(['ok'])
  })

  it('recusa uma pasta com arquivos e não grava nada nela', async () => {
    const dir = await temp()
    await writeFile(join(dir, 'notas.txt'), 'meu')
    await expect(createFromTemplate(dir, 'rest-api')).rejects.toThrow(/já tem o arquivo notas\.txt/)
    expect(await readdir(dir)).toEqual(['notas.txt'])
  })

  it('aceita uma pasta só com um repositório recém-criado, ou que ainda não existe', async () => {
    const dir = await temp()
    await mkdir(join(dir, '.git'))
    await expect(createFromTemplate(dir, 'empty')).resolves.toContain('environments/dev.env.json')
    await expect(createFromTemplate(join(await temp(), 'nova'), 'empty')).resolves.toContain('README.md')
  })

  it('só aceita ids de modelo conhecidos', () => {
    expect(isProjectTemplate('rest-api')).toBe(true)
    expect(isProjectTemplate('__proto__')).toBe(false)
    expect(isProjectTemplate(1)).toBe(false)
  })
})
