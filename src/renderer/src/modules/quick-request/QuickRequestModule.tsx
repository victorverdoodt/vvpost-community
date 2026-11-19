import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { History, Plus, Save, Workflow, X } from 'lucide-react'
import { SegmentedControl, separator, Shortcut, useMenuCommands, usePromptDialog, useToast, type ContextMenuEntries, type JsonValueActions } from '../../design-system'
import { requestToFlow } from '@vvpost/core/flows/simple-flow'
import { filesChanged } from '../../app/workspace/docs'
import { flowIdFor } from '../flow-studio/model'
import { useTabSource } from '../../lib/shell-tabs'
import { HTTP_METHODS, type HistoryRunSummary, type HttpMethod, type PluginCatalog } from '@shared/ipc'
import { copyText } from '../../lib/clipboard'
import { navigate } from '../../lib/navigate'
import { timedRun } from '../../lib/perf'
import { FOCUS_URL, OPEN_REQUEST, takePendingRequest, takeUrlFocus, type OpenRequest } from '../../lib/open-request'
import { parseCurl, toCode } from '../../lib/request-code'
import { useWorkspace } from '../../panels/useWorkspace'
import { activeHeaders, applyRealtime, draftPayload, draftRequest, draftScripts, draftSignature, flowSignature, draftTitle, emptyFormRow, graphqlDraft, idleLive, newDraft, payloadDraft, toRows, type RequestDraft } from './draft'
import { QuickContext } from './QuickContext'
import { QuickInspector } from './QuickInspector'
import { fullUrl, requestEntries, exampleFromDraft, scenarioFromDraft, type RequestActions } from './menus'
import { RequestEditor, type AdapterContribution } from './RequestEditor'
import { confirmProtected } from '../../lib/protected'

/**
 * Fluxos do workspace para a preparação, lidos depois do primeiro paint e de
 * novo quando o workspace muda ou a janela volta ao foco. Só id e nome: o fluxo roda no main.
 */
function usePrepareFlows(dir: string | null): { id: string; name: string }[] {
  const [flows, setFlows] = useState<{ id: string; name: string }[]>([])
  useEffect(() => {
    if (!dir) return setFlows([])
    const load = () =>
      void window.vvpost.listFlows().then((r) => setFlows(r.ok && r.value ? r.value.flows.map(({ flow }) => ({ id: flow.id, name: flow.name })) : []))
    const handle = requestIdleCallback(load, { timeout: 2000 })
    window.addEventListener('focus', load)
    return () => {
      cancelIdleCallback(handle)
      window.removeEventListener('focus', load)
    }
  }, [dir])
  return flows
}

/**
 * Adapters dos plugins ligados (gRPC, Kafka...), oferecidos como protocolo da aba. Lidos sob
 * demanda (o seletor de protocolo sob o mouse ou em foco, uma aba de plugin) para a abertura do
 * app não carregar o gerenciador de plugins; depois, relidos quando a janela volta ao foco.
 */
function useAdapters(wanted: boolean): { adapters: ReadonlyMap<string, AdapterContribution> | null; load: () => void } {
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null)
  const requested = useRef(false)
  const load = useCallback(() => {
    requested.current = true
    void window.vvpost.listPlugins().then((r) => r.ok && setCatalog(r.value))
  }, [])
  const want = useCallback(() => {
    if (!requested.current) load()
  }, [load])
  useEffect(() => {
    if (wanted) want()
  }, [wanted, want])
  useEffect(() => {
    const refresh = () => requested.current && load()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [load])
  const adapters = useMemo(() => {
    if (!catalog) return null
    const map = new Map<string, AdapterContribution>()
    for (const p of catalog.plugins) {
      if (!p.enabled || p.error) continue
      for (const c of p.contributions) if (c.kind === 'adapter') map.set(c.name, { ...c, pluginName: p.name })
    }
    return map
  }, [catalog])
  return { adapters, load: want }
}

/** Abas fechadas que "Reabrir aba fechada" (Ctrl+Shift+T) ainda traz de volta. */
const MAX_CLOSED = 10
const icon = { size: 14, 'aria-hidden': true } as const

