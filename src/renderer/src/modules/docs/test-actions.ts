import type { DocEndpoint } from '@shared/ipc'
import { navigate } from '../../lib/navigate'
import { openInQuickRequest } from '../../lib/open-request'

/** Origem dos headers do próprio endpoint no modelo (ENDPOINT_ORIGIN do core). */
const ENDPOINT_ORIGIN = '(endpoint)'

/**
 * "Testar" da documentação: o endpoint abre numa aba do Quick Request com a herança do conector
 * (só os headers do próprio endpoint vão na aba; os herdados entram no envio, como no Catálogo).
 */
export function testEndpoint(connectorId: string, e: Pick<DocEndpoint, 'id' | 'method' | 'path' | 'headers' | 'body'>): void {
  openInQuickRequest(
    {
      method: e.method,
      url: e.path,
      headers: e.headers.filter((h) => h.from === ENDPOINT_ORIGIN).map(({ name, value }) => ({ name, value })),
      body: e.body ?? '',
      connectorId,
      environmentId: null,
      endpointId: e.id
    },
    'docs'
  )
}

/** A request (cenário) roda nos Testes, com as asserções. */
export function runScenario(connectorId: string, endpointId: string, scenarioId: string): void {
  navigate({ module: 'scenarios', connectorId, endpointId, scenarioId, action: 'run' })
}

/** O fluxo abre no Flow Studio, pronto para executar. */
export function openFlow(flowId: string): void {
  navigate({ module: 'flows', flowId })
}
