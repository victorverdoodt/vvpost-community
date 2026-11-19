import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, ExternalLink, FlaskConical, History, RefreshCw, RotateCcw, Server, Settings2, Terminal, Trash2, Workflow } from 'lucide-react'
import type {
  FlowNodeResult,
  HistoryExchange,
  HistoryOutcome,
  HistoryQuery,
  HistoryRunDetail,
  HistoryRunSummary,
  HistorySource,
  HttpErrorCode,
  HttpResult
} from '@shared/ipc'
import {
  AssertionList,
  Badge,
  Button,
  CodeEditor,
  controlClass,
  cx,
  EmptyState,
  Field,
  formatBytes,
  formatJson,
  formatMs,
  IconButton,
  InspectorPanel,
  InspectorSection,
  MethodBadge,
  OutcomeCell,
  failureKind,
  OutcomeTotals,
  ResponseViewer,
  SegmentedControl,
  table,
  separator,
  Shortcut,
  Tabs,
  useContextMenu,
  useMenuCommands,
  usePromptDialog,
  useToast,
  type ContextMenuEntries,
  type Outcome,
  formatDateTime,
  formatTime,
  ResizablePane
} from '../../design-system'
import { copyText } from '../../lib/clipboard'
import { navigate, useNavigation } from '../../lib/navigate'
import { openInQuickRequest } from '../../lib/open-request'
import { toCode } from '../../lib/request-code'
import { HistorySettingsView, LEVEL_LABEL } from './HistorySettings'
import { confirmProtected } from '../../lib/protected'
import { useWorkspace } from '../../panels/useWorkspace'

/** remote: as execuções de um Execution Runner, de qualquer origem. */
type SourceFilter = HistorySource | 'all' | 'remote'

export const SOURCE_LABEL: Record<HistorySource, string> = {
  request: 'Quick Request',
  scenarios: 'Cenários',
  flow: 'Fluxo',
  cli: 'CLI'
}

const OUTCOME_LABEL: Record<HistoryOutcome, string> = {
  passed: 'ok',
  failed: 'falhou',
  error: 'erro',
  canceled: 'cancelado'
}

/** Cancelado aparece como erro na célula (com o texto dizendo "cancelado"). */
const cellOutcome = (o: HistoryOutcome | null): Outcome | undefined => (o === null ? undefined : o === 'canceled' ? 'error' : o)

const PAGE = 100

/**
 * Histórico: toda execução do app (Quick Request, cenários, fluxos) e do CLI com
 * `--history`, com as requisições como foram montadas e como foram para a rede, a resposta, as
 * asserções e os logs, no nível de riqueza de cada origem. Daqui uma requisição é reaberta no
 * Quick Request ou reproduzida, com {{VAR}} e auth resolvidos de novo.
 */
