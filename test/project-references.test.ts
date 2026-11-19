import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { createMcpServer, type McpServer } from '../src/main/mcp/server'
import { resolveProject } from '../src/main/workspace/references'

// Projeto de referência: o workspace do front aponta o catálogo da API de outro repositório, só para leitura.

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Loja', version: '2' },
  paths: {
    '/pedidos/{id}': {
      get: {
        tags: ['Pedidos'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pedido' } } } } }
      }
    }
  },
  components: { schemas: { Pedido: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, total: { type: 'number' } } } } }
}

function write(root: string, files: Record<string, unknown>): void {
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), `${JSON.stringify(data, null, 2)}\n`)
  }
}

/** repos/front/vvpost com o projeto "loja" apontando a spec (e, se pedido, o workspace da API ao lado). */
function repos(reference: Record<string, string>, api?: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'vvpost-refs-'))
  dirs.push(root)
  write(root, {
    'front/api/loja.json': { ...SPEC, info: { ...SPEC.info, description: String(Math.random()) } },
    'front/vvpost/loja/vvpost.project.json': { id: 'loja', name: 'API da loja', reference }
  })
  if (api) {
    write(root, {
      'api/vvpost/connectors/loja.connector.vvpost.json': {
        id: 'loja',
        name: 'Loja (workspace)',
        version: '1.0.0',
        config: { baseUrl: 'https://loja.exemplo.com' },
        endpoints: [{ id: 'pedido', name: 'Pedido', method: 'GET', path: '/pedidos/{id}' }]
      }
    })
  }
  return join(root, 'front/vvpost')
}

const http = { cancel() {}, send: async () => ({ ok: false as const, error: { code: 'X', message: 'sem rede' } }) }

async function call(s: McpServer, name: string, args: Record<string, unknown>) {
  const res = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as {
    result: { isError: boolean; content: { text: string }[] }
  }
  return { isError: res.result.isError, data: JSON.parse(res.result.content[0]!.text) }
}

describe('projeto de referência', () => {
  it('a spec vira o catálogo, com rotas e schemas, e a mesma spec não é convertida de novo', async () => {
    const ws = repos({ openapi: '../../api/loja.json' })
    const first = await resolveProject(ws, 'loja')
    expect(first.reference).toEqual({ project: 'loja', source: 'openapi', location: '../../api/loja.json' })
    expect((await resolveProject(ws, 'loja')).dir).toBe(first.dir)

    const s = createMcpServer({ workspaceDir: ws, http: http as never, auth: createAuthEngine() })
    const listed = await call(s, 'list_projects', {})
    expect(listed.data.projects).toEqual([expect.objectContaining({ id: 'loja', reference: { openapi: '../../api/loja.json' } })])
    const catalog = await call(s, 'get_api_catalog', { project: 'loja', view: 'summary' })
    expect(catalog.isError).toBe(false)
    expect(JSON.stringify(catalog.data)).toContain('pedidos')
    const schema = await call(s, 'get_source', { project: 'loja', kind: 'schema', id: 'Pedido' })
    expect(JSON.stringify(schema.data)).toContain('total')
  })

  it('o workspace da API ao lado vence a spec, e a escrita é recusada', async () => {
    const ws = repos({ workspace: '../../../api/vvpost', openapi: '../../api/loja.json' }, true)
    const s = createMcpServer({ workspaceDir: ws, http: http as never, auth: createAuthEngine() })
    const catalog = await call(s, 'get_api_catalog', { project: 'loja', view: 'summary' })
    expect(JSON.stringify(catalog.data)).toContain('https://loja.exemplo.com')
    const edit = await call(s, 'edit_project', {
      project: 'loja',
      ops: [{ op: 'upsertEndpoint', connectorId: 'loja', endpoint: { id: 'x', name: 'X', method: 'GET', path: '/x' } }]
    })
    expect(edit.data).toMatchObject({ code: 'BLOCKED', error: expect.stringContaining('referência só para leitura') })
    expect(readFileSync(join(ws, '../../api/vvpost/connectors/loja.connector.vvpost.json'), 'utf8')).not.toContain('"/x"')
  })

  it('sem nenhuma fonte, o erro diz o que foi procurado', async () => {
    const ws = repos({ workspace: '../../nada' })
    const s = createMcpServer({ workspaceDir: ws, http: http as never, auth: createAuthEngine() })
    expect((await call(s, 'get_api_catalog', { project: 'loja' })).data).toMatchObject({
      code: 'UNKNOWN_PROJECT',
      error: expect.stringContaining('workspace ../../nada')
    })
  })
})
