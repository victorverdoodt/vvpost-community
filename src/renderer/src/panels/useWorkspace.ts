import { useCallback, useEffect, useState } from 'react'
import type { CatalogConnector, ConnectorCatalog, WorkspaceResult } from '@shared/ipc'
import { track } from '../lib/ux-study'

/** Lembra a última escolha entre sessões. localStorage pode faltar (ex.: modo bench): só perde a conveniência. */
function remembered(key: string): string | null {
  try {
    return localStorage.getItem(`vvpost.quick.${key}`)
  } catch {
    return null
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(`vvpost.quick.${key}`, value)
  } catch {
    // sem armazenamento local
  }
}

/** Ambiente escolhido em qualquer módulo: os outros acompanham. */
const ENVIRONMENT_CHANGED = 'vvpost:environment-changed'

/** Disparado quando um painel troca a pasta do workspace (o shell relê nome e branch). */
export const WORKSPACE_CHANGED = 'vvpost:workspace-changed'

export interface ConnectorSelection {
  connector: CatalogConnector | null
  environmentId: string
}

/**
 * Workspace do Quick Request: o conector escolhido define baseUrl, headers, auth e
 * mTLS herdados, e o ambiente resolve os {{VAR}}. O workspace é o mesmo do painel Git. Tudo roda no main
 * process; aqui só aparecem os modelos, nunca valores de segredo.
 */
export function useWorkspace() {
  const [result, setResult] = useState<WorkspaceResult<ConnectorCatalog | null> | null>(null)
  const [connectorId, setConnectorId] = useState(() => remembered('connector') ?? '')
  const [environmentId, setEnvironmentId] = useState<string | null>(() => remembered('environment'))

  const reload = useCallback(() => {
    void window.vvpost.getConnectorCatalog().then(setResult)
  }, [])

  // Lê o workspace depois do primeiro paint, e de novo quando a janela volta ao foco
  // (arquivos editados fora do app, import do Postman em outra aba).
  useEffect(() => {
    const handle = requestIdleCallback(reload, { timeout: 2000 })
    window.addEventListener('focus', reload)
    window.addEventListener(WORKSPACE_CHANGED, reload)
    return () => {
      cancelIdleCallback(handle)
      window.removeEventListener('focus', reload)
      window.removeEventListener(WORKSPACE_CHANGED, reload)
    }
  }, [reload])

  useEffect(() => {
    const follow = (e: Event) => setEnvironmentId((e as CustomEvent<string>).detail)
    window.addEventListener(ENVIRONMENT_CHANGED, follow)
    return () => window.removeEventListener(ENVIRONMENT_CHANGED, follow)
  }, [])

  const workspace = result?.ok ? result.value : null
  const connector = workspace?.connectors.find((c) => c.id === connectorId) ?? null
  // Sem escolha lembrada, começa no primeiro ambiente do projeto: começar vazio fazia a primeira
  // execução falhar com {{VAR}} indefinida. "Sem ambiente" continua possível.
  const environment =
    environmentId === null
      ? (workspace?.environments[0] ?? null)
      : (workspace?.environments.find((e) => e.id === environmentId) ?? null)

  return {
    result,
    workspace,
    reload,
    // O mesmo workspace do painel Git: abrir aqui também muda lá.
    open: () =>
      void window.vvpost.openWorkspace().then((r) => {
        if (!r.ok) setResult(r)
        else if (r.value) {
          reload()
          window.dispatchEvent(new Event(WORKSPACE_CHANGED))
        }
      }),
    selection: { connector, environmentId: environment?.id ?? '' } as ConnectorSelection,
    environment,
    selectConnector(id: string) {
      setConnectorId(id)
      remember('connector', id)
    },
    selectEnvironment(id: string) {
      setEnvironmentId(id)
      remember('environment', id)
      window.dispatchEvent(new CustomEvent(ENVIRONMENT_CHANGED, { detail: id }))
      track('environment', { id })
    }
  }
}
