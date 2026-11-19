import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Copy, FileSearch, FileSpreadsheet, FlaskConical, FolderOpen, Network, Pencil, Play, Plus, RotateCw, Terminal, X, Zap } from 'lucide-react'
import type {
  CatalogConnector,
  CatalogScenario,
  DataFile,
  ScenarioResult,
  ScenarioRunInput,
  ScenarioRunReport
} from '@shared/ipc'
import {
  AssertionList,
  Badge,
  Collapsible,
  FAILURE_LABEL,
  FAILURE_SHORT,
  FailedAssertion,
  failureKind,
  Button,
  CodeEditor,
  ContextSelector,
  cx,
  EmptyState,
  ErrorNotice,
  ExecutionToolbar,
  Field,
  formatJson,
  formatShortcut,
  formatMs,
  IconButton,
  InspectorPanel,
  InspectorSection,
  MethodBadge,
  OutcomeCell,
  OutcomeTotals,
  statusTone,
  separator,
  Shortcut,
  table,
  useContextMenu,
  useMenuCommands,
  usePromptDialog,
  useToast,
  DockablePane,
  type ContextMenuEntries
} from '../../design-system'
import { openInQuickRequest, type OpenRequest } from '../../lib/open-request'
import { docsMenuItems } from '../docs/open'
import { scenarioMenu } from '../connectors/menus'
import { copyText } from '../../lib/clipboard'
import { navigate, useNavigation } from '../../lib/navigate'
import { timedRun } from '../../lib/perf'
import { toCode } from '../../lib/request-code'
import { useWorkspace } from '../../panels/useWorkspace'
import { ScenarioEditor } from '../connectors/editor/ScenarioEditor'
import { describeRemoteRun, RemoteRunButton, RemoteRunStrip, useRemoteRun, useRemoteRunTarget } from './RemoteRun'
import { confirmProtected } from '../../lib/protected'
import { accessCheckScenario, ACCESS_CHECK_ID } from '@vvpost/core/scenarios/access'

type CatalogEndpoint = CatalogConnector['endpoints'][number]

/** O endpoint com o gate de acesso (requiresAuth) entre os cenários: o VVPost acrescenta ao rodar, e a linha não se edita. */
function withAccessCheck(e: CatalogEndpoint): CatalogEndpoint {
  const access = accessCheckScenario(e)
  return access ? { ...e, scenarios: [...e.scenarios, access as CatalogScenario] } : e
}

const cellKey = (endpointId: string, scenarioId: string, environmentId: string) =>
  `${endpointId}/${scenarioId}@${environmentId}`

/**
 * Tests: a matriz de cenários. Os cenários table-driven de cada endpoint, como
 * escritos no arquivo do conector, rodam em lote em um ou mais ambientes pelo mesmo ciclo de
 * execução do Quick Request (ExecutionToolbar). Cada célula é um cenário num ambiente; o
 * inspector mostra asserção por asserção, a requisição e o corpo da resposta.
 */
