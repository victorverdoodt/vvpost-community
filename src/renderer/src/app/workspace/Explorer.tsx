import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { ArrowRightLeft, BookOpen, Boxes, ChevronDown, ChevronRight, FlaskConical, FolderOpen, KeyRound, Network, Plus, RefreshCw, Search, Shapes, Workflow } from 'lucide-react'
import type { CatalogConnector, FlowCatalog } from '@shared/ipc'
import { byInheritance, unusedShared } from './explorer-tree'
import { Button, cx, IconButton, MethodBadge, useContextMenu, usePromptDialog, useToast } from '../../design-system'
import { navigate } from '../../lib/navigate'
import { openFlowAsRequest } from '../../lib/flow-view'
import { openInQuickRequest } from '../../lib/open-request'
import { tabSource } from '../../lib/shell-tabs'
import { WORKSPACE_CHANGED, type useWorkspace } from '../../panels/useWorkspace'
import { closeDocTab, FILES_CHANGED, openDoc, type DocRef } from './docs'
import { onConvertRequest } from './convert-request'
import { showNewItem, showNewItemStep } from './NewItem'
import {
  connectorMenu,
  endpointMenu,
  environmentMenu,
  fileMenu,
  flowMenu,
  scenarioMenu,
  sectionMenu,
  type ExplorerMenuDeps,
  type ExplorerSection,
  type SectionMenuContext
} from './explorer-menus'

const icon = { size: 14, strokeWidth: 1.75, 'aria-hidden': true } as const

type Section = ExplorerSection
const SECTIONS_KEY = 'vvpost.explorer.collapsed'

function rememberedCollapsed(): Set<Section> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '[]') as Section[])
  } catch {
    return new Set()
  }
}