export default function HistoryModule() {
  const [source, setSource] = useState<SourceFilter>('all')
  const [outcome, setOutcome] = useState<HistoryOutcome | ''>('')
  const [search, setSearch] = useState('')
  const [runs, setRuns] = useState<HistoryRunSummary[] | null>(null)
  const [more, setMore] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<HistoryRunDetail | null>(null)
  const [exchangeId, setExchangeId] = useState<number | null>(null)
  const [view, setView] = useState<'runs' | 'settings'>('runs')
  const root = useRef<HTMLDivElement>(null)
  useNavigation('history', (t) => {
    setView('runs')
    if (t.runId !== undefined) {
      setSource('all')
      setOutcome('')
      setSearch('')
      setSelectedId(t.runId)
    }
  })

  const query = useMemo<HistoryQuery>(
    () => ({
      ...(source === 'remote' ? { remote: true } : source !== 'all' && { source }),
      ...(outcome && { outcome }),
      ...(search.trim() && { search: search.trim() }),
      limit: PAGE
    }),
    [source, outcome, search]
  )

  const refresh = useCallback(() => {
    void window.vvpost.listHistory(query).then((rows) => {
      setRuns(rows)
      setMore(rows.length === PAGE)
    })
  }, [query])

  // A busca espera a digitação parar; os filtros recarregam na hora.
  useEffect(() => {
    const t = setTimeout(refresh, search ? 200 : 0)
    return () => clearTimeout(t)
  }, [refresh, search])

  // O módulo fica montado quando oculto: só relê enquanto está visível (execuções de outros módulos).
  useEffect(() => {
    const tick = () => {
      if (root.current?.offsetParent) refresh()
    }
    const interval = setInterval(tick, 4000)
    window.addEventListener('focus', tick)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', tick)
    }
  }, [refresh])

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null)
      return
    }
    let alive = true
    void window.vvpost.getHistoryRun(selectedId).then((d) => {
      if (!alive) return
      setDetail(d)
      setExchangeId(d?.exchanges[0]?.id ?? null)
    })
    return () => {
      alive = false
    }
  }, [selectedId])

  const loadMore = () => {
    const last = runs?.at(-1)
    if (!last) return
    void window.vvpost.listHistory({ ...query, beforeId: last.id }).then((rows) => {
      setRuns((all) => [...(all ?? []), ...rows])
      setMore(rows.length === PAGE)
    })
  }

  const exchange = detail?.exchanges.find((x) => x.id === exchangeId) ?? null

  // Menus de contexto da lista de execuções e das requisições de uma execução.
  const ctx = useContextMenu()
  const notify = useToast()
  const dialog = usePromptDialog()
  const ws = useWorkspace()
  // Reproduzir num ambiente protegido pede confirmação, como qualquer disparo (docs/security-model.md).
  const confirmReplay = (x: HistoryExchange) =>
    confirmProtected(dialog.confirm, [ws.workspace?.environments.find((e) => e.id === x.environmentId)], 'Reproduzir a requisição')
  const copy = (text: string, what: string) =>
    void copyText(text, what).then((m) => notify(m, 'success'), () => notify('Não deu para copiar.', 'danger'))
  const firstExchange = async (id: number) => {
    const run = id === detail?.id ? detail : await window.vvpost.getHistoryRun(id)
    const x = run?.exchanges[0]
    if (!x) notify('A execução não tem requisições guardadas.', 'warning')
    return x ?? null
  }
  const replay = async (x: HistoryExchange) => {
    if (!x.replayable) return notify(`Reproduzir indisponível: ${x.replayBlocked ?? 'nível de histórico baixo'}.`, 'warning')
    if (!(await confirmReplay(x))) return
    const r = await window.vvpost.replayHistory(x.id)
    if (!r.ok) return notify(r.message, 'warning')
    notify(r.result.ok ? `Reproduzida: HTTP ${r.result.response.status}` : `Reproduzida com erro: ${r.result.error.code}`, r.result.ok && r.result.response.status < 400 ? 'success' : 'warning')
    refresh()
    if (r.runId !== null) setSelectedId(r.runId)
  }
  const exchangeEntries = (x: HistoryExchange): ContextMenuEntries => [
    { id: 'reopen', label: 'Reabrir no Quick Request', icon: <ExternalLink size={14} aria-hidden />, shortcut: Shortcut.openInNewTab, run: () => reopenExchange(x, notify) },
    { id: 'replay', label: 'Reproduzir', icon: <RotateCcw size={14} aria-hidden />, shortcut: Shortcut.run, disabled: !x.replayable, hint: x.replayable ? undefined : x.replayBlocked, run: () => void replay(x) },
    separator,
    { id: 'copy-url', label: 'Copiar URL', icon: <Copy size={14} aria-hidden />, shortcut: Shortcut.copy, run: () => copy(x.sent?.url ?? x.url, 'URL copiada') },
    { id: 'copy-curl', label: 'Copiar como cURL', icon: <Terminal size={14} aria-hidden />, shortcut: Shortcut.copyAsCurl, run: () => copy(exchangeCurl(x), 'cURL copiado (segredos mascarados)') },
    x.response?.body !== undefined && { id: 'copy-body', label: 'Copiar o corpo da resposta', run: () => copy(x.response!.body!, 'Corpo copiado') }
  ]
  const runEntries = (r: HistoryRunSummary): ContextMenuEntries => [
    { id: 'open', label: 'Ver a execução', run: () => setSelectedId(r.id) },
    {
      id: 'reopen',
      label: 'Reabrir no Quick Request',
      icon: <ExternalLink size={14} aria-hidden />,
      shortcut: Shortcut.openInNewTab,
      disabled: r.exchangeCount === 0,
      run: () => void firstExchange(r.id).then((x) => x && reopenExchange(x, notify))
    },
    {
      id: 'replay',
      label: r.exchangeCount > 1 ? 'Reproduzir a primeira requisição' : 'Reproduzir',
      icon: <RotateCcw size={14} aria-hidden />,
      shortcut: Shortcut.run,
      disabled: r.exchangeCount === 0,
      run: () => void firstExchange(r.id).then((x) => x && replay(x))
    },
    separator,
    r.url && { id: 'copy-url', label: 'Copiar URL', icon: <Copy size={14} aria-hidden />, shortcut: Shortcut.copy, run: () => copy(r.url!, 'URL copiada') },
    {
      id: 'copy-curl',
      label: 'Copiar como cURL',
      icon: <Terminal size={14} aria-hidden />,
      shortcut: Shortcut.copyAsCurl,
      disabled: r.exchangeCount === 0,
      run: () => void firstExchange(r.id).then((x) => x && copy(exchangeCurl(x), 'cURL copiado (segredos mascarados)'))
    },
    separator,
    r.flowId && { id: 'flow', label: 'Abrir o fluxo no Flow Studio', icon: <Workflow size={14} aria-hidden />, run: () => navigate({ module: 'flows', flowId: r.flowId! }) },
    r.source === 'scenarios' && r.connectorId && { id: 'tests', label: 'Abrir os cenários em Tests', icon: <FlaskConical size={14} aria-hidden />, run: () => navigate({ module: 'scenarios', connectorId: r.connectorId! }) },
    r.connectorId && { id: 'catalog', label: 'Abrir o conector no Catálogo', run: () => navigate({ module: 'catalog', connectorId: r.connectorId! }) },
    r.replayOf !== null && { id: 'original', label: `Ver a execução original (#${r.replayOf})`, run: () => setSelectedId(r.replayOf) },
    separator,
    {
      id: 'delete',
      label: 'Apagar…',
      icon: <Trash2 size={14} aria-hidden />,
      shortcut: Shortcut.remove,
      danger: true,
      run: async () => {
        const ok = await dialog.confirm({ title: 'Apagar esta execução do histórico?', message: r.url ?? r.title, confirmLabel: 'Apagar', danger: true })
        if (!ok) return
        await window.vvpost.deleteHistoryRun(r.id)
        if (r.id === selectedId) setSelectedId(null)
        refresh()
      }
    }
  ]
  const selectedRun = runs?.find((r) => r.id === selectedId)
  useMenuCommands('Histórico', [
    { id: 'reload', label: 'Recarregar o histórico', icon: <RefreshCw size={14} aria-hidden />, run: refresh },
    { id: 'settings', label: view === 'settings' ? 'Voltar às execuções' : 'Configurar o histórico', icon: <Settings2 size={14} aria-hidden />, run: () => setView(view === 'settings' ? 'runs' : 'settings') },
    ...(selectedRun && view === 'runs' ? runEntries(selectedRun).filter((e) => e && 'id' in e && e.id !== 'open') : [])
  ], { shortcuts: true })

  const afterDelete = () => {
    setSelectedId(null)
    refresh()
  }

  return (
    <div ref={root} className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
          <SegmentedControl<SourceFilter>
            label="Origem"
            value={source}
            onChange={setSource}
            options={[
              { value: 'all', label: 'Tudo' },
              { value: 'request', label: 'Requisições' },
              { value: 'scenarios', label: 'Cenários' },
              { value: 'flow', label: 'Fluxos' },
              { value: 'cli', label: 'CLI' },
              { value: 'remote', label: 'Remotas' }
            ]}
          />
          <select
            aria-label="Resultado"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as HistoryOutcome | '')}
            className={controlClass}
          >
            <option value="">Qualquer resultado</option>
            <option value="passed">Ok</option>
            <option value="failed">Falhou</option>
            <option value="error">Erro</option>
            <option value="canceled">Cancelado</option>
          </select>
          <input
            type="search"
            aria-label="Procurar no histórico"
            placeholder="Procurar por URL, cenário ou título"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={cx(controlClass, 'w-64 font-mono')}
          />
          <span className="flex-1" />
          <IconButton label="Recarregar" onClick={refresh}>
            <RefreshCw size={14} aria-hidden />
          </IconButton>
          <Button
            size="sm"
            variant={view === 'settings' ? 'primary' : 'secondary'}
            icon={<Settings2 size={14} aria-hidden />}
            aria-pressed={view === 'settings'}
            onClick={() => setView(view === 'settings' ? 'runs' : 'settings')}
          >
            Configurar
          </Button>
        </div>

        {view === 'settings' ? (
          <HistorySettingsView onChanged={refresh} />
        ) : runs === null ? null : runs.length === 0 ? (
          <EmptyState
            icon={<History size={20} aria-hidden />}
            title={query.source || query.outcome || query.search ? 'Nada encontrado' : 'Histórico vazio'}
            description={
              query.source || query.outcome || query.search
                ? 'Nenhuma execução corresponde aos filtros.'
                : 'Requisições do Quick Request, lotes de cenários e fluxos aparecem aqui, com request e response no nível escolhido em Configurar.'
            }
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <ResizablePane
              id="history.runs"
              edge="bottom"
              unit="%"
              label="Altura da lista de execuções"
              defaultSize={40}
              min={12}
              max={85}
              className="overflow-auto border-b border-border"
            >
              <RunsTable runs={runs} selectedId={selectedId} onSelect={setSelectedId} menu={(r) => ctx.bind(`Execução ${r.url ?? r.title}`, () => runEntries(r))} />
              {more && (
                <div className="p-2 text-center">
                  <Button size="sm" variant="ghost" onClick={loadMore}>
                    Carregar mais
                  </Button>
                </div>
              )}
            </ResizablePane>
            {detail ? (
              <RunView run={detail} exchange={exchange} onSelectExchange={setExchangeId} menu={(x) => ctx.bind(`Requisição ${x.label ?? x.url}`, () => exchangeEntries(x))} />
            ) : (
              <EmptyState title="Nenhuma execução selecionada" description="Escolha uma linha para ver as requisições, a resposta e as asserções." />
            )}
          </div>
        )}
      </div>
      {ctx.menu}
      {dialog.element}
      <InspectorPanel id="history" title="Inspector">
        {detail && view === 'runs' ? (
          <RunInspector
            run={detail}
            exchange={exchange}
            onOpenRun={(id) => setSelectedId(id)}
            confirmReplay={confirmReplay}
            onReplayed={(id) => {
              refresh()
              if (id !== null) setSelectedId(id)
            }}
            onDeleted={afterDelete}
          />
        ) : (
          <EmptyState title="Nada selecionado" description="O inspector mostra a execução e a requisição escolhidas, com reproduzir e reabrir." />
        )}
      </InspectorPanel>
    </div>
  )
}