export default function TestsModule() {
  const ws = useWorkspace()
  const { workspace } = ws
  const connector = ws.selection.connector
  const [endpointId, setEndpointId] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null)
  const [results, setResults] = useState<ReadonlyMap<string, ScenarioResult>>(new Map())
  const [running, setRunning] = useState<{ runId: string; keys: ReadonlySet<string> } | null>(null)
  const [report, setReport] = useState<ScenarioRunReport | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [onlyFailures, setOnlyFailures] = useState(false)
  /** Arquivo de dados: com ele, cada cenário roda uma vez por linha, e a célula junta as iterações. */
  const [data, setData] = useState<DataFile | null>(null)
  const [iterations, setIterations] = useState<ReadonlyMap<string, ScenarioResult[]>>(new Map())
  const [iterationPick, setIterationPick] = useState<number | null>(null)
  /** Editor aberto: num cenário, num cenário novo do endpoint, ou no primeiro cenário. */
  const [editing, setEditing] = useState<{ endpointId?: string; scenarioId?: string } | null>(null)

  // Colunas da matriz: os ambientes marcados, na ordem do workspace. Sem escolha, o ambiente do Quick Request.
  const envOptions = useMemo(() => [{ id: '', name: 'Sem ambiente' }, ...(workspace?.environments ?? [])], [workspace])
  const chosen = picked ?? new Set([ws.selection.environmentId])
  const columns = envOptions.filter((e) => chosen.has(e.id))

  const endpoints = useMemo(() => (connector?.endpoints ?? []).map(withAccessCheck).filter((e) => e.scenarios.length > 0), [connector])
  const shown = endpointId ? endpoints.filter((e) => e.id === endpointId) : endpoints
  const total = shown.reduce((n, e) => n + e.scenarios.length, 0)

  // Resultados de um relatório (local ou do runner) entram na matriz pelas mesmas chaves.
  // Com iterações, a célula mostra a primeira que não passou (ou a última) e guarda todas para o inspector.
  const applyReport = (outcome: ScenarioRunReport) => {
    setReport(outcome)
    const byCell = new Map<string, ScenarioResult[]>()
    for (const r of outcome.results) {
      const key = cellKey(r.endpointId, r.scenarioId, r.environmentId)
      byCell.set(key, [...(byCell.get(key) ?? []), r])
    }
    setResults((prev) => {
      const next = new Map(prev)
      for (const [key, list] of byCell) next.set(key, list.find((r) => r.outcome !== 'passed') ?? list.at(-1)!)
      return next
    })
    setIterations((prev) => {
      const next = new Map(prev)
      for (const [key, list] of byCell) {
        if (list.some((r) => r.iteration !== undefined)) next.set(key, list)
        else next.delete(key)
      }
      return next
    })
    setIterationPick(null)
  }

  const pickData = async () => {
    const picked = await window.vvpost.pickDataFile()
    if (!picked) return
    if (!picked.ok) return toast(`Arquivo de dados: ${picked.message}`, 'danger')
    setData(picked.value)
    toast(`${picked.value.rows.length} ${picked.value.rows.length === 1 ? 'linha' : 'linhas'} de ${picked.value.name}: cada cenário roda uma vez por linha`, 'success')
  }

  const remoteTarget = useRemoteRunTarget()
  const remote = useRemoteRun((reports) => {
    const mine = reports.filter((r) => r.connectorId === connector?.id)
    if (mine.length) applyReport(mine.length === 1 ? mine[0]! : mergeReports(mine))
  })
  const runRemote = async () => {
    if (!connector) return
    const selection = {
      // Sem ambiente vira run sem --env; os ids de ambiente viram --env.
      environments: columns.map((c) => c.id).filter(Boolean),
      connectors: [connector.id],
      scenarios: endpointId ? [endpointId] : [],
      flows: []
    }
    // Antes de sair da máquina: destino, ambiente, projeto e segredos, para confirmar.
    const preview = await window.vvpost.previewRemoteRun(selection)
    if (!preview.ok) return toast(preview.message, 'danger')
    const endpointName = connector.endpoints.find((e) => e.id === endpointId)?.name
    const ok = await dialog.confirm({
      title: `Enviar ao runner de ${preview.value.source}?`,
      message: describeRemoteRun(preview.value, endpointName ? `cenários de ${endpointName}` : 'todos os cenários do conector'),
      confirmLabel: 'Enviar ao runner'
    })
    if (ok) void remote.start(selection)
  }

  const toggleEnv = (id: string) => {
    const next = new Set(chosen)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }

  const run = async (scope: Pick<ScenarioRunInput, 'endpointIds' | 'scenarioKeys'>, envs = columns) => {
    if (!connector || running || envs.length === 0) return
    if (!(await confirmProtected(dialog.confirm, envs, 'Rodar os cenários'))) return
    const runId = crypto.randomUUID()
    const keys = new Set<string>()
    for (const e of endpoints) {
      if (scope.endpointIds && !scope.endpointIds.includes(e.id)) continue
      for (const s of e.scenarios) {
        if (scope.scenarioKeys && !scope.scenarioKeys.includes(`${e.id}/${s.id}`)) continue
        for (const c of envs) keys.add(cellKey(e.id, s.id, c.id))
      }
    }
    setRunning({ runId, keys })
    try {
      const outcome = await timedRun('scenarios', () =>
        window.vvpost.runScenarios({
          runId,
          connectorId: connector.id,
          ...scope,
          environmentIds: envs.map((c) => c.id),
          ...(data && { data: { name: data.name, rows: data.rows } })
        })
      )
      applyReport(outcome)
    } finally {
      setRunning(null)
    }
  }

  // O resumo conta a matriz que está na tela, não só o último disparo (que pode ter sido um cenário).
  const matrixTotals = { passed: 0, failed: 0, error: 0 }
  for (const e of endpoints) {
    for (const s of e.scenarios) {
      for (const c of columns) {
        const r = results.get(cellKey(e.id, s.id, c.id))
        if (r) matrixTotals[r.outcome]++
      }
    }
  }

  const selectedIterations = selected ? iterations.get(selected) : undefined
  const selectedResult = selected
    ? (selectedIterations?.find((r) => r.iteration === iterationPick) ?? results.get(selected))
    : undefined
  const isFailing = (e: CatalogEndpoint, s: CatalogScenario) =>
    columns.some((c) => {
      const r = results.get(cellKey(e.id, s.id, c.id))
      return r && r.outcome !== 'passed'
    })

  // Menus de contexto: endpoint, cenário (os mesmos itens do Catálogo) e célula de resultado.
  const ctx = useContextMenu()
  const toast = useToast()
  const dialog = usePromptDialog()
  const copy = (text: string, what: string) =>
    void copyText(text, what).then((m) => toast(m, 'success'), () => toast('Não deu para copiar.', 'danger'))
  const apply = async (ops: Parameters<typeof window.vvpost.editProject>[0], done: string) => {
    const r = await window.vvpost.editProject(ops)
    if (!r.ok) {
      toast(r.message, 'danger')
      return false
    }
    ws.reload()
    toast(done, 'success')
    return true
  }
  const openEndpoint = (e: CatalogEndpoint) =>
    connector &&
    openInQuickRequest({
      method: e.method,
      url: e.path,
      headers: e.headers,
      body: e.body ?? '',
      connectorId: connector.id,
      environmentId: ws.selection.environmentId || null,
      endpointId: e.id
    })
  const endpointCurl = (e: CatalogEndpoint) =>
    toCode('curl', { method: e.method, url: `${connector?.baseUrl ?? ''}${e.path}`, headers: e.headers, ...(e.body && { body: e.body }) })
  const canRun = !running && columns.length > 0 && !editing

  const endpointEntries = (e: CatalogEndpoint): ContextMenuEntries =>
    connector
      ? [
          { id: 'run', label: 'Executar os cenários', icon: <Play size={14} aria-hidden />, shortcut: Shortcut.run, disabled: !canRun, run: () => void run({ endpointIds: [e.id] }) },
          { id: 'new', label: 'Novo cenário', icon: <Plus size={14} aria-hidden />, run: () => setEditing({ endpointId: e.id }) },
          { id: 'quick', label: 'Abrir no Quick Request', icon: <Zap size={14} aria-hidden />, shortcut: Shortcut.openInNewTab, run: () => openEndpoint(e) },
          { id: 'copy-curl', label: 'Copiar como cURL', icon: <Terminal size={14} aria-hidden />, shortcut: Shortcut.copyAsCurl, run: () => copy(endpointCurl(e), 'cURL copiado (sem a auth do conector)') },
          { id: 'catalog', label: 'Abrir no Catálogo', run: () => navigate({ module: 'catalog', connectorId: connector.id, endpointId: e.id }) },
          separator,
          ...docsMenuItems({ kind: 'endpoint', connectorId: connector.id, endpointId: e.id })
        ]
      : []

  const scenarioEntries = (e: CatalogEndpoint, s: CatalogScenario): ContextMenuEntries =>
    connector
      ? scenarioMenu({
          connectorId: connector.id,
          endpointId: e.id,
          scenario: s,
          apply,
          dialog,
          openInQuick: () => openEndpoint(e),
          copyCurl: () => copy(endpointCurl(e), 'cURL do endpoint copiado'),
          onEdit: () => setEditing({ endpointId: e.id, scenarioId: s.id }),
          onRun: () => void run({ scenarioKeys: [`${e.id}/${s.id}`] })
        })
      : []

  const cellEntries = (e: CatalogEndpoint, s: CatalogScenario, env: { id: string; name: string }): ContextMenuEntries => {
    const r = results.get(cellKey(e.id, s.id, env.id))
    const failed = r?.assertions.filter((a) => !a.passed) ?? []
    return [
      {
        id: 'rerun',
        label: r ? 'Executar de novo só esta célula' : 'Executar só esta célula',
        icon: <RotateCw size={14} aria-hidden />,
        shortcut: Shortcut.run,
        disabled: !!running || !!editing,
        run: () => void run({ scenarioKeys: [`${e.id}/${s.id}`] }, [env])
      },
      r && { id: 'detail', label: 'Ver o detalhe', run: () => setSelected(cellKey(e.id, s.id, env.id)) },
      separator,
      r?.bodyPreview && { id: 'copy-body', label: 'Copiar o corpo da resposta', icon: <Copy size={14} aria-hidden />, shortcut: Shortcut.copy, run: () => copy(r.bodyPreview!, 'Corpo copiado') },
      failed.length > 0 && {
        id: 'copy-failed',
        label: 'Copiar as asserções que falharam',
        run: () => copy(failed.map((a) => `✗ ${describeAssertion(a)}: ${a.message}`).join('\n'), 'Asserções copiadas')
      },
      r && {
        id: 'quick',
        label: 'Abrir a requisição no Quick Request',
        icon: <Zap size={14} aria-hidden />,
        shortcut: Shortcut.openInNewTab,
        run: () => connector && openInQuickRequest(scenarioAsRequest(connector.id, r, e, s))
      }
    ]
  }

  // Vindo do Catálogo ou do Quick Request: seleciona o conector e executa ou abre o editor.
  const [pendingRun, setPendingRun] = useState<Pick<ScenarioRunInput, 'endpointIds' | 'scenarioKeys'> | null>(null)
  useNavigation('scenarios', (t) => {
    if (connector?.id !== t.connectorId) ws.selectConnector(t.connectorId)
    setSelected(null)
    setEndpointId(t.endpointId ?? '')
    if (t.action === 'edit' || t.action === 'new') {
      setEditing({ endpointId: t.endpointId, ...(t.action === 'edit' && { scenarioId: t.scenarioId }) })
      return
    }
    setEditing(null)
    if (t.action === 'run')
      setPendingRun(t.scenarioId && t.endpointId ? { scenarioKeys: [`${t.endpointId}/${t.scenarioId}`] } : t.endpointId ? { endpointIds: [t.endpointId] } : {})
  })
  useEffect(() => {
    if (!pendingRun || !connector || running) return
    setPendingRun(null)
    void run(pendingRun)
  })

  const selectedEndpoint = shown.length === 1 ? shown[0] : undefined
  useMenuCommands('Tests', [
    connector && {
      id: 'run-all',
      label: `Rodar os cenários de ${selectedEndpoint?.name ?? connector.name}`,
      icon: <Play size={14} aria-hidden />,
      // Ctrl+Enter já é da barra de execução; aqui só a dica.
      hint: formatShortcut(Shortcut.run),
      keywords: ['testar', 'endpoint', 'executar', 'cenario'],
      disabled: !canRun || total === 0,
      run: () => void run(endpointId ? { endpointIds: [endpointId] } : {})
    },
    connector && !connector.error && { id: 'edit', label: 'Editar cenários', icon: <Pencil size={14} aria-hidden />, run: () => setEditing({}) },
    selectedEndpoint && { id: 'new', label: `Novo cenário em ${selectedEndpoint.name}`, icon: <Plus size={14} aria-hidden />, run: () => setEditing({ endpointId: selectedEndpoint.id }) },
    { id: 'only-failures', label: onlyFailures ? 'Mostrar todos os cenários' : 'Mostrar só as falhas', run: () => setOnlyFailures(!onlyFailures) }
  ], { shortcuts: true })

  const runCount = total * columns.length * (data?.rows.length ?? 1)
  const changeConnector = (id: string) => {
    ws.selectConnector(id)
    setEditing(null)
    setEndpointId('')
    setSelected(null)
  }

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-end gap-x-4 gap-y-3 border-b border-border px-4 py-3">
          {!workspace ? (
            <div className="flex items-center gap-3 text-xs text-muted">
              <Button size="sm" icon={<FolderOpen size={14} aria-hidden />} onClick={ws.open}>
                Abrir workspace…
              </Button>
              <span>Os cenários ficam nos arquivos de conector do workspace.</span>
              {ws.result && !ws.result.ok && <span className="text-danger">{ws.result.message}</span>}
            </div>
          ) : (
            <>
              <ContextSelector
                label="Contexto dos testes"
                fields={[
                  {
                    label: 'Conector',
                    ariaLabel: 'Conector',
                    icon: <Network size={13} aria-hidden />,
                    value: connector?.id ?? '',
                    onFocus: ws.reload,
                    onChange: changeConnector,
                    options: [
                      { value: '', label: 'Escolha…' },
                      ...workspace.connectors.map((c) => ({
                        value: c.id,
                        label: c.error ? `${c.name} (erro)` : c.name,
                        disabled: !!c.error
                      }))
                    ]
                  }
                ]}
              >
                <fieldset className="flex min-w-0 flex-col gap-1" aria-label="Ambientes da matriz">
                  <legend className="mb-1 text-[10px] font-medium tracking-wider text-muted uppercase">
                    Ambientes
                  </legend>
                  <div className="flex flex-wrap gap-1.5">
                    {envOptions.map((e) => (
                      <label
                        key={e.id}
                        className={cx(
                          'flex h-8 cursor-pointer items-center gap-1.5 rounded-[var(--radius-control)] border px-2.5 text-xs',
                          chosen.has(e.id)
                            ? 'border-accent/50 bg-accent/10 text-fg'
                            : 'border-border bg-elevated text-muted'
                        )}
                      >
                        <input type="checkbox" checked={chosen.has(e.id)} onChange={() => toggleEnv(e.id)} />
                        {e.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </ContextSelector>
              <DataFileControl data={data} disabled={!!running} onPick={() => void pickData()} onClear={() => setData(null)} />
              <div className="ml-auto flex items-center gap-2">
                {connector && !editing && !connector.error && (
                  <Button icon={<Pencil size={14} aria-hidden />} onClick={() => setEditing({})}>
                    Editar cenários
                  </Button>
                )}
                {remoteTarget && (
                  <RemoteRunButton
                    target={remoteTarget}
                    disabled={!connector || total === 0 || columns.length === 0 || !!editing || remote.active || !!data}
                    onClick={() => void runRemote()}
                  />
                )}
                <ExecutionToolbar
                  state={running ? 'running' : 'idle'}
                  runLabel={`Rodar ${runCount || ''} ${runCount === 1 ? 'cenário' : 'cenários'}`}
                  canRun={!!connector && total > 0 && columns.length > 0 && !editing}
                  onRun={() => void run(endpointId ? { endpointIds: [endpointId] } : {})}
                  onCancel={running ? () => void window.vvpost.cancelScenarios(running.runId) : undefined}
                />
              </div>
            </>
          )}
        </div>

        {remote.run && (
          <RemoteRunStrip
            run={remote.run}
            lines={remote.lines}
            active={remote.active}
            source={remoteTarget?.source ?? 'Control Plane'}
            onCancel={() => void remote.cancel()}
            onDismiss={remote.dismiss}
          />
        )}

        {report && (
          <div className="shrink-0 border-b border-border-subtle px-4 py-2">
            <RunSummary report={report} totals={matrixTotals} running={!!running} />
          </div>
        )}

        {connector && editing ? (
          <div className="flex min-h-0 flex-1 flex-col p-4">
            <ScenarioEditor
              key={`${connector.id}/${editing.endpointId ?? ''}/${editing.scenarioId ?? ''}`}
              connectorId={connector.id}
              environments={workspace?.environments ?? []}
              {...editing}
              onDone={(saved) => {
                setEditing(null)
                if (saved) {
                  // Resultados antigos podem não valer mais para o cenário editado.
                  setResults(new Map())
                  setReport(null)
                  setSelected(null)
                  ws.reload()
                }
              }}
            />
          </div>
        ) : !connector ? (
          <EmptyState
            icon={<FlaskConical size={20} aria-hidden />}
            title={workspace ? 'Escolha um conector' : 'Nenhum workspace aberto'}
            description={
              workspace
                ? 'Os cenários ficam em endpoints[].scenarios no arquivo *.connector.vvpost.json.'
                : 'Abra o workspace para ver os cenários de teste dos conectores.'
            }
          />
        ) : endpoints.length === 0 ? (
          <EmptyState icon={<FlaskConical size={20} aria-hidden />} title={`${connector.name} não tem cenários`}>
            {connector.endpoints.length > 0 && !connector.error && (
              <Button
                variant="primary"
                icon={<Plus size={14} aria-hidden />}
                onClick={() => setEditing({ endpointId: connector.endpoints[0]!.id })}
              >
                Criar cenário
              </Button>
            )}
          </EmptyState>
        ) : (
          <div className="flex min-h-0 flex-1">
            <DockablePane
              as="nav"
              id="tests.endpoints"
              title="Endpoints"
              dockLabel="a lista de endpoints"
              inspector="tests"
              label="Largura da lista de endpoints"
              defaultSize={208}
              min={160}
              max={480}
              className="flex flex-col gap-0.5 overflow-auto border-r border-border-subtle p-2 text-xs"
              aria-label="Endpoints"
            >
              <EndpointButton active={!endpointId} onClick={() => setEndpointId('')}>
                <span>Todos os endpoints</span>
                <span className="ml-auto text-muted">{endpoints.reduce((n, e) => n + e.scenarios.length, 0)}</span>
              </EndpointButton>
              {endpoints.map((e) => (
                <EndpointButton
                  key={e.id}
                  active={e.id === endpointId}
                  onClick={() => setEndpointId(e.id)}
                  menu={ctx.bind(`Endpoint ${e.name}`, () => endpointEntries(e))}
                >
                  <MethodBadge method={e.method} className="w-14" />
                  <span className="truncate" title={`${e.path} · ${e.name}`}>
                    {e.name}
                  </span>
                  <span className="ml-auto text-muted">{e.scenarios.length}</span>
                </EndpointButton>
              ))}
              <label className="mt-3 flex items-center gap-2 px-2 text-muted">
                <input type="checkbox" checked={onlyFailures} onChange={(e) => setOnlyFailures(e.target.checked)} />
                Só falhas
              </label>
            </DockablePane>

            <div className="min-h-0 min-w-0 flex-1 overflow-auto">
              <table className={table.root} aria-label="Matriz de cenários">
                <thead className={table.head}>
                  <tr>
                    <th className={table.th}>Cenário e overrides</th>
                    <th className={table.th}>Asserções</th>
                    {columns.map((c) => (
                      <th key={c.id} className={`${table.th} text-center`}>
                        {c.name}
                      </th>
                    ))}
                    <th className="w-16" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((e) => {
                    const rows = onlyFailures ? e.scenarios.filter((s) => isFailing(e, s)) : e.scenarios
                    if (rows.length === 0) return null
                    return (
                      <Fragment key={e.id}>
                        <tr className={table.group} {...ctx.bind(`Endpoint ${e.name}`, () => endpointEntries(e))}>
                          <td colSpan={2 + columns.length} className="px-3 py-1.5 font-mono">
                            <span className="inline-flex items-center gap-2">
                              <MethodBadge method={e.method} />
                              {e.path}
                              <span className="font-sans text-muted">{e.name}</span>
                            </span>
                          </td>
                          <td className="px-2 text-right whitespace-nowrap">
                            <IconButton
                              label={`Novo cenário em ${e.name}`}
                              onClick={() => setEditing({ endpointId: e.id })}
                            >
                              <Plus size={13} aria-hidden />
                            </IconButton>
                            <IconButton
                              label={`Rodar os cenários de ${e.name}`}
                              disabled={!!running || columns.length === 0}
                              onClick={() => void run({ endpointIds: [e.id] })}
                            >
                              <Play size={13} aria-hidden />
                            </IconButton>
                          </td>
                        </tr>
                        {rows.map((s) => (
                          <tr
                            key={s.id}
                            className={table.row}
                            {...(s.id !== ACCESS_CHECK_ID && ctx.bind(`Cenário ${s.name}`, () => scenarioEntries(e, s)))}
                          >
                            <td className={table.td} title={s.description}>
                              <div className="max-w-64 text-fg">{s.name}</div>
                              <div className="font-mono text-muted">
                                <Overrides scenario={s} />
                              </div>
                            </td>
                            <td className={`${table.td} font-mono text-muted`}>
                              {s.assertions.map((a, i) => (
                                <div key={i} className="max-w-56 truncate" title={describeAssertion(a)}>
                                  {describeAssertion(a)}
                                </div>
                              ))}
                            </td>
                            {columns.map((c) => {
                              const key = cellKey(e.id, s.id, c.id)
                              const r = results.get(key)
                              const list = iterations.get(key)
                              return (
                                <td
                                  key={c.id}
                                  className="px-2 py-2 text-center"
                                  {...ctx.bind(`${s.name} em ${c.name}`, () => cellEntries(e, s, c))}
                                >
                                  <OutcomeCell
                                    outcome={r?.outcome}
                                    pending={!!running?.keys.has(key)}
                                    text={r && (list ? iterationsText(list) : cellText(r))}
                                    kind={r && r.outcome === 'error' ? failureKind(r.error?.code) : undefined}
                                    label={`${s.name} em ${c.name}`}
                                    title={r && (list ? iterationsTitle(list) : cellTitle(r))}
                                    active={selected === key}
                                    onClick={() => {
                                      setIterationPick(null)
                                      setSelected(selected === key ? null : key)
                                    }}
                                  />
                                </td>
                              )
                            })}
                            <td className="px-2 py-2 text-right whitespace-nowrap">
                              {s.id !== ACCESS_CHECK_ID && (
                                <IconButton
                                  label={`Editar ${s.name}`}
                                  onClick={() => setEditing({ endpointId: e.id, scenarioId: s.id })}
                                >
                                  <Pencil size={13} aria-hidden />
                                </IconButton>
                              )}
                              <IconButton
                                label={`Rodar ${s.name}`}
                                disabled={!!running || columns.length === 0}
                                onClick={() => void run({ scenarioKeys: [`${e.id}/${s.id}`] })}
                              >
                                <Play size={13} aria-hidden />
                              </IconButton>
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      {ctx.menu}
      {dialog.element}
      <InspectorPanel id="tests" title="Inspector">
        {selectedResult && selectedIterations && (
          <IterationPicker results={selectedIterations} current={selectedResult.iteration} onPick={setIterationPick} />
        )}
        {selectedResult ? (
          <ResultDetail
            result={selectedResult}
            scenario={endpoints.find((e) => e.id === selectedResult.endpointId)?.scenarios.find((s) => s.id === selectedResult.scenarioId)}
            environment={envOptions.find((e) => e.id === selectedResult.environmentId)?.name ?? ''}
            onOpenEndpoint={
              connector ? () => navigate({ module: 'catalog', connectorId: connector.id, endpointId: selectedResult.endpointId }) : undefined
            }
            onEdit={() => setEditing({ endpointId: selectedResult.endpointId, scenarioId: selectedResult.scenarioId })}
            onOpenInQuick={
              connector
                ? () => {
                    const endpoint = endpoints.find((e) => e.id === selectedResult.endpointId)
                    const scenario = endpoint?.scenarios.find((s) => s.id === selectedResult.scenarioId)
                    openInQuickRequest(scenarioAsRequest(connector.id, selectedResult, endpoint, scenario), 'scenario')
                  }
                : undefined
            }
            onClose={() => setSelected(null)}
          />
        ) : (
          <EmptyState
            title="Nenhuma célula selecionada"
            description="Rode os cenários e clique numa célula da matriz para ver asserções, requisição e resposta."
          />
        )}
      </InspectorPanel>
    </div>
  )
}

/** Arquivo de dados das iterações: escolher, ver quantas linhas e colunas, tirar. */
function DataFileControl(props: { data: DataFile | null; disabled: boolean; onPick: () => void; onClear: () => void }) {
  const { data } = props
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] font-medium tracking-wider text-muted uppercase">Dados</span>
      {data ? (
        <div className="flex h-8 items-center gap-1.5" aria-label="Arquivo de dados">
          <Badge tone="info" title={`Colunas: ${data.columns.join(', ')}`}>
            <FileSpreadsheet size={12} aria-hidden /> {data.name} · {data.rows.length} {data.rows.length === 1 ? 'iteração' : 'iterações'}
          </Badge>
          <IconButton label="Rodar sem o arquivo de dados" disabled={props.disabled} onClick={props.onClear}>
            <X size={13} aria-hidden />
          </IconButton>
        </div>
      ) : (
        <Button
          icon={<FileSpreadsheet size={14} aria-hidden />}
          disabled={props.disabled}
          onClick={props.onPick}
          title="CSV com cabeçalho ou JSON: cada linha vira uma iteração, com as colunas em {{coluna}}"
        >
          Arquivo de dados…
        </Button>
      )}
    </div>
  )
}

/** As iterações da célula: cada uma com o resultado; escolher troca o detalhe abaixo. */
function IterationPicker(props: { results: ScenarioResult[]; current?: number; onPick: (n: number) => void }) {
  return (
    <InspectorSection title="Iterações" count={props.results.length}>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Iterações do arquivo de dados">
        {props.results.map((r) => (
          <button
            key={r.iteration}
            type="button"
            aria-pressed={r.iteration === props.current}
            title={r.outcome === 'passed' ? `Linha ${r.iteration}: passou` : `Linha ${r.iteration}: ${r.outcome === 'failed' ? 'falhou' : 'erro'}`}
            onClick={() => r.iteration !== undefined && props.onPick(r.iteration)}
            className={cx(
              'h-6 min-w-8 rounded-[var(--radius-control)] border px-1.5 font-mono text-[11px]',
              r.outcome === 'passed' ? 'border-success/40 text-success' : 'border-danger/40 text-danger',
              r.iteration === props.current && 'bg-accent/15 text-fg'
            )}
          >
            #{r.iteration}
          </button>
        ))}
      </div>
    </InspectorSection>
  )
}

function EndpointButton(props: {
  active: boolean
  onClick: () => void
  menu?: ReturnType<ReturnType<typeof useContextMenu>['bind']>
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      {...props.menu}
      aria-current={props.active ? 'true' : undefined}
      className={cx(
        'flex items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-left',
        props.active ? 'bg-accent/15 text-fg' : 'text-muted hover:bg-elevated hover:text-fg'
      )}
    >
      {props.children}
    </button>
  )
}

function RunSummary(props: { report: ScenarioRunReport; totals: ScenarioRunReport['totals']; running: boolean }) {
  const { report, running } = props
  if (report.error) return <div className="text-xs text-danger">{report.error}</div>
  return (
    <OutcomeTotals {...props.totals} dim={running}>
      <span className="text-muted" title="Duração do último disparo">
        último disparo: {report.results.length} em {formatMs(report.durationMs)}
      </span>
      {report.canceled && <Badge tone="warning">cancelado</Badge>}
    </OutcomeTotals>
  )
}

/** Vários lotes do mesmo conector (um por ambiente no runner) num só relatório para a matriz. */
function mergeReports(reports: ScenarioRunReport[]): ScenarioRunReport {
  const totals = { passed: 0, failed: 0, error: 0 }
  for (const r of reports) {
    totals.passed += r.totals.passed
    totals.failed += r.totals.failed
    totals.error += r.totals.error
  }
  const errors = reports.map((r) => r.error).filter(Boolean)
  return {
    ...reports[0]!,
    durationMs: reports.reduce((n, r) => n + r.durationMs, 0),
    results: reports.flatMap((r) => r.results),
    totals,
    canceled: reports.some((r) => r.canceled),
    ...(errors.length ? { error: errors.join('; ') } : {})
  }
}

function cellText(r: ScenarioResult): string {
  if (r.outcome === 'passed') return String(r.status ?? '')
  if (r.outcome === 'failed') return `${r.assertions.filter((a) => !a.passed).length}/${r.assertions.length}`
  return FAILURE_SHORT[failureKind(r.error?.code)]
}

/** Célula com iterações: quantas passaram de quantas. */
function iterationsText(list: ScenarioResult[]): string {
  return `${list.filter((r) => r.outcome === 'passed').length}/${list.length}`
}

function iterationsTitle(list: ScenarioResult[]): string {
  const failing = list.filter((r) => r.outcome !== 'passed').map((r) => `#${r.iteration}`)
  return failing.length
    ? `${failing.length} de ${list.length} iterações não passaram: ${failing.slice(0, 10).join(', ')}${failing.length > 10 ? '…' : ''}`
    : `${list.length} iterações passaram`
}

/** Dica da célula: tempo e status, ou o tipo de falha e o código. */
function cellTitle(r: ScenarioResult): string {
  const timing = `${formatMs(r.durationMs)}${r.status ? ` · HTTP ${r.status}` : ''}`
  if (r.outcome === 'error') return `${FAILURE_LABEL[failureKind(r.error?.code)]}: ${r.error?.code ?? 'erro'} · ${timing}`
  if (r.outcome === 'failed') return `${FAILURE_LABEL.assertion} · ${timing}`
  return timing
}

function ResultDetail(props: {
  result: ScenarioResult
  scenario?: CatalogScenario
  environment: string
  onOpenInQuick?: () => void
  onOpenEndpoint?: () => void
  onEdit?: () => void
  onClose: () => void
}) {
  const { result } = props
  const failures = result.assertions.filter((a) => !a.passed)
  const first = failures[0]
  const kind = result.outcome === 'passed' ? null : result.outcome === 'failed' ? 'assertion' : failureKind(result.error?.code)
  const showBody = () =>
    document.getElementById('scenario-response-body')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  const hasBody = result.bodyPreview !== undefined && result.bodyPreview !== ''
  return (
    <section aria-label="Detalhe do cenário">
      <InspectorSection
        title={props.scenario?.name ?? result.scenarioId}
        actions={
          props.onOpenInQuick && (
            <Button
              size="sm"
              variant="ghost"
              onClick={props.onOpenInQuick}
              title="Abrir numa aba nova do Quick Request, no mesmo conector e ambiente"
            >
              Abrir no Quick Request
            </Button>
          )
        }
      >
        {kind && (
          <div className="mb-2 flex flex-wrap items-center gap-2" aria-label="Tipo de falha">
            <Badge tone={kind === 'policy' ? 'info' : kind === 'config' ? 'warning' : kind === 'canceled' ? 'neutral' : 'danger'}>
              {FAILURE_LABEL[kind]}
            </Badge>
            {kind === 'assertion' && (
              <span className="text-xs text-muted">
                {failures.length} de {result.assertions.length} {result.assertions.length === 1 ? 'asserção falhou' : 'asserções falharam'}
              </span>
            )}
          </div>
        )}
        {first && (
          <FailedAssertion
            label={describeAssertion(first)}
            expected={first.expected}
            actual={first.actual}
            message={first.message}
            showExpected={first.operator !== 'exists' && first.operator !== 'notExists' && first.operator !== 'matchesExample'}
          />
        )}
        <div className="my-2 flex flex-wrap gap-1.5" aria-label="Ações do cenário">
          {props.onOpenEndpoint && (
            <Button size="sm" variant="ghost" icon={<Network size={13} aria-hidden />} onClick={props.onOpenEndpoint}>
              Abrir endpoint
            </Button>
          )}
          {hasBody && (
            <Button size="sm" variant="ghost" icon={<FileSearch size={13} aria-hidden />} onClick={showBody}>
              Inspecionar resposta
            </Button>
          )}
          {props.onEdit && (
            <Button size="sm" variant="ghost" icon={<Pencil size={13} aria-hidden />} onClick={props.onEdit}>
              Editar cenário
            </Button>
          )}
        </div>
        <Field label="Ambiente">{props.environment}</Field>
        <Field label="Requisição">
          <span className="inline-flex min-w-0 items-center gap-2">
            <MethodBadge method={result.request.method} />
            <span className="truncate font-mono">{result.request.url}</span>
          </span>
        </Field>
        <Field label="Status">
          {result.status !== undefined ? (
            <Badge tone={statusTone(result.status)} mono>
              HTTP {result.status}
            </Badge>
          ) : (
            '—'
          )}
        </Field>
        <Field label="Duração">
          <span className="font-mono">{formatMs(result.durationMs)}</span>
        </Field>
        {result.error && (
          <ErrorNotice
            compact
            className="mt-2"
            title="O cenário não rodou"
            code={result.error.code}
            message={result.error.message}
            location={props.environment || undefined}
          />
        )}
      </InspectorSection>
      {result.assertions.length > 0 && (
        <InspectorSection title="Asserções" count={result.assertions.length}>
          {/* Com uma falha em destaque, o resto fica a um clique. */}
          <Collapsible
            label={first ? `Ver todas as ${result.assertions.length} asserções` : `${result.assertions.length} asserções`}
            defaultOpen={!first}
          >
            <AssertionList
              rows={result.assertions.map((a) => ({ passed: a.passed, label: describeAssertion(a), message: a.message }))}
            />
          </Collapsible>
        </InspectorSection>
      )}
      {hasBody && (
        <InspectorSection title="Corpo da resposta" id="scenario-response-body">
          <div className="-mx-3 flex h-56 border-y border-border-subtle">
            <CodeEditor
              ariaLabel="Corpo da resposta do cenário"
              value={formatJson(result.bodyPreview ?? '')}
              language="json"
            />
          </div>
        </InspectorSection>
      )}
      <div className="p-3">
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Fechar detalhe
        </Button>
      </div>
    </section>
  )
}

function Overrides({ scenario }: { scenario: CatalogScenario }) {
  const o = scenario.overrides
  if (!o) return <span>sem overrides</span>
  const parts: string[] = []
  if (o.pathParams) parts.push(...Object.entries(o.pathParams).map(([k, v]) => `{${k}} = ${v}`))
  if (o.query) parts.push(...Object.entries(o.query).map(([k, v]) => (v === null ? `−?${k}` : `?${k}=${v}`)))
  if (o.headers === null) parts.push('sem headers herdados')
  else if (o.headers) parts.push(...Object.entries(o.headers).map(([k, v]) => (v === null ? `−${k}` : `${k}: ${v}`)))
  if ('body' in o) parts.push(o.body === null ? 'sem corpo' : `body ${compact(o.body)}`)
  return (
    <>
      {parts.map((p, i) => (
        <div key={i} className="max-w-48 truncate" title={p}>
          {p}
        </div>
      ))}
    </>
  )
}

const OPERATOR: Record<string, string> = {
  equals: '==',
  notEquals: '!=',
  lessThan: '<',
  lessThanOrEqual: '<=',
  greaterThan: '>',
  greaterThanOrEqual: '>=',
  contains: 'contém',
  matches: '~',
  exists: 'existe',
  notExists: 'não existe',
  matchesSchema: 'segue schema',
  matchesExample: 'segue o schema do exemplo'
}

function describeAssertion(a: { target: string; operator: string; expected?: unknown }): string {
  const op = OPERATOR[a.operator] ?? a.operator
  if (a.operator === 'exists' || a.operator === 'notExists' || a.operator === 'matchesSchema' || a.operator === 'matchesExample')
    return `${a.target} ${op}`
  return `${a.target} ${op} ${compact(a.expected)}`
}

function compact(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value))
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

/**
 * Cenário como requisição editável do Quick Request: a URL já montada (path params e
 * query), os headers do endpoint com os overrides e o corpo do cenário, no mesmo conector e
 * ambiente. Os {{VAR}} ficam para o envio, como no cenário.
 */
function scenarioAsRequest(
  connectorId: string,
  result: ScenarioResult,
  endpoint: CatalogConnector['endpoints'][number] | undefined,
  scenario: CatalogScenario | undefined
): OpenRequest {
  const overrides = scenario?.overrides ?? {}
  let headers = overrides.headers === null ? [] : [...(endpoint?.headers ?? [])]
  for (const [name, value] of Object.entries(overrides.headers ?? {})) {
    headers = headers.filter((h) => h.name.toLowerCase() !== name.toLowerCase())
    if (value !== null) headers.push({ name, value })
  }
  const body =
    'body' in overrides
      ? overrides.body === null || overrides.body === undefined
        ? ''
        : typeof overrides.body === 'string'
          ? overrides.body
          : JSON.stringify(overrides.body, null, 2)
      : (endpoint?.body ?? '')
  return {
    method: result.request.method,
    url: result.request.url,
    headers,
    body,
    connectorId,
    environmentId: result.environmentId || null
  }
}
