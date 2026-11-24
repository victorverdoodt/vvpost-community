import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useDiskChange } from '../../lib/disk-changes'
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type {
  CatalogConnector,
  Flow,
  FlowCatalog,
  FlowEdge,
  FlowNode,
  FlowNodeResult,
  FlowNodeStatus,
  FlowRunReport,
  PluginCatalog,
  PluginContribution,
  WorkspaceResult
} from '@shared/ipc'
import { useWorkspace } from '../../panels/useWorkspace'
import { DataPicker } from './DataPicker'
import { EndpointPalette } from './EndpointPalette'
import { HandleBoundsGuard } from './HandleBoundsGuard'
import { BaseSettings, Inspector } from './Inspector'
import {
  ancestorsOf,
  autoLayout,
  highImpactOperations,
  requestFromNode,
  duplicateNode,
  subflowUntil,
  contributionKey,
  createsCycle,
  edgeKey,
  flowIdFor,
  newNode,
  NODE_LABELS,
  newPluginNode,
  newEndpointNode,
  parseEndpointDrag,
  ENDPOINT_DRAG_TYPE,
  pluginKeyOf,
  type KnownOutputs
} from './model'
import { nodeTypes, type CanvasNode } from './nodes'
import { PickTargetContext, type PickTarget } from './TemplateInput'
import {
  EmptyState,
  ExecutionToolbar,
  InspectorPanel,
  buttonClass as buttonClassFor,
  controlClass,
  describeError,
  matchesShortcut,
  menuHeader,
  PanelActiveContext,
  SegmentedControl,
  separator,
  Shortcut,
  useContextMenu,
  useMenuCommands,
  usePromptDialog,
  useToast,
  type ContextMenuEntries
} from '../../design-system'
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Braces,
  CopyPlus,
  FolderOpen,
  Maximize,
  Pencil,
  Play,
  Plus,
  Save,
  Send,
  StepForward,
  Trash2,
  Unlink,
  Workflow
} from 'lucide-react'
import { useNavigation } from '../../lib/navigate'
import { useTabSource } from '../../lib/shell-tabs'
import { timedRun } from '../../lib/perf'
import { openInQuickRequest } from '../../lib/open-request'
import { openFlowAsRequest } from '../../lib/flow-view'
import { flowToRequest } from '@vvpost/core/flows/simple-flow'
import { confirmProtected } from '../../lib/protected'

const icon = { size: 14, 'aria-hidden': true } as const

const selectClass = `max-w-56 ${controlClass}`
const buttonClass = buttonClassFor('secondary', 'sm')

interface Draft {
  file?: string
  flow: Flow
  /** JSON do que está no disco, para saber se há mudança a salvar. */
  saved: string
  /** Versão do arquivo de quando a aba abriu: salvar recusa se alguém (a IA) gravou no meio. */
  version?: string | null
}

const serialize = (flow: Flow) => JSON.stringify(flow)

/** Troca $nodes.Antigo (e nodes['Antigo'] no Python, nodes.Antigo no JavaScript) por Novo em todos os nós. */
function renameReferences(flow: Flow, from: string, to: string): Flow {
  const ref = new RegExp(`\\$nodes\\.${from}(?![A-Za-z0-9_])`, 'g')
  const py = new RegExp(`nodes\\[(["'])${from}\\1\\]`, 'g')
  const js = new RegExp(`(?<![$\\w.])nodes\\.${from}(?![A-Za-z0-9_])`, 'g')
  const swap = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value
        .replace(ref, `$nodes.${to}`)
        .replace(py, (_, q: string) => `nodes[${q}${to}${q}]`)
        .replace(js, `nodes.${to}`)
    }
    if (Array.isArray(value)) return value.map(swap)
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)]))
    return value
  }
  return { ...flow, nodes: flow.nodes.map((n) => swap(n.name === from ? { ...n, name: to } : n) as FlowNode) }
}

/**
 * Flow Studio: canvas React Flow (carregado só quando a aba abre) sobre
 * os arquivos *.flow.vvpost.json do workspace. O fluxo roda no main process pelo
 * Context Engine; o canvas mostra o estado de cada nó e o inspetor edita o nó
 * selecionado, com autocomplete de {{ $nodes... }} e o Visual Data Picker.
 */
