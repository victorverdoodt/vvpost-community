import { authHeaderName } from './connectors/headless'
import { resolveConnector } from './connectors/resolve'
import type { LoadedWorkspace } from './connectors/workspace'
import type { SecretSanitizer } from './sanitizer'

/**
 * Registra no sanitizer todo segredo do workspace e o nome do header de auth de cada
 * conector, antes de qualquer saída: resposta ao agente de IA (MCP) ou relatório e log
 * do CLI, que costumam acabar em artefatos de CI.
 */
export function protectWorkspace(sanitizer: SecretSanitizer, ws: LoadedWorkspace): void {
  sanitizer.addWorkspace(ws)
  for (const c of ws.connectors.values()) {
    try {
      const auth = resolveConnector(c.id, ws.connectors).auth
      const header = auth && authHeaderName(auth.config)
      if (header) sanitizer.addSensitiveName(header)
    } catch {
      // herança quebrada: o catálogo (ou o relatório) mostra o erro
    }
  }
}
