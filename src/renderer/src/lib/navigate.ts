import { useEffect, useRef } from 'react'
import type { Flow } from '@shared/ipc'

/**
 * Navegação entre módulos pelos menus de contexto ("Abrir o conector no Catálogo", "Abrir
 * em Tests"; para o Quick Request, lib/open-request). O App troca de módulo; o módulo de destino recebe o alvo, também
 * quando ainda não tinha sido aberto (o pedido fica guardado até ele montar).
 */
export type NavigateTarget =
  | { module: 'catalog'; connectorId: string; endpointId?: string }
  | {
      module: 'scenarios'
      connectorId: string
      endpointId?: string
      scenarioId?: string
      /** Executa o escopo, abre o editor do cenário ou um cenário novo. */
      action?: 'run' | 'edit' | 'new'
    }
  /**
   * `flow`: um fluxo ainda não salvo ("Ver como fluxo" dos scripts), aberto como rascunho. Com
   * `file`, é a mudança não salva do fluxo desse arquivo (a visão Simples passando ao canvas).
   */
  | { module: 'flows'; flowId: string; flow?: Flow; file?: string }
  | { module: 'secrets'; environmentId?: string; variable?: string }
  | { module: 'history'; runId?: number }
  | { module: 'webhooks'; eventId?: number }
  | { module: 'docs'; connectorId?: string; endpointId?: string }
  /** `reimportConnectorId`: abre a revisão da reimportação da spec de onde o conector veio. */
  | { module: 'import-export'; reimportConnectorId?: string }
  | { module: 'git' | 'extensions' | 'mcp' | 'settings' }

export const NAVIGATE = 'vvpost:navigate'
const pending = new Map<string, NavigateTarget>()

export function navigate(target: NavigateTarget): void {
  pending.set(target.module, target)
  window.dispatchEvent(new CustomEvent<NavigateTarget>(NAVIGATE, { detail: target }))
}

/** O módulo `module` recebe os pedidos de navegação para ele. */
export function useNavigation<M extends NavigateTarget['module']>(
  module: M,
  handler: (target: Extract<NavigateTarget, { module: M }>) => void
): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    const take = () => {
      const target = pending.get(module)
      if (!target) return
      pending.delete(module)
      latest.current(target as Extract<NavigateTarget, { module: M }>)
    }
    // Montou por causa do pedido: ele chegou antes do módulo existir.
    take()
    const onNav = (e: Event) => {
      if ((e as CustomEvent<NavigateTarget>).detail.module === module) take()
    }
    window.addEventListener(NAVIGATE, onNav)
    return () => window.removeEventListener(NAVIGATE, onNav)
  }, [module])
}
