import { useEffect, useState, type ReactNode } from 'react'
import { GitBranch } from 'lucide-react'
import type { McpServerState, MockServerState, SecretEngineState, WebhookServerState } from '@shared/ipc'
import { SegmentedControl } from '../../design-system'
import type { AppServices } from './useAppServices'

/** Memória acima disso aparece como estado degradado. */
const MEMORY_WARN_MB = 180

/**
 * Barra de status do AppShell (spec, seções 7.1 e 7.3): métricas reais do app, o workspace e os
 * toggles do mock de Secret Managers e dos servidores MCP e de webhooks. Estados degradados ganham cor e dica.
 */
export function StatusBar({ services, children }: { services: AppServices; children?: ReactNode }) {
  const { usage, engine, mcp, webhooks, workspace, busy } = services
  const [copied, setCopied] = useState(false)
  // Teste com usuários: o participante sempre vê que a sessão está sendo gravada.
  const [study, setStudy] = useState(false)
  useEffect(() => void window.vvpost.getUxStudyStatus().then(setStudy), [])

  const copyMcpUrl = () => {
    if (!mcp?.url) return
    void navigator.clipboard.writeText(`${mcp.url}/mcp`).then(() => setCopied(true))
  }
  const toggleMcp = () => {
    setCopied(false)
    services.toggleMcp()
  }

  const memoryHigh = usage !== null && usage.totalMemoryMB > MEMORY_WARN_MB
  const engineReady = usage?.engine === 'ready'

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 overflow-hidden whitespace-nowrap border-t border-border bg-panel px-3 text-[11px] text-muted">
      <Metric
        tone={usage === null ? 'idle' : memoryHigh ? 'warn' : 'ok'}
        title={
          usage
            ? `Memória somada dos processos (${usage.metric}): ${Object.entries(usage.byProcessType)
                .map(([type, mb]) => `${type} ${Math.round(mb)} MB`)
                .join(', ')}${memoryHigh ? `. Acima de ${MEMORY_WARN_MB} MB.` : ''}`
            : undefined
        }
      >
        Memory: {usage ? `${Math.round(usage.totalMemoryMB)} MB` : '…'}
      </Metric>
      <Metric tone={engineReady ? 'ok' : 'warn'} title="Motor de requisições (dispatcher HTTP e histórico)">
        Engine: {engineReady ? 'Ready' : 'Starting'}
      </Metric>
      <span className="flex min-w-0 items-center gap-1.5" title={workspace?.dir ?? 'Nenhuma pasta de workspace aberta'}>
        <GitBranch size={12} aria-hidden />
        <span className="truncate">
          Git: {workspace ? (workspace.branch ?? 'fora de um repositório') : 'sem workspace'}
        </span>
      </span>
      {children}
      <div className="ml-auto flex items-center gap-1">
        {study && (
          <span
            className="flex items-center gap-1.5 px-2 text-info"
            title="Estudo de UX: o app grava localmente quais módulos e ações foram usados, sem URLs, headers, corpos ou segredos"
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-info" />
            Estudo de UX gravando
          </span>
        )}
        {mcp?.status === 'running' && (
          <button
            type="button"
            onClick={copyMcpUrl}
            title="Copiar a URL do Streamable HTTP para configurar o cliente de IA"
            className="rounded px-2 py-0.5 hover:bg-border/60"
          >
            {copied ? 'Copiado' : 'Copiar URL'}
          </button>
        )}
        <Toggle
          label={`Mock: ${mockLabel(services.mock)}`}
          title={mockTitle(services.mock)}
          status={services.mock?.status}
          disabled={busy !== null || services.mock?.status === 'starting'}
          onClick={services.toggleMock}
        />
        <Toggle
          label={`Webhooks: ${webhooksLabel(webhooks)}`}
          title={webhooksTitle(webhooks)}
          status={webhooks?.status}
          disabled={busy !== null || webhooks?.status === 'starting'}
          onClick={services.toggleWebhooks}
        />
        <Toggle
          label={`MCP: ${mcpLabel(mcp)}`}
          title={mcpTitle(mcp)}
          status={mcp?.status}
          disabled={busy !== null || mcp?.status === 'starting'}
          onClick={toggleMcp}
        />
        {engine?.proxyAvailable && (
          <SegmentedControl
            label="Modo do Secret Engine"
            size="xs"
            value={engine.mode ?? 'localMock'}
            onChange={services.setEngineMode}
            disabled={busy !== null || engine.status === 'starting'}
            options={[
              {
                value: 'localMock',
                label: 'Mock',
                title: 'Local Mock: segredos do cofre local do workspace'
              },
              {
                value: 'enterpriseProxy',
                label: 'Proxy',
                title:
                  'Cloud Proxy: segredos do cofre da organização pelo SSO corporativo, só em memória (VVPost Enterprise)'
              }
            ]}
          />
        )}
        <Toggle
          label={`Secrets: ${engineLabel(engine)}`}
          title={engineTitle(engine)}
          status={engine?.status}
          disabled={busy !== null || engine?.status === 'starting'}
          onClick={services.toggleEngine}
        />
      </div>
    </footer>
  )
}

const dots = { ok: 'bg-success', warn: 'bg-warning', error: 'bg-danger', idle: 'bg-faint' }

