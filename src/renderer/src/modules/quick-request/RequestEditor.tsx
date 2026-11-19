import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent } from 'react'
import { Braces, ChevronDown, ChevronRight, ChevronUp, Copy, CopyPlus, GitCompare, Move, Network, PenLine, Plug, Send, ToggleLeft, Trash2, Unplug, Workflow, X } from 'lucide-react'
import { HTTP_METHODS, type AuthUsage, type CatalogConnector, type HttpMethod, type HttpResult, type PluginContribution, type PrepareUsage, type SentRequest } from '@shared/ipc'
import {
  Button,
  CodeEditor,
  cx,
  EmptyState,
  ExecutionToolbar,
  formatJson,
  formatMs,
  formatShortcut,
  IconButton,
  InheritanceBadge,
  isEditableTarget,
  jsonPathAt,
  jsonValueEntries,
  toJsonPath,
  useContextMenu,
  useJsonCommand,
  VariableDialog,
  dockEntries,
  DockGrip,
  DOCK_REQUEST,
  ResizeHandle,
  ResponseViewer,
  useDock,
  separator,
  SegmentedControl,
  Shortcut,
  Tabs,
  textEditEntries,
  valueAt,
  type ContextMenuEntries,
  type ExecutionState,
  type JsonValueActions,
  formatTime,
  hasFormFields,
  parseFormBody,
  SchemaForm
} from '../../design-system'
import { CompareDialog } from './CompareDialog'
import { emptyFormRow, emptyRow, idleLive, parseQuery, pathParams, REALTIME_LABEL, withQuery, type BodyMode, type HeaderRow, type QueryParam, type RequestDraft } from './draft'
import { FormBodyEditor } from './FormBodyEditor'
import { fromGraphqlBody } from './graphql'
import { isShortWindow } from '../../lib/short-window'
import { useLayoutChoice, usePanelSize } from '../../lib/layout'

type RequestTab = 'params' | 'headers' | 'body' | 'auth' | 'scripts'
const BODY_LABEL: Record<Exclude<BodyMode, 'raw'>, string> = { urlencoded: 'form', multipart: 'form-data', binary: 'arquivo', graphql: 'GraphQL' }
const GraphqlBodyEditor = lazy(() => import('./GraphqlBodyEditor'))
/** Adapter de plugin (gRPC, Kafka...) que o Quick Request oferece como protocolo. */
export type AdapterContribution = PluginContribution & { pluginName: string }
const PluginRequestForm = lazy(() => import('./PluginRequestForm'))
const RealtimePanel = lazy(() => import('./RealtimePanel'))
const NO_ADAPTERS: ReadonlyMap<string, AdapterContribution> = new Map()
const icon = { size: 14, 'aria-hidden': true } as const

type OpenMenu = ReturnType<typeof useContextMenu>['open']

/** Botão direito num campo: as ações de texto do campo e, embaixo, as da linha. */
function fieldMenu(open: OpenMenu, label: string, entries: () => ContextMenuEntries) {
  return (e: MouseEvent<HTMLElement>) => {
    if (e.defaultPrevented || !isEditableTarget(e.target)) return
    e.preventDefault()
    e.stopPropagation()
    open(e, label, [...textEditEntries(e.target as HTMLElement), separator, ...entries()], e.target as HTMLElement)
  }
}

/** Uma requisição do Quick Request: barra de execução, abas de edição e a resposta. */
const REQUEST_MIN = 12
const REQUEST_MAX = 80
const REQUEST_WIDTH = { fallback: 45, min: 25, max: 75 }
const EDIT_SIDES = ['top', 'left', 'right'] as const
type EditSide = (typeof EDIT_SIDES)[number]
const EDIT_LABEL = 'a edição da requisição'

