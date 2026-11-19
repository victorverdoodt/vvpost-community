import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { WORKSPACE_CHANGED } from '../../panels/useWorkspace'
import type { McpServerState, MockServerState, ResourceUsage, SecretEngineState, WebhookServerState, WorkspaceInfo } from '@shared/ipc'

const POLL_MS = 2000

export interface AppServices {
  usage: ResourceUsage | null
  engine: SecretEngineState | null
  mcp: McpServerState | null
  webhooks: WebhookServerState | null
  mock: MockServerState | null
  workspace: WorkspaceInfo | null
  busy: 'engine' | 'mcp' | 'webhooks' | 'mock' | null
  toggleEngine: () => void
  /** Troca entre Local Mock e Cloud Proxy; ligado, o engine reinicia no outro modo. */
  setEngineMode: (mode: 'localMock' | 'enterpriseProxy') => void
  toggleMcp: () => void
  toggleWebhooks: () => void
  toggleMock: () => void
  refresh: () => void
}

/**
 * Estado global do shell: memória, mock de Secret Managers, servidores MCP, de webhooks e de mock e workspace aberto.
 * Só lê o que o main já guarda; nenhum desses serviços é carregado por causa do polling.
 */
export function useAppServices(): AppServices {
  const [usage, setUsage] = useState<ResourceUsage | null>(null)
  const [engine, setEngine] = useState<SecretEngineState | null>(null)
  const [mcp, setMcp] = useState<McpServerState | null>(null)
  const [webhooks, setWebhooks] = useState<WebhookServerState | null>(null)
  const [mock, setMock] = useState<MockServerState | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [busy, setBusy] = useState<'engine' | 'mcp' | 'webhooks' | 'mock' | null>(null)

  const refresh = useCallback(() => {
    void window.vvpost.getResourceUsage().then(setUsage)
    void window.vvpost.getSecretEngine().then(setEngine)
    void window.vvpost.getMcpServer().then(setMcp)
    void window.vvpost.getWebhookServer().then(setWebhooks)
    void window.vvpost.getMockServer().then(setMock)
    void window.vvpost.getWorkspaceInfo().then(setWorkspace)
  }, [])

  useEffect(() => {
    const poll = () => {
      // Sem polling com a janela oculta: não gastar CPU em segundo plano.
      if (!document.hidden) refresh()
    }
    // A primeira leitura ignora document.hidden: a janela nasce oculta até o ready-to-show, e
    // esperar o próximo ciclo deixava "Abrir workspace" na barra por até 2 s.
    refresh()
    const timer = setInterval(poll, POLL_MS)
    window.addEventListener('focus', poll)
    document.addEventListener('visibilitychange', poll)
    window.addEventListener(WORKSPACE_CHANGED, poll)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', poll)
      document.removeEventListener('visibilitychange', poll)
      window.removeEventListener(WORKSPACE_CHANGED, poll)
    }
  }, [refresh])

  const toggleEngine = useCallback(() => {
    setBusy('engine')
    void window.vvpost
      .setSecretEngine(engine?.status !== 'running')
      .then(setEngine)
      .finally(() => setBusy(null))
  }, [engine])

  const setEngineMode = useCallback((mode: 'localMock' | 'enterpriseProxy') => {
    setBusy('engine')
    void window.vvpost
      .setSecretEngineMode(mode)
      .then(setEngine)
      .finally(() => setBusy(null))
  }, [])

  const toggleMcp = useCallback(() => {
    setBusy('mcp')
    void window.vvpost
      .setMcpServer(mcp?.status !== 'running')
      .then(setMcp)
      .finally(() => setBusy(null))
  }, [mcp])

  const toggleWebhooks = useCallback(() => {
    setBusy('webhooks')
    void window.vvpost
      .setWebhookServer(webhooks?.status !== 'running')
      .then(setWebhooks)
      .finally(() => setBusy(null))
  }, [webhooks])

  const toggleMock = useCallback(() => {
    setBusy('mock')
    void window.vvpost
      .setMockServer(mock?.status !== 'running')
      .then(setMock)
      .finally(() => setBusy(null))
  }, [mock])

  return { usage, engine, mcp, webhooks, mock, workspace, busy, toggleEngine, setEngineMode, toggleMcp, toggleWebhooks, toggleMock, refresh }
}

/** O mesmo estado do shell para os módulos (uma fonte de verdade: nada de polling próprio). */
export const AppServicesContext = createContext<AppServices | null>(null)

export function useServices(): AppServices {
  const services = useContext(AppServicesContext)
  if (!services) throw new Error('useServices fora do AppShell')
  return services
}