/**
 * Quick Request, o módulo de referência do design system: contexto (conector, ambiente,
 * endpoint), abas de requisições, barra de execução, resposta e inspector. Tudo dispara pelo
 * dispatcher Undici e pela auth headless do main process, sem depender do Flow Studio.
 */
export default function QuickRequestModule() {
  const [drafts, setDrafts] = useState<RequestDraft[]>(() => [newDraft()])
  const [activeId, setActiveId] = useState(drafts[0]!.id)
  const [history, setHistory] = useState<HistoryRunSummary[]>([])
  const ws = useWorkspace()
  const flows = usePrepareFlows(ws.workspace?.dir ?? null)
  const { connector, environmentId } = ws.selection
  const active = drafts.find((d) => d.id === activeId) ?? drafts[0]!
  const { adapters, load: loadAdapters } = useAdapters(drafts.some((d) => d.adapter))
  const closed = useRef<RequestDraft[]>([])
  const toast = useToast()
  const dialog = usePromptDialog()

  // Menu de valores do JSON (resposta e body): variável no ambiente escolhido e próxima requisição.
  const jsonActions: JsonValueActions = {
    variableTarget: ws.environment ? { environmentId: ws.environment.id, label: ws.environment.name } : null,
    async useAsVariable(name, value) {
      if (!ws.environment) return 'Escolha um ambiente no contexto.'
      const r = await window.vvpost.setEnvironmentVariable({ environmentId: ws.environment.id, name, value })
      if (!r.ok) return r.message
      ws.reload()
      toast(
        r.value.secret
          ? `{{${name}}} salva como segredo no vault local (${ws.environment.name})`
          : `{{${name}}} salva em ${r.value.file}`,
        'success'
      )
      return null
    },
    insertIntoNextRequest(value) {
      // A próxima requisição é uma aba nova, logo depois da atual, com o valor no body.
      const d = { ...newDraft(), method: 'POST' as const, body: JSON.stringify(value, null, 2) ?? '' }
      setDrafts((all) => {
        const i = all.findIndex((x) => x.id === active.id)
        return [...all.slice(0, i + 1), d, ...all.slice(i + 1)]
      })
      setActiveId(d.id)
      toast('Valor inserido no body de uma nova requisição', 'success')
    }
  }

  const refreshHistory = useCallback(() => {
    void window.vvpost.listHistory({ source: 'request', limit: 100 }).then(setHistory)
  }, [])

  // O histórico abre o SQLite no main process: fica para depois do primeiro paint.
  useEffect(() => {
    const handle = requestIdleCallback(refreshHistory, { timeout: 2000 })
    return () => cancelIdleCallback(handle)
  }, [refreshHistory])

  const update = useCallback(
    (id: string, patch: Partial<RequestDraft> | ((d: RequestDraft) => Partial<RequestDraft>)) => {
      setDrafts((all) =>
        all.map((d) => (d.id === id ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d))
      )
    },
    []
  )

  // Conexões realtime: os estados e as mensagens chegam do main em lotes, pela conexão de cada aba.
  useEffect(
    () =>
      window.vvpost.onRealtimeEvents((events) =>
        setDrafts((all) =>
          all.map((d) => (d.live?.connectionId && events.some((e) => e.id === d.live!.connectionId) ? { ...d, live: applyRealtime(d.live, events) } : d))
        )
      ),
    []
  )
  const liveIds = useRef<string[]>([])
  liveIds.current = drafts.flatMap((d) => (d.live?.connectionId && (d.live.status === 'open' || d.live.status === 'connecting') ? [d.live.connectionId] : []))
  useEffect(() => () => liveIds.current.forEach((id) => void window.vvpost.closeRealtime(id)), [])

  const connect = (draft: RequestDraft) => {
    const id = crypto.randomUUID()
    const sse = draft.realtime === 'sse'
    const withBody = sse && draft.method !== 'GET' && draft.method !== 'HEAD' && !!draft.body
    update(draft.id, { live: { ...idleLive(), connectionId: id, status: 'connecting' } })
    void window.vvpost
      .openRealtime({
        id,
        protocol: draft.realtime!,
        url: draft.url.trim(),
        headers: activeHeaders(draft),
        ...(connector && { connectorId: connector.id }),
        ...(environmentId && { environmentId }),
        ...(sse && { method: draft.method }),
        ...(withBody && { body: draft.body }),
        ...(draft.realtime === 'websocket' && draft.subprotocols?.trim() && { subprotocols: draft.subprotocols.split(',').map((p) => p.trim()).filter(Boolean) })
      })
      .then((r) => {
        if (!r.ok) update(draft.id, (d) => (d.live?.connectionId === id ? { live: { ...d.live, status: 'error', code: 'CONFIG_ERROR', detail: r.message } } : {}))
      })
  }
  const disconnect = (draft: RequestDraft) => {
    if (draft.live?.connectionId) void window.vvpost.closeRealtime(draft.live.connectionId)
  }
  const sendMessage = (draft: RequestDraft) => {
    const id = draft.live?.connectionId
    if (!id || draft.live?.status !== 'open') return
    const compose = draft.compose ?? { data: '', event: '' }
    void window.vvpost
      .sendRealtime(id, { data: compose.data, ...(draft.realtime === 'socketio' && { event: compose.event }) })
      .then((r) => !r.ok && toast(r.message, 'danger'))
  }

  const send = async (draft: RequestDraft) => {
    if (draft.realtime) {
      if (draft.live?.status === 'open' || draft.live?.status === 'connecting') disconnect(draft)
      else if (draft.url.trim()) connect(draft)
      return
    }
    if (draft.pendingId || (!draft.adapter && !draft.url.trim())) return
    if (!(await confirmProtected(dialog.confirm, [ws.environment ?? undefined], 'Enviar a requisição'))) return
    const requestId = crypto.randomUUID()
    update(draft.id, { pendingId: requestId })
    try {
      // Protocolo de plugin: o adapter no main process, com o conector e o ambiente do contexto.
      const result = await timedRun('quick', () =>
        draft.adapter
          ? window.vvpost.sendPluginRequest({
              id: requestId,
              adapter: draft.adapter,
              config: draft.pluginConfig ?? {},
              ...(connector && { connectorId: connector.id }),
              ...(environmentId && { environmentId })
            })
          : window.vvpost.sendRequest({
              id: requestId,
              method: draft.method,
              url: draft.url.trim(),
              headers: activeHeaders(draft),
              ...(draftPayload(draft) ? { payload: draftPayload(draft) } : { body: draft.body || undefined }),
              connectorId: connector?.id,
              environmentId: environmentId || undefined,
              ...(draft.prepareFlowId && { prepareFlowId: draft.prepareFlowId }),
              // Os nós de antes do fluxo que a aba é rodam em segundo plano, como a preparação.
              ...(!draft.prepareFlowId && draft.flow?.before?.nodes.length && { prepareFlow: draft.flow.before }),
              // O endpoint leva os scripts dele e os do conector para o envio.
              ...(connector && draft.endpointId && { endpointId: draft.endpointId }),
              ...(draftScripts(draft) && { scripts: draftScripts(draft) })
            })
      )
      update(draft.id, (d) => ({ result, previous: d.result }))
    } finally {
      update(draft.id, { pendingId: null })
      refreshHistory()
    }
  }

  /** "Ver como fluxo": o fluxo script → requisição → script desta aba, como rascunho no Flow Studio. */
  const viewScriptFlow = async (draft: RequestDraft) => {
    const r = await window.vvpost.requestScriptFlow({
      id: crypto.randomUUID(),
      method: draft.method,
      url: draft.url.trim(),
      headers: activeHeaders(draft),
      ...(draftPayload(draft) ? { payload: draftPayload(draft) } : { body: draft.body || undefined }),
      ...(connector && { connectorId: connector.id }),
      ...(connector && draft.endpointId && { endpointId: draft.endpointId }),
      ...(draftScripts(draft) && { scripts: draftScripts(draft) })
    })
    if (!r.ok) return toast(r.message, 'danger')
    navigate({ module: 'flows', flowId: r.value.id, flow: r.value })
  }

  /** A aba tem mudança que ainda não está no arquivo do fluxo dela. */
  const isDirty = (d: RequestDraft) => !!d.flow && draftSignature(d, connector?.id) !== d.flow.saved

  /**
   * Ctrl+S: a requisição é gravada como o fluxo que ela é, em flows/: os nós de antes (ou a
   * preparação escolhida, que passa a fazer parte do fluxo) e o nó da requisição no fim. A
   * primeira vez pergunta o nome; depois grava no mesmo arquivo.
   */
  const saveAsFlow = async (d: RequestDraft) => {
    const req = draftRequest(d, connector?.id)
    if (!req) return toast('Conexões realtime e protocolos de plugin ainda não viram fluxo.', 'warning')
    if (!ws.workspace) return toast('Abra um workspace para salvar a requisição como fluxo.', 'warning')
    if (!req.url) return toast('Preencha a URL antes de salvar.', 'warning')
    let ref = d.flow
    if (!ref) {
      const endpoint = connector && d.endpointId ? connector.endpoints.find((e) => e.id === d.endpointId) : undefined
      const name = (await dialog.prompt({ title: 'Salvar a requisição como fluxo', label: 'Nome do fluxo', initial: endpoint?.name ?? draftTitle(d), confirmLabel: 'Salvar' }))?.trim()
      if (!name) return
      const listed = await window.vvpost.listFlows()
      const taken = new Set(listed.ok && listed.value ? listed.value.flows.map((f) => f.flow.id) : [])
      ref = { id: flowIdFor(name, taken), name, saved: '' }
    }
    // A preparação escolhida no contexto entra no fluxo como os nós de antes.
    let before = ref.before ?? null
    if (!before?.nodes.length && d.prepareFlowId) {
      const listed = await window.vvpost.listFlows()
      before = (listed.ok && listed.value?.flows.find((f) => f.flow.id === d.prepareFlowId)?.flow) || null
    }
    const flow = requestToFlow(req, { id: ref.id, name: ref.name, ...(ref.keep?.description && { description: ref.keep.description }), ...(ref.keep?.inherit && { keep: ref.keep.inherit }) }, {
      before,
      ...(ref.node && { node: ref.node }),
      ...(ref.before && ref.incoming && { incoming: ref.incoming })
    })
    const r = await window.vvpost.saveFlow(flow, ref.file, ref.file ? ref.version : undefined)
    if (!r.ok) return toast(r.message, 'danger')
    const last = flow.nodes.at(-1)!
    const kept = flow.nodes.slice(0, -1)
    const nextBefore = kept.length ? { id: flow.id, name: flow.name, nodes: kept, edges: (flow.edges ?? []).filter((e) => e.to !== last.id) } : null
    update(d.id, {
      prepareFlowId: null,
      flow: {
        ...ref,
        file: r.value.file,
        version: r.value.version,
        before: nextBefore,
        node: { id: last.id, name: last.name, ...(last.position && { position: last.position }) },
        incoming: (flow.edges ?? []).filter((e) => e.to === last.id).map((e) => e.from),
        saved: flowSignature(req, '', nextBefore)
      }
    })
    filesChanged()
    toast(`Salvo em ${r.value.file}`, 'success')
  }

  /** Visão Canvas: a aba vira o fluxo no Flow Studio, no mesmo lugar da barra de abas. */
  const viewAsCanvas = (d: RequestDraft) => {
    const req = draftRequest(d, connector?.id)
    if (!req) return toast('Conexões realtime e protocolos de plugin ainda não viram fluxo.', 'warning')
    if (d.flow && !isDirty(d)) navigate({ module: 'flows', flowId: d.flow.id })
    else {
      const name = d.flow?.name ?? draftTitle(d)
      const flow = requestToFlow(req, { id: d.flow?.id ?? 'flow.nova-requisicao', name, ...(d.flow?.keep?.description && { description: d.flow.keep.description }), ...(d.flow?.keep?.inherit && { keep: d.flow.keep.inherit }) }, {
        before: d.flow?.before ?? null,
        ...(d.flow?.node && { node: d.flow.node }),
        ...(d.flow?.incoming && { incoming: d.flow.incoming })
      })
      // A mudança não salva vai junto: o canvas mostra o fluxo com ela, ainda por salvar.
      navigate({ module: 'flows', flowId: flow.id, flow, ...(d.flow?.file && { file: d.flow.file }) })
    }
    closeTab(d.id)
  }

  const addTab = () => {
    const d = newDraft()
    setDrafts((all) => [...all, d])
    setActiveId(d.id)
  }

  /** Fecha as abas de `ids`; a ativa passa para a vizinha. As fechadas podem ser reabertas. */
  const closeTabs = (ids: string[]) => {
    const gone = new Set(ids)
    setDrafts((all) => {
      const i = all.findIndex((d) => d.id === activeId)
      const removed = all.filter((d) => gone.has(d.id))
      // Fechar a aba fecha a conexão dela.
      for (const d of removed) disconnect(d)
      closed.current = [...closed.current, ...removed.map((d) => ({ ...d, pendingId: null, live: idleLive() }))].slice(-MAX_CLOSED)
      const rest = all.filter((d) => !gone.has(d.id))
      const next = rest.length ? rest : [newDraft()]
      if (gone.has(activeId) || !rest.length) setActiveId(next[Math.min(Math.max(i, 0), next.length - 1)]!.id)
      return next
    })
  }
  const closeTab = (id: string) => closeTabs([id])

  const openTab = (d: RequestDraft, after?: string) => {
    setDrafts((all) => {
      const at = after ? all.findIndex((x) => x.id === after) : -1
      return at < 0 ? [...all, d] : [...all.slice(0, at + 1), d, ...all.slice(at + 1)]
    })
    setActiveId(d.id)
  }

  const duplicateTab = (src: RequestDraft) =>
    openTab(
      {
        ...newDraft(),
        method: src.method,
        url: src.url,
        headers: toRows(activeHeaders(src)),
        body: src.body,
        bodyMode: src.bodyMode ?? 'raw',
        formRows: (src.formRows ?? []).map((r) => ({ ...r, key: emptyFormRow().key })),
        binaryFile: src.binaryFile ?? '',
        binaryType: src.binaryType ?? '',
        endpointId: src.endpointId,
        prepareFlowId: src.prepareFlowId ?? null,
        ...(src.scripts && { scripts: { ...src.scripts } }),
        adapter: src.adapter ?? null,
        ...(src.pluginConfig && { pluginConfig: src.pluginConfig }),
        realtime: src.realtime ?? null,
        ...(src.subprotocols && { subprotocols: src.subprotocols }),
        ...(src.compose && { compose: src.compose })
      },
      src.id
    )

  const reopenTab = () => {
    const d = closed.current.pop()
    if (d) openTab({ ...d, id: newDraft().id })
  }

  const notify = (task: Promise<string>) =>
    void task.then(
      (msg) => toast(msg, 'success'),
      (err: Error) => toast(err.message, 'danger')
    )

  /** Lê um comando curl da área de transferência para a aba (ou uma nova, se a aba já tiver URL). */
  const pasteCurl = (target: RequestDraft) =>
    void navigator.clipboard.readText().then((text) => {
      const req = parseCurl(text)
      if (!req) return toast('A área de transferência não tem um comando curl.', 'warning')
      const method = (HTTP_METHODS as readonly string[]).includes(req.method) ? (req.method as HttpMethod) : 'GET'
      const patch = { method, url: req.url, headers: toRows(req.headers), body: req.body ?? '', ...payloadDraft(req.payload), endpointId: null, adapter: null, realtime: null }
      if (target.url.trim()) openTab({ ...newDraft(), ...patch }, target.id)
      else update(target.id, patch)
      toast('Requisição montada a partir do cURL.', 'success')
    })

  const generateScenario = (d: RequestDraft) => {
    if (!connector) return
    const op = scenarioFromDraft(d, connector)
    if (!op || op.op !== 'upsertScenario') return
    void window.vvpost.editProject([op]).then((r) => {
      if (!r.ok) return toast(r.message, 'danger')
      ws.reload()
      toast(`Cenário "${op.scenario.name}" criado em ${connector.name}.`, 'success')
      navigate({ module: 'scenarios', connectorId: connector.id, endpointId: op.endpointId })
    })
  }

  const saveExample = (d: RequestDraft) => {
    if (!connector) return
    const op = exampleFromDraft(d, connector)
    if (typeof op === 'string') return toast(op, 'warning')
    void window.vvpost.editProject([op]).then((r) => {
      if (!r.ok) return toast(r.message, 'danger')
      ws.reload()
      toast(`Exemplo "${op.example.name}" salvo em ${op.endpointId}: o mock server já responde com ele.`, 'success')
    })
  }

  const actionsFor = (d: RequestDraft): RequestActions => ({
    send: () => void send(d),
    duplicate: () => duplicateTab(d),
    pasteCurl: () => pasteCurl(d),
    copy: (text, what) => notify(copyText(text, what)),
    generateScenario: () => generateScenario(d),
    saveExample: () => saveExample(d),
    ...(connector && { openConnector: () => navigate({ module: 'catalog', connectorId: connector.id, ...(d.endpointId && { endpointId: d.endpointId }) }) })
  })

  const tabEntries = (d: RequestDraft): ContextMenuEntries => {
    const i = drafts.findIndex((x) => x.id === d.id)
    return [
      ...requestEntries(d, connector, actionsFor(d)),
      separator,
      {
        id: 'save-flow',
        label: d.flow ? `Salvar o fluxo ${d.flow.name}` : 'Salvar como fluxo…',
        icon: <Save {...icon} />,
        shortcut: Shortcut.save,
        disabled: !!d.realtime || !!d.adapter,
        run: () => void saveAsFlow(d)
      },
      {
        id: 'view-canvas',
        label: 'Ver no canvas (Flow Studio)',
        icon: <Workflow {...icon} />,
        disabled: !!d.realtime || !!d.adapter,
        run: () => viewAsCanvas(d)
      },
      separator,
      { id: 'close', label: 'Fechar', icon: <X {...icon} />, shortcut: Shortcut.closeTab, run: () => closeTab(d.id) },
      {
        id: 'close-others',
        label: 'Fechar as outras',
        disabled: drafts.length < 2,
        run: () => closeTabs(drafts.filter((x) => x.id !== d.id).map((x) => x.id))
      },
      {
        id: 'close-right',
        label: 'Fechar as da direita',
        disabled: i === drafts.length - 1,
        run: () => closeTabs(drafts.slice(i + 1).map((x) => x.id))
      },
      { id: 'close-all', label: 'Fechar todas', run: () => closeTabs(drafts.map((x) => x.id)) },
      separator,
      { id: 'new', label: 'Nova requisição', icon: <Plus {...icon} />, shortcut: Shortcut.newTab, run: addTab },
      {
        id: 'reopen',
        label: 'Reabrir aba fechada',
        icon: <History {...icon} />,
        shortcut: Shortcut.reopenTab,
        disabled: closed.current.length === 0,
        run: reopenTab
      }
    ]
  }

  // As mesmas ações na Command Palette, sobre a aba ativa; Ctrl+T, Ctrl+W e Ctrl+Shift+T valem no módulo.
  useMenuCommands('Quick Request', tabEntries(active), { shortcuts: true })

  // As requisições abertas são abas da barra única do workspace (lib/shell-tabs).
  useTabSource('quick-request', {
    tabs: drafts.map((d) => ({
      id: d.id,
      title: d.flow?.name ?? draftTitle(d),
      dirty: isDirty(d),
      busy: !!d.pendingId || d.live?.status === 'open' || d.live?.status === 'connecting'
    })),
    activeId: active.id,
    select: setActiveId,
    close: closeTab,
    menu: (id) => {
      const d = drafts.find((x) => x.id === id)
      return d ? tabEntries(d) : []
    }
  })

  const applyContext = (r: Pick<OpenRequest, 'connectorId' | 'environmentId'>) => {
    if (r.connectorId !== null || r.environmentId !== null || connector || environmentId) {
      ws.selectConnector(r.connectorId ?? '')
      ws.selectEnvironment(r.environmentId ?? '')
    }
  }

  // A lista guarda o resumo; o modelo (headers e corpo, já mascarados) vem do detalhe.
  const loadFromHistory = (entry: HistoryRunSummary) => {
    void window.vvpost.getHistoryRun(entry.id).then((run) => {
      const x = run?.exchanges[0]
      if (!x) return
      update(active.id, {
        method: x.method,
        url: x.url,
        headers: toRows(x.template?.headers ?? []),
        body: x.template?.body ?? '',
        ...payloadDraft(x.template?.payload),
        endpointId: x.template?.endpointId ?? null,
        prepareFlowId: x.template?.prepareFlowId ?? null,
        scripts: x.template?.scripts ?? {},
        adapter: null
      })
      applyContext(x)
    })
  }

  /** Entrada do histórico numa aba nova (e enviada, em "Enviar de novo"). */
  const openHistory = (entry: HistoryRunSummary, sendNow: boolean) => {
    void window.vvpost.getHistoryRun(entry.id).then((run) => {
      const x = run?.exchanges[0]
      if (!x) return
      const d: RequestDraft = {
        ...newDraft(),
        method: x.method,
        url: x.url,
        headers: toRows(x.template?.headers ?? []),
        body: x.template?.body ?? '',
        ...payloadDraft(x.template?.payload),
        endpointId: x.template?.endpointId ?? null,
        prepareFlowId: x.template?.prepareFlowId ?? null,
        ...(x.template?.scripts && { scripts: x.template.scripts })
      }
      openTab(d)
      applyContext(x)
      if (sendNow) setTimeout(() => setResend(d.id))
    })
  }
  // Envia depois que a aba nova e o contexto (conector, ambiente) já estão no estado.
  const [resend, setResend] = useState<string | null>(null)
  useEffect(() => {
    if (!resend) return
    const d = drafts.find((x) => x.id === resend)
    setResend(null)
    if (d) void send(d)
  })

  // "Reabrir no Quick Request" no módulo Histórico: abre numa aba nova, mesmo se o módulo ainda não estava montado.
  useEffect(() => {
    const openPending = () => {
      const r = takePendingRequest()
      if (!r) return
      // O mesmo fluxo volta à aba dele.
      const open = r.flow && drafts.find((x) => x.flow?.id === r.flow!.id)
      if (open) return setActiveId(open.id)
      const d: RequestDraft = {
        ...newDraft(),
        method: r.method,
        url: r.url,
        headers: toRows(r.headers),
        body: r.body,
        ...payloadDraft(r.payload),
        ...(!r.payload && graphqlDraft(r.body)),
        endpointId: r.endpointId ?? null,
        prepareFlowId: r.prepareFlowId ?? null,
        ...(r.scripts && { scripts: r.scripts }),
        ...(r.flow && { flow: r.flow })
      }
      setDrafts((all) => [...all, d])
      setActiveId(d.id)
      // Um fluxo leva o conector dele; o ambiente fica o que já está escolhido.
      if (r.flow) ws.selectConnector(r.connectorId ?? '')
      else if (!r.keepContext) applyContext(r)
    }
    openPending()
    window.addEventListener(OPEN_REQUEST, openPending)
    return () => window.removeEventListener(OPEN_REQUEST, openPending)
  })

  // Ctrl+L / Ctrl+N: depois do render (a aba nova já está na tela), foco e seleção na URL.
  const [focusTick, setFocusTick] = useState(0)
  useEffect(() => {
    const take = () => takeUrlFocus() && setFocusTick((n) => n + 1)
    take()
    window.addEventListener(FOCUS_URL, take)
    return () => window.removeEventListener(FOCUS_URL, take)
  }, [])
  useEffect(() => {
    if (!focusTick) return
    const input = [...document.querySelectorAll<HTMLInputElement>('input[aria-label="URL"]')].find((el) => el.offsetParent)
    input?.focus()
    input?.select()
  }, [focusTick])

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <QuickContext
          ws={ws}
          flows={flows}
          prepareFlowId={active.prepareFlowId ?? ''}
          onPrepareFlow={(id) => update(active.id, { prepareFlowId: id || null })}
          inlinePrepare={active.flow?.before?.nodes.map((n) => n.name)}
          trailing={
            !active.realtime && !active.adapter ? (
              <SegmentedControl
                label="Visão do documento"
                size="xs"
                value="simple"
                onChange={(v) => v === 'canvas' && viewAsCanvas(active)}
                options={[
                  { value: 'simple', label: 'Simples' },
                  { value: 'canvas', label: 'Canvas' }
                ]}
              />
            ) : undefined
          }
          onPickEndpoint={(endpoint) => {
            // Um endpoint é HTTP (ou de plugin): a conexão realtime da aba fecha.
            disconnect(active)
            update(active.id, {
              method: endpoint.method,
              url: endpoint.path,
              headers: toRows(endpoint.headers),
              body: endpoint.body ?? '',
              ...payloadDraft(endpoint.payload),
              ...(!endpoint.payload && graphqlDraft(endpoint.body)),
              endpointId: endpoint.id,
              disabledParams: [],
              // Endpoint de plugin (gRPC, Kafka...): a aba passa ao adapter com a config do arquivo.
              adapter: endpoint.plugin?.adapter ?? null,
              pluginConfig: endpoint.plugin?.config ?? {},
              realtime: null
            })
          }}
        />
        {drafts.map((d) => (
          <div
            key={d.id}
            id={`ws-panel-src:quick-request:${d.id}`}
            role="tabpanel"
            aria-labelledby={`ws-tab-src:quick-request:${d.id}`}
            hidden={d.id !== active.id}
            className="flex min-h-0 flex-1 flex-col"
          >
            <RequestEditor
              draft={d}
              connector={connector}
              onChange={(patch) => update(d.id, patch)}
              onSend={() => void send(d)}
              onDisconnect={() => disconnect(d)}
              onSendMessage={() => sendMessage(d)}
              menu={() => requestEntries(d, connector, actionsFor(d))}
              onIntrospect={(body) =>
                window.vvpost.sendRequest({
                  id: crypto.randomUUID(),
                  method: 'POST',
                  url: d.url.trim(),
                  headers: [...activeHeaders(d).filter((h) => h.name.toLowerCase() !== 'content-type'), { name: 'Content-Type', value: 'application/json' }],
                  body,
                  connectorId: connector?.id,
                  environmentId: environmentId || undefined
                })
              }
              onPasteCurl={(text) => {
                const req = parseCurl(text)
                if (!req) return false
                const method = (HTTP_METHODS as readonly string[]).includes(req.method) ? (req.method as HttpMethod) : 'GET'
                update(d.id, { method, url: req.url, headers: toRows(req.headers), body: req.body ?? '', ...payloadDraft(req.payload), endpointId: null, adapter: null, realtime: null })
                toast('Requisição montada a partir do cURL colado.', 'success')
                return true
              }}
              onOpenConnector={connector ? () => navigate({ module: 'catalog', connectorId: connector.id }) : undefined}
              onOpenFlow={(flowId) => navigate({ module: 'flows', flowId })}
              onViewScriptFlow={() => void viewScriptFlow(d)}
              jsonActions={jsonActions}
              {...(adapters && { adapters })}
              onWantAdapters={loadAdapters}
            />
          </div>
        ))}
      </div>
      <QuickInspector
        draft={active}
        connector={connector}
        history={history}
        onPickHistory={loadFromHistory}
        onOpenHistory={(entry) => openHistory(entry, false)}
        onResendHistory={(entry) => openHistory(entry, true)}
        onDeleteHistory={(entry) => void window.vvpost.deleteHistoryRun(entry.id).then(refreshHistory)}
        onCopyHistory={(entry, as) => {
          if (as === 'url') return notify(copyText(entry.url ?? '', 'URL copiada'))
          notify(
            window.vvpost.getHistoryRun(entry.id).then((run) => {
              const x = run?.exchanges[0]
              if (!x) throw new Error('A entrada não está mais no histórico.')
              const c = ws.workspace?.connectors.find((k) => k.id === x.connectorId) ?? null
              const req = { method: x.method, url: fullUrl(x.url, c), headers: x.template?.headers ?? [], body: x.template?.body ?? undefined }
              return copyText(toCode('curl', req), 'cURL copiado')
            })
          )
        }}
        onClearHistory={() => void window.vvpost.clearHistory().then(refreshHistory)}
      />
      {dialog.element}
    </div>
  )
}