export function RequestEditor(props: {
  draft: RequestDraft
  connector: CatalogConnector | null
  onChange: (patch: Partial<RequestDraft> | ((d: RequestDraft) => Partial<RequestDraft>)) => void
  onSend: () => void
  /** Ações da requisição (menu da barra de URL). */
  menu: () => ContextMenuEntries
  /** Texto colado na URL que parece um curl: true se virou a requisição. */
  onPasteCurl: (text: string) => boolean
  onOpenConnector?: () => void
  /** Ações do menu de valores do JSON (variável no ambiente, próxima requisição). */
  jsonActions?: JsonValueActions
  /** Abre o fluxo de preparação no Flow Studio (quando um nó dele falha). */
  onOpenFlow?: (flowId: string) => void
  /** "Ver como fluxo": abre no Flow Studio o fluxo script → requisição → script desta aba. */
  onViewScriptFlow?: () => void
  /** Adapters dos plugins ligados, por protocolo; ausente enquanto a lista não foi lida. */
  adapters?: ReadonlyMap<string, AdapterContribution>
  /** Pede a lista de adapters (lida sob demanda, quando o seletor de protocolo vai ser usado). */
  onWantAdapters?: () => void
  /** Manda um corpo (a introspecção do GraphQL) para a URL da aba, com o conector e o ambiente. */
  onIntrospect?: (body: string) => Promise<HttpResult>
  /** Conexão realtime: fecha (ou cancela a abertura) e envia a mensagem da caixa. */
  onDisconnect?: () => void
  onSendMessage?: () => void
}) {
  const { draft, connector } = props
  const adapters = props.adapters ?? NO_ADAPTERS
  const adapter = draft.adapter ? adapters.get(draft.adapter) : undefined
  const [tab, setTab] = useState<RequestTab>('headers')
  const [pinnedCollapsed, setPinnedCollapsed] = useEditorCollapsed()
  // Janela baixa (zoom de 150%, notebook): depois do envio a edição recolhe sozinha para a resposta
  // aparecer sem rolar. Só nesta aba e até a pessoa abrir a edição de novo.
  const [autoCollapsed, setAutoCollapsed] = useState(false)
  useEffect(() => {
    if (draft.result && isShortWindow()) setAutoCollapsed(true)
  }, [draft.result])
  const collapsed = pinnedCollapsed || autoCollapsed
  const setCollapsed = (v: boolean) => {
    setAutoCollapsed(false)
    setPinnedCollapsed(v)
  }
  // Altura da edição em % da coluna, para a divisão acompanhar a janela (lib/layout).
  const requestHeight = usePanelSize('quick.request-height', { fallback: 38, min: REQUEST_MIN, max: REQUEST_MAX })
  // A edição em cima da resposta ou ao lado dela, como um grupo do VS Code: arrastar pelo grip move.
  const [editSide, setEditSide] = useLayoutChoice<EditSide>('quick.edit-side', 'top', EDIT_SIDES)
  const sideBySide = editSide !== 'top'
  const requestWidth = usePanelSize('quick.request-width', REQUEST_WIDTH)
  const splitArea = useRef<HTMLDivElement>(null)
  const areaPx = (pct: number, wide = false) =>
    (pct / 100) * ((wide ? splitArea.current?.clientWidth : splitArea.current?.clientHeight) || 1)
  const dock = useDock({ label: EDIT_LABEL, area: () => splitArea.current, sides: EDIT_SIDES, current: editSide, move: setEditSide })
  const editMenu = useContextMenu()
  const moveEntries = () => dockEntries(EDIT_LABEL, EDIT_SIDES, editSide, setEditSide)
  useEffect(() => {
    const onDock = (e: Event) => {
      const { target, side } = (e as CustomEvent<{ target: string; side: EditSide }>).detail
      if (target === 'quick-edit' && splitArea.current?.offsetParent && EDIT_SIDES.includes(side)) setEditSide(side)
    }
    window.addEventListener(DOCK_REQUEST, onDock)
    return () => window.removeEventListener(DOCK_REQUEST, onDock)
  }, [setEditSide])
  const editPaneStyle = sideBySide
    ? { width: `${requestWidth.size}%` }
    : draft.adapter || !collapsed
      ? { height: `${requestHeight.size}%` }
      : undefined
  const editMargin = editSide === 'top' ? 'mx-4 mt-3' : editSide === 'left' ? 'ml-4 mr-1 mt-3 mb-4' : 'mr-4 ml-1 mt-3 mb-4'
  const ctx = useContextMenu()
  const [comparing, setComparing] = useState(false)
  const params = parseQuery(draft.url)
  const endpointQuery = parseQuery(connector?.endpoints.find((e) => e.id === draft.endpointId)?.path ?? '')
  const runCommand = useJsonCommand(props.jsonActions)
  const [variable, setVariable] = useState<{ x: number; y: number; path: (string | number)[]; value: unknown } | null>(null)
  const live = draft.live ?? idleLive()
  const connected = live.status === 'open' || live.status === 'connecting'
  // Só o SSE tem método e corpo (POST em stream); WebSocket e Socket.IO abrem com um GET de upgrade.
  const withMethod = !draft.realtime || draft.realtime === 'sse'
  const bodyAllowed = withMethod && draft.method !== 'GET' && draft.method !== 'HEAD'
  const localCount = draft.headers.filter((h) => h.enabled && h.name.trim()).length
  const inheritedCount = connector?.headers.length ?? 0
  const endpoint = connector?.endpoints.find((e) => e.id === draft.endpointId)
  // Endpoint com bodySchema (ex.: importado do OpenAPI): o corpo JSON ganha o formulário do schema.
  const bodySchema = endpoint?.bodySchema && hasFormFields(endpoint.bodySchema) ? endpoint.bodySchema : undefined
  const bodyView = bodySchema ? (draft.bodyView ?? 'form') : 'json'
  const inheritedScripts = [...(connector?.scripts ?? []), ...(endpoint?.scripts ? [{ from: 'endpoint', ...endpoint.scripts }] : [])]
  const scriptCount =
    inheritedScripts.reduce((n, s) => n + (s.pre?.trim() ? 1 : 0) + (s.post?.trim() ? 1 : 0), 0) +
    (draft.scripts?.pre?.trim() ? 1 : 0) +
    (draft.scripts?.post?.trim() ? 1 : 0)

  const updateHeader = (key: number, patch: Partial<HeaderRow>) =>
    props.onChange((d) => {
      const next = d.headers.map((r) => (r.key === key ? { ...r, ...patch } : r))
      // Sempre existe uma linha vazia no fim para digitar o próximo cabeçalho.
      const last = next.at(-1)
      return { headers: last && (last.name || last.value) ? [...next, emptyRow()] : next }
    })

  const state: ExecutionState = draft.realtime
    ? live.status === 'connecting'
      ? 'running'
      : 'idle'
    : draft.pendingId
    ? 'running'
    : !draft.result
      ? 'idle'
      : draft.result.ok
        ? 'done'
        : draft.result.error.code === 'ABORTED'
          ? 'cancelled'
          : 'failed'

  return (
    <>
      {ctx.menu}
      <form
        {...ctx.bind(`Requisição ${draft.method} ${draft.url.trim() || '(sem URL)'}`, props.menu)}
        className="shrink-0 px-4 pt-3"
        onSubmit={(e) => {
          e.preventDefault()
          props.onSend()
        }}
      >
        <ExecutionToolbar
          state={state}
          runLabel={draft.realtime ? (connected ? 'Desconectar' : 'Conectar') : 'Enviar'}
          runIcon={draft.realtime ? connected ? <Unplug size={14} aria-hidden /> : <Plug size={14} aria-hidden /> : <Send size={14} aria-hidden />}
          canRun={draft.adapter ? !!adapter : !!draft.url.trim()}
          onRun={props.onSend}
          onCancel={draft.realtime ? props.onDisconnect : draft.pendingId ? () => void window.vvpost.cancelRequest(draft.pendingId!) : undefined}
        >
          {props.onWantAdapters && (
            <select
              aria-label="Protocolo"
              title="Protocolo: HTTP, uma conexão (WebSocket, SSE, Socket.IO) ou o adapter de um plugin ligado (gRPC, Kafka...)"
              value={draft.adapter ?? (draft.realtime ? `rt:${draft.realtime}` : '')}
              disabled={connected}
              onPointerEnter={props.onWantAdapters}
              onFocus={props.onWantAdapters}
              onChange={(e) => {
                const v = e.target.value
                props.onChange(
                  v.startsWith('rt:')
                    ? { adapter: null, realtime: v.slice(3) as keyof typeof REALTIME_LABEL, ...(v === 'rt:sse' ? {} : { method: 'GET' as const }) }
                    : { adapter: v || null, realtime: null }
                )
              }}
              className="h-8 max-w-40 border px-2 text-xs"
            >
              <option value="">HTTP</option>
              {Object.entries(REALTIME_LABEL).map(([value, label]) => (
                <option key={value} value={`rt:${value}`}>
                  {label}
                </option>
              ))}
              {[...adapters.values()].map((c) => (
                <option key={c.name} value={c.name}>
                  {c.title}
                </option>
              ))}
              {draft.adapter && !adapter && (
                <option value={draft.adapter}>
                  {draft.adapter}
                  {props.adapters ? ' (indisponível)' : ''}
                </option>
              )}
            </select>
          )}
          {draft.adapter ? (
            <div className="flex h-8 min-w-0 flex-1 items-center gap-2 truncate rounded-[var(--radius-control)] border border-border-subtle px-2.5 text-xs text-muted">
              <span className="font-semibold text-fg">{adapter?.title ?? draft.adapter}</span>
              {draft.url.trim() && <span className="truncate font-mono">{draft.url.trim()}</span>}
              {connector && <span className="truncate">· conector {connector.name}</span>}
            </div>
          ) : !withMethod ? (
            <span className="flex h-8 shrink-0 items-center rounded-[var(--radius-control)] border border-border-subtle px-2.5 font-mono text-xs font-semibold text-cyan">
              {draft.realtime === 'socketio' ? 'IO' : 'WS'}
            </span>
          ) : (
            <select
              aria-label="Método HTTP"
              value={draft.method}
              onChange={(e) => props.onChange({ method: e.target.value as HttpMethod })}
              className={`h-8 w-24 border px-2 font-mono text-xs font-semibold ${methodColor(draft.method)}`}
            >
              {HTTP_METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          )}
          <div hidden={!!draft.adapter} className="flex h-8 min-w-0 flex-1 items-center rounded-[var(--radius-control)] border border-border bg-surface font-mono text-xs focus-within:border-accent focus-within:outline focus-within:outline-accent">
            {connector?.baseUrl && (
              <span
                className="max-w-[40%] shrink-0 truncate border-r border-border-subtle px-2.5 text-cyan"
                title="baseUrl herdada do conector"
              >
                {connector.baseUrl}
              </span>
            )}
            <input
              aria-label="URL"
              placeholder={
                draft.realtime === 'websocket'
                  ? connector ? '/ws' : 'wss://api.exemplo.com/ws'
                  : draft.realtime === 'socketio'
                    ? connector ? '/ (ou /namespace)' : 'https://api.exemplo.com/namespace'
                    : draft.realtime === 'sse'
                      ? connector ? '/eventos' : 'https://api.exemplo.com/eventos'
                      : connector ? '/recurso' : 'https://api.exemplo.com/recurso'
              }
              readOnly={!!draft.realtime && connected}
              value={draft.url}
              onChange={(e) => props.onChange({ url: e.target.value })}
              onContextMenu={fieldMenu(ctx.open, 'URL', props.menu)}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text')
                // Colar um curl na URL monta a requisição inteira (método, headers e corpo).
                if (/^\s*curl(\.exe)?\s/.test(text) && props.onPasteCurl(text)) e.preventDefault()
              }}
              spellCheck={false}
              className="h-full min-w-0 flex-1 !border-0 !bg-transparent px-2.5 !outline-none"
            />
          </div>
        </ExecutionToolbar>
      </form>

      <div
        ref={splitArea}
        data-edit-side={editSide}
        className={cx('flex min-h-0 flex-1', sideBySide ? 'flex-row' : 'flex-col')}
      >
      {/* A edição (campos do protocolo ou abas da requisição): em cima da resposta ou ao lado dela. */}
      <div
        style={editPaneStyle}
        className={cx('relative flex min-h-0 shrink-0 flex-col', sideBySide && 'min-w-0', editSide === 'right' && 'order-1')}
      >
      {draft.adapter && (
        <section
          aria-label="Campos do protocolo"
          className={cx('flex min-h-40 flex-1 flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-panel', editMargin)}
        >
          {adapter ? (
            <Suspense fallback={null}>
              <PluginRequestForm
                key={`${draft.id}:${draft.adapter}`}
                contribution={adapter}
                config={draft.pluginConfig ?? {}}
                onChange={(pluginConfig) => props.onChange({ pluginConfig })}
              />
            </Suspense>
          ) : (
            props.adapters && (
              <EmptyState
                title={`O protocolo ${draft.adapter} não está disponível`}
                description="Instale ou ligue o plugin que traz esse adapter no Extensions Hub."
              />
            )
          )}
        </section>
      )}
      <section
        hidden={!!draft.adapter}
        className={cx(
          'flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-panel',
          editMargin,
          collapsed ? 'shrink-0' : 'min-h-0 flex-1'
        )}
        {...editMenu.bind('Edição da requisição', moveEntries)}
      >
        <Tabs
          label="Requisição"
          value={tab}
          onChange={(t) => {
            setTab(t)
            setCollapsed(false)
          }}
          right={
            <>
              <DockGrip label={EDIT_LABEL} onPointerDown={dock.onPointerDown} />
              <IconButton label="Mover a edição…" onClick={(e) => editMenu.open(e.currentTarget, 'Mover a edição', moveEntries())}>
                <Move {...icon} />
              </IconButton>
              <IconButton
                label={collapsed ? 'Mostrar a edição da requisição' : 'Recolher a edição e dar espaço à resposta'}
                aria-expanded={!collapsed}
                onClick={() => setCollapsed(!collapsed)}
              >
                {collapsed ? <ChevronDown {...icon} /> : <ChevronUp {...icon} />}
              </IconButton>
            </>
          }
          tabs={[
            { id: 'params', label: `Params${params.length ? ` (${params.length})` : ''}` },
            {
              id: 'headers',
              label: `Headers${localCount + inheritedCount ? ` (${localCount + inheritedCount})` : ''}`
            },
            ...(withMethod ? [{ id: 'body' as const, label: draft.bodyMode && draft.bodyMode !== 'raw' ? `Body (${BODY_LABEL[draft.bodyMode]})` : 'Body' }] : []),
            { id: 'auth', label: 'Auth' },
            // Os scripts rodam em volta de uma requisição: uma conexão realtime não tem.
            ...(draft.realtime ? [] : [{ id: 'scripts' as const, label: `Scripts${scriptCount ? ` (${scriptCount})` : ''}` }])
          ]}
        />
        {!collapsed && tab === 'params' && (
          <ParamsEditor
            url={draft.url}
            params={params}
            disabled={draft.disabledParams ?? []}
            fromEndpoint={endpointQuery}
            open={ctx.open}
            bind={ctx.bind}
            onChange={(next, disabledParams) => props.onChange((d) => ({ url: withQuery(d.url, next), disabledParams }))}
          />
        )}
        {!collapsed && tab === 'headers' && draft.realtime === 'websocket' && (
          <label className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1 text-xs text-muted">
            Subprotocolos
            <input
              aria-label="Subprotocolos do WebSocket"
              placeholder="graphql-transport-ws, chat (Sec-WebSocket-Protocol)"
              value={draft.subprotocols ?? ''}
              onChange={(e) => props.onChange({ subprotocols: e.target.value })}
              className="h-6 min-w-0 flex-1 border px-2 font-mono text-xs text-fg"
            />
          </label>
        )}
        {!collapsed && tab === 'headers' && (
          <HeadersEditor
            rows={draft.headers}
            connector={connector}
            open={ctx.open}
            bind={ctx.bind}
            onUpdate={updateHeader}
            onChange={(headers) => props.onChange({ headers })}
            onRemove={(key) => props.onChange((d) => ({ headers: d.headers.filter((r) => r.key !== key) }))}
            onOpenConnector={props.onOpenConnector}
          />
        )}
        {!collapsed && tab === 'body' && bodyAllowed && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-2 py-1">
            <SegmentedControl<BodyMode>
              label="Tipo do corpo"
              size="xs"
              value={draft.bodyMode ?? 'raw'}
              onChange={(bodyMode) =>
                props.onChange((d) => ({
                  bodyMode,
                  formRows: d.formRows?.length ? d.formRows : [emptyFormRow()],
                  // GraphQL: um corpo { query, variables } que já estava na aba vira a consulta.
                  ...(bodyMode === 'graphql' && !d.graphql && { graphql: fromGraphqlBody(d.body) ?? { query: '', variables: '' } })
                }))
              }
              options={[
                { value: 'raw', label: 'Texto/JSON' },
                { value: 'urlencoded', label: 'x-www-form-urlencoded' },
                { value: 'multipart', label: 'form-data' },
                { value: 'binary', label: 'Binário' },
                { value: 'graphql', label: 'GraphQL' }
              ]}
            />
            {bodySchema && (draft.bodyMode ?? 'raw') === 'raw' && (
              <>
                <span className="flex-1" />
                <SegmentedControl<'form' | 'json'>
                  label="Edição do corpo"
                  size="xs"
                  value={bodyView}
                  onChange={(v) => props.onChange({ bodyView: v })}
                  options={[
                    { value: 'form', label: 'Formulário', title: 'Campos gerados do schema do endpoint' },
                    { value: 'json', label: 'JSON raw' }
                  ]}
                />
              </>
            )}
          </div>
        )}
        {!collapsed &&
          tab === 'body' &&
          bodyAllowed &&
          draft.bodyMode === 'graphql' && (
            <Suspense fallback={<div className="flex-1" />}>
              <GraphqlBodyEditor
                value={draft.graphql ?? { query: '', variables: '' }}
                schemaKey={`${connector?.id ?? ''}|${draft.url.trim()}`}
                onChange={(graphql, body) => props.onChange({ graphql, body })}
                onRun={props.onSend}
                introspect={(body) => props.onIntrospect?.(body) ?? Promise.reject(new Error('introspecção indisponível'))}
              />
            </Suspense>
          )}
        {!collapsed &&
          tab === 'body' &&
          bodyAllowed &&
          (draft.bodyMode ?? 'raw') !== 'raw' &&
          draft.bodyMode !== 'graphql' && (
            <FormBodyEditor
              mode={draft.bodyMode as Exclude<BodyMode, 'raw' | 'graphql'>}
              rows={draft.formRows ?? [emptyFormRow()]}
              binaryFile={draft.binaryFile ?? ''}
              binaryType={draft.binaryType ?? ''}
              onRows={(formRows) => props.onChange({ formRows })}
              onBinary={(patch) => props.onChange(patch)}
            />
          )}
        {!collapsed &&
          tab === 'body' &&
          withMethod &&
          (draft.bodyMode ?? 'raw') === 'raw' &&
          (bodyAllowed ? (
            bodyView === 'form' && bodySchema ? (
              <SchemaBody
                schema={bodySchema}
                body={draft.body}
                onChange={(body) => props.onChange({ body })}
                onShowJson={() => props.onChange({ bodyView: 'json' })}
              />
            ) : (
            <div
              className="flex min-h-0 flex-1 flex-col"
              onContextMenu={fieldMenu(ctx.open, 'Corpo da requisição', () => [
                {
                  id: 'format',
                  label: 'Formatar JSON',
                  icon: <Braces {...icon} />,
                  disabled: !draft.body.trim(),
                  run: () => props.onChange({ body: formatJson(draft.body) })
                },
                {
                  id: 'copy-body',
                  label: 'Copiar o corpo inteiro',
                  icon: <Copy {...icon} />,
                  disabled: !draft.body,
                  run: () => void navigator.clipboard.writeText(draft.body)
                },
                { id: 'clear-body', label: 'Limpar o corpo', icon: <Trash2 {...icon} />, danger: true, disabled: !draft.body, run: () => props.onChange({ body: '' }) }
              ])}
            >
            <CodeEditor
              ariaLabel="Corpo da requisição"
              language="json"
              validate
              value={draft.body}
              onChange={(body) => props.onChange({ body })}
              onEditorContextMenu={(e) => {
                // O Chromium põe o cursor onde o botão direito clicou: o valor sob ele vira o alvo.
                const path = jsonPathAt(draft.body, e.currentTarget.selectionStart)
                if (!path) return
                e.preventDefault()
                const at =
                  e.clientX || e.clientY ? { x: e.clientX, y: e.clientY + 6 } : caretPoint(e.currentTarget)
                const value = valueAt(JSON.parse(draft.body), path)
                ctx.openAt(
                  at,
                  toJsonPath(path),
                  jsonValueEntries({
                    ...(props.jsonActions && { actions: props.jsonActions }),
                    run: (command) => runCommand(command, path, value),
                    onUseAsVariable: () => setVariable({ ...at, path, value })
                  })
                )
              }}
              placeholder='{ "chave": "valor" }'
              toolbar={
                <>
                  <span>JSON</span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    className="hover:text-fg"
                    onClick={() => props.onChange({ body: formatJson(draft.body) })}
                  >
                    Formatar
                  </button>
                </>
              }
            />
            </div>
            )
          ) : (
            <EmptyState title={`${draft.method} não envia corpo`} description="Troque o método para enviar um corpo." />
          ))}
        {!collapsed && tab === 'auth' && <AuthTab connector={connector} />}
        {!collapsed && tab === 'scripts' && (
          <ScriptsTab
            draft={draft}
            inherited={inheritedScripts}
            onChange={(scripts) => props.onChange((d) => ({ scripts: { ...d.scripts, ...scripts } }))}
            onOpenConnector={props.onOpenConnector}
            onViewFlow={props.onViewScriptFlow}
          />
        )}
        {variable && props.jsonActions && (
          <VariableDialog
            at={variable}
            path={variable.path}
            value={variable.value}
            actions={props.jsonActions}
            onClose={() => setVariable(null)}
          />
        )}
      </section>

      {sideBySide ? (
        <ResizeHandle
          edge={editSide === 'left' ? 'right' : 'left'}
          label="Largura da edição da requisição"
          size={areaPx(requestWidth.size, true)}
          min={areaPx(REQUEST_WIDTH.min, true)}
          max={areaPx(REQUEST_WIDTH.max, true)}
          onResize={(px) => requestWidth.setSize((px / areaPx(100, true)) * 100)}
          onReset={requestWidth.reset}
        />
      ) : (
        (draft.adapter || !collapsed) && (
          // A divisão entre a edição e a resposta: arrastar ajusta a altura (lembrada no workspace);
          // arrastar até em cima recolhe a edição.
          <ResizeHandle
            edge="bottom"
            label="Altura da edição da requisição"
            size={areaPx(requestHeight.size)}
            min={Math.max(160, areaPx(REQUEST_MIN))}
            max={areaPx(REQUEST_MAX)}
            onResize={(px) => requestHeight.setSize((px / areaPx(100)) * 100)}
            onReset={requestHeight.reset}
            {...(!draft.adapter && { onCollapse: () => setCollapsed(true) })}
          />
        )
      )}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {draft.realtime && (
        <div className="mx-4 mt-4 mb-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-panel">
          <Suspense fallback={<div className="flex-1" />}>
            <RealtimePanel
              protocol={draft.realtime}
              live={live}
              compose={draft.compose ?? { data: '', event: '' }}
              onCompose={(compose) => props.onChange({ compose })}
              onSend={() => props.onSendMessage?.()}
              onClear={() => props.onChange((d) => ({ live: { ...(d.live ?? idleLive()), messages: [], dropped: 0 } }))}
            />
          </Suspense>
        </div>
      )}
      {!draft.realtime && draft.result?.sent && <SentRequestBar sent={draft.result.sent} />}
      <div
        hidden={!!draft.realtime}
        className={cx(
          'mx-4 mb-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-panel',
          draft.result?.sent ? 'mt-2' : sideBySide ? 'mt-3' : 'mt-4'
        )}
      >
        <ResponseViewer
          result={draft.result}
          pending={!!draft.pendingId}
          meta={
            (draft.result?.prepare || draft.result?.auth || draft.result?.plugin) && (
              <>
                {draft.result.plugin && (
                  <span title={draft.result.plugin.logs ? `Logs do plugin:\n${draft.result.plugin.logs}` : undefined}>
                    pelo adapter {draft.result.plugin.adapter}
                    {draft.result.plugin.logs ? ' (com logs)' : ''}
                    {(draft.result.prepare || draft.result.auth) && <span className="text-faint"> · </span>}
                  </span>
                )}
                {draft.result.prepare && <PrepareBadge prepare={draft.result.prepare} />}
                {draft.result.prepare && draft.result.auth && <span className="text-faint"> · </span>}
                {draft.result.auth && <AuthBadge auth={draft.result.auth} />}
              </>
            )
          }
          timeline={[
            ...(draft.result?.prepare
              ? [{ label: 'Preparação', ms: draft.result.prepare.durationMs, detail: `fluxo ${draft.result.prepare.flowName}` }]
              : []),
            ...(draft.result?.auth && draft.result.auth.source !== 'cache' && draft.result.auth.source !== 'static'
              ? [{ label: 'Auth do conector', ms: draft.result.auth.ms, detail: `de ${draft.result.auth.from}` }]
              : [])
          ]}
          {...(draft.result?.prepare?.failed && {
            errorLocation: `${draft.result.prepare.flowName} · nó ${draft.result.prepare.failed.name}`,
            errorActions: props.onOpenFlow && (
              <Button size="sm" icon={<Workflow {...icon} />} onClick={() => props.onOpenFlow!(draft.result!.prepare!.flowId)}>
                Abrir o fluxo no Flow Studio
              </Button>
            )
          })}
          emptyHint="Envie com o botão ou Ctrl+Enter."
          visualizer={draft.visualizer ?? ''}
          onVisualizerChange={(visualizer) => props.onChange({ visualizer })}
          {...(props.jsonActions && { jsonActions: props.jsonActions })}
          menu={() => [
            {
              id: 'compare',
              label: 'Comparar com a resposta anterior',
              icon: <GitCompare {...icon} />,
              disabled: !draft.previous || !draft.result,
              run: () => setComparing(true)
            },
            {
              id: 'resend',
              label: 'Enviar de novo',
              icon: <Send {...icon} />,
              hint: formatShortcut(Shortcut.run),
              disabled: !!draft.pendingId,
              run: props.onSend
            }
          ]}
        />
      </div>
      </div>
      </div>
      {editMenu.menu}
      {dock.overlay}
      {comparing && draft.previous && draft.result && (
        <CompareDialog before={draft.previous} after={draft.result} onClose={() => setComparing(false)} />
      )}
    </>
  )
}