/** Uma linha da árvore: o recuo diz a profundidade; o chevron, quando há filhos. */
function Row(props: {
  depth: number
  icon: ReactNode
  label: ReactNode
  title?: string
  active?: boolean
  expanded?: boolean
  onToggle?: () => void
  onOpen: () => void
  /** Menu de contexto (botão direito, Shift+F10 ou a tecla de menu na linha focada). */
  menu?: ReturnType<ReturnType<typeof useContextMenu>['bind']>
}) {
  return (
    <div
      {...props.menu}
      role="treeitem"
      aria-level={props.depth + 1}
      aria-selected={props.active ?? false}
      {...(props.expanded !== undefined && { 'aria-expanded': props.expanded })}
      className={cx(
        'group flex h-7 items-center gap-1 rounded-[var(--radius-control)] pr-1 text-xs',
        props.active ? 'bg-accent/15 text-fg' : 'text-muted hover:bg-border/50 hover:text-fg'
      )}
      style={{ paddingLeft: 4 + props.depth * 12 }}
    >
      {props.onToggle ? (
        <button type="button" tabIndex={-1} aria-label={props.expanded ? 'Recolher' : 'Expandir'} onClick={props.onToggle} className="flex h-5 w-4 shrink-0 items-center justify-center text-faint hover:text-fg">
          {props.expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        </button>
      ) : (
        <span className="w-4 shrink-0" />
      )}
      <button
        type="button"
        onClick={props.onOpen}
        onKeyDown={(e) => {
          if (!props.onToggle) return
          if ((e.key === 'ArrowRight' && !props.expanded) || (e.key === 'ArrowLeft' && props.expanded)) {
            e.preventDefault()
            props.onToggle()
          }
        }}
        title={props.title}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="shrink-0">{props.icon}</span>
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
      </button>
    </div>
  )
}

/**
 * "Converter para fluxos" (vvpost migrate): mostra a prévia, pede confirmação e grava tudo de uma
 * vez. Devolve o aviso para o toast.
 */
async function convertToFlows(confirm: ReturnType<typeof usePromptDialog>['confirm']): Promise<{ message: string; tone: 'success' | 'warning' | 'danger' } | null> {
  const preview = await window.vvpost.migrateProject(true)
  if (!preview.ok) return { message: preview.message, tone: 'danger' }
  const plan = preview.value
  const schemas = plan?.schemas ?? []
  if (!plan || (!plan.converted.length && !schemas.length)) {
    const why = plan?.skipped.map((s) => `${s.id}: ${s.reason}`).join('; ')
    return { message: `Nada a converter${why ? ` (${why})` : ''}.`, tone: 'warning' }
  }
  const skipped = plan.skipped.length ? ` Ficam como estão: ${plan.skipped.map((s) => `${s.id} (${s.reason})`).join(', ')}.` : ''
  const parts = [
    ...(plan.converted.length
      ? [`${plan.converted.length} conector(es) viram fluxos-base, um arquivo por requisição em flows/<conector>/: ${plan.converted.join(', ')}. As requisições, a herança e a documentação continuam iguais.`]
      : []),
    ...(schemas.length
      ? [`${schemas.length} schema(s) copiado(s) em vários endpoints viram compartilhados em schemas/ (${schemas.map((s) => s.name).join(', ')}): editar um muda todos os usos.`]
      : [])
  ]
  const ok = await confirm({
    title: 'Converter para fluxos',
    message: `${parts.join(' ')}${skipped}`,
    confirmLabel: 'Converter'
  })
  if (!ok) return null
  const done = await window.vvpost.migrateProject(false)
  if (!done.ok) return { message: done.message, tone: 'danger' }
  if (done.value?.errors.length) return { message: `Nada foi gravado: ${done.value.errors.join('; ')}`, tone: 'danger' }
  const summary = [
    ...(plan.converted.length ? [`${plan.converted.length} conector(es) convertido(s) em fluxos`] : []),
    ...(schemas.length ? [`${schemas.length} schema(s) compartilhado(s)`] : [])
  ]
  return { message: `${summary.join(' e ')}.`, tone: 'success' }
}

const CONVERT_LATER_KEY = 'vvpost.explorer.convertLater'

/** As pastas em que a pessoa deixou o "Converter para fluxos" para depois. */
function convertLater(): string[] {
  try {
    return JSON.parse(localStorage.getItem(CONVERT_LATER_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

/**
 * Explorador do projeto, à esquerda das abas (como num editor de código): conectores pela herança
 * (cada base com os que herdam dela, os endpoints e os cenários), fluxos, ambientes, documentos
 * .md e diagramas .mmd. Cada item abre numa aba com o editor do tipo dele; o botão Novo abre o
 * modal de criar.
 */
export default function Explorer(props: {
  ws: ReturnType<typeof useWorkspace>
  /** Nova requisição no Quick Request (o mesmo do modal Novo). */
  onNewRequest?: () => void
  activeKey: string | null
  activeDoc: DocRef | null
  activeFlowId: string | null
  /** Grip e botão de mover do cabeçalho (o shell decide onde o explorador fica). */
  dock?: ReactNode
  /** Menu do cabeçalho (mover para outro lado). */
  headerMenu?: { onContextMenu: (e: MouseEvent<HTMLElement>) => void }
}) {
  const ws = props.ws
  const [flows, setFlows] = useState<FlowCatalog['flows']>([])
  const [files, setFiles] = useState<{ markdown: string[]; diagrams: string[] }>({ markdown: [], diagrams: [] })
  const [collapsed, setCollapsed] = useState(rememberedCollapsed)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  // Bases com conectores que herdam delas começam abertas; aqui ficam as que a pessoa fechou.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const [later, setLater] = useState(() => convertLater())
  const [filter, setFilter] = useState('')
  const [converting, setConverting] = useState(false)
  const dialog = usePromptDialog()
  const notify = useToast()
  const ctx = useContextMenu()

  const loadFiles = useCallback(() => {
    void window.vvpost.listFlows().then((r) => setFlows(r.ok && r.value ? r.value.flows : []))
    void window.vvpost.docsFiles().then((r) => setFiles(r.ok ? r.value : { markdown: [], diagrams: [] }))
  }, [])
  // Lê depois do primeiro paint e de novo quando a janela volta ao foco ou um arquivo muda.
  useEffect(() => {
    const handle = requestIdleCallback(loadFiles, { timeout: 2000 })
    for (const name of ['focus', WORKSPACE_CHANGED, FILES_CHANGED]) window.addEventListener(name, loadFiles)
    return () => {
      cancelIdleCallback(handle)
      for (const name of ['focus', WORKSPACE_CHANGED, FILES_CHANGED]) window.removeEventListener(name, loadFiles)
    }
  }, [loadFiles])

  const toggleSection = (s: Section) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      try {
        localStorage.setItem(SECTIONS_KEY, JSON.stringify([...next]))
      } catch {
        // sem armazenamento local: só não lembra
      }
      return next
    })
  const flip = (set: typeof setExpanded) => (id: string) =>
    set((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggle = flip(setExpanded)
  const toggleBase = flip(setClosed)

  const q = filter.trim().toLowerCase()
  const hit = (...texts: (string | undefined)[]) => !q || texts.some((t) => t?.toLowerCase().includes(q))
  const connectors = useMemo(
    () =>
      (ws.workspace?.connectors ?? []).flatMap((c) => {
        const endpoints = c.endpoints.filter((e) => hit(c.name, c.id, e.name, e.path, ...e.scenarios.map((s) => s.name)))
        return hit(c.name, c.id) || endpoints.length ? [{ ...c, endpoints: hit(c.name, c.id) ? c.endpoints : endpoints }] : []
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws.workspace, q]
  )
  // Do Compartilhado (e do catálogo da organização), só o que algum conector do projeto herda; o resto fica atrás de um clique.
  const [showUnused, setShowUnused] = useState(false)
  const unused = useMemo(() => unusedShared(ws.workspace?.connectors ?? []), [ws.workspace])
  const visible = useMemo(
    () => (showUnused || q ? connectors : connectors.filter((c) => !unused.has(c.id))),
    [connectors, unused, showUnused, q]
  )
  const tree = useMemo(() => byInheritance(visible), [visible])
  const doc = props.activeDoc
  // Com filtro, tudo que bate fica aberto.
  const isOpen = (id: string) => !!q || expanded.has(id)
  const isBaseOpen = (id: string) => !!q || !closed.has(id)

  const section = (s: Section, label: string, count: number, children: ReactNode, extra: Partial<SectionMenuContext> = {}) => (
    <div role="group" aria-label={label}>
      <button
        type="button"
        {...ctx.bind(label, () =>
          sectionMenu(s, { collapsed: collapsed.has(s), toggle: () => toggleSection(s), reload: reloadAll, ...extra }, deps)
        )}
        onClick={() => toggleSection(s)}
        aria-expanded={!collapsed.has(s)}
        className="flex h-7 w-full items-center gap-1 px-1 text-[11px] font-medium tracking-wide text-faint uppercase hover:text-fg"
      >
        {collapsed.has(s) ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
        <span className="flex-1 text-left">{label}</span>
        <span className="font-normal tabular-nums">{count}</span>
      </button>
      {!collapsed.has(s) && <div className="flex flex-col pb-1">{children}</div>}
    </div>
  )

  // A paleta converte mesmo com a faixa dispensada; o convert de cada render fica no ref.
  const convertRef = useRef<() => Promise<void>>(async () => {})
  const ready = !!ws.workspace
  useEffect(() => (ready ? onConvertRequest(() => void convertRef.current()) : undefined), [ready])

  if (!ws.workspace) {
    return (
      <aside aria-label="Explorador do projeto" className="flex h-full w-full flex-col gap-3 bg-panel p-3 text-xs">
        <p className="text-muted">Nenhum workspace aberto.</p>
        <Button size="sm" icon={<FolderOpen size={14} aria-hidden />} onClick={ws.open}>
          Abrir workspace…
        </Button>
      </aside>
    )
  }

  const md = files.markdown.filter((f) => hit(f))
  const mmd = files.diagrams.filter((f) => hit(f))
  // Fluxos-base e de requisição aparecem em Conectores, pela herança.
  const compiled = new Set(ws.workspace.flowFiles ?? [])
  const flowList = flows.filter((f) => !compiled.has(f.file) && hit(f.flow.name, f.file))
  const legacy = later.includes(ws.workspace.dir) ? 0 : (ws.workspace.legacy ?? 0)
  const postpone = () => {
    const next = [...later, ws.workspace!.dir]
    setLater(next)
    try {
      localStorage.setItem(CONVERT_LATER_KEY, JSON.stringify(next))
    } catch {
      // sem armazenamento local: volta na próxima vez
    }
  }
  const convert = async () => {
    setConverting(true)
    try {
      const outcome = await convertToFlows(dialog.confirm)
      if (outcome) notify(outcome.message, outcome.tone)
      if (outcome?.tone === 'success') {
        ws.reload()
        loadFiles()
        window.dispatchEvent(new Event(FILES_CHANGED))
      }
    } finally {
      setConverting(false)
    }
  }

  // Um fluxo de um nó abre na visão Simples (Quick Request), a menos que já esteja aberto no canvas.
  const openFlow = ({ file, flow, version }: FlowCatalog['flows'][number]) => {
    const inCanvas = tabSource('flows')?.tabs.some((t) => t.id === flow.id)
    if (inCanvas || !openFlowAsRequest(flow, { file, version }, 'explorer')) navigate({ module: 'flows', flowId: flow.id })
  }

  convertRef.current = convert

  const reloadAll = () => {
    ws.reload()
    loadFiles()
  }
  const fileRef = (file: string): DocRef => (/\.mmd$/i.test(file) ? { kind: 'diagram', file } : { kind: 'markdown', file })
  const afterFileChange = () => {
    loadFiles()
    window.dispatchEvent(new Event(FILES_CHANGED))
  }

  const deps: ExplorerMenuDeps = {
    navigate,
    openQuick: openInQuickRequest,
    copy: (text, what) => void navigator.clipboard.writeText(text).then(() => notify(`${what} na área de transferência.`, 'success')),
    reveal: (path) => void window.vvpost.revealInFolder({ workspacePath: path }).then((r) => !r.ok && notify(r.message, 'danger')),
    remove: async ({ title, message, ops, done }) => {
      if (!(await dialog.confirm({ title, message, confirmLabel: 'Excluir', danger: true }))) return
      const r = await window.vvpost.editProject(ops)
      if (!r.ok) return notify(r.message, 'danger')
      notify(done, 'success')
      ws.reload()
      loadFiles()
      window.dispatchEvent(new Event(FILES_CHANGED))
    },
    renameFile: async (file) => {
      const ext = file.slice(file.lastIndexOf('.'))
      const to = await dialog.prompt({
        title: 'Renomear',
        message: 'O caminho é relativo ao workspace; mudar a pasta move o arquivo. Os {{> include}} que apontam para o nome antigo não mudam.',
        label: 'Novo caminho',
        initial: file,
        confirmLabel: 'Renomear',
        validate: (v) => (v.toLowerCase().endsWith(ext.toLowerCase()) ? undefined : `O nome precisa terminar em ${ext}.`)
      })
      if (!to || to === file) return
      const r = await window.vvpost.renameDocsFile({ from: file, to })
      if (!r.ok) return notify(r.message, 'danger')
      closeDocTab(fileRef(file))
      notify(`Renomeado para ${r.value.file}.`, 'success')
      afterFileChange()
    },
    removeFile: async (file) => {
      const ok = await dialog.confirm({
        title: `Excluir ${file.slice(file.lastIndexOf('/') + 1)}?`,
        message: `O arquivo ${file} é apagado do workspace. Dá para recuperar pelo Git.`,
        confirmLabel: 'Excluir',
        danger: true
      })
      if (!ok) return
      const r = await window.vvpost.deleteDocsFile(file)
      if (!r.ok) return notify(r.message, 'danger')
      closeDocTab(fileRef(file))
      notify(`${file} excluído.`, 'success')
      afterFileChange()
    },
    create: (kind) => {
      switch (kind) {
        case 'request':
          return props.onNewRequest ? props.onNewRequest() : showNewItem()
        case 'connector':
          return openDoc({ kind: 'connector', connectorId: null })
        case 'diagram':
          return openDoc({ kind: 'diagram', file: null })
        case 'environment':
          return navigate({ module: 'secrets' })
        default:
          return showNewItemStep(kind)
      }
    }
  }

  const connectorRow = (c: CatalogConnector, depth: number): ReactNode => {
    const kids = tree.children.get(c.id) ?? []
    const open = kids.length ? isBaseOpen(c.id) : isOpen(c.id)
    return (
      <div key={c.id}>
        <Row
          depth={depth}
          icon={<Network {...icon} className={c.error ? 'text-danger' : undefined} />}
          label={
            <>
              {c.name}
              {c.shared && <span className="ml-1.5 text-[10px] text-faint">compartilhado</span>}
            </>
          }
          title={`${c.id}${c.file ? ` · ${c.file}` : ''}${c.shared ? ` · compartilhado (${c.shared}), só leitura` : ''}${c.error ? ` · ${c.error}` : ''}`}
          active={doc?.kind === 'connector' && doc.connectorId === c.id}
          expanded={open}
          onToggle={kids.length ? () => toggleBase(c.id) : c.endpoints.length ? () => toggle(c.id) : undefined}
          onOpen={() => openDoc({ kind: 'connector', connectorId: c.id })}
          menu={ctx.bind(`Conector ${c.name}`, () => connectorMenu(c, () => openDoc({ kind: 'connector', connectorId: c.id }), deps))}
        />
        {open && kids.map((k) => connectorRow(k, depth + 1))}
        {open &&
          c.endpoints.map((e) => {
            const key = `${c.id}/${e.id}`
            const flow = e.flowFile ? flows.find((f) => f.file === e.flowFile) : undefined
            // Um endpoint que é um fluxo de requisição abre como o fluxo: a visão Simples, ou o canvas se já aberto lá.
            const openEndpoint = () => (flow ? openFlow(flow) : openDoc({ kind: 'endpoint', connectorId: c.id, endpointId: e.id }))
            return (
              <div key={e.id}>
                <Row
                  depth={depth + 1}
                  icon={<MethodBadge method={e.method} className="!h-4 min-w-9 !px-1 text-[10px]" />}
                  label={e.name}
                  active={doc?.kind === 'endpoint' && doc.connectorId === c.id && doc.endpointId === e.id}
                  title={e.flowFile ? `${e.path} · ${e.flowFile}` : e.path}
                  expanded={isOpen(key)}
                  onToggle={e.scenarios.length ? () => toggle(key) : undefined}
                  onOpen={openEndpoint}
                  menu={ctx.bind(`Endpoint ${e.name}`, () => endpointMenu(c, e, openEndpoint, deps, flow?.flow.id))}
                />
                {isOpen(key) &&
                  e.scenarios.map((s) => (
                    <Row
                      key={s.id}
                      depth={depth + 2}
                      icon={<FlaskConical {...icon} />}
                      label={s.name}
                      active={doc?.kind === 'scenario' && doc.connectorId === c.id && doc.endpointId === e.id && doc.scenarioId === s.id}
                      onOpen={() => openDoc({ kind: 'scenario', connectorId: c.id, endpointId: e.id, scenarioId: s.id })}
                      menu={ctx.bind(`Cenário ${s.name}`, () =>
                        scenarioMenu(c, e, s, () => openDoc({ kind: 'scenario', connectorId: c.id, endpointId: e.id, scenarioId: s.id }), deps)
                      )}
                    />
                  ))}
              </div>
            )
          })}
      </div>
    )
  }
  const envs = ws.workspace.environments.filter((e) => hit(e.name, e.id))

  return (
    <aside aria-label="Explorador do projeto" className="flex h-full w-full flex-col bg-panel">
      <div className={cx('flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1', props.dock ? 'pl-1' : 'pl-3')} {...props.headerMenu}>
        {props.dock}
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide text-faint uppercase" title={ws.workspace.dir}>
          Explorador
        </span>
        <IconButton
          label="Recarregar"
          onClick={() => {
            ws.reload()
            loadFiles()
          }}
        >
          <RefreshCw {...icon} />
        </IconButton>
        <Button size="sm" variant="primary" icon={<Plus size={14} aria-hidden />} onClick={showNewItem} title="Criar novo (Ctrl+Shift+N)">
          Novo
        </Button>
      </div>
      <label className="mx-2 mt-2 flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-2 text-xs text-muted focus-within:border-accent">
        <Search size={12} aria-hidden />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
          placeholder="Filtrar"
          aria-label="Filtrar o explorador"
          className="min-w-0 flex-1 bg-transparent outline-none"
        />
      </label>
      {legacy > 0 && (
        <div className="mx-2 mt-2 flex shrink-0 flex-col gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface p-2 text-xs text-muted">
          <p>
            {legacy} conector(es) no formato antigo. Em fluxos, a autenticação e cada requisição viram um arquivo que herda da base.
          </p>
          <div className="flex gap-1.5">
            <Button size="sm" icon={<ArrowRightLeft size={14} aria-hidden />} onClick={() => void convert()} disabled={converting}>
              Converter para fluxos
            </Button>
            <Button size="sm" variant="ghost" onClick={postpone} title="Depois, pela paleta (Ctrl+K): Converter conectores para fluxos">
              Agora não
            </Button>
          </div>
        </div>
      )}
      <div role="tree" aria-label="Arquivos do projeto" className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {section(
          'connectors',
          'Conectores',
          visible.length,
          <>
            {tree.roots.map((c) => connectorRow(c, 0))}
            {!q && unused.size > 0 && (
              <button
                type="button"
                onClick={() => setShowUnused((v) => !v)}
                aria-expanded={showUnused}
                title="Bases do Compartilhado que nenhum conector deste projeto herda"
                className="flex h-7 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-left text-[11px] text-faint hover:bg-elevated hover:text-fg"
              >
                <Boxes {...icon} />
                {showUnused ? 'Esconder' : 'Mostrar'} {unused.size} do Compartilhado sem uso aqui
              </button>
            )}
          </>,
          {
            expandAll: () => {
              setClosed(new Set())
              setExpanded(new Set(visible.flatMap((c) => [c.id, ...c.endpoints.filter((e) => e.scenarios.length).map((e) => `${c.id}/${e.id}`)])))
            },
            collapseAll: () => {
              setExpanded(new Set())
              setClosed(new Set(visible.map((c) => c.id)))
            },
            legacy: ws.workspace.legacy ?? 0,
            convert: () => void convert(),
            unused: q ? 0 : unused.size,
            showUnused,
            toggleUnused: () => setShowUnused((v) => !v)
          }
        )}
        {section(
          'flows',
          'Fluxos',
          flowList.length,
          flowList.map(({ file, flow }) => (
            <Row
              key={flow.id}
              depth={0}
              icon={<Workflow {...icon} />}
              label={flow.name}
              title={file}
              active={props.activeFlowId === flow.id}
              onOpen={() => openFlow({ file, flow })}
              menu={ctx.bind(`Fluxo ${flow.name}`, () => flowMenu(flow, file, () => openFlow({ file, flow }), deps))}
            />
          ))
        )}
        {section(
          'environments',
          'Ambientes',
          envs.length,
          envs.map((e) => (
            <Row
              key={e.id}
              depth={0}
              icon={<KeyRound {...icon} className={e.missingSecrets.length ? 'text-warning' : undefined} />}
              label={e.name}
              title={e.missingSecrets.length ? `${e.missingSecrets.length} segredo(s) pendente(s)` : e.id}
              active={props.activeKey === 'tool:secrets'}
              onOpen={() => navigate({ module: 'secrets', environmentId: e.id })}
              menu={ctx.bind(`Ambiente ${e.name}`, () => environmentMenu(e, () => navigate({ module: 'secrets', environmentId: e.id }), deps))}
            />
          ))
        )}
        {section(
          'docs',
          'Documentos',
          md.length,
          md.map((f) => (
            <Row
              key={f}
              depth={0}
              icon={<BookOpen {...icon} />}
              label={f.replace(/^docs\//, '')}
              title={f}
              active={doc?.kind === 'markdown' && doc.file === f}
              onOpen={() => openDoc({ kind: 'markdown', file: f })}
              menu={ctx.bind(`Documento ${f}`, () => fileMenu(f, () => openDoc({ kind: 'markdown', file: f }), deps))}
            />
          ))
        )}
        {section(
          'diagrams',
          'Diagramas',
          mmd.length,
          mmd.map((f) => (
            <Row
              key={f}
              depth={0}
              icon={<Shapes {...icon} />}
              label={f.replace(/^docs\/diagramas\//, '')}
              title={f}
              active={doc?.kind === 'diagram' && doc.file === f}
              onOpen={() => openDoc({ kind: 'diagram', file: f })}
              menu={ctx.bind(`Diagrama ${f}`, () => fileMenu(f, () => openDoc({ kind: 'diagram', file: f }), deps))}
            />
          ))
        )}
        {q && !connectors.length && !flowList.length && !envs.length && !md.length && !mmd.length && (
          <p className="px-2 py-3 text-xs text-muted">Nada com “{filter}”.</p>
        )}
      </div>
      {dialog.element}
      {ctx.menu}
    </aside>
  )
}