type MenuBinding = ReturnType<ReturnType<typeof useContextMenu>['bind']>

function RunsTable(props: {
  runs: HistoryRunSummary[]
  selectedId: number | null
  onSelect: (id: number) => void
  menu: (r: HistoryRunSummary) => MenuBinding
}) {
  return (
    <table className={table.root} aria-label="Execuções">
      <thead className={table.head}>
        <tr>
          <th className={table.th}>Quando</th>
          <th className={table.th}>Origem</th>
          <th className={table.th}>Execução</th>
          <th className={table.th}>Resultado</th>
          <th className={cx(table.th, 'text-right')}>Duração</th>
          <th className={cx(table.th, 'text-right')}>Requisições</th>
        </tr>
      </thead>
      <tbody>
        {props.runs.map((r) => {
          const active = r.id === props.selectedId
          return (
            <tr
              key={r.id}
              className={cx(table.row, 'cursor-pointer', active && 'bg-accent/10')}
              onClick={() => props.onSelect(r.id)}
              {...props.menu(r)}
            >
              <td className={cx(table.td, 'whitespace-nowrap text-muted')} title={formatDateTime(r.createdAt)}>
                {formatWhen(r.createdAt)}
              </td>
              <td className={cx(table.td, 'whitespace-nowrap')}>
                <span className="flex items-center gap-1">
                  <Badge tone={r.source === 'request' ? 'info' : r.source === 'cli' ? 'neutral' : 'accent'}>{SOURCE_LABEL[r.source]}</Badge>
                  {r.remote && (
                    <Badge tone="warning" title={`Execution Runner de ${r.remote.source}, execução #${r.remote.runId}`}>
                      <Server size={11} aria-hidden /> Remota
                    </Badge>
                  )}
                </span>
              </td>
              <td className={cx(table.td, 'max-w-0 w-full')}>
                <button
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onSelect(r.id)
                  }}
                  className="flex w-full min-w-0 items-center gap-2 text-left"
                >
                  {r.source === 'request' && r.method && <MethodBadge method={r.method} className="w-14" />}
                  <span className={cx('min-w-0 truncate', r.source === 'request' && 'font-mono')}>
                    {r.source === 'request' ? r.url : r.title}
                  </span>
                  {r.replayOf !== null && <Badge tone="cyan">reproduzida</Badge>}
                </button>
              </td>
              <td className={cx(table.td, 'whitespace-nowrap')}>
                <OutcomeCell
                  outcome={cellOutcome(r.outcome)}
                  kind={r.errorCode ? failureKind(r.errorCode) : undefined}
                  text={runCellText(r)}
                  label={`Resultado: ${OUTCOME_LABEL[r.outcome]}`}
                />
              </td>
              <td className={cx(table.td, 'text-right font-mono whitespace-nowrap text-muted')}>{formatMs(r.durationMs)}</td>
              <td className={cx(table.td, 'text-right font-mono text-muted')}>{r.exchangeCount}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function runCellText(r: HistoryRunSummary): string {
  if (r.outcome === 'canceled') return 'cancelado'
  if (r.source === 'request') return r.status !== null ? String(r.status) : (r.errorCode ?? 'erro')
  if (r.totals) return `${r.totals.passed}/${r.totals.passed + r.totals.failed + r.totals.error}`
  return OUTCOME_LABEL[r.outcome]
}

type DetailTab = 'response' | 'request' | 'assertions' | 'logs' | 'nodes'

function RunView(props: {
  run: HistoryRunDetail
  exchange: HistoryExchange | null
  onSelectExchange: (id: number) => void
  menu: (x: HistoryExchange) => MenuBinding
}) {
  const { run, exchange } = props
  const nodes = flowNodes(run.report)
  const [tab, setTab] = useState<DetailTab>('response')
  const tabs: { id: DetailTab; label: string }[] = [
    { id: 'response', label: 'Resposta' },
    { id: 'request', label: 'Requisição' },
    ...(exchange?.assertions?.length ? [{ id: 'assertions' as const, label: `Asserções (${exchange.assertions.length})` }] : []),
    ...(exchange?.logs ? [{ id: 'logs' as const, label: 'Logs' }] : []),
    ...(nodes.length ? [{ id: 'nodes' as const, label: `Nós (${nodes.length})` }] : [])
  ]
  const current = tabs.some((t) => t.id === tab) ? tab : 'response'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {run.totals && run.source !== 'request' && (
        <div className="flex h-8 shrink-0 items-center border-b border-border-subtle px-3">
          <OutcomeTotals {...run.totals}>
            {run.outcome === 'canceled' && <Badge tone="warning">cancelado</Badge>}
            <span className="text-muted">nível {LEVEL_LABEL[run.level].toLowerCase()}</span>
          </OutcomeTotals>
        </div>
      )}
      {run.exchanges.length > 1 && (
        <div className="max-h-40 shrink-0 overflow-auto border-b border-border">
          <table className={table.root} aria-label="Requisições da execução">
            <tbody>
              {run.exchanges.map((x) => (
                <tr key={x.id} className={cx(table.row, x.id === exchange?.id && 'bg-accent/10')} {...props.menu(x)}>
                  <td className="px-3 py-1.5 whitespace-nowrap text-muted">{x.label ?? `#${x.seq + 1}`}</td>
                  <td className="w-full max-w-0 px-3 py-1.5">
                    <button
                      type="button"
                      aria-current={x.id === exchange?.id ? 'true' : undefined}
                      onClick={() => props.onSelectExchange(x.id)}
                      className="flex w-full min-w-0 items-center gap-2 text-left font-mono"
                    >
                      <MethodBadge method={x.method} className="w-14" />
                      <span className="truncate">{x.url}</span>
                    </button>
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-muted">{x.environmentId}</td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    <OutcomeCell
                      outcome={cellOutcome(x.outcome)}
                      kind={x.errorCode ? failureKind(x.errorCode) : undefined}
                      text={x.status !== null ? String(x.status) : (x.errorCode ?? '—')}
                      label={`${x.label ?? x.url}: ${x.outcome ? OUTCOME_LABEL[x.outcome] : 'sem resultado'}`}
                      active={x.id === exchange?.id}
                      onClick={() => props.onSelectExchange(x.id)}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap text-muted">{formatMs(x.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {exchange || nodes.length ? (
        <>
          <Tabs label="Detalhe" value={current} onChange={setTab} tabs={tabs} />
          {current === 'response' &&
            (exchange ? (
              <ResponseViewer
                result={toResult(exchange)}
                pending={false}
                meta={!exchange.response && exchange.status !== null ? <span className="text-faint">headers e corpo não gravados (nível {LEVEL_LABEL[run.level].toLowerCase()})</span> : undefined}
                emptyHint="Esta execução não disparou requisições."
              />
            ) : (
              <EmptyState title="Sem requisições" description="Os nós deste fluxo não dispararam requisições HTTP." />
            ))}
          {current === 'request' &&
            (exchange ? <RequestView exchange={exchange} level={run.level} /> : <EmptyState title="Sem requisições" />)}
          {current === 'assertions' && exchange?.assertions && (
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <AssertionList
                rows={exchange.assertions.map((a) => ({
                  passed: a.passed,
                  label: `${a.target} ${a.operator}`,
                  message: a.message
                }))}
              />
            </div>
          )}
          {current === 'logs' && exchange?.logs && (
            <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">{exchange.logs}</pre>
          )}
          {current === 'nodes' && <NodesTable nodes={nodes} />}
        </>
      ) : (
        <EmptyState title="Sem requisições" description="Esta execução não disparou requisições." />
      )}
    </div>
  )
}

function RequestView({ exchange, level }: { exchange: HistoryExchange; level: HistoryRunSummary['level'] }) {
  const t = exchange.template
  const s = exchange.sent
  const options = [
    t?.inheritHeaders === false && 'sem headers nem auth do conector',
    t?.anonymous && 'sem credencial (sem a auth do conector e sem os headers de credencial)',
    t?.dropHeaders?.length && `headers herdados retirados: ${t.dropHeaders.join(', ')}`,
    t?.extra && `${Object.keys(t.extra).length} valores de $nodes`
  ].filter(Boolean)
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <section className="border-b border-border-subtle p-3" aria-label="Modelo da requisição">
        <h3 className="mb-2 text-xs font-semibold">Como foi montada <span className="font-normal text-muted">(com {'{{VAR}}'}, como o Quick Request reabre)</span></h3>
        <div className="mb-2 flex items-center gap-2 font-mono text-xs">
          <MethodBadge method={exchange.method} />
          <span className="break-all">{exchange.url}</span>
        </div>
        {options.length > 0 && <p className="mb-2 text-xs text-muted">{options.join(' · ')}</p>}
        {t?.headers ? <HeadersTable headers={t.headers} label="Headers do modelo" /> : <LevelNote level={level} what="os headers" />}
        {t && 'body' in t && t.body ? (
          <CodeEditor ariaLabel="Corpo do modelo" value={pretty(t.body)} language={looksJson(t.body) ? 'json' : 'text'} className="mt-2 max-h-64" />
        ) : null}
      </section>
      <section className="p-3" aria-label="Requisição enviada">
        <h3 className="mb-2 text-xs font-semibold">Como foi para a rede <span className="font-normal text-muted">(herança, auth e variáveis resolvidas; segredos mascarados)</span></h3>
        {s ? (
          <>
            <div className="mb-2 font-mono text-xs break-all">{s.url}</div>
            <HeadersTable headers={s.headers} label="Headers enviados" />
            {s.body ? <CodeEditor ariaLabel="Corpo enviado" value={pretty(s.body)} language={looksJson(s.body) ? 'json' : 'text'} className="mt-2 max-h-64" /> : null}
          </>
        ) : (
          <LevelNote level={level} what="a requisição resolvida" />
        )}
      </section>
    </div>
  )
}

function LevelNote({ level, what }: { level: HistoryRunSummary['level']; what: string }) {
  return <p className="text-xs text-faint">O nível {LEVEL_LABEL[level].toLowerCase()} não guarda {what}.</p>
}

function HeadersTable({ headers, label }: { headers: { name: string; value: string }[]; label: string }) {
  if (!headers.length) return <p className="text-xs text-faint">Sem headers.</p>
  return (
    <table className="w-full font-mono text-xs" aria-label={label}>
      <tbody>
        {headers.map((h, i) => (
          <tr key={i} className="border-b border-border-subtle last:border-b-0">
            <td className="w-1/3 py-1 pr-3 align-top text-muted">{h.name}</td>
            <td className="py-1 break-all">{h.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function NodesTable({ nodes }: { nodes: FlowNodeResult[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className={table.root} aria-label="Nós do fluxo">
        <thead className={table.head}>
          <tr>
            <th className={table.th}>Nó</th>
            <th className={table.th}>Estado</th>
            <th className={cx(table.th, 'text-right')}>Duração</th>
            <th className={table.th}>Detalhe</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n, i) => (
            <tr key={`${n.nodeId}-${i}`} className={table.row}>
              <td className={table.td}>{n.name}</td>
              <td className={table.td}>
                <OutcomeCell
                  outcome={n.status === 'success' ? 'passed' : n.status === 'error' ? 'failed' : undefined}
                  text={n.status === 'success' ? 'ok' : n.status === 'error' ? (n.error?.code ?? 'erro') : undefined}
                  label={`${n.name}: ${n.status}`}
                />
                {n.status === 'skipped' && <span className="text-muted">pulado</span>}
              </td>
              <td className={cx(table.td, 'text-right font-mono text-muted')}>{formatMs(n.durationMs)}</td>
              <td className={cx(table.td, 'text-muted')}>
                {n.error?.message ?? n.reason ?? (n.output ? <span className="font-mono">{preview(n.output.data)}</span> : '')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RunInspector(props: {
  run: HistoryRunDetail
  exchange: HistoryExchange | null
  onOpenRun: (id: number) => void
  confirmReplay: (x: HistoryExchange) => Promise<boolean>
  onReplayed: (runId: number | null) => void
  onDeleted: () => void
}) {
  const { run, exchange } = props
  const notify = useToast()
  const [replaying, setReplaying] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => setConfirmDelete(false), [run.id])

  const replay = async () => {
    if (!exchange || !(await props.confirmReplay(exchange))) return
    setReplaying(true)
    try {
      const r = await window.vvpost.replayHistory(exchange.id)
      if (!r.ok) notify(r.message, 'warning')
      else {
        notify(
          r.result.ok ? `Reproduzida: HTTP ${r.result.response.status} em ${formatMs(r.result.response.timings.totalMs)}` : `Reproduzida com erro: ${r.result.error.code}`,
          r.result.ok && r.result.response.status < 400 ? 'success' : 'warning'
        )
        props.onReplayed(r.runId)
      }
    } finally {
      setReplaying(false)
    }
  }

  const reopen = () => exchange && reopenExchange(exchange, notify)

  return (
    <>
      <InspectorSection title="Execução">
        <Field label="Origem">{SOURCE_LABEL[run.source]}</Field>
        {run.remote && (
          <Field label="Onde">
            Execution Runner de <span className="font-mono">{run.remote.source}</span>, execução #{run.remote.runId}. As
            requisições rodaram no runner: nenhuma reproduz daqui.
          </Field>
        )}
        <Field label="Quando">{formatDateTime(run.createdAt)}</Field>
        <Field label="Resultado">{OUTCOME_LABEL[run.outcome]}</Field>
        <Field label="Nível">{LEVEL_LABEL[run.level]}</Field>
        {run.connectorId && (
          <Field label="Conector">
            <span className="font-mono">{run.connectorId}</span>
          </Field>
        )}
        {run.environmentId && (
          <Field label="Ambiente">
            <span className="font-mono">{run.environmentId}</span>
          </Field>
        )}
        {run.flowId && (
          <Field label="Fluxo">
            <span className="font-mono">{run.flowId}</span>
          </Field>
        )}
        <Field label="Duração">{formatMs(run.durationMs)}</Field>
        <Field label="Requisições">{run.exchangeCount}</Field>
        <Field label="Guardado">{formatBytes(run.bytes)}</Field>
        {run.replayOf !== null && (
          <Field label="Reproduz">
            <button type="button" className="text-cyan hover:underline" onClick={() => props.onOpenRun(run.replayOf!)}>
              execução #{run.replayOf}
            </button>
          </Field>
        )}
        {reportError(run.report) && <p className="pt-1 text-xs text-danger">{reportError(run.report)}</p>}
      </InspectorSection>

      {exchange && (
        <InspectorSection title="Requisição">
          {exchange.label && <Field label="Cenário ou nó">{exchange.label}</Field>}
          <Field label="Status">{exchange.status ?? exchange.errorCode ?? '—'}</Field>
          {exchange.errorMessage && <p className="py-1 text-xs text-danger">{exchange.errorMessage}</p>}
          {exchange.auth && (
            <Field label="Auth">
              {exchange.auth.type} de <span className="font-mono">{exchange.auth.from}</span> ({exchange.auth.source}
              {exchange.auth.retried ? ', repetida após 401' : ''})
            </Field>
          )}
          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              size="sm"
              variant="primary"
              icon={<RotateCcw size={14} aria-hidden />}
              disabled={!exchange.replayable || replaying}
              title={exchange.replayable ? 'Envia de novo, resolvendo {{VAR}} e a auth no ambiente atual' : exchange.replayBlocked}
              onClick={() => void replay()}
            >
              {replaying ? 'Reproduzindo…' : 'Reproduzir'}
            </Button>
            <Button size="sm" icon={<ExternalLink size={14} aria-hidden />} onClick={reopen}>
              Reabrir no Quick Request
            </Button>
          </div>
          {!exchange.replayable && exchange.replayBlocked && (
            <p className="pt-2 text-xs text-muted">Reproduzir indisponível: {exchange.replayBlocked}.</p>
          )}
        </InspectorSection>
      )}

      <InspectorSection title="Apagar">
        <Button
          size="sm"
          variant="danger"
          icon={<Trash2 size={14} aria-hidden />}
          onClick={() => {
            if (!confirmDelete) return setConfirmDelete(true)
            void window.vvpost.deleteHistoryRun(run.id).then(props.onDeleted)
          }}
        >
          {confirmDelete ? 'Confirmar: apagar esta execução' : 'Apagar esta execução'}
        </Button>
      </InspectorSection>
    </>
  )
}

/** Reabre a requisição gravada numa aba nova do Quick Request (com o modelo, não o que foi para a rede). */
function reopenExchange(exchange: HistoryExchange, notify: ReturnType<typeof useToast>) {
  openInQuickRequest({
    method: exchange.method,
    url: exchange.url,
    headers: exchange.template?.headers ?? [],
    body: exchange.template?.body ?? '',
    connectorId: exchange.connectorId,
    environmentId: exchange.environmentId,
    endpointId: exchange.template?.endpointId ?? null,
    prepareFlowId: exchange.template?.prepareFlowId ?? null,
    ...(exchange.template?.scripts && { scripts: exchange.template.scripts })
  })
  const t = exchange.template
  if (t?.inheritHeaders === false || t?.anonymous || t?.dropHeaders?.length || t?.extra) {
    notify('Aberta no Quick Request. Ajustes de herança e valores de $nodes do cenário ou fluxo não vão junto; Reproduzir os mantém.', 'info')
  }
}

/** cURL do que foi para a rede (URL completa, segredos mascarados), ou do modelo no nível baixo. */
function exchangeCurl(x: HistoryExchange): string {
  const sent = x.sent
  return toCode('curl', {
    method: x.method,
    url: sent?.url ?? x.url,
    headers: sent?.headers ?? x.template?.headers ?? [],
    body: (sent ? sent.body : x.template?.body) ?? undefined
  })
}

/** Resposta gravada no formato do ResponseViewer; sem headers e corpo no nível metadados. */
function toResult(x: HistoryExchange): HttpResult {
  const t = x.timings
  const timings = t && 'ttfbMs' in t ? t : { ttfbMs: 0, downloadMs: 0, totalMs: t?.totalMs ?? x.durationMs }
  if (x.status === null) {
    return { ok: false, error: { code: (x.errorCode ?? 'NETWORK_ERROR') as HttpErrorCode, message: x.errorMessage ?? '' }, timings: { totalMs: timings.totalMs }, ...(x.auth && { auth: x.auth }) }
  }
  const r = x.response
  return {
    ok: true,
    response: {
      status: x.status,
      statusText: r?.statusText ?? '',
      headers: r?.headers ?? [],
      body: r?.body ?? '',
      ...(r?.bodyBase64 !== undefined && { bodyBase64: r.bodyBase64 }),
      sizeBytes: r?.sizeBytes ?? x.sizeBytes ?? 0,
      truncated: !!(r?.truncated || r?.bodyCut),
      timings
    },
    ...(x.auth && { auth: x.auth })
  }
}

/** Nós do fluxo no relatório (fluxo do app ou fluxos de um `vvpost run`). */
function flowNodes(report: unknown): FlowNodeResult[] {
  if (!report || typeof report !== 'object') return []
  const r = report as { nodes?: FlowNodeResult[]; flows?: { nodes?: FlowNodeResult[] }[] }
  if (Array.isArray(r.nodes)) return r.nodes
  if (Array.isArray(r.flows)) return r.flows.flatMap((f) => f.nodes ?? [])
  return []
}

function reportError(report: unknown): string | undefined {
  const error = report && typeof report === 'object' ? (report as { error?: unknown }).error : undefined
  return typeof error === 'string' ? error : undefined
}

function formatWhen(at: number): string {
  const d = new Date(at)
  const today = new Date()
  return d.toDateString() === today.toDateString() ? formatTime(d) : formatDateTime(d)
}

const looksJson = (text: string) => /^\s*[{[]/.test(text)
const pretty = (text: string) => (looksJson(text) ? formatJson(text) : text)

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? ''
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}