function Dot({ tone }: { tone: keyof typeof dots }) {
  return <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${dots[tone]}`} />
}

function Metric(props: { tone: keyof typeof dots; title?: string; children: React.ReactNode }) {
  return (
    <span title={props.title} className={`flex items-center gap-1.5 ${props.tone === 'warn' ? 'text-warning' : ''}`}>
      <Dot tone={props.tone} />
      {props.children}
    </span>
  )
}

function Toggle(props: {
  label: string
  title: string
  status: 'off' | 'starting' | 'running' | 'error' | undefined
  disabled: boolean
  onClick: () => void
}) {
  const running = props.status === 'running'
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      aria-pressed={running}
      className={`flex items-center gap-1.5 rounded px-2 py-0.5 hover:bg-border/60 disabled:opacity-60 ${
        props.status === 'error' ? 'text-danger' : running ? 'text-fg' : ''
      }`}
    >
      <Dot tone={running ? 'ok' : props.status === 'error' ? 'error' : props.status === 'starting' ? 'warn' : 'idle'} />
      {props.label}
    </button>
  )
}

function engineLabel(s: SecretEngineState | null): string {
  switch (s?.status) {
    case 'running':
      return `${s.mode === 'enterpriseProxy' ? 'Cloud Proxy' : 'Local Mock'} :${s.port}`
    case 'starting':
      return 'Iniciando…'
    case 'error':
      return 'Erro'
    default:
      return 'Off'
  }
}

function engineTitle(s: SecretEngineState | null): string {
  if (s?.status === 'running' && s.mode === 'enterpriseProxy') {
    return `Cloud Proxy em http://localhost:${s.port}: as APIs de Azure Key Vault, AWS Secrets Manager e HashiCorp Vault buscam no cofre da organização (${s.environment ?? 'cofre'}), só em memória e com auditoria. Clique para desligar.`
  }
  if (s?.status === 'running') {
    return `Mock de Azure Key Vault, AWS Secrets Manager e HashiCorp Vault em http://localhost:${s.port}, servindo o ambiente ${s.environment ?? '(nenhum)'}. Clique para desligar.`
  }
  if (s?.status === 'error') return `${s.message ?? 'Falha ao ligar o mock.'} Clique para tentar de novo.`
  if (s?.mode === 'enterpriseProxy')
    return 'Ligar o Cloud Proxy (porta 4460): login no SSO da organização e segredos do cofre, só em memória.'
  return 'Ligar o mock de Secret Managers (porta 4460) com os segredos locais do workspace.'
}

function mcpLabel(s: McpServerState | null): string {
  switch (s?.status) {
    case 'running':
      return `:${new URL(s.url ?? 'http://x').port}`
    case 'starting':
      return 'Iniciando…'
    case 'error':
      return 'Erro'
    default:
      return 'Off'
  }
}

function mcpTitle(s: McpServerState | null): string {
  if (s?.status === 'running') {
    return (
      `Servidor MCP do workspace ${s.workspace ?? ''}: Streamable HTTP em ${s.url}/mcp e SSE em ${s.url}/sse` +
      `${s.token ? ', exigindo o token de VVPOST_MCP_TOKEN' : ''}. Credenciais passam pelo Secret Sanitizer. Clique para desligar.`
    )
  }
  if (s?.status === 'error') return `${s.message ?? 'Falha ao ligar o servidor MCP.'} Clique para tentar de novo.`
  return 'Ligar o servidor MCP (HTTP/SSE em 127.0.0.1:4470) para Claude Code, Cursor e Copilot usarem o workspace aberto.'
}

function webhooksLabel(s: WebhookServerState | null): string {
  switch (s?.status) {
    case 'running':
      return `:${new URL(s.url ?? 'http://x').port}${s.events ? ` · ${s.events}` : ''}`
    case 'starting':
      return 'Iniciando…'
    case 'error':
      return 'Erro'
    default:
      return 'Off'
  }
}

function webhooksTitle(s: WebhookServerState | null): string {
  if (s?.status === 'running') {
    const hooks = s.hooks.length ? `${s.hooks.length} hook(s) de .vvpost/webhooks.json` : 'qualquer caminho (sem .vvpost/webhooks.json)'
    return `Servidor de webhooks em ${s.url}: ${hooks}, ${s.events} evento(s) na memória. Os eventos aparecem no módulo Webhooks (Ctrl+0). Clique para desligar.`
  }
  if (s?.status === 'error') return `${s.message ?? 'Falha ao ligar o servidor de webhooks.'} Clique para tentar de novo.`
  return 'Ligar o servidor local de webhooks (127.0.0.1:4480) para receber e inspecionar eventos e disparar fluxos e cenários.'
}

function mockLabel(s: MockServerState | null): string {
  switch (s?.status) {
    case 'running':
      return `:${new URL(s.url ?? 'http://x').port}${s.hits ? ` · ${s.hits}` : ''}`
    case 'starting':
      return 'Iniciando…'
    case 'error':
      return 'Erro'
    default:
      return 'Off'
  }
}

function mockTitle(s: MockServerState | null): string {
  if (s?.status === 'running') {
    return `Mock server em ${s.url}: ${s.endpoints} endpoints no caminho basePath + path, ${s.withExamples} com exemplos de resposta; ${s.hits} requisição(ões) atendidas. Escolha o exemplo com ?__example=<id> ou ?__status=<código>. Clique para desligar.`
  }
  if (s?.status === 'error') return `${s.message ?? 'Falha ao ligar o mock server.'} Clique para tentar de novo.`
  return 'Ligar o mock server local (127.0.0.1:4490): cada endpoint responde com os exemplos de resposta salvos nele.'
}