export default function FlowStudioModule() {
  const ws = useWorkspace()
  // Bases dos outros projetos ("<projeto>:<id>"), oferecidas no conector de um nó e no extends da base.
  const [projectBases, setProjectBases] = useState<CatalogConnector[]>([])
  useEffect(() => {
    if (!ws.workspace) return
    void window.vvpost.getProjectBases().then((r) => setProjectBases(r.ok ? r.value : []))
  }, [ws.workspace])
  const connectors = useMemo(() => {
    const own = ws.workspace?.connectors ?? []
    const ids = new Set(own.map((c) => c.id))
    return [...own, ...projectBases.filter((c) => !ids.has(c.id))]
  }, [ws.workspace, projectBases])
  const [catalog, setCatalog] = useState<WorkspaceResult<FlowCatalog | null> | null>(null)
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(new Map())
  const [currentId, setCurrentId] = useState<string | null>(null)
  /** Fluxos abertos em abas, na ordem em que foram abertos; o rascunho de uma aba fechada continua na memória. */
  const [openIds, setOpenIds] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [rfNodes, setRfNodes] = useState<CanvasNode[]>([])
  const [statuses, setStatuses] = useState<ReadonlyMap<string, { status: FlowNodeStatus; result?: FlowNodeResult }>>(
    new Map()
  )
  const [report, setReport] = useState<FlowRunReport | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)
  const [creating, setCreating] = useState<string | null>(null)
  const [target, setTarget] = useState<PickTarget | null>(null)
  const runIdRef = useRef<string | null>(null)
  const [plugins, setPlugins] = useState<PluginCatalog | null>(null)
  const ctx = useContextMenu()
  const dialog = usePromptDialog()
  const toast = useToast()
  const canvas = useRef<ReactFlowInstance<CanvasNode, Edge> | null>(null)

  // "Abrir no Flow Studio" (Git, histórico): troca para o fluxo pedido.
  // Com `flow` (scripts de uma requisição), abre um rascunho novo, que só vai para o disco se for salvo.
  useNavigation('flows', (t) => {
    let id = t.flowId
    if (t.flow && t.file) {
      // A visão Simples passando ao canvas com mudança não salva: o rascunho do arquivo leva a mudança.
      const { flow: changed, file } = t
      id = changed.id
      setDrafts((prev) => new Map(prev).set(id, { file, flow: changed, saved: prev.get(id)?.saved ?? '' }))
      setStatuses(new Map())
      setReport(null)
    } else if (t.flow) {
      id = flowIdFor(t.flow.name, new Set(drafts.keys()))
      const flow = { ...t.flow, id }
      setDrafts((prev) => new Map(prev).set(id, { flow, saved: '' }))
      setStatuses(new Map())
      setReport(null)
    }
    setCurrentId(id)
    setSelectedId(null)
  })

  // Tipos de nó e adapters dos plugins ligados (Extensions Hub); relidos quando a janela volta ao foco.
  const loadPlugins = useCallback(() => void window.vvpost.listPlugins().then((r) => r.ok && setPlugins(r.value)), [])
  useEffect(() => {
    loadPlugins()
    window.addEventListener('focus', loadPlugins)
    return () => window.removeEventListener('focus', loadPlugins)
  }, [loadPlugins])
  const contributions = useMemo(() => {
    const map = new Map<string, PluginContribution & { pluginName: string }>()
    for (const p of plugins?.plugins ?? []) {
      if (!p.enabled || p.error) continue
      for (const c of p.contributions) map.set(contributionKey(c.kind, c.name), { ...c, pluginName: p.name })
    }
    return map
  }, [plugins])

  const reloadFlows = useCallback(() => {
    void window.vvpost.listFlows().then((result) => {
      setCatalog(result)
      if (!result.ok || !result.value) return
      // Arquivos relidos do disco viram rascunhos; um rascunho com mudanças não salvas é mantido.
      setDrafts((prev) => {
        const next = new Map(prev)
        for (const { file, flow, version } of result.value!.flows) {
          const old = next.get(flow.id)
          const laid = autoLayout(flow)
          if (!old || serialize(old.flow) === old.saved) next.set(flow.id, { file, flow: laid, saved: serialize(laid), version })
          // Rascunho que chegou da visão Simples antes de o arquivo ser lido: fica a mudança, e o disco vira o salvo.
          else if (old.saved === '' && old.file === file) next.set(flow.id, { ...old, saved: serialize(laid), version })
          else next.set(flow.id, { ...old, file })
        }
        return next
      })
      setCurrentId((id) => id ?? result.value!.flows[0]?.flow.id ?? null)
    })
  }, [])

  useEffect(() => {
    reloadFlows()
  }, [reloadFlows, ws.workspace?.dir])
  // Um fluxo gravado fora do app (um agente pelo MCP, o CLI): as abas sem mudanças releem; com
  // mudanças, ficam como estão e Salvar avisa que o arquivo mudou.
  useDiskChange((f) => f.endsWith('.flow.vvpost.json'), reloadFlows)

  // Eventos de progresso da execução: cada nó acende no canvas enquanto roda.
  useEffect(
    () =>
      window.vvpost.onFlowEvent((event) => {
        if (event.runId !== runIdRef.current) return
        setStatuses((prev) =>
          new Map(prev).set(
            event.nodeId,
            'result' in event ? { status: event.status, result: event.result } : { status: event.status }
          )
        )
      }),
    []
  )

  // O fluxo que fica ativo (lista, Abrir no Flow Studio, novo fluxo) ganha uma aba.
  useEffect(() => {
    if (currentId) setOpenIds((ids) => (ids.includes(currentId) ? ids : [...ids, currentId]))
  }, [currentId])

  const draft = currentId ? drafts.get(currentId) : undefined
  const flow = draft?.flow
  const dirty = !!draft && serialize(draft.flow) !== draft.saved

  const updateFlow = useCallback(
    (fn: (flow: Flow) => Flow) => {
      if (!currentId) return
      setDrafts((prev) => {
        const d = prev.get(currentId)
        return d ? new Map(prev).set(currentId, { ...d, flow: fn(d.flow) }) : prev
      })
    },
    [currentId]
  )
  const updateNode = useCallback(
    (id: string, fn: (node: FlowNode) => FlowNode) =>
      updateFlow((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === id ? fn(n) : n)) })),
    [updateFlow]
  )

  // Nós do React Flow espelham o fluxo; posição e medidas ficam no estado do canvas.
  useEffect(() => {
    if (!flow) return setRfNodes([])
    setRfNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]))
      return flow.nodes.map((node): CanvasNode => {
        const state = statuses.get(node.id)
        const before = old.get(node.id)
        const note = state?.result?.error?.message ?? state?.result?.reason
        const pluginTitle = node.type === 'plugin' ? contributions.get(pluginKeyOf(node))?.title : undefined
        const target =
          node.type === 'request' && node.request.endpoint
            ? connectors
                .find((c) => c.id === node.request.connector)
                ?.endpoints.find((e) => e.id === node.request.endpoint)
            : undefined
        const endpointLabel = target && node.type === 'request' && `${node.request.method ?? target.method} ${target.name}`
        return {
          ...before,
          id: node.id,
          type: node.type,
          position: before?.dragging ? before.position : (node.position ?? { x: 0, y: 0 }),
          selected: node.id === selectedId,
          data: {
            node,
            ...(state && { status: state.status }),
            ...(state?.result && { durationMs: state.result.durationMs }),
            ...(note && { note }),
            ...(pluginTitle && { pluginTitle }),
            ...(endpointLabel && { endpointLabel })
          }
        }
      })
    })
  }, [flow, statuses, selectedId, contributions, connectors])

  const edges = useMemo<Edge[]>(
    () =>
      (flow?.edges ?? []).map((e) => {
        const source = statuses.get(e.from)?.result
        const taken =
          source?.status === 'success' &&
          (e.branch === undefined ||
            String((source.output?.data as { result?: boolean })?.result === true) === e.branch)
        return {
          id: edgeKey(e),
          source: e.from,
          target: e.to,
          ...(e.branch && { sourceHandle: e.branch, label: e.branch === 'true' ? 'sim' : 'não' }),
          animated: statuses.get(e.to)?.status === 'running',
          markerEnd: { type: MarkerType.ArrowClosed },
          style: taken ? { stroke: '#6d8cff', strokeWidth: 2 } : undefined
        }
      }),
    [flow?.edges, statuses]
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      setRfNodes((prev) => applyNodeChanges(changes, prev))
      for (const c of changes) {
        if (c.type === 'position' && c.position && !c.dragging) {
          const position = { x: Math.round(c.position.x), y: Math.round(c.position.y) }
          updateNode(c.id, (n) => ({ ...n, position }))
        } else if (c.type === 'select' && c.selected) {
          setSelectedId(c.id)
        } else if (c.type === 'remove') {
          updateFlow((f) => ({
            ...f,
            nodes: f.nodes.filter((n) => n.id !== c.id),
            edges: (f.edges ?? []).filter((e) => e.from !== c.id && e.to !== c.id)
          }))
          setSelectedId((id) => (id === c.id ? null : id))
        }
      }
    },
    [updateFlow, updateNode]
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id))
      if (removed.size) updateFlow((f) => ({ ...f, edges: (f.edges ?? []).filter((e) => !removed.has(edgeKey(e))) }))
    },
    [updateFlow]
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (!flow || !c.source || !c.target) return
      if (createsCycle(flow, c.source, c.target)) {
        setMessage({ kind: 'error', text: 'Essa ligação criaria um ciclo: o fluxo roda em ordem, sem voltar.' })
        return
      }
      const source = flow.nodes.find((n) => n.id === c.source)
      const edge: FlowEdge = {
        from: c.source,
        to: c.target,
        ...(source?.type === 'condition' && { branch: c.sourceHandle === 'false' ? 'false' : 'true' })
      }
      if ((flow.edges ?? []).some((e) => edgeKey(e) === edgeKey(edge))) return
      updateFlow((f) => ({ ...f, edges: [...(f.edges ?? []), edge] }))
    },
    [flow, updateFlow]
  )

  const addNode = (
    make: (flow: Flow, position: { x: number; y: number }) => FlowNode,
    at?: { x: number; y: number }
  ) => {
    if (!flow) return
    if (at) {
      // Pelo menu do canvas: no ponto do clique, sem ligação automática.
      const node = make(flow, { x: Math.round(at.x), y: Math.round(at.y) })
      updateFlow((f) => ({ ...f, nodes: [...f.nodes, node] }))
      setSelectedId(node.id)
      return
    }
    const selected = flow.nodes.find((n) => n.id === selectedId)
    const lowest = Math.max(-140, ...flow.nodes.map((n) => n.position?.y ?? 0))
    const position = selected?.position
      ? { x: selected.position.x + 280, y: selected.position.y }
      : { x: 0, y: flow.nodes.length ? lowest + 140 : 0 }
    const node = make(flow, position)
    // Com um nó selecionado, o novo nó já sai ligado a ele (no ramo "sim" de uma condição).
    const edge: FlowEdge | null = selected
      ? { from: selected.id, to: node.id, ...(selected.type === 'condition' && { branch: 'true' as const }) }
      : null
    updateFlow((f) => ({ ...f, nodes: [...f.nodes, node], edges: edge ? [...(f.edges ?? []), edge] : f.edges }))
    setSelectedId(node.id)
  }

  const createFlow = () => {
    const name = creating?.trim()
    if (!name) return
    const taken = new Set(drafts.keys())
    const id = flowIdFor(name, taken)
    const fresh: Flow = { id, name, nodes: [], edges: [] }
    setDrafts((prev) => new Map(prev).set(id, { flow: fresh, saved: '' }))
    setCurrentId(id)
    setSelectedId(null)
    setCreating(null)
    setStatuses(new Map())
    setReport(null)
  }

  const save = async () => {
    if (!draft) return
    const result = await window.vvpost.saveFlow(draft.flow, draft.file, draft.file ? draft.version : undefined)
    if (!result.ok) return setMessage({ kind: 'error', text: result.message })
    setDrafts((prev) =>
      new Map(prev).set(draft.flow.id, { file: result.value.file, flow: draft.flow, saved: serialize(draft.flow), version: result.value.version })
    )
    setMessage({ kind: 'info', text: `Salvo em ${result.value.file}` })
    reloadFlows()
  }

  const run = async (until?: string) => {
    if (!flow || runId) return
    const target = until ? subflowUntil(flow, until) : flow
    // Confirmação antes de operações de impacto elevado: o que cada nó faz e onde.
    const env = ws.workspace?.environments.find((e) => e.id === ws.selection.environmentId)
    const risky = highImpactOperations(target, connectors, env)
    if (risky.length) {
      const ok = await dialog.confirm({
        title: `Rodar ${risky.length === 1 ? 'uma operação' : `${risky.length} operações`} de impacto elevado?`,
        message: `${risky.map((r) => `${r.name}: ${r.reason}`).join('. ')}. ${env ? `Ambiente ${env.name}.` : 'Sem ambiente.'}`,
        confirmLabel: 'Rodar mesmo assim',
        danger: true
      })
      if (!ok) return setMessage({ kind: 'info', text: 'Execução cancelada antes de começar.' })
    } else if (!(await confirmProtected(dialog.confirm, [env], 'Rodar o fluxo')))
      return setMessage({ kind: 'info', text: 'Execução cancelada antes de começar.' })
    const id = crypto.randomUUID()
    runIdRef.current = id
    setRunId(id)
    setStatuses(new Map())
    setReport(null)
    setMessage(null)
    // Um plugin ligado ou desligado no Extensions Hub aparece no canvas a cada execução.
    loadPlugins()
    try {
      const outcome = await timedRun('flows', () =>
        window.vvpost.runFlow({
          runId: id,
          flow: target,
          environmentId: ws.selection.environmentId
        })
      )
      setReport(outcome)
      // O relatório é a palavra final (eventos podem chegar depois do retorno).
      setStatuses(new Map(outcome.results.map((r) => [r.nodeId, { status: r.status, result: r }])))
      if (outcome.error) setMessage({ kind: 'error', text: outcome.error })
      else if (until) {
        const name = flow.nodes.find((n) => n.id === until)?.name
        setMessage({ kind: 'info', text: `Executado até ${name}: ${target.nodes.length} de ${flow.nodes.length} nós.` })
      }
    } finally {
      setRunId(null)
    }
  }

  const switchFlow = (id: string | null) => {
    if (id === currentId) return
    setCurrentId(id)
    setSelectedId(null)
    setStatuses(new Map())
    setReport(null)
  }

  const closeFlowTab = (id: string) => {
    const open = openIds.filter((x) => drafts.has(x))
    const rest = open.filter((x) => x !== id)
    setOpenIds(rest)
    if (id === currentId) switchFlow(rest[Math.max(0, open.indexOf(id) - 1)] ?? null)
  }

  const removeNode = (nodeId: string) => {
    updateFlow((f) => ({
      ...f,
      nodes: f.nodes.filter((n) => n.id !== nodeId),
      edges: (f.edges ?? []).filter((e) => e.from !== nodeId && e.to !== nodeId)
    }))
    setSelectedId((id) => (id === nodeId ? null : id))
  }

  /** Renomear pelo menu: seleciona o nó e põe o foco no campo Nome do inspector. */
  const focusName = (nodeId: string) => {
    setSelectedId(nodeId)
    setTimeout(() => {
      const field = document.querySelector<HTMLInputElement>('input[aria-label="Nome do nó"]')
      field?.focus()
      field?.select()
    }, 50)
  }

  /** O nó vira uma aba do Quick Request com os $nodes da última execução já preenchidos. */
  const openNodeInQuick = (node: Extract<FlowNode, { type: 'request' }>) => {
    const { request, missing } = requestFromNode(node, connectors, outputs)
    openInQuickRequest({ ...request, environmentId: ws.selection.environmentId || null }, 'flow')
    if (missing.length)
      toast(
        `Sem valor da última execução para ${missing.join(', ')}: rode o fluxo até este nó para preencher.`,
        'warning'
      )
  }

  const nodeEntries = (node: FlowNode): ContextMenuEntries => {
    const linked = (flow?.edges ?? []).some((e) => e.from === node.id || e.to === node.id)
    return [
      {
        id: 'run-until',
        label: 'Executar até aqui',
        icon: <StepForward {...icon} />,
        disabled: !!runId,
        run: () => void run(node.id)
      },
      node.type === 'request' && {
        id: 'open-in-quick',
        label: 'Abrir no Quick Request',
        icon: <Send {...icon} />,
        run: () => openNodeInQuick(node)
      },
      separator,
      {
        id: 'duplicate',
        label: 'Duplicar',
        icon: <CopyPlus {...icon} />,
        shortcut: Shortcut.duplicate,
        run: () => {
          if (!flow) return
          const copy = duplicateNode(flow, node)
          updateFlow((f) => ({ ...f, nodes: [...f.nodes, copy] }))
          setSelectedId(copy.id)
        }
      },
      {
        id: 'rename',
        label: 'Renomear',
        icon: <Pencil {...icon} />,
        shortcut: Shortcut.rename,
        run: () => focusName(node.id)
      },
      {
        id: 'copy-ref',
        label: `Copiar referência $nodes.${node.name}`,
        icon: <Braces {...icon} />,
        shortcut: Shortcut.copy,
        run: () =>
          void navigator.clipboard
            .writeText(`{{ $nodes.${node.name} }}`)
            .then(() => toast(`{{ $nodes.${node.name} }} na área de transferência.`, 'success'))
      },
      {
        id: 'unlink',
        label: 'Desconectar',
        icon: <Unlink {...icon} />,
        disabled: !linked,
        run: () =>
          updateFlow((f) => ({ ...f, edges: (f.edges ?? []).filter((e) => e.from !== node.id && e.to !== node.id) }))
      },
      separator,
      {
        id: 'delete',
        label: 'Excluir…',
        icon: <Trash2 {...icon} />,
        shortcut: Shortcut.remove,
        danger: true,
        run: async () => {
          const links = (flow?.edges ?? []).filter((e) => e.from === node.id || e.to === node.id).length
          const ok = await dialog.confirm({
            title: `Excluir o nó ${node.name ?? node.id}?`,
            message: links
              ? `As ${links} ligações dele vão junto. Até salvar, recarregar o fluxo desfaz.`
              : 'Até salvar, recarregar o fluxo desfaz.',
            confirmLabel: 'Excluir',
            danger: true
          })
          if (ok) removeNode(node.id)
        }
      }
    ]
  }

  const edgeEntries = (edge: FlowEdge): ContextMenuEntries => [
    {
      id: 'select-source',
      label: 'Selecionar a origem',
      icon: <ArrowLeftToLine {...icon} />,
      run: () => setSelectedId(edge.from)
    },
    {
      id: 'select-target',
      label: 'Selecionar o destino',
      icon: <ArrowRightToLine {...icon} />,
      run: () => setSelectedId(edge.to)
    },
    separator,
    {
      id: 'delete',
      label: 'Excluir a ligação',
      icon: <Trash2 {...icon} />,
      shortcut: Shortcut.remove,
      danger: true,
      run: () => updateFlow((f) => ({ ...f, edges: (f.edges ?? []).filter((e) => edgeKey(e) !== edgeKey(edge)) }))
    }
  ]

  const addNodeItems = (at?: { x: number; y: number }): ContextMenuEntries => [
    ...(['request', 'condition', 'wait', 'webhook', 'python'] as const).map((type) => ({
      id: `add-${type}`,
      label: NODE_LABELS[type],
      run: () => addNode((f, pos) => newNode(f, type, pos), at)
    })),
    contributions.size > 0 && separator,
    ...[...contributions].map(([key, c]) => ({
      id: `add-${key}`,
      label: `${c.title} (${c.kind === 'adapter' ? `adapter ${c.name}` : c.pluginName})`,
      run: () => addNode((f, pos) => newPluginNode(f, c, pos), at)
    }))
  ]

  const flowEntries = (at?: { x: number; y: number }): ContextMenuEntries => {
    if (!flow || !draft) return []
    const taken = new Set(drafts.keys())
    return [
      menuHeader(flow.name),
      {
        id: 'add',
        label: at ? 'Adicionar nó aqui' : 'Adicionar nó',
        icon: <Plus {...icon} />,
        items: addNodeItems(at)
      },
      {
        id: 'fit',
        label: 'Ajustar à tela',
        icon: <Maximize {...icon} />,
        run: () => void canvas.current?.fitView({ maxZoom: 1 })
      },
      separator,
      {
        id: 'run',
        label: 'Executar o fluxo',
        icon: <Play {...icon} />,
        hint: 'Ctrl+Enter',
        disabled: !!runId || !flow.nodes.length,
        run: () => void run()
      },
      {
        id: 'save',
        label: dirty ? 'Salvar' : 'Salvo',
        icon: <Save {...icon} />,
        disabled: !dirty,
        run: () => void save()
      },
      separator,
      {
        id: 'rename-flow',
        label: 'Renomear o fluxo…',
        icon: <Pencil {...icon} />,
        run: async () => {
          const name = await dialog.prompt({ title: 'Renomear o fluxo', label: 'Nome', initial: flow.name })
          if (name && name !== flow.name) updateFlow((f) => ({ ...f, name }))
        }
      },
      {
        id: 'duplicate-flow',
        label: 'Duplicar o fluxo',
        icon: <CopyPlus {...icon} />,
        run: async () => {
          const name = `${flow.name} (cópia)`
          const copy: Flow = { ...structuredClone(flow), id: flowIdFor(name, taken), name }
          const r = await window.vvpost.saveFlow(copy)
          if (!r.ok) return toast(r.message, 'danger')
          setDrafts((prev) => new Map(prev).set(copy.id, { file: r.value.file, flow: copy, saved: serialize(copy) }))
          setCurrentId(copy.id)
          setSelectedId(null)
          toast(`Fluxo duplicado em ${r.value.file}.`, 'success')
        }
      },
      {
        id: 'reveal',
        label: 'Revelar o arquivo',
        icon: <FolderOpen {...icon} />,
        shortcut: Shortcut.reveal,
        disabled: !draft.file,
        run: () =>
          void window.vvpost
            .revealInFolder({ workspacePath: draft.file! })
            .then((r) => !r.ok && toast(r.message, 'danger'))
      },
      {
        id: 'delete-flow',
        label: 'Excluir o fluxo…',
        icon: <Trash2 {...icon} />,
        danger: true,
        run: async () => {
          const ok = await dialog.confirm({
            title: `Excluir o fluxo ${flow.name}?`,
            message: draft.file ? `O arquivo ${draft.file} é apagado do workspace.` : 'O fluxo ainda não foi salvo.',
            confirmLabel: 'Excluir',
            danger: true
          })
          if (!ok) return
          if (draft.file) {
            const r = await window.vvpost.editProject([{ op: 'deleteFlow', id: flow.id }])
            if (!r.ok) return toast(r.message, 'danger')
          }
          setDrafts((prev) => {
            const next = new Map(prev)
            next.delete(flow.id)
            return next
          })
          setCurrentId([...drafts.keys()].find((id) => id !== flow.id) ?? null)
          setSelectedId(null)
          toast(`Fluxo ${flow.name} excluído.`, 'success')
        }
      }
    ]
  }

  const selectedNode = flow?.nodes.find((n) => n.id === selectedId)
  // Na paleta: as ações do fluxo e as do nó selecionado (Ctrl+D duplica o nó com o canvas focado).
  useMenuCommands('Flow Studio', [
    ...flowEntries(),
    ...(selectedNode
      ? nodeEntries(selectedNode).map((e) =>
          e && typeof e === 'object' && !('type' in e) ? { ...e, label: `Nó ${selectedNode.name}: ${e.label}` } : e
        )
      : [])
  ])

  const outputs: KnownOutputs = useMemo(() => {
    const map = new Map<string, FlowNodeResult['output']>()
    for (const { result } of statuses.values()) if (result?.output) map.set(result.name, result.output)
    return map
  }, [statuses])

  // Visão Simples: um fluxo de um nó abre no Quick Request, no lugar desta aba.
  const simple = flow ? flowToRequest(flow) : null
  const viewAsSimple = () => {
    if (!flow || !currentId) return
    const saved = draft?.saved ? (JSON.parse(draft.saved) as Flow) : null
    if (openFlowAsRequest(flow, { ...(draft?.file && { file: draft.file, version: draft.version }), saved })) closeFlowTab(currentId)
  }

  // Ctrl+S salva o fluxo, como nas outras abas do workspace.
  const active = useContext(PanelActiveContext)
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !matchesShortcut(e, Shortcut.save)) return
      e.preventDefault()
      void saveRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  const openTabs = openIds.filter((id) => drafts.has(id))
  // Os fluxos abertos são abas da barra única do workspace (lib/shell-tabs).
  useTabSource('flows', {
    tabs: openTabs.map((id) => {
      const d = drafts.get(id)!
      return { id, title: d.flow.name, dirty: serialize(d.flow) !== d.saved, busy: !!runId && id === currentId }
    }),
    activeId: currentId,
    select: switchFlow,
    close: closeFlowTab,
    menu: (id) => [
      { id: 'close', label: 'Fechar a aba', run: () => closeFlowTab(id) },
      {
        id: 'close-others',
        label: 'Fechar os outros fluxos',
        disabled: openTabs.length < 2,
        run: () => {
          setOpenIds([id])
          switchFlow(id)
        }
      },
      { id: 'new-flow', label: 'Novo fluxo', run: () => setCreating('') }
    ]
  })
  if (ws.result && !ws.result.ok)
    return <EmptyState icon={<Workflow size={20} aria-hidden />} title={ws.result.message} />
  if (catalog?.ok && catalog.value === null) {
    return (
      <EmptyState
        icon={<Workflow size={20} aria-hidden />}
        title="Nenhum workspace aberto"
        description="Abra a pasta do workspace para editar e rodar os fluxos (*.flow.vvpost.json)."
      >
        <button type="button" onClick={ws.open} className={buttonClass}>
          Abrir workspace…
        </button>
      </EmptyState>
    )
  }

  const selected = flow?.nodes.find((n) => n.id === selectedId)
  const tabs = openIds.filter((id) => drafts.has(id))
  const ancestors = flow && selected ? ancestorsOf(flow, selected.id) : []
  const flowList = [...drafts.values()].map((d) => d.flow)
  const counts = report && {
    success: report.results.filter((r) => r.status === 'success').length,
    error: report.results.filter((r) => r.status === 'error').length,
    skipped: report.results.filter((r) => r.status === 'skipped').length
  }
  // O resumo leva ao primeiro nó que falhou: seleciona e abre o inspector dele.
  const firstFailed = report?.results.find((r) => r.status === 'error')

  return (
    <PickTargetContext.Provider value={setTarget}>
      <div className="flex h-full flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <SegmentedControl
            label="Visão do documento"
            size="xs"
            value="canvas"
            disabled={!flow}
            onChange={(v) => v === 'simple' && viewAsSimple()}
            options={[
              { value: 'simple', label: 'Simples', disabled: !simple, ...(!simple && { title: 'Só um fluxo de um nó de requisição abre na visão Simples' }) },
              { value: 'canvas', label: 'Canvas' }
            ]}
          />
          <select
            aria-label="Fluxo"
            {...ctx.bind(`Fluxo ${flow?.name ?? ''}`, () => flowEntries())}
            className={selectClass}
            value={currentId ?? ''}
            onChange={(e) => switchFlow(e.target.value || null)}
          >
            {flowList.length === 0 && <option value="">Nenhum fluxo</option>}
            {flowList.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          {creating === null ? (
            <button type="button" className={buttonClass} onClick={() => setCreating('')}>
              Novo fluxo
            </button>
          ) : (
            <form
              className="flex gap-1"
              onSubmit={(e) => {
                e.preventDefault()
                createFlow()
              }}
            >
              <input
                autoFocus
                aria-label="Nome do novo fluxo"
                placeholder="Nome do fluxo"
                value={creating}
                onChange={(e) => setCreating(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setCreating(null)}
                className={selectClass}
              />
              <button type="submit" className={buttonClass} disabled={!creating.trim()}>
                Criar
              </button>
            </form>
          )}
          <span className="mx-1 h-4 w-px bg-border" />
          {(['request', 'condition', 'wait', 'webhook', 'python'] as const).map((type) => (
            <button
              key={type}
              type="button"
              className={buttonClass}
              disabled={!flow}
              onClick={() => addNode((f, pos) => newNode(f, type, pos))}
            >
              + {NODE_LABELS[type]}
            </button>
          ))}
          <select
            aria-label="Adicionar nó de plugin"
            className={selectClass}
            disabled={!flow || contributions.size === 0}
            value=""
            onChange={(e) => {
              const c = contributions.get(e.target.value)
              if (c) addNode((f, pos) => newPluginNode(f, c, pos))
            }}
          >
            <option value="">{contributions.size ? '+ Plugin…' : 'Sem plugins ligados'}</option>
            {[...contributions].map(([key, c]) => (
              <option key={key} value={key}>
                {c.title} ({c.kind === 'adapter' ? `adapter ${c.name}` : c.pluginName})
              </option>
            ))}
          </select>
          <button type="button" className={buttonClass} disabled={!dirty} onClick={() => void save()}>
            {dirty ? 'Salvar' : 'Salvo'}
          </button>
          <span className="flex-1" />
          <select
            aria-label="Ambiente do fluxo"
            className={selectClass}
            value={ws.selection.environmentId}
            onChange={(e) => ws.selectEnvironment(e.target.value)}
          >
            <option value="">Sem ambiente</option>
            {ws.workspace?.environments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
          <ExecutionToolbar
            state={runId ? 'running' : 'idle'}
            runLabel="Rodar fluxo"
            canRun={!!flow && flow.nodes.length > 0}
            onRun={() => void run()}
            {...(runId && { onCancel: () => void window.vvpost.cancelFlow(runId) })}
          />
        </header>
        {(message || counts || (catalog?.ok && !!catalog.value?.issues.length)) && (
          <div className="flex flex-wrap gap-3 border-b border-border px-3 py-1 text-xs">
            {counts && (
              <span role="status" aria-label="Resumo da execução">
                {report!.outcome === 'canceled'
                  ? 'Cancelado'
                  : report!.outcome === 'success'
                    ? 'Fluxo ok'
                    : 'Fluxo com erro'}
                : {counts.success} ok, {counts.error} com erro, {counts.skipped} pulados em {report!.durationMs} ms
              </span>
            )}
            {firstFailed && flow?.nodes.some((n) => n.id === firstFailed.nodeId) && (
              <button
                type="button"
                onClick={() => setSelectedId(firstFailed.nodeId)}
                className="rounded text-danger underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
              >
                Ver o nó com erro: {firstFailed.name}
                {firstFailed.error && ` (${describeError(firstFailed.error.code).category})`}
              </button>
            )}
            {message && <span className={message.kind === 'error' ? 'text-danger' : 'text-muted'}>{message.text}</span>}
            {catalog?.ok &&
              catalog.value?.issues.map((i) => (
                <span key={`${i.file}${i.message}`} className="text-warning">
                  {i.file}: {i.message}
                </span>
              ))}
          </div>
        )}
        <div
          className="flex min-h-0 flex-1"
          {...(currentId &&
            tabs.includes(currentId) && {
              id: `flow-panel-${currentId}`,
              role: 'tabpanel',
              'aria-labelledby': `flow-tab-${currentId}`
            })}
        >
          {/* A paleta fica colada ao canvas quando o inspector vai para a esquerda ou para baixo. */}
          <div className="flex min-h-0 min-w-0 flex-1">
            <EndpointPalette
              connectors={ws.workspace?.connectors ?? []}
              disabled={!flow}
              onAdd={(ref, name) => addNode((f, pos) => newEndpointNode(f, ref, name, pos))}
            />
            <div className="relative min-w-0 flex-1" aria-label="Canvas do fluxo">
              {flow ? (
                <ReactFlow
                  nodes={rfNodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onPaneClick={() => setSelectedId(null)}
                  onInit={(instance) => (canvas.current = instance)}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(ENDPOINT_DRAG_TYPE)) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'copy'
                  }}
                  onDrop={(e) => {
                    const ref = parseEndpointDrag(e.dataTransfer.getData(ENDPOINT_DRAG_TYPE))
                    if (!ref) return
                    e.preventDefault()
                    const endpoint = ws.workspace?.connectors
                      .find((c) => c.id === ref.connector)
                      ?.endpoints.find((x) => x.id === ref.endpoint)
                    if (!endpoint) return
                    // O nó nasce onde foi solto, centrado no ponteiro (o card tem 224 px de largura).
                    const at = canvas.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY })
                    if (!at) return
                    addNode((f, pos) => newEndpointNode(f, ref, endpoint.name, pos), { x: at.x - 112, y: at.y - 30 })
                  }}
                  onNodeContextMenu={(e, n) => {
                    const node = flow.nodes.find((x) => x.id === n.id)
                    if (!node) return
                    e.preventDefault()
                    setSelectedId(node.id)
                    ctx.open(e, `Nó ${node.name}`, nodeEntries(node))
                  }}
                  onEdgeContextMenu={(e, edge) => {
                    const fe = (flow.edges ?? []).find((x) => edgeKey(x) === edge.id)
                    if (!fe) return
                    e.preventDefault()
                    ctx.open(e, 'Ligação', edgeEntries(fe))
                  }}
                  onPaneContextMenu={(e) => {
                    e.preventDefault()
                    const at = canvas.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY })
                    ctx.open({ x: e.clientX, y: e.clientY }, 'Canvas do fluxo', flowEntries(at))
                  }}
                  onKeyDown={(e) => {
                    // Shift+F10 e os atalhos do menu no nó focado (o React Flow foca o nó com Tab).
                    const id = (e.target as HTMLElement).closest<HTMLElement>('.react-flow__node')?.dataset['id']
                    const node = id ? flow.nodes.find((n) => n.id === id) : undefined
                    if (node) ctx.bind(`Nó ${node.name}`, () => nodeEntries(node)).onKeyDown(e)
                  }}
                  colorMode="dark"
                  fitView
                  fitViewOptions={{ maxZoom: 1 }}
                  minZoom={0.2}
                  deleteKeyCode={['Delete', 'Backspace']}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background gap={24} />
                  <Controls showInteractive={false} />
                  <HandleBoundsGuard />
                </ReactFlow>
              ) : (
                <EmptyState
                  icon={<Workflow size={20} aria-hidden />}
                  title="Nenhum fluxo"
                  description="Crie um fluxo para começar."
                />
              )}
            </div>
          </div>
          <InspectorPanel id="flows" title="Inspector do nó" defaultWidth={384}>
            <div className="flex flex-col gap-4 overflow-x-hidden p-3">
              {flow && selected ? (
                <>
                  <Inspector
                    key={selected.id}
                    flow={flow}
                    node={selected}
                    connectors={connectors}
                    contributions={contributions}
                    ancestors={ancestors}
                    outputs={outputs}
                    {...(statuses.get(selected.id)?.result && { result: statuses.get(selected.id)!.result })}
                    onChange={(node) => updateNode(selected.id, () => node)}
                    onRename={(name) => updateFlow((f) => renameReferences(f, selected.name, name))}
                    {...(selected.type === 'request' && { onOpenInQuick: () => openNodeInQuick(selected) })}
                    onRemove={() => {
                      updateFlow((f) => ({
                        ...f,
                        nodes: f.nodes.filter((n) => n.id !== selected.id),
                        edges: (f.edges ?? []).filter((e) => e.from !== selected.id && e.to !== selected.id)
                      }))
                      setSelectedId(null)
                    }}
                  />
                  <DataPicker names={ancestors} outputs={outputs} target={target} />
                </>
              ) : (
                <div className="text-xs text-muted">
                  {flow ? (
                    <>
                      <BaseSettings flow={flow} connectors={connectors} onChange={(next) => updateFlow(() => next)} />
                      <p className="mt-4">Selecione um nó para editar.</p>
                      <p className="mt-2">
                        Nós ligados rodam em ordem; nós sem dependência entre si rodam em paralelo. A saída de cada um
                        fica em <code>$nodes.Nome</code> para os seguintes.
                      </p>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          </InspectorPanel>
        </div>
      </div>
      {ctx.menu}
      {dialog.element}
    </PickTargetContext.Provider>
  )
}
