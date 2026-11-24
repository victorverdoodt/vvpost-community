import { useState, type ReactNode } from 'react'
import { FolderOpen, Network, ShieldCheck, TriangleAlert, Workflow } from 'lucide-react'
import { Badge, Button, ContextSelector, cx } from '../../design-system'
import type { useWorkspace } from '../../panels/useWorkspace'
import { useShortWindow } from '../../lib/short-window'
import { navigate } from '../../lib/navigate'
import type { Endpoint } from './draft'

/**
 * Faixa de contexto do Quick Request: conector, ambiente e endpoint (ContextSelector) e o resumo
 * do que o conector aplica sozinho (auth, mTLS, headers herdados).
 */
export function QuickContext(props: {
  ws: ReturnType<typeof useWorkspace>
  onPickEndpoint: (endpoint: Endpoint) => void
  /** Fluxos do workspace que podem preparar a requisição (login, token, dados). */
  flows: { id: string; name: string }[]
  prepareFlowId: string
  onPrepareFlow: (flowId: string) => void
  /** Nós de antes do fluxo que a aba é: rodam em segundo plano, no lugar da preparação. */
  inlinePrepare?: string[]
  /** No fim da faixa: a visão do documento (Simples | Canvas). */
  trailing?: ReactNode
}) {
  const { ws } = props
  const { workspace, selection, environment } = ws
  const connector = selection.connector
  const [renewed, setRenewed] = useState(false)
  // Janela baixa (150%): a faixa vira uma linha só, para a requisição e a resposta terem espaço.
  const compact = useShortWindow()

  if (!workspace) {
    return (
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 text-xs text-muted">
        <Button size="sm" icon={<FolderOpen size={14} aria-hidden />} onClick={ws.open}>
          Abrir workspace…
        </Button>
        <span>Abra uma pasta VVPost para herdar URL base, headers e auth dos conectores. Sem ela, a URL é livre.</span>
        {ws.result && !ws.result.ok && <span className="text-danger">{ws.result.message}</span>}
      </div>
    )
  }

  const dynamicAuth = connector?.auth?.type === 'oauth2' || connector?.auth?.type === 'login'
  const missing = environment?.missingSecrets ?? []
  const via = (from: string) => (connector && from !== connector.id ? ` · de ${from}` : '')

  return (
    <div
      data-compact={compact || undefined}
      className={cx(
        'flex shrink-0 flex-wrap items-end border-b border-border px-4',
        compact ? 'gap-2 py-1.5' : 'gap-3 py-3'
      )}
    >
      <ContextSelector
        label="Contexto da requisição"
        compact={compact}
        fields={[
          {
            label: 'Conector',
            ariaLabel: 'Conector',
            icon: <Network size={13} aria-hidden />,
            value: connector?.id ?? '',
            onFocus: ws.reload,
            onChange: ws.selectConnector,
            options: [
              { value: '', label: 'Nenhum (URL livre)' },
              ...workspace.connectors.map((c) => ({
                value: c.id,
                label: c.error ? `${c.name} (erro)` : c.name,
                disabled: !!c.error
              }))
            ]
          },
          {
            label: 'Ambiente',
            ariaLabel: 'Ambiente',
            status: environment ? (missing.length ? 'warn' : 'ok') : undefined,
            value: selection.environmentId,
            onFocus: ws.reload,
            onChange: ws.selectEnvironment,
            width: 'w-44',
            options: [
              { value: '', label: 'Nenhum' },
              ...workspace.environments.map((e) => ({ value: e.id, label: e.name }))
            ]
          },
          ...(connector && connector.endpoints.length > 0
            ? [
                {
                  label: 'Endpoint',
                  ariaLabel: 'Endpoint',
                  value: '',
                  width: 'w-64',
                  onChange: (id: string) => {
                    const endpoint = connector.endpoints.find((x) => x.id === id)
                    if (endpoint) props.onPickEndpoint(endpoint)
                  },
                  options: [
                    { value: '', label: 'Preencher a partir de…' },
                    ...connector.endpoints.map((e) => ({ value: e.id, label: `${e.method} ${e.path} · ${e.name}` }))
                  ]
                }
              ]
            : []),
          // Preparação headless: o fluxo roda antes do envio, sem abrir o canvas.
          ...(!props.inlinePrepare?.length && (props.flows.length > 0 || props.prepareFlowId)
            ? [
                {
                  label: 'Preparação',
                  ariaLabel: 'Fluxo de preparação',
                  icon: <Workflow size={13} aria-hidden />,
                  value: props.prepareFlowId,
                  width: 'w-48',
                  onChange: props.onPrepareFlow,
                  options: [
                    { value: '', label: 'Nenhuma' },
                    ...props.flows.map((f) => ({ value: f.id, label: f.name })),
                    ...(props.prepareFlowId && !props.flows.some((f) => f.id === props.prepareFlowId)
                      ? [{ value: props.prepareFlowId, label: `${props.prepareFlowId} (não encontrado)` }]
                      : [])
                  ]
                }
              ]
            : [])
        ]}
      />

      {connector && !connector.error && (
        <div
          className={cx(
            'flex h-8 min-w-0 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-elevated px-2.5 text-xs',
            compact && 'max-w-72'
          )}
        >
          <ShieldCheck size={14} className={connector.auth ? 'text-success' : 'text-muted'} aria-hidden />
          <span className="truncate" title={connector.auth ? `Auth herdada de ${connector.auth.from}` : undefined}>
            {connector.auth ? `${connector.auth.summary}${via(connector.auth.from)}` : 'Sem auth herdada'}
          </span>
          {connector.tlsFrom && <Badge tone="info">mTLS</Badge>}
          <Badge>
            {connector.headers.length} {connector.headers.length === 1 ? 'header' : 'headers'}
          </Badge>
          {dynamicAuth && (
            <button
              type="button"
              className="shrink-0 text-muted underline-offset-2 hover:text-fg hover:underline"
              title="Descarta o token em memória; a próxima requisição roda o fluxo de auth de novo"
              onClick={() =>
                void window.vvpost.clearAuthCache(connector.auth!.from).then(() => {
                  setRenewed(true)
                  setTimeout(() => setRenewed(false), 1500)
                })
              }
            >
              {renewed ? 'Token descartado' : 'Renovar token'}
            </button>
          )}
        </div>
      )}

      {!!props.inlinePrepare?.length && (
        <span
          className="flex h-8 min-w-0 items-center gap-1.5 self-end text-xs text-muted"
          title="Os nós anteriores do fluxo rodam em segundo plano antes do envio; a requisição lê a saída deles com {{ $nodes.Nome... }}"
        >
          <Workflow size={13} className="shrink-0" aria-hidden />
          <span className="truncate">Antes: {props.inlinePrepare.join(' → ')}</span>
        </span>
      )}

      {props.trailing && <div className="ml-auto flex shrink-0 items-center self-center">{props.trailing}</div>}

      {(missing.length > 0 || workspace.issues.length > 0 || connector?.error) && (
        <div className="flex w-full flex-wrap gap-x-4 gap-y-1 text-xs">
          {missing.length > 0 && environment && (
            // Leva ao Secrets, no ambiente da requisição e no primeiro segredo pendente, para preencher.
            <button
              type="button"
              className="flex items-center gap-1.5 text-left text-warning underline-offset-2 hover:underline"
              title={`Preencher no Secrets (${environment.name})`}
              onClick={() => navigate({ module: 'secrets', environmentId: environment.id, variable: missing[0] })}
            >
              <TriangleAlert size={13} className="shrink-0" aria-hidden />
              Segredos sem valor: {missing.join(', ')}
            </button>
          )}
          {workspace.issues.length > 0 && (
            <span
              className="flex items-center gap-1.5 text-warning"
              title={workspace.issues.map((i) => `${i.file}: ${i.message}`).join('\n')}
            >
              <TriangleAlert size={13} aria-hidden />
              {workspace.issues.length === 1 ? '1 problema' : `${workspace.issues.length} problemas`} no workspace
            </span>
          )}
          {connector?.error && <span className="text-danger">{connector.error}</span>}
        </div>
      )}
    </div>
  )
}
