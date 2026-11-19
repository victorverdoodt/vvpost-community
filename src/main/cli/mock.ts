import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { MOCK_DEFAULT_PORT, mockRoutes, startMockServer, type MockHit } from '@vvpost/core/mock'
import { UsageError } from './run'

/**
 * `vvpost mock`: o mock server local com os exemplos de resposta dos endpoints, até o Ctrl+C.
 * Relê o workspace a cada requisição, então um exemplo editado vale na hora. Cada requisição
 * sai numa linha (ou em NDJSON com --json -).
 */
export async function serveMock(
  workspaceDir: string,
  io: { stdout: (t: string) => void; stderr: (t: string) => void; signal?: AbortSignal },
  options: { port?: number; connectors: string[]; json: boolean }
): Promise<number> {
  const first = mockRoutes(await loadWorkspace(workspaceDir), options.connectors)
  const missing = options.connectors.find((id) => first.problems.some((p) => p.startsWith(`conector "${id}"`)))
  if (missing) throw new UsageError(`conector "${missing}" não existe no workspace`)
  const server = await startMockServer({
    port: options.port ?? MOCK_DEFAULT_PORT,
    routes: async () => mockRoutes(await loadWorkspace(workspaceDir), options.connectors).routes,
    onHit: (hit) => io.stdout(`${options.json ? JSON.stringify(hit) : hitLine(hit)}\n`)
  }).catch((err: NodeJS.ErrnoException) => {
    throw new UsageError(err.code === 'EADDRINUSE' ? `a porta ${options.port ?? MOCK_DEFAULT_PORT} já está em uso (use --port)` : err.message)
  })
  const withExamples = first.routes.filter((r) => r.examples.length)
  io.stderr(
    [
      `Mock em ${server.url} (workspace ${workspaceDir}): ${first.routes.length} endpoints, ${withExamples.length} com exemplos`,
      ...first.routes.map((r) => `  ${r.method.padEnd(6)} ${r.path}  ${r.connectorId}/${r.endpointId}  ${r.examples.length ? r.examples.map((e) => `${e.status} ${e.id}`).join(', ') : '(sem exemplo: 501)'}`),
      ...first.problems.map((p) => `  aviso: ${p}`),
      'Escolha o exemplo com ?__example=<id>, ?__status=<código> ou o header Prefer: code=<código>. Ctrl+C para sair.',
      ''
    ].join('\n')
  )
  await new Promise<void>((done) => {
    if (!io.signal || io.signal.aborted) return done()
    io.signal.addEventListener('abort', () => done(), { once: true })
  })
  await server.close()
  return 0
}

function hitLine(hit: MockHit): string {
  const target = hit.endpointId ? `${hit.connectorId}/${hit.endpointId}${hit.exampleId ? `#${hit.exampleId}` : ''}` : '-'
  return `${hit.at.slice(11, 19)}  ${hit.method.padEnd(6)} ${hit.path}  ${hit.status}  ${target}  ${hit.durationMs} ms`
}
