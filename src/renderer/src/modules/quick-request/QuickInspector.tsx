import { Copy, FileInput, RotateCw, SquarePlus, Terminal, Trash2 } from 'lucide-react'
import type { CatalogConnector, HistoryRunSummary } from '@shared/ipc'
import {
  separator,
  Shortcut,
  useContextMenu,
  Badge,
  Field,
  formatMs,
  InheritanceBadge,
  InspectorPanel,
  InspectorSection,
  MethodBadge,
  statusTone,
  formatTime
} from '../../design-system'
import { AUTH_LABEL } from './RequestEditor'
import type { RequestDraft } from './draft'

/**
 * Inspector do Quick Request: explica a requisição ativa (auth efetiva, herança, headers que vão
 * no envio, endpoint de origem) e guarda as requisições recentes. Lê o estado do módulo, sem
 * cópia própria.
 */
export function QuickInspector(props: {
  draft: RequestDraft
  connector: CatalogConnector | null
  history: HistoryRunSummary[]
  onPickHistory: (entry: HistoryRunSummary) => void
  onOpenHistory: (entry: HistoryRunSummary) => void
  onResendHistory: (entry: HistoryRunSummary) => void
  onDeleteHistory: (entry: HistoryRunSummary) => void
  onCopyHistory: (entry: HistoryRunSummary, as: 'url' | 'curl') => void
  onClearHistory: () => void
  /** Endpoint público: manda (true) ou não a auth do conector. */
  onWithAuth?: (withAuth: boolean) => void
}) {
  const { draft, connector } = props
  const ctx = useContextMenu()
  const icon = { size: 14, 'aria-hidden': true } as const
  const endpoint = connector?.endpoints.find((e) => e.id === draft.endpointId)
  const lastAuth = draft.result?.auth
  // Endpoint público: vai sem credencial, como no vvpost run, a menos que a aba peça a auth.
  const isPublic = !!connector?.auth && endpoint?.requiresAuth === false && !endpoint.plugin
  const anonymous = isPublic && !draft.withAuth
  const local = draft.headers.filter((h) => h.enabled && h.name.trim())
  const localNames = new Set(local.map((h) => h.name.trim().toLowerCase()))
  const inheritedNames = new Set(connector?.headers.map((h) => h.name.toLowerCase()))

  return (
    <InspectorPanel id="quick-request" title="Inspector">
      {connector && (
        <>
          <InspectorSection title="Autenticação">
            {connector.auth ? (
              <>
                <Field label="Tipo">{AUTH_LABEL[connector.auth.type]}</Field>
                <Field
                  label="Origem"
                  aside={<InheritanceBadge kind={connector.auth.from === connector.id ? 'local' : 'inherited'} />}
                >
                  <span className="font-mono">{connector.auth.from}</span>
                </Field>
                {isPublic && (
                  <>
                    <p className="text-xs text-muted" role="note">
                      {anonymous
                        ? 'Endpoint público (requiresAuth: false): vai sem a auth do conector e sem os headers de credencial, como no vvpost run.'
                        : 'Endpoint público, mas esta aba manda a auth do conector.'}
                    </p>
                    <label className="flex items-center gap-2 text-xs">
                      <input type="checkbox" checked={!!draft.withAuth} onChange={(e) => props.onWithAuth?.(e.target.checked)} />
                      Enviar a auth mesmo assim
                    </label>
                  </>
                )}
                <Field label="Último envio">
                  {anonymous && !lastAuth ? 'sem credencial' : lastAuth
                    ? lastAuth.source === 'cache'
                      ? 'token em cache'
                      : lastAuth.source === 'static'
                        ? 'credencial do ambiente'
                        : `fluxo rodou em ${formatMs(lastAuth.ms)}`
                    : 'ainda não enviada'}
                </Field>
                {lastAuth?.expiresAt && (
                  <Field label="Expira">{formatTime(lastAuth.expiresAt)}</Field>
                )}
              </>
            ) : (
              <p className="text-xs text-muted">O conector não define auth.</p>
            )}
          </InspectorSection>

          <InspectorSection title="Herança" count={connector.chain.length}>
            <div className="flex flex-col gap-1 text-xs">
              {connector.chain.map((id, i) => (
                <div key={id} className="flex items-center gap-2" style={{ paddingLeft: i * 12 }}>
                  <span className="text-faint">{i === 0 ? '◆' : '└'}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{id}</span>
                  {i === connector.chain.length - 1 ? (
                    <Badge tone="accent">atual</Badge>
                  ) : (
                    <Badge tone="success">extends</Badge>
                  )}
                </div>
              ))}
              {connector.tlsFrom && (
                <Field
                  label="mTLS"
                  aside={<InheritanceBadge kind={connector.tlsFrom === connector.id ? 'local' : 'inherited'} />}
                >
                  <span className="font-mono">{connector.tlsFrom}</span>
                </Field>
              )}
            </div>
          </InspectorSection>
        </>
      )}

      <InspectorSection title="Headers no envio" count={local.length + (connector?.headers.length ?? 0)}>
        {local.length + (connector?.headers.length ?? 0) === 0 ? (
          <p className="text-xs text-muted">Nenhum header.</p>
        ) : (
          <div className="font-mono">
            {connector?.headers.map((h) => (
              <Field key={`i-${h.name}`} label={h.name} aside={<InheritanceBadge kind="inherited" />}>
                <span className={localNames.has(h.name.toLowerCase()) ? 'text-faint line-through' : ''}>{h.value}</span>
              </Field>
            ))}
            {local.map((h) => (
              <Field
                key={`l-${h.key}`}
                label={h.name}
                aside={
                  <InheritanceBadge kind={inheritedNames.has(h.name.trim().toLowerCase()) ? 'overridden' : 'local'} />
                }
              >
                {h.value}
              </Field>
            ))}
          </div>
        )}
      </InspectorSection>

      {endpoint && (
        <InspectorSection title="Endpoint">
          <Field label="Nome">{endpoint.name}</Field>
          <Field label="Método">
            <MethodBadge method={endpoint.method} />
          </Field>
          <Field label="Caminho">
            <span className="font-mono">{endpoint.path}</span>
          </Field>
          <Field label="Cenários">{endpoint.scenarios.length}</Field>
          <Field label="Exemplos (mock)">{endpoint.examples?.length ?? 0}</Field>
        </InspectorSection>
      )}

      <InspectorSection
        title="Requisições recentes"
        count={props.history.length}
        actions={
          props.history.length > 0 && (
            <button type="button" onClick={props.onClearHistory} className="text-[11px] text-muted hover:text-fg">
              Limpar
            </button>
          )
        }
      >
        {props.history.length === 0 ? (
          <p className="text-xs text-muted">Nenhuma requisição ainda.</p>
        ) : (
          <ul className="-mx-3">
            {props.history.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => props.onPickHistory(e)}
                  {...ctx.bind(`Histórico ${e.method ?? ''} ${e.url ?? ''}`, () => [
                    { id: 'open', label: 'Abrir em nova aba', icon: <SquarePlus {...icon} />, shortcut: Shortcut.openInNewTab, run: () => props.onOpenHistory(e) },
                    { id: 'load', label: 'Carregar na aba atual', icon: <FileInput {...icon} />, run: () => props.onPickHistory(e) },
                    { id: 'resend', label: 'Enviar de novo em nova aba', icon: <RotateCw {...icon} />, shortcut: Shortcut.run, run: () => props.onResendHistory(e) },
                    separator,
                    { id: 'copy-url', label: 'Copiar URL', icon: <Copy {...icon} />, shortcut: Shortcut.copy, disabled: !e.url, run: () => props.onCopyHistory(e, 'url') },
                    { id: 'copy-curl', label: 'Copiar como cURL', icon: <Terminal {...icon} />, shortcut: Shortcut.copyAsCurl, run: () => props.onCopyHistory(e, 'curl') },
                    separator,
                    { id: 'delete', label: 'Remover do histórico', icon: <Trash2 {...icon} />, shortcut: Shortcut.remove, danger: true, run: () => props.onDeleteHistory(e) },
                    { id: 'clear', label: 'Limpar o histórico', danger: true, run: props.onClearHistory }
                  ])}
                  title={e.connectorId ? `${e.connectorId} ${e.url}` : (e.url ?? undefined)}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-xs hover:bg-elevated"
                >
                  <MethodBadge method={e.method ?? 'GET'} className="w-14" />
                  <span className="min-w-0 flex-1 truncate">{e.url}</span>
                  <span className={e.status ? textTone(e.status) : 'text-danger'}>{e.status ?? e.errorCode}</span>
                  <span className="w-14 shrink-0 text-right text-muted">{formatMs(e.durationMs)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>
      {ctx.menu}
    </InspectorPanel>
  )
}

function textTone(status: number): string {
  const tone = statusTone(status)
  return tone === 'success'
    ? 'text-success'
    : tone === 'warning'
      ? 'text-warning'
      : tone === 'danger'
        ? 'text-danger'
        : 'text-info'
}
