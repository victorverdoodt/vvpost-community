import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, History, Power, RefreshCw, RotateCcw, Terminal, Trash2, Webhook, Workflow, FlaskConical } from 'lucide-react'
import type { HttpResult, WebhookEvent, WebhookEventSummary, WebhookHookInfo, WebhookServerState } from '@shared/ipc'
import {
  Badge,
  Button,
  controlClass,
  cx,
  EmptyState,
  Field,
  formatBytes,
  formatDateTime,
  formatMs,
  formatTime,
  IconButton,
  InspectorPanel,
  InspectorSection,
  MethodBadge,
  ResponseViewer,
  separator,
  Shortcut,
  statusTone,
  table,
  Tabs,
  useContextMenu,
  useMenuCommands,
  useToast,
  type ContextMenuEntries,
  ResizablePane,
  type Tone
} from '../../design-system'
import { useServices } from '../../app/shell/useAppServices'
import { copyText } from '../../lib/clipboard'
import { navigate, useNavigation } from '../../lib/navigate'
import { toCode } from '../../lib/request-code'

const TRIGGER_LABEL: Record<NonNullable<WebhookEventSummary['trigger']>['status'], { text: string; tone: Tone }> = {
  queued: { text: 'na fila', tone: 'neutral' },
  running: { text: 'rodando', tone: 'info' },
  passed: { text: 'passou', tone: 'success' },
  failed: { text: 'falhou', tone: 'danger' },
  error: { text: 'erro', tone: 'danger' },
  skipped: { text: 'não rodou', tone: 'warning' }
}

const SIGNATURE_LABEL: Record<NonNullable<WebhookEventSummary['signature']>, { text: string; tone: Tone }> = {
  valid: { text: 'assinatura ok', tone: 'success' },
  invalid: { text: 'assinatura inválida', tone: 'danger' },
  missing: { text: 'sem assinatura', tone: 'danger' },
  unconfigured: { text: 'chave sem valor', tone: 'warning' }
}

/** Corpo recebido no ResponseViewer: o status é o que o servidor respondeu ao remetente. */
function asResult(event: WebhookEvent): HttpResult {
  return {
    ok: true,
    response: {
      status: event.response.status,
      statusText: event.rejected ? 'recusado' : 'respondido',
      headers: event.headers,
      body: event.body,
      ...(event.bodyBase64 !== undefined && { bodyBase64: event.bodyBase64 }),
      sizeBytes: event.sizeBytes,
      truncated: event.truncated,
      timings: { ttfbMs: 0, downloadMs: 0, totalMs: event.response.durationMs }
    }
  }
}

function eventCurl(event: WebhookEvent, base: string): string {
  const skip = new Set(['host', 'content-length', 'connection', 'accept-encoding'])
  return toCode('curl', {
    method: event.method,
    url: new URL(event.url, base).toString(),
    headers: event.headers.filter((h) => !skip.has(h.name.toLowerCase())),
    ...(event.bodyBase64 === undefined && event.body && { body: event.body })
  })
}

/**
 * Webhooks: o servidor local que recebe eventos assíncronos (callbacks de
 * pagamento, notificações de CI, webhooks do GitHub), guarda cada um em memória para inspeção
 * e, pelos hooks de .vvpost/webhooks.json, responde, confere a assinatura e dispara fluxos e
 * cenários. Daqui um evento é reenviado ao servidor ou copiado como cURL.
 */