function HeadersEditor(props: {
  rows: HeaderRow[]
  connector: CatalogConnector | null
  open: OpenMenu
  bind: ReturnType<typeof useContextMenu>['bind']
  onUpdate: (key: number, patch: Partial<HeaderRow>) => void
  onChange: (rows: HeaderRow[]) => void
  onRemove: (key: number) => void
  onOpenConnector?: () => void
}) {
  const local = new Set(props.rows.filter((r) => r.enabled && r.name.trim()).map((r) => r.name.trim().toLowerCase()))
  const rowEntries = (h: HeaderRow): ContextMenuEntries => {
    const empty = h === props.rows.at(-1) && !h.name && !h.value
    const i = props.rows.indexOf(h)
    return [
      {
        id: 'toggle',
        label: h.enabled ? 'Desativar' : 'Ativar',
        icon: <ToggleLeft {...icon} />,
        disabled: empty,
        run: () => props.onUpdate(h.key, { enabled: !h.enabled })
      },
      {
        id: 'duplicate',
        label: 'Duplicar',
        icon: <CopyPlus {...icon} />,
        shortcut: Shortcut.duplicate,
        disabled: empty,
        run: () => props.onChange([...props.rows.slice(0, i + 1), { ...h, key: emptyRow().key }, ...props.rows.slice(i + 1)])
      },
      {
        id: 'copy',
        label: 'Copiar como "Nome: valor"',
        icon: <Copy {...icon} />,
        shortcut: Shortcut.copy,
        disabled: empty,
        run: () => void navigator.clipboard.writeText(`${h.name}: ${h.value}`)
      },
      {
        id: 'remove',
        label: 'Remover',
        icon: <Trash2 {...icon} />,
        shortcut: Shortcut.remove,
        danger: true,
        disabled: empty,
        run: () => props.onRemove(h.key)
      },
      separator,
      {
        id: 'remove-disabled',
        label: 'Remover os desativados',
        disabled: !props.rows.some((r) => !r.enabled),
        run: () => props.onChange(props.rows.filter((r) => r.enabled || r === props.rows.at(-1)))
      },
      {
        id: 'copy-all',
        label: 'Copiar todos os headers',
        disabled: !props.rows.some((r) => r.enabled && r.name.trim()),
        run: () =>
          void navigator.clipboard.writeText(
            props.rows
              .filter((r) => r.enabled && r.name.trim())
              .map((r) => `${r.name}: ${r.value}`)
              .join('\n')
          )
      }
    ]
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <div className="flex flex-col gap-1">
        {props.rows.map((h) => (
          <div
            key={h.key}
            className="flex items-center gap-2"
            {...props.bind(`Header ${h.name || 'novo'}`, () => rowEntries(h))}
            onContextMenu={(e) => {
              if (isEditableTarget(e.target)) return fieldMenu(props.open, `Header ${h.name || 'novo'}`, () => rowEntries(h))(e)
              props.bind(`Header ${h.name || 'novo'}`, () => rowEntries(h)).onContextMenu(e)
            }}
          >
            <input
              type="checkbox"
              aria-label="Ativar cabeçalho"
              checked={h.enabled}
              onChange={(e) => props.onUpdate(h.key, { enabled: e.target.checked })}
            />
            <input
              aria-label="Nome do cabeçalho"
              placeholder="Nome"
              className="h-7 w-1/3 border px-2 font-mono text-xs"
              value={h.name}
              onChange={(e) => props.onUpdate(h.key, { name: e.target.value })}
              spellCheck={false}
            />
            <input
              aria-label="Valor do cabeçalho"
              placeholder="Valor"
              className="h-7 flex-1 border px-2 font-mono text-xs"
              value={h.value}
              onChange={(e) => props.onUpdate(h.key, { value: e.target.value })}
              spellCheck={false}
            />
            <IconButton
              label="Remover cabeçalho"
              disabled={h === props.rows.at(-1)}
              onClick={() => props.onRemove(h.key)}
              className="disabled:invisible"
            >
              <X size={13} aria-hidden />
            </IconButton>
          </div>
        ))}
      </div>
      {props.connector && (props.connector.headers.length > 0 || props.connector.auth) && (
        <div className="mt-2 border-t border-border-subtle pt-2" aria-label="Herdados do conector">
          <p className="mb-1 text-[11px] text-muted">Herdados de {props.connector.chain.join(' → ')}</p>
          {props.connector.headers.map((h) => {
            const overridden = local.has(h.name.toLowerCase())
            const entries = (): ContextMenuEntries => [
              {
                id: 'copy',
                label: 'Copiar como "Nome: valor"',
                icon: <Copy {...icon} />,
                shortcut: Shortcut.copy,
                run: () => void navigator.clipboard.writeText(`${h.name}: ${h.value}`)
              },
              {
                id: 'override',
                label: 'Sobrescrever nesta requisição',
                icon: <PenLine {...icon} />,
                disabled: overridden,
                run: () => {
                  const last = props.rows.at(-1)
                  const row = { ...emptyRow(), name: h.name, value: h.value }
                  props.onChange(last && !last.name && !last.value ? [...props.rows.slice(0, -1), row, last] : [...props.rows, row, emptyRow()])
                }
              },
              props.onOpenConnector && {
                id: 'open-connector',
                label: 'Abrir o conector no Catálogo',
                icon: <Network {...icon} />,
                run: props.onOpenConnector
              }
            ]
            return (
              <div
                key={h.name}
                tabIndex={0}
                {...props.bind(`Header herdado ${h.name}`, entries)}
                className="flex items-center gap-2 py-0.5 pl-6 font-mono text-xs"
              >
                <span className={`w-1/3 shrink-0 truncate ${overridden ? 'text-faint line-through' : 'text-muted'}`}>
                  {h.name}
                </span>
                <span className={`min-w-0 flex-1 truncate ${overridden ? 'text-faint line-through' : ''}`}>
                  {h.value}
                </span>
                <InheritanceBadge kind="inherited" />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Origem de um parâmetro: o endpoint do conector define a query padrão; o resto é desta aba. */
function paramOrigin(p: QueryParam, fromEndpoint: QueryParam[]): { kind: 'inherited' | 'overridden' | 'local'; from?: string } {
  const base = fromEndpoint.find((e) => e.name === p.name)
  if (!base) return { kind: 'local' }
  return base.value === p.value ? { kind: 'inherited', from: 'endpoint' } : { kind: 'overridden', from: 'endpoint' }
}

/**
 * Aba Params: a query da URL em linhas. Editar uma linha reescreve a URL;
 * desativar tira o parâmetro da URL sem perdê-lo; cada linha diz se veio do endpoint, se foi
 * alterada ou se é desta requisição. Os parâmetros de rota aparecem embaixo.
 */
function ParamsEditor(props: {
  url: string
  params: QueryParam[]
  disabled: QueryParam[]
  /** Query padrão do endpoint que preencheu a aba. */
  fromEndpoint: QueryParam[]
  open: OpenMenu
  bind: ReturnType<typeof useContextMenu>['bind']
  onChange: (params: QueryParam[], disabled: QueryParam[]) => void
}) {
  const { params, disabled } = props
  const rows = [
    ...params.map((p) => ({ ...p, enabled: true })),
    ...disabled.map((p) => ({ ...p, enabled: false })),
    { name: '', value: '', enabled: true }
  ]
  const last = rows.length - 1
  const route = pathParams(props.url)
  // Índice na lista visível → posição em params (ativos) ou disabled.
  const where = (i: number) => (i < params.length ? { list: 'on' as const, j: i } : { list: 'off' as const, j: i - params.length })
  const set = (i: number, patch: Partial<QueryParam>) => {
    if (i === last) return props.onChange([...params, { name: '', value: '', ...patch }].filter((p) => p.name || p.value), disabled)
    const { list, j } = where(i)
    if (list === 'on') props.onChange(params.map((p, k) => (k === j ? { ...p, ...patch } : p)), disabled)
    else props.onChange(params, disabled.map((p, k) => (k === j ? { ...p, ...patch } : p)))
  }
  const remove = (i: number) => {
    const { list, j } = where(i)
    if (list === 'on') props.onChange(params.filter((_, k) => k !== j), disabled)
    else props.onChange(params, disabled.filter((_, k) => k !== j))
  }
  const toggle = (i: number) => {
    const { list, j } = where(i)
    if (list === 'on') props.onChange(params.filter((_, k) => k !== j), [...disabled, params[j]!])
    else props.onChange([...params, disabled[j]!], disabled.filter((_, k) => k !== j))
  }
  const entries = (i: number): ContextMenuEntries => {
    const p = rows[i]!
    const empty = i === last
    return [
      {
        id: 'toggle',
        label: p.enabled ? 'Desativar' : 'Ativar',
        icon: <ToggleLeft {...icon} />,
        disabled: empty,
        run: () => toggle(i)
      },
      {
        id: 'duplicate',
        label: 'Duplicar',
        icon: <CopyPlus {...icon} />,
        shortcut: Shortcut.duplicate,
        disabled: empty || !p.enabled,
        run: () => props.onChange([...params.slice(0, i + 1), p, ...params.slice(i + 1)], disabled)
      },
      {
        id: 'copy',
        label: 'Copiar como nome=valor',
        icon: <Copy {...icon} />,
        shortcut: Shortcut.copy,
        disabled: empty,
        run: () => void navigator.clipboard.writeText(`${p.name}=${p.value}`)
      },
      { id: 'remove', label: 'Remover', icon: <Trash2 {...icon} />, shortcut: Shortcut.remove, danger: true, disabled: empty, run: () => remove(i) },
      separator,
      {
        id: 'copy-query',
        label: 'Copiar a query string',
        disabled: !params.length,
        run: () => void navigator.clipboard.writeText(withQuery('', params).replace(/^\?/, ''))
      },
      { id: 'remove-all', label: 'Remover todos', danger: true, disabled: !params.length && !disabled.length, run: () => props.onChange([], []) }
    ]
  }
  // Parâmetros do endpoint que não estão em nenhuma linha: removidos nesta requisição.
  const removed = props.fromEndpoint.filter((e) => !rows.some((r) => r.name === e.name))
  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <div className="flex flex-col gap-1" aria-label="Parâmetros da query">
        {rows.map((p, i) => {
          const origin = i === last ? null : paramOrigin(p, props.fromEndpoint)
          return (
            <div
              key={i}
              className="flex items-center gap-2"
              {...props.bind(`Parâmetro ${p.name || 'novo'}`, () => entries(i))}
              onContextMenu={(e) => {
                if (isEditableTarget(e.target)) return fieldMenu(props.open, `Parâmetro ${p.name || 'novo'}`, () => entries(i))(e)
                props.bind(`Parâmetro ${p.name || 'novo'}`, () => entries(i)).onContextMenu(e)
              }}
            >
              <input
                type="checkbox"
                aria-label={`Ativar parâmetro ${p.name || 'novo'}`}
                checked={p.enabled}
                disabled={i === last}
                onChange={() => toggle(i)}
                className="disabled:invisible"
              />
              <input
                aria-label="Nome do parâmetro"
                placeholder="Nome"
                className={cx('h-7 w-1/3 border px-2 font-mono text-xs', !p.enabled && 'text-faint line-through')}
                value={p.name}
                onChange={(e) => set(i, { name: e.target.value })}
                spellCheck={false}
              />
              <input
                aria-label="Valor do parâmetro"
                placeholder="Valor"
                className={cx('h-7 min-w-0 flex-1 border px-2 font-mono text-xs', !p.enabled && 'text-faint line-through')}
                value={p.value}
                onChange={(e) => set(i, { value: e.target.value })}
                spellCheck={false}
              />
              {origin && props.fromEndpoint.length > 0 && <InheritanceBadge kind={origin.kind} from={origin.from} />}
              <IconButton label="Remover parâmetro" disabled={i === last} onClick={() => remove(i)} className="disabled:invisible">
                <X size={13} aria-hidden />
              </IconButton>
            </div>
          )
        })}
      </div>
      {removed.length > 0 && (
        <div className="mt-2 border-t border-border-subtle pt-2 text-xs" aria-label="Removidos do endpoint">
          <p className="mb-1 text-[11px] text-muted">Do endpoint, fora desta requisição</p>
          {removed.map((p) => (
            <div key={p.name} className="flex items-center gap-2 py-0.5 pl-6 font-mono">
              <span className="w-1/3 truncate text-faint line-through">{p.name}</span>
              <span className="min-w-0 flex-1 truncate text-faint line-through">{p.value}</span>
              <button
                type="button"
                className="rounded px-1 font-sans text-[11px] text-accent hover:underline"
                onClick={() => props.onChange([...params, p], disabled)}
              >
                Restaurar
              </button>
            </div>
          ))}
        </div>
      )}
      {route.length > 0 && (
        <div className="mt-2 border-t border-border-subtle pt-2 text-xs" aria-label="Parâmetros de rota">
          <p className="mb-1 text-[11px] text-muted">Parâmetros de rota (troque na URL ou nos cenários)</p>
          {route.map((name) => (
            <p key={name} className="py-0.5 pl-1 font-mono text-cyan">
              {`{${name}}`}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

function AuthTab({ connector }: { connector: CatalogConnector | null }) {
  if (!connector?.auth) {
    return (
      <EmptyState
        title={connector ? 'Este conector não define auth' : 'Sem conector'}
        description="Um header Authorization na aba Headers vai como está. Com um conector, a auth herdada é resolvida no envio, sem o segredo passar pela interface."
      />
    )
  }
  const { auth } = connector
  return (
    <div className="flex flex-col gap-2 p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium">{AUTH_LABEL[auth.type]}</span>
        <InheritanceBadge
          kind={auth.from === connector.id ? 'local' : 'inherited'}
          from={auth.from === connector.id ? undefined : auth.from}
        />
      </div>
      <p className="font-mono text-muted">{auth.summary}</p>
      <p className="text-muted">
        A credencial é obtida e renovada no processo principal a cada envio; o token nunca chega a esta tela. Um header
        com o mesmo nome na aba Headers substitui a auth herdada.
      </p>
    </div>
  )
}

type ScriptPhase = 'pre' | 'post'
const PHASE_HINT: Record<ScriptPhase, string> = {
  pre: `// Roda antes do envio e pode mudar a requisição.
// vv.request.headers['X-Assinatura'] = vv.variables.get('TENANT')
// vv.request.query.pagina = 2`,
  post: `// Roda com a resposta: testes e variáveis para as próximas requisições.
// vv.test('status 200', () => vv.expect(vv.response.status).to.equal(200))
// vv.variables.set('token', vv.response.json().token)`
}
const phaseLabel = (from: string) => (from === 'endpoint' ? 'do endpoint' : `do conector ${from}`)

/**
 * Scripts pre e post da aba (fase 13). Por trás, a requisição vira um fluxo do Flow Studio
 * (script → requisição → script) que roda no mesmo motor; "Ver como fluxo" abre esse fluxo.
 * Os scripts do conector e do endpoint rodam antes dos da aba (pre) e antes deles (post).
 */
function ScriptsTab(props: {
  draft: RequestDraft
  inherited: { from: string; pre?: string; post?: string }[]
  onChange: (scripts: { pre?: string; post?: string }) => void
  onOpenConnector?: () => void
  onViewFlow?: () => void
}) {
  const [phase, setPhase] = useState<ScriptPhase>('pre')
  const inherited = props.inherited.filter((s) => s[phase]?.trim())
  const code = props.draft.scripts?.[phase] ?? ''
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-2 py-1 text-xs">
        <SegmentedControl<ScriptPhase>
          label="Momento do script"
          size="xs"
          value={phase}
          onChange={setPhase}
          options={[
            { value: 'pre', label: `Antes do envio${props.draft.scripts?.pre?.trim() ? ' •' : ''}` },
            { value: 'post', label: `Depois da resposta${props.draft.scripts?.post?.trim() ? ' •' : ''}` }
          ]}
        />
        {inherited.length > 0 && (
          <span className="flex min-w-0 items-center gap-1 text-muted" title={inherited.map((s) => `${phaseLabel(s.from)}:\n${s[phase]}`).join('\n\n')}>
            <InheritanceBadge kind="inherited" from={inherited.map((s) => (s.from === 'endpoint' ? 'endpoint' : s.from)).join(', ')} />
            <span className="truncate">rodam antes deste</span>
            {props.onOpenConnector && (
              <button type="button" className="shrink-0 underline hover:text-fg" onClick={props.onOpenConnector}>
                ver no Catálogo
              </button>
            )}
          </span>
        )}
        <span className="flex-1" />
        {props.onViewFlow && (
          <Button size="sm" variant="ghost" icon={<Workflow {...icon} />} onClick={props.onViewFlow} disabled={!props.draft.url.trim()}>
            Ver como fluxo
          </Button>
        )}
      </div>
      <CodeEditor
        key={phase}
        ariaLabel={phase === 'pre' ? 'Script antes do envio' : 'Script depois da resposta'}
        language="javascript"
        value={code}
        onChange={(value) => props.onChange({ [phase]: value })}
        placeholder={PHASE_HINT[phase]}
        toolbar={
          <>
            <span>JavaScript · API vv (request, response, variables, test, expect)</span>
            <span className="flex-1" />
            <span className="text-faint">segredos aparecem como {'{{NOME}}'}</span>
          </>
        }
      />
    </div>
  )
}

const COLLAPSED_KEY = 'vvpost.quick.editorCollapsed'

/** Edição recolhida, lembrada entre sessões: com ela, a resposta ocupa o espaço. */
function useEditorCollapsed(): [boolean, (v: boolean) => void] {
  const [collapsed, set] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  return [
    collapsed,
    (v) => {
      set(v)
      try {
        localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0')
      } catch {
        // sem armazenamento local: só não lembra
      }
    }
  ]
}

/**
 * A requisição como foi para a rede, separada do modelo editável acima: URL
 * final com a baseUrl e os {{VAR}} resolvidos e os headers herdados e da auth, com as credenciais
 * mascaradas pelo main process.
 */
function SentRequestBar({ sent }: { sent: SentRequest }) {
  const [open, setOpen] = useState(false)
  return (
    <section aria-label="Requisição enviada" className="mx-4 mt-2 rounded-[var(--radius-card)] border border-dashed border-border text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left hover:bg-border/40"
        title="O que foi para a rede, com herança, auth e variáveis resolvidas (segredos mascarados)"
      >
        {open ? <ChevronDown {...icon} /> : <ChevronRight {...icon} />}
        <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted uppercase">Enviada</span>
        <span className={cx('shrink-0 font-mono font-semibold', methodColor(sent.method))}>{sent.method}</span>
        <span className="min-w-0 flex-1 truncate font-mono" data-testid="sent-url">
          {sent.url}
        </span>
        <span className="shrink-0 text-muted">{sent.headers.length} headers</span>
      </button>
      {open && (
        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-0.5 border-t border-border-subtle px-3 py-2 pl-8 font-mono text-[11px]">
          {sent.headers.map((h, i) => (
            <div key={`${h.name}-${i}`} className="contents">
              <dt className="truncate text-muted">{h.name}</dt>
              <dd className="truncate">{h.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

export const AUTH_LABEL: Record<AuthUsage['type'], string> = {
  bearer: 'Token fixo',
  apiKey: 'API key',
  basic: 'Basic',
  oauth2: 'OAuth2',
  login: 'Login',
  digest: 'Digest',
  ntlm: 'NTLM',
  awsSigV4: 'AWS SigV4',
  oauth1: 'OAuth 1.0'
}

/** Como a auth herdada foi resolvida: token em cache, obtido agora ou renovado após 401. */
export function AuthBadge({ auth }: { auth: AuthUsage }) {
  const source =
    auth.source === 'cache'
      ? 'token em cache'
      : auth.source === 'fetched'
        ? `token obtido em ${formatMs(auth.ms)}`
        : auth.source === 'refreshed'
          ? `token renovado em ${formatMs(auth.ms)}`
          : 'credencial do ambiente'
  const expires = auth.expiresAt ? ` · expira às ${formatTime(auth.expiresAt)}` : ''
  return (
    <span className="text-muted" aria-label="Auth do conector" title={`Auth herdada de ${auth.from}${expires}`}>
      {AUTH_LABEL[auth.type]} · {source}
      {auth.retried ? ' (após 401)' : ''}
    </span>
  )
}

/** O fluxo de preparação que rodou antes da requisição: nome, nós e tempo. */
export function PrepareBadge({ prepare }: { prepare: PrepareUsage }) {
  const nodes = prepare.nodes.length === 1 ? '1 nó' : `${prepare.nodes.length} nós`
  return (
    <span className="text-muted" aria-label="Preparação" title={`Fluxo ${prepare.flowId}: ${prepare.nodes.join(', ') || 'nenhum nó rodou'}`}>
      Preparação {prepare.flowName} · {prepare.failed ? `parou em ${prepare.failed.name}` : `${nodes} em ${formatMs(prepare.durationMs)}`}
    </span>
  )
}

function methodColor(method: HttpMethod): string {
  switch (method) {
    case 'GET':
      return 'text-success'
    case 'POST':
      return 'text-accent'
    case 'PUT':
      return 'text-warning'
    case 'PATCH':
      return 'text-cyan'
    case 'DELETE':
      return 'text-danger'
    default:
      return 'text-info'
  }
}

/** Ponto para abrir o menu pelo teclado (tecla Menu, Shift+F10): o canto do editor. */
function caretPoint(el: HTMLElement): { x: number; y: number } {
  const box = el.getBoundingClientRect()
  return { x: box.left + 24, y: box.top + 24 }
}

/** Corpo JSON editado pelo formulário do bodySchema; o texto da aba continua sendo o JSON. */
function SchemaBody(props: { schema: Record<string, unknown>; body: string; onChange: (body: string) => void; onShowJson: () => void }) {
  const parsed = parseFormBody(props.body)
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      {parsed.ok ? (
        <SchemaForm
          schema={props.schema}
          value={parsed.value}
          label="Formulário do corpo"
          onChange={(value) => props.onChange(value === undefined ? '' : JSON.stringify(value, null, 2))}
        />
      ) : (
        <EmptyState
          title="O corpo não é um JSON válido"
          description={`Corrija no JSON raw para voltar ao formulário (${parsed.message}).`}
        >
          <Button size="sm" onClick={props.onShowJson}>
            Abrir o JSON raw
          </Button>
        </EmptyState>
      )}
    </div>
  )
}
