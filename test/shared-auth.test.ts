import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { createHttpDispatcher, type HttpDispatcher } from '@vvpost/core/http/dispatcher'
import { createMcpServer, type McpServer } from '../src/main/mcp/server'
import { clearReviewMarks } from '../src/main/project'
import { SECRETS_FILE } from '../src/main/workspace/vault'

/*
 * Um projeto com duas APIs de origens diferentes (consulta de CNPJ e de veículos) que usam a
 * mesma auth: uma base de auth, uma base por API herdando dela e as requisições herdando das
 * APIs. Tudo montado e rodado só pelo MCP, sem duplicar o login.
 */

interface Seen {
  api: string
  path: string
  auth?: string
}

function fakeApi(api: string, seen: Seen[], handle?: (req: IncomingMessage, res: ServerResponse) => boolean): Promise<Server> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    seen.push({ api, path, ...(req.headers.authorization && { auth: req.headers.authorization }) })
    if (handle?.(req, res)) return
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== 'Bearer tok-shared') {
      res.statusCode = 401
      return res.end('{"error":"unauthorized"}')
    }
    res.end(JSON.stringify({ api, path }))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

const originOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`

async function call(server: McpServer, name: string, args: Record<string, unknown>) {
  const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as {
    result: { isError: boolean; content: { text: string }[] }
  }
  return { isError: res.result.isError, data: JSON.parse(res.result.content[0]!.text) }
}

const request = (id: string, extendsId: string, path: string) => ({
  id,
  name: id,
  extends: extendsId,
  nodes: [{ id: 'request', name: 'Request', type: 'request', request: { method: 'GET', url: path } }],
  edges: [],
  scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
})

describe('duas APIs com a mesma auth', () => {
  const seen: Seen[] = []
  let servers: Server[]
  let http: HttpDispatcher
  let logins = 0
  let dir: string

  beforeAll(async () => {
    servers = [
      await fakeApi('auth', seen, (req, res) => {
        if (req.method !== 'POST') return false
        logins++
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ access_token: 'tok-shared', expires_in: 3600 }))
        return true
      }),
      await fakeApi('cnpj', seen),
      await fakeApi('veiculos', seen)
    ]
    http = createHttpDispatcher()
    dir = mkdtempSync(join(tmpdir(), 'vvpost-shared-auth-'))
    mkdirSync(join(dir, 'environments'))
    mkdirSync(join(dir, '.vvpost'))
    writeFileSync(
      join(dir, 'environments/dev.env.json'),
      JSON.stringify({
        id: 'dev',
        name: 'Dev',
        variables: {
          AUTH_URL: { type: 'string', value: originOf(servers[0]!) },
          CNPJ_URL: { type: 'string', value: originOf(servers[1]!) },
          VEICULOS_URL: { type: 'string', value: originOf(servers[2]!) },
          CLIENT_ID: { type: 'string', value: 'app' },
          CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
        }
      })
    )
    writeFileSync(join(dir, SECRETS_FILE), JSON.stringify({ dev: { CLIENT_SECRET: 's3cr3t-value' } }))
  })
  afterAll(async () => {
    await http.close()
    for (const s of servers) s.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a IA monta a base de auth uma vez, as duas APIs herdam e o login roda uma vez só', async () => {
    const mcp = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine() })
    const ops = [
      {
        op: 'upsertFlow',
        flow: {
          id: 'auth',
          name: 'Auth',
          defaults: { headers: { Authorization: 'Bearer {{ $nodes.Login.data.access_token }}' } },
          nodes: [
            {
              id: 'login',
              name: 'Login',
              type: 'request',
              cache: { expiresIn: 'data.expires_in' },
              request: {
                method: 'POST',
                url: '{{AUTH_URL}}/oauth/token',
                body: { client_id: '{{CLIENT_ID}}', client_secret: '{{CLIENT_SECRET}}' }
              }
            }
          ],
          edges: []
        }
      },
      { op: 'upsertFlow', flow: { id: 'cnpj', name: 'Consulta CNPJ', extends: 'auth', defaults: { baseUrl: '{{CNPJ_URL}}' }, nodes: [], edges: [] } },
      { op: 'upsertFlow', flow: { id: 'veiculos', name: 'Consulta de veículos', extends: 'auth', defaults: { baseUrl: '{{VEICULOS_URL}}' }, nodes: [], edges: [] } },
      { op: 'upsertFlow', flow: request('cnpj.consultar', 'cnpj', '/cnpj/00000000000191') },
      { op: 'upsertFlow', flow: request('veiculos.consultar', 'veiculos', '/veiculos/ABC1D23') }
    ]
    const edit = await call(mcp, 'edit_project', { ops })
    expect(edit.data.errors).toBeUndefined()
    expect(edit.isError).toBe(false)
    expect(edit.data.ok).toBe(true)

    // O catálogo mostra uma auth só, definida na base, e as duas APIs como filhas dela.
    const catalog = (await call(mcp, 'get_api_catalog', {})).data
    expect(catalog.tree).toContainEqual({
      id: 'auth',
      name: 'Auth',
      children: [
        { id: 'cnpj', name: 'Consulta CNPJ' },
        { id: 'veiculos', name: 'Consulta de veículos' }
      ]
    })
    for (const id of ['cnpj', 'veiculos']) {
      const detail = (await call(mcp, 'get_api_catalog', { connectorId: id })).data
      expect(detail.resolved.auth).toMatchObject({ type: 'login', from: 'auth' })
      expect(detail.endpoints.map((e: { id: string }) => e.id)).toEqual(['consultar'])
      // A troca de origem é o desenho pedido: a auth não tem baseUrl, então não há aviso.
      expect(JSON.stringify(detail)).not.toContain('INHERITED_AUTH_NEW_ORIGIN')
    }
    expect(JSON.stringify(catalog)).not.toContain('s3cr3t-value')

    // get_source diz que a API é um fluxo-base e em que arquivos estão a base e cada endpoint.
    const source = (await call(mcp, 'get_source', { kind: 'connector', id: 'cnpj' })).data
    expect(source.flows).toMatchObject({ base: 'flows/cnpj.flow.vvpost.json', endpoints: { consultar: 'flows/cnpj.consultar.flow.vvpost.json' } })
    const list = (await call(mcp, 'get_source', { kind: 'flow' })).data.flows
    expect(list.find((f: { id: string }) => f.id === 'cnpj.consultar').is).toEqual({ connector: 'cnpj', endpoint: 'consultar' })
    expect(list.find((f: { id: string }) => f.id === 'auth').is).toEqual({ connector: 'auth' })
    // E a IA edita o endpoint como endpoint: grava no fluxo de requisição.
    const renamed = await call(mcp, 'edit_project', {
      ops: [{ op: 'upsertEndpoint', connectorId: 'cnpj', endpoint: { id: 'consultar', name: 'Consultar CNPJ', method: 'GET', path: '/cnpj/00000000000191' } }]
    })
    expect(renamed.data.changes).toEqual([{ path: 'flows/cnpj.consultar.flow.vvpost.json', action: 'update', version: expect.any(String) }])

    // A auth escrita pela IA espera a revisão do usuário, como qualquer auth.
    const blocked = await call(mcp, 'execute_flow', { flowId: 'cnpj.consultar', environmentId: 'dev' })
    expect(edit.data.review.connectors).toEqual(['auth', 'cnpj', 'veiculos'])
    expect(blocked.data.error).toContain('ainda não foi revisado')
    expect((await call(mcp, 'execute_flow', { flowId: 'auth', environmentId: 'dev' })).data.error).toContain('ainda não foi revisado')
    expect(seen).toEqual([])
    await clearReviewMarks(dir, edit.data.review.connectors)

    for (const flowId of ['cnpj.consultar', 'veiculos.consultar', 'cnpj.consultar']) {
      const run = await call(mcp, 'execute_flow', { flowId, environmentId: 'dev' })
      expect(run.data.outcome).toBe('success')
    }
    expect(logins).toBe(1)
    expect(seen).toEqual([
      { api: 'auth', path: '/oauth/token' },
      { api: 'cnpj', path: '/cnpj/00000000000191', auth: 'Bearer tok-shared' },
      { api: 'veiculos', path: '/veiculos/ABC1D23', auth: 'Bearer tok-shared' },
      { api: 'cnpj', path: '/cnpj/00000000000191', auth: 'Bearer tok-shared' }
    ])

    // Rodar a base pelo MCP testa o login: um token novo, que não aparece no resultado.
    const base = await call(mcp, 'execute_flow', { flowId: 'auth', environmentId: 'dev' })
    expect(base.data).toMatchObject({ outcome: 'success', nodes: [{ name: 'Login', status: 'success', auth: { type: 'login', from: 'auth' } }] })
    expect(base.data.nodes[0].data).toContain('token obtido')
    expect(JSON.stringify(base.data)).not.toContain('tok-shared')
    expect(logins).toBe(2)
  })
})