export default function WebhooksModule() {
  const services = useServices()
  const state = services.webhooks
  const running = state?.status === 'running'
  const [events, setEvents] = useState<WebhookEventSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<WebhookEvent | null>(null)
  const [hook, setHook] = useState('')
  const [search, setSearch] = useState('')
  const notify = useToast()
  const ctx = useContextMenu()

  const reload = useCallback(() => void window.vvpost.listWebhookEvents().then(setEvents), [])

  // A lista acompanha o servidor ao vivo: eventos novos, respostas e disparos atualizados.
  useEffect(() => {
    reload()
    return window.vvpost.onWebhookChange((c) => {
      if (c.change === 'cleared') return setEvents([])
      setEvents((all) =>
        c.change === 'added' ? [c.event, ...all.filter((e) => e.id !== c.event.id)] : all.map((e) => (e.id === c.event.id ? c.event : e))
      )
    })
  }, [reload, state?.url])

  useNavigation('webhooks', (t) => t.eventId !== undefined && setSelectedId(t.eventId))

  const selected = events.find((e) => e.id === selectedId)
  useEffect(() => {
    if (selectedId === null) return setDetail(null)
    let alive = true
    void window.vvpost.getWebhookEvent(selectedId).then((d) => alive && setDetail(d))
    return () => {
      alive = false
    }
    // O detalhe é relido quando o evento muda (resposta enviada, disparo terminou).
  }, [selectedId, selected?.trigger?.status, selected?.response.durationMs])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return events.filter(
      (e) => (hook === '' || (hook === '-' ? !e.hookId : e.hookId === hook)) && (!q || e.url.toLowerCase().includes(q) || e.method.toLowerCase() === q)
    )
  }, [events, hook, search])

  const copy = (text: string, what: string) =>
    void copyText(text, what).then((m) => notify(m, 'success'), () => notify('Não deu para copiar.', 'danger'))
  const replay = async (id: number) => {
    const r = await window.vvpost.replayWebhookEvent(id)
    if (!r.ok) return notify(r.message, 'warning')
    notify(`Reenviado: o servidor respondeu ${r.value.status}`, r.value.status < 400 ? 'success' : 'warning')
    if (r.value.id !== null) setSelectedId(r.value.id)
  }
  const clear = async () => {
    await window.vvpost.clearWebhookEvents()
    setSelectedId(null)
  }
  const base = state?.url ?? 'http://127.0.0.1:4480'
  const sample = `curl -X POST ${base}/teste -H 'Content-Type: application/json' -d '{"ok":true}'`

  const eventEntries = (e: WebhookEventSummary): ContextMenuEntries => [
    { id: 'open', label: 'Ver o evento', run: () => setSelectedId(e.id) },
    { id: 'replay', label: 'Reenviar ao servidor', icon: <RotateCcw size={14} aria-hidden />, shortcut: Shortcut.run, disabled: !running, run: () => void replay(e.id) },
    separator,
    { id: 'copy-url', label: 'Copiar URL', icon: <Copy size={14} aria-hidden />, shortcut: Shortcut.copy, run: () => copy(new URL(e.url, base).toString(), 'URL copiada') },
    {
      id: 'copy-curl',
      label: 'Copiar como cURL',
      icon: <Terminal size={14} aria-hidden />,
      shortcut: Shortcut.copyAsCurl,
      run: () => void window.vvpost.getWebhookEvent(e.id).then((d) => d && copy(eventCurl(d, base), 'cURL copiado'))
    },
    separator,
    e.trigger?.historyRunId !== undefined && {
      id: 'history',
      label: 'Abrir a execução no Histórico',
      icon: <History size={14} aria-hidden />,
      run: () => navigate({ module: 'history', runId: e.trigger!.historyRunId! })
    },
    e.trigger?.kind === 'flow' && { id: 'flow', label: 'Abrir o fluxo no Flow Studio', icon: <Workflow size={14} aria-hidden />, run: () => navigate({ module: 'flows', flowId: e.trigger!.target }) },
    e.trigger?.kind === 'scenarios' && {
      id: 'tests',
      label: 'Abrir os cenários em Tests',
      icon: <FlaskConical size={14} aria-hidden />,
      run: () => navigate({ module: 'scenarios', connectorId: e.trigger!.target })
    }
  ]
  useMenuCommands(
    'Webhooks',
    [
      { id: 'toggle', label: running ? 'Desligar o servidor de webhooks' : 'Ligar o servidor de webhooks', icon: <Power size={14} aria-hidden />, run: services.toggleWebhooks },
      { id: 'copy-base', label: 'Copiar a URL do servidor', icon: <Copy size={14} aria-hidden />, disabled: !running, run: () => copy(base, 'URL copiada') },
      { id: 'clear', label: 'Limpar os eventos', icon: <Trash2 size={14} aria-hidden />, disabled: !events.length, run: () => void clear() },
      ...(selected ? eventEntries(selected).filter((e) => e && 'id' in e && e.id !== 'open') : [])
    ],
    { shortcuts: true }
  )

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
          <Button
            size="sm"
            variant={running ? 'secondary' : 'primary'}
            icon={<Power size={14} aria-hidden />}
            disabled={services.busy !== null || state?.status === 'starting'}
            onClick={services.toggleWebhooks}
          >
            {running ? 'Desligar' : state?.status === 'starting' ? 'Ligando…' : 'Ligar o servidor'}
          </Button>
          {running && (
            <button
              type="button"
              className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-xs text-muted hover:bg-border/60"
              title="Copiar a URL do servidor"
              onClick={() => copy(base, 'URL copiada')}
            >
              <span className="truncate">{base}</span>
              <Copy size={12} aria-hidden />
            </button>
          )}
          <span className="mx-1 h-4 w-px bg-border" />
          <select aria-label="Hook" value={hook} onChange={(e) => setHook(e.target.value)} className={controlClass}>
            <option value="">Todos os hooks</option>
            {state?.hooks.map((h) => (
              <option key={h.id} value={h.id}>
                {h.id}
              </option>
            ))}
            <option value="-">Sem hook</option>
          </select>
          <input
            type="search"
            aria-label="Procurar nos eventos"
            placeholder="Procurar por caminho ou método"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={cx(controlClass, 'w-56 font-mono')}
          />
          <span className="flex-1" />
          <IconButton label="Recarregar" onClick={reload}>
            <RefreshCw size={14} aria-hidden />
          </IconButton>
          <Button size="sm" variant="ghost" icon={<Trash2 size={14} aria-hidden />} disabled={!events.length} onClick={() => void clear()}>
            Limpar
          </Button>
        </div>

        {!running && !events.length ? (
          <EmptyState
            icon={<Webhook size={20} aria-hidden />}
            title={state?.status === 'error' ? 'O servidor de webhooks não ligou' : 'Servidor de webhooks desligado'}
            description={
              state?.status === 'error'
                ? state.message
                : 'Ligue o servidor para receber eventos em http://127.0.0.1:4480 (callbacks, notificações, webhooks de provedores). Cada evento fica aqui, só em memória, e os hooks de .vvpost/webhooks.json respondem, conferem a assinatura e disparam fluxos e cenários.'
            }
          >
            <Button size="sm" variant="primary" icon={<Power size={14} aria-hidden />} disabled={services.busy !== null} onClick={services.toggleWebhooks}>
              Ligar o servidor
            </Button>
          </EmptyState>
        ) : !events.length ? (
          <EmptyState
            icon={<Webhook size={20} aria-hidden />}
            title="Nenhum evento ainda"
            description={
              <>
                Mande qualquer requisição para <span className="font-mono">{base}</span>; ela aparece aqui na hora. Para receber de um serviço na internet, use um túnel
                (ngrok, cloudflared) e libere o host em allowHosts.
              </>
            }
          >
            <Button size="sm" variant="secondary" icon={<Terminal size={14} aria-hidden />} onClick={() => copy(sample, 'cURL de exemplo copiado')}>
              Copiar um cURL de exemplo
            </Button>
          </EmptyState>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <ResizablePane
              id="webhooks.events"
              edge="bottom"
              unit="%"
              label="Altura da lista de eventos"
              defaultSize={40}
              min={12}
              max={85}
              className="overflow-auto border-b border-border"
            >
              <EventsTable events={shown} selectedId={selectedId} onSelect={setSelectedId} menu={(e) => ctx.bind(`Evento ${e.method} ${e.path}`, () => eventEntries(e))} />
              {!shown.length && <p className="p-3 text-xs text-muted">Nenhum evento corresponde aos filtros.</p>}
            </ResizablePane>
            {detail ? (
              <EventView event={detail} />
            ) : (
              <EmptyState title="Nenhum evento selecionado" description="Escolha uma linha para ver headers, query e corpo recebidos." />
            )}
          </div>
        )}
      </div>
      {ctx.menu}
      <InspectorPanel id="webhooks" title="Inspector">
        {detail ? (
          <EventInspector event={detail} base={base} running={running} onReplay={() => void replay(detail.id)} onCopy={copy} />
        ) : (
          <ServerInspector state={state} />
        )}
      </InspectorPanel>
    </div>
  )
}

type MenuBinding = ReturnType<ReturnType<typeof useContextMenu>['bind']>

function EventsTable(props: {
  events: WebhookEventSummary[]
  selectedId: number | null
  onSelect: (id: number) => void
  menu: (e: WebhookEventSummary) => MenuBinding
}) {
  return (
    <table className={table.root} aria-label="Eventos recebidos">
      <thead className={table.head}>
        <tr>
          <th className={table.th}>Quando</th>
          <th className={table.th}>Evento</th>
          <th className={table.th}>Hook</th>
          <th className={table.th}>Resposta</th>
          <th className={table.th}>Disparo</th>
          <th className={cx(table.th, 'text-right')}>Tamanho</th>
        </tr>
      </thead>
      <tbody>
        {props.events.map((e) => {
          const active = e.id === props.selectedId
          const trigger = e.trigger && TRIGGER_LABEL[e.trigger.status]
          return (
            <tr key={e.id} className={cx(table.row, 'cursor-pointer', active && 'bg-accent/10')} onClick={() => props.onSelect(e.id)} {...props.menu(e)}>
              <td className={cx(table.td, 'whitespace-nowrap text-muted')} title={formatDateTime(Date.parse(e.receivedAt))}>
                {formatTime(Date.parse(e.receivedAt))}
              </td>
              <td className={cx(table.td, 'w-full max-w-0')}>
                <button
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    props.onSelect(e.id)
                  }}
                  className="flex w-full min-w-0 items-center gap-2 text-left"
                >
                  <MethodBadge method={e.method} className="w-14" />
                  <span className="min-w-0 truncate font-mono">{e.url}</span>
                </button>
              </td>
              <td className={cx(table.td, 'whitespace-nowrap text-muted')}>{e.hookId ?? '—'}</td>
              <td className={cx(table.td, 'whitespace-nowrap')}>
                <span className="flex items-center gap-1">
                  <Badge mono tone={statusTone(e.response.status)} title={e.rejected}>
                    {e.response.status}
                  </Badge>
                  {e.signature && e.signature !== 'valid' && <Badge tone={SIGNATURE_LABEL[e.signature].tone}>{SIGNATURE_LABEL[e.signature].text}</Badge>}
                  {e.signature === 'valid' && <Badge tone="success">assinado</Badge>}
                </span>
              </td>
              <td className={cx(table.td, 'whitespace-nowrap')}>
                {trigger ? (
                  <Badge tone={trigger.tone} title={e.trigger!.message}>
                    {e.trigger!.kind === 'flow' ? 'fluxo' : 'cenários'} {trigger.text}
                  </Badge>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>
              <td className={cx(table.td, 'text-right font-mono whitespace-nowrap text-muted')}>{formatBytes(e.sizeBytes)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

type DetailTab = 'body' | 'query'

function EventView({ event }: { event: WebhookEvent }) {
  const [tab, setTab] = useState<DetailTab>('body')
  const query = Object.entries(event.query)
  const tabs: { id: DetailTab; label: string }[] = [
    { id: 'body', label: 'Recebido' },
    ...(query.length ? [{ id: 'query' as const, label: `Query (${query.length})` }] : [])
  ]
  const current = tabs.some((t) => t.id === tab) ? tab : 'body'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {event.rejected && (
        <div className="shrink-0 border-b border-border-subtle bg-danger/8 px-3 py-1.5 text-xs text-danger">
          Recusado ({event.response.status}): {event.rejected}. Eventos recusados não disparam nada nem servem aos nós webhook.
        </div>
      )}
      <Tabs label="Detalhe do evento" value={current} onChange={setTab} tabs={tabs} />
      {current === 'body' && (
        <ResponseViewer
          result={asResult(event)}
          pending={false}
          bodyLabel="Corpo"
          meta={<span className="text-muted">resposta dada ao remetente</span>}
          emptyHint="O evento chegou sem corpo."
        />
      )}
      {current === 'query' && (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className={table.root} aria-label="Query do evento">
            <tbody>
              {query.flatMap(([k, v]) =>
                (Array.isArray(v) ? v : [v]).map((value, i) => (
                  <tr key={`${k}-${i}`} className={table.row}>
                    <td className={cx(table.td, 'font-mono whitespace-nowrap text-muted')}>{k}</td>
                    <td className={cx(table.td, 'w-full font-mono break-all')}>{value}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function EventInspector(props: { event: WebhookEvent; base: string; running: boolean; onReplay: () => void; onCopy: (text: string, what: string) => void }) {
  const { event: e } = props
  const t = e.trigger
  const replayOf = e.headers.find((h) => h.name.toLowerCase() === 'x-vvpost-replay-of')?.value
  return (
    <div className="flex flex-col">
      <InspectorSection title={`Evento #${e.id}`}>
        <Field label="Recebido">{formatDateTime(Date.parse(e.receivedAt))}</Field>
        <Field label="Método">{e.method}</Field>
        <Field label="Caminho">
          <span className="font-mono" title={e.url}>
            {e.url}
          </span>
        </Field>
        <Field label="Hook">{e.hookId ?? 'nenhum (resposta padrão)'}</Field>
        <Field label="Resposta">
          {e.response.status} em {formatMs(e.response.durationMs)}
        </Field>
        <Field label="Tamanho">{formatBytes(e.sizeBytes)}</Field>
        {e.remoteAddress && <Field label="Remetente">{e.remoteAddress}</Field>}
        {e.signature && (
          <Field label="Assinatura">
            <Badge tone={SIGNATURE_LABEL[e.signature].tone}>{SIGNATURE_LABEL[e.signature].text}</Badge>
          </Field>
        )}
        {replayOf && <Field label="Reenvio de">#{replayOf}</Field>}
        <div className="flex flex-wrap gap-2 px-3 pt-1 pb-3">
          <Button size="sm" variant="secondary" icon={<RotateCcw size={14} aria-hidden />} disabled={!props.running} onClick={props.onReplay}>
            Reenviar
          </Button>
          <Button size="sm" variant="ghost" icon={<Terminal size={14} aria-hidden />} onClick={() => props.onCopy(eventCurl(e, props.base), 'cURL copiado')}>
            Copiar cURL
          </Button>
        </div>
      </InspectorSection>
      {t && (
        <InspectorSection title="Disparo">
          <Field label={t.kind === 'flow' ? 'Fluxo' : 'Cenários de'}>{t.target}</Field>
          <Field label="Ambiente">{t.environmentId || 'sem ambiente'}</Field>
          <Field label="Resultado">
            <Badge tone={TRIGGER_LABEL[t.status].tone}>{TRIGGER_LABEL[t.status].text}</Badge>
          </Field>
          {t.durationMs !== undefined && <Field label="Duração">{formatMs(t.durationMs)}</Field>}
          {t.message && <p className="px-3 pb-2 text-xs break-words text-muted">{t.message}</p>}
          <div className="flex flex-wrap gap-2 px-3 pb-3">
            {t.historyRunId !== undefined && (
              <Button size="sm" variant="ghost" icon={<History size={14} aria-hidden />} onClick={() => navigate({ module: 'history', runId: t.historyRunId! })}>
                Ver no Histórico
              </Button>
            )}
            {t.kind === 'flow' && (
              <Button size="sm" variant="ghost" icon={<Workflow size={14} aria-hidden />} onClick={() => navigate({ module: 'flows', flowId: t.target })}>
                Abrir o fluxo
              </Button>
            )}
          </div>
        </InspectorSection>
      )}
    </div>
  )
}

function ServerInspector({ state }: { state: WebhookServerState | null }) {
  if (state?.status !== 'running') {
    return <EmptyState title="Servidor desligado" description="Ligado, o inspector mostra a URL, o ambiente e os hooks de .vvpost/webhooks.json." />
  }
  return (
    <div className="flex flex-col">
      <InspectorSection title="Servidor">
        <Field label="URL">
          <span className="font-mono">{state.url}</span>
        </Field>
        <Field label="Ambiente">{state.environment ?? 'nenhum'}</Field>
        <Field label="Eventos">{state.events}</Field>
        {!state.configured && (
          <p className="px-3 pb-3 text-xs text-muted">
            Sem .vvpost/webhooks.json: todo caminho responde 200. Crie o arquivo para respostas próprias, assinaturas e disparos (veja docs/webhooks.md).
          </p>
        )}
      </InspectorSection>
      {state.hooks.length > 0 && (
        <InspectorSection title="Hooks" count={state.hooks.length}>
          <ul className="flex flex-col gap-1 px-3 pb-3">
            {state.hooks.map((h) => (
              <HookRow key={h.id} hook={h} />
            ))}
          </ul>
        </InspectorSection>
      )}
    </div>
  )
}

function HookRow({ hook: h }: { hook: WebhookHookInfo }) {
  return (
    <li className="rounded-[var(--radius-control)] bg-surface px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-fg">{h.name ?? h.id}</span>
        <span className="truncate font-mono text-muted">
          {h.methods?.join(',') ?? '*'} {h.path}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        <Badge mono tone={statusTone(h.status)}>
          {h.status}
        </Badge>
        {h.signatureHeader && <Badge tone="info">assinatura em {h.signatureHeader}</Badge>}
        {h.trigger && (
          <Badge tone="accent">
            {h.trigger.kind === 'flow' ? 'fluxo' : 'cenários de'} {h.trigger.target}
          </Badge>
        )}
      </div>
    </li>
  )
}
