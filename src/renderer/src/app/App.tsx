import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { listenDiskChanges } from '../lib/disk-changes'
import { WriteProblems } from './shell/WriteProblems'
import {
  ArrowLeftRight,
  BookOpen,
  Bot,
  FolderOpen,
  FolderPlus,
  FolderTree,
  KeyRound,
  Layers,
  LayoutTemplate,
  ListChecks,
  PanelsTopLeft,
  Plus,
  RotateCcw,
  Save,
  Search,
  TextCursorInput,
  TextSearch,
  Trash2,
  Webhook,
  Workflow,
  X,
  Zap
} from 'lucide-react'
import type { DocScope } from '@shared/ipc'
import {
  CommandPalette,
  emptyFind,
  formatShortcut,
  matchesShortcut,
  dockEntries,
  DockGrip,
  moveLabel,
  PanelActiveContext,
  requestDock,
  ResizeHandle,
  useContextMenu,
  useDock,
  Shortcut,
  separator,
  TextEditMenu,
  ToastProvider,
  useCommandRegistry,
  usePromptDialog,
  WorkspaceTabs,
  type Command,
  type ContextMenuEntries,
  type FindState
} from '../design-system'
import { NAVIGATE, type NavigateTarget } from '../lib/navigate'
import { PageFind } from './PageFind'
import { panels } from '../panels/registry'
import { useWorkspace, WORKSPACE_CHANGED } from '../panels/useWorkspace'
import { tabSource, useTabSources } from '../lib/shell-tabs'
import { focusQuickRequestUrl, OPEN_REQUEST, openInQuickRequest } from '../lib/open-request'
import { track } from '../lib/ux-study'
import {
  applyNamedLayout,
  deleteNamedLayout,
  layoutScope,
  MAX_LAYOUT_NAME,
  namedLayouts,
  resetLayout,
  saveNamedLayout,
  setLayoutScope,
  useLayoutChoice,
  usePanelSize
} from '../lib/layout'
import { moduleOpening, useModuleShown } from '../lib/perf'
import { ProjectSearch } from './ProjectSearch'
import { OPEN_DOCS, openDocs } from '../modules/docs/open'
import { Sidebar } from './shell/Sidebar'
import { EnterpriseBar } from './shell/EnterpriseBar'
import { Onboarding, showOnboarding } from './shell/Onboarding'
import { NewProject, showNewProject } from './shell/NewProject'
import { StatusBar } from './shell/StatusBar'
import { TopBar } from './shell/TopBar'
import { showNewWorkspaceProject, showProjectMenu } from './shell/ProjectSwitcher'
import { requestConvertToFlows } from './workspace/convert-request'
import { AppServicesContext, useAppServices } from './shell/useAppServices'
import { DocTabHost } from './workspace/DocTabHost'
import { docsAfterProjectSwitch, PROJECT_PANELS, projectIdentity, tabsLeavingProject } from './workspace/project-switch'
import { CLOSE_DOC, docKey, docTitle, OPEN_DOC, type DocRef } from './workspace/docs'
import { docIcon } from './workspace/icons'
import { NewItem, showNewItem } from './workspace/NewItem'
import { mergeOrder, neighborOf, parseSourceKey, sourceKey } from './workspace/order'

// A documentação rica (marked, Mermaid) é um chunk à parte, carregado no primeiro pedido.
const DocsViewer = lazy(() => import('../modules/docs/DocsViewer'))
// O explorador do projeto só carrega quando aparece (fechado em janela estreita).
const Explorer = lazy(() => import('./workspace/Explorer'))

/** Dentro do Suspense do módulo: só monta quando o chunk do módulo carregou (lib/perf). */
function ModuleShown(props: { id: string; active: boolean }) {
  useModuleShown(props.id, props.active)
  return null
}

/** Um módulo montado: só redesenha quando fica visível ou oculto, não a cada mudança do shell. */
const PanelHost = memo(function PanelHost(props: { id: string; component: ComponentType; visible: boolean; active: boolean }) {
  const Panel = props.component
  return (
    <div className="h-full" hidden={!props.visible} data-find-root={props.id}>
      <PanelActiveContext.Provider value={props.active}>
        <Suspense fallback={null}>
          <Panel />
          <ModuleShown id={props.id} active={props.visible} />
        </Suspense>
      </PanelActiveContext.Provider>
    </div>
  )
})

/** Módulos que publicam as próprias abas (vários documentos abertos) na barra do workspace. */
const SOURCE_PANELS = new Set(['quick-request', 'flows'])
const SOURCE_ICON: Record<string, typeof Zap> = { 'quick-request': Zap, flows: Workflow }
const tabIcon = { size: 13, strokeWidth: 1.75, 'aria-hidden': true, className: 'shrink-0 text-faint' } as const

// Antes do layout por workspace (lib/layout), a escolha ficava aqui: vira o padrão.
const EXPLORER_KEY = 'vvpost.shell.explorer'
function rememberedExplorer(): boolean {
  try {
    const v = localStorage.getItem(EXPLORER_KEY)
    // Sem escolha lembrada: aberto em janela larga; em 150% ou notebook, a área de trabalho fica com o espaço.
    return v === null ? window.innerWidth >= 1400 : v === 'open'
  } catch {
    return false
  }
}

const EXPLORER_MIN = 180
const EXPLORER_MAX = 720
const EXPLORER_SIDES = ['left', 'right', 'bottom'] as const
const EXPLORER_HEIGHT = { fallback: 240, min: 120, max: 900 }
const INSPECTOR_SIDES = ['left', 'right', 'bottom'] as const
const SIDE_LIST_SIDES = ['left', 'right'] as const
const SHOWN = ['open', 'closed'] as const

const insertAfter = (order: readonly string[], anchor: string | null, key: string): string[] => {
  const i = anchor ? order.indexOf(anchor) : -1
  return i < 0 ? [...order, key] : [...order.slice(0, i + 1), key, ...order.slice(i + 1)]
}

/**
 * AppShell: barra superior com o workspace e o módulo ativo,
 * sidebar de 48 px que troca de módulo, a área de trabalho e a barra de status. Módulos já
 * abertos ficam montados (preservam o estado ao trocar); os nunca abertos não custam nada.
 */
export function App() {
  /**
   * A aba ativa: "src:<módulo>" é a aba ativa do módulo que publica abas (Quick Request, Flow
   * Studio); "tool:<módulo>", um módulo de ferramenta; "doc:...", um arquivo aberto numa aba.
   */
  const [activeKey, setActiveKey] = useState(`src:${panels[0]!.id}`)
  const [opened, setOpened] = useState<readonly string[]>(() => [panels[0]!.id])
  const [order, setOrder] = useState<readonly string[]>([])
  const [docTabs, setDocTabs] = useState<ReadonlyMap<string, DocRef>>(new Map())
  const [dirtyDocs, setDirtyDocs] = useState<ReadonlySet<string>>(new Set())
  const [palette, setPalette] = useState<false | 'commands' | 'search'>(false)
  const [docs, setDocs] = useState<DocScope | null>(null)
  const [find, setFind] = useState<FindState | null>(null)
  const [findFocus, setFindFocus] = useState(0)
  const [findRoot, setFindRoot] = useState<HTMLElement | null>(null)
  const main = useRef<HTMLElement>(null)
  const services = useAppServices()
  const registry = useCommandRegistry()
  const ws = useWorkspace()
  const sources = useTabSources()
  const dialog = usePromptDialog()
  const [layouts, setLayouts] = useState(namedLayouts)
  // Layout (largura e lado do explorador, painéis dos módulos) lembrado por workspace: lib/layout.
  const scope = layoutScope(services.workspace)
  useLayoutEffect(() => setLayoutScope(scope), [scope])
  const explorerSize = usePanelSize('explorer.width', { fallback: 240, min: EXPLORER_MIN, max: EXPLORER_MAX })
  const [explorerSide, setExplorerSide] = useLayoutChoice('explorer.side', 'left', EXPLORER_SIDES)
  const explorerHeightSize = usePanelSize('explorer.height', EXPLORER_HEIGHT)
  // Arrastar o explorador pelo grip, como uma view do VS Code: a área é a janela de trabalho.
  const workbench = useRef<HTMLDivElement>(null)
  const explorerDock = useDock({ label: 'o explorador', area: () => workbench.current, sides: EXPLORER_SIDES, current: explorerSide, move: setExplorerSide })
  const shellMenu = useContextMenu()
  const [explorerShown, setExplorerShown] = useLayoutChoice('explorer.shown', rememberedExplorer() ? 'open' : 'closed', SHOWN)
  const explorer = explorerShown === 'open'

  const visiblePanel = activeKey.startsWith('src:') ? activeKey.slice(4) : activeKey.startsWith('tool:') ? activeKey.slice(5) : null
  const activeSource = activeKey.startsWith('src:') ? sources.get(activeKey.slice(4)) : undefined
  const shownKey = activeKey.startsWith('src:')
    ? activeSource?.activeId
      ? sourceKey(activeKey.slice(4), activeSource.activeId)
      : null
    : activeKey
  const shownRef = useRef(shownKey)
  shownRef.current = shownKey
  const orderRef = useRef(order)
  orderRef.current = order
  const dirtyRef = useRef(dirtyDocs)
  dirtyRef.current = dirtyDocs

  // As abas que os módulos publicam entram na barra na ordem deles (workspace/order).
  useEffect(() => {
    const map = new Map(sources.owners().map((o) => [o, sources.get(o)!.tabs.map((t) => t.id)] as const))
    setOrder((prev) => {
      const next = mergeOrder(prev, map, shownRef.current ?? undefined)
      return next.length === prev.length && next.every((k, i) => k === prev[i]) ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources.version])

  const setExplorer = useCallback((open: boolean) => setExplorerShown(open ? 'open' : 'closed'), [setExplorerShown])

  // "Gerar documentação" do menu de contexto de qualquer módulo abre a visualização aqui.
  useEffect(() => {
    const onOpen = (e: Event) => setDocs((e as CustomEvent<DocScope>).detail)
    window.addEventListener(OPEN_DOCS, onOpen)
    return () => window.removeEventListener(OPEN_DOCS, onOpen)
  }, [])

  const visibleRef = useRef(visiblePanel)
  visibleRef.current = visiblePanel
  /** Mostra o módulo `id`: o que publica abas fica na aba ativa dele; uma ferramenta ganha a própria aba. */
  const open = useCallback((id: string) => {
    setDocs(null)
    // Teste com usuários e bench de módulos: troca de módulo e o tempo até ele aparecer (lib/perf).
    if (id !== visibleRef.current) {
      track('module', { id })
      moduleOpening(id)
    }
    const key = SOURCE_PANELS.has(id) ? `src:${id}` : `tool:${id}`
    if (key.startsWith('tool:')) setOrder((prev) => (prev.includes(key) ? prev : insertAfter(prev, shownRef.current, key)))
    setActiveKey(key)
    setOpened((prev) => (prev.includes(id) ? prev : [...prev, id]))
  }, [])

  const selectTab = useCallback(
    (key: string) => {
      const src = parseSourceKey(key)
      if (src) {
        open(src.owner)
        tabSource(src.owner)?.select(src.id)
      } else if (key.startsWith('tool:')) open(key.slice(5))
      else {
        setDocs(null)
        setActiveKey(key)
      }
    },
    [open]
  )

  /** Fecha a aba `key`; se era a ativa, a vizinha fica ativa (a do mesmo módulo, o próprio módulo escolhe). */
  const closeTab = useCallback(
    async (key: string) => {
      const src = parseSourceKey(key)
      const wasShown = key === shownRef.current
      const neighbor = wasShown ? neighborOf(orderRef.current, key) : undefined
      const focusNeighbor = () => {
        if (!wasShown) return
        if (neighbor) selectTab(neighbor)
        else open(panels[0]!.id)
      }
      if (src) {
        tabSource(src.owner)?.close(src.id)
        if (neighbor && parseSourceKey(neighbor)?.owner !== src.owner) focusNeighbor()
        return
      }
      if (key.startsWith('doc:') && dirtyRef.current.has(key)) {
        const ok = await dialog.confirm({
          title: 'Fechar sem salvar?',
          message: 'As mudanças desta aba ainda não foram salvas e vão se perder.',
          confirmLabel: 'Fechar sem salvar',
          danger: true
        })
        if (!ok) return
      }
      setOrder((prev) => prev.filter((k) => k !== key))
      if (key.startsWith('tool:')) setOpened((prev) => prev.filter((id) => id !== key.slice(5)))
      else {
        setDocTabs((prev) => {
          const next = new Map(prev)
          next.delete(key)
          return next
        })
        setDirtyDocs((prev) => (prev.has(key) ? new Set([...prev].filter((k) => k !== key)) : prev))
      }
      focusNeighbor()
    },
    [dialog, open, selectTab]
  )

  /** Abre um arquivo numa aba (o mesmo arquivo volta à aba que já existe). */
  const openDocTab = useCallback((ref: DocRef) => {
    const key = docKey(ref)
    setDocTabs((prev) => (prev.has(key) ? prev : new Map(prev).set(key, ref)))
    setOrder((prev) => (prev.includes(key) ? prev : insertAfter(prev, shownRef.current, key)))
    setDocs(null)
    setActiveKey(key)
  }, [])

  /** O documento novo virou um arquivo: a aba passa a ser a dele, no mesmo lugar. */
  const replaceDoc = useCallback((key: string, ref: DocRef) => {
    const next = docKey(ref)
    setDocTabs((prev) => {
      const map = new Map(prev)
      map.delete(key)
      return map.set(next, ref)
    })
    setOrder((prev) => (prev.includes(next) ? prev.filter((k) => k !== key) : prev.map((k) => (k === key ? next : k))))
    setDirtyDocs((prev) => (prev.has(key) ? new Set([...prev].filter((k) => k !== key)) : prev))
    setActiveKey((k) => (k === key ? next : k))
  }, [])

  const markDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyDocs((prev) => {
      if (prev.has(key) === dirty) return prev
      const next = new Set(prev)
      if (dirty) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  const closeDoc = useCallback((key: string) => void closeTab(key), [closeTab])

  // Trocou de projeto (ou de pasta): as abas de arquivo e a documentação aberta eram do anterior.
  // As abas sem mudanças fecham; a documentação do projeto é gerada de novo, a de um conector fecha;
  // o módulo Documentação remonta com o projeto novo (key do PanelHost).
  const project = projectIdentity(services.workspace)
  const docTabsRef = useRef(docTabs)
  docTabsRef.current = docTabs
  const lastProject = useRef(project)
  useEffect(() => {
    const before = lastProject.current
    if (project === null || project === before) return
    lastProject.current = project
    if (before === null) return
    setDocs(docsAfterProjectSwitch)
    const leaving = new Set(tabsLeavingProject(docTabsRef.current, dirtyRef.current))
    if (!leaving.size) return
    setDocTabs((prev) => new Map([...prev].filter(([key]) => !leaving.has(key))))
    setOrder((prev) => prev.filter((k) => !leaving.has(k)))
    if (leaving.has(activeKeyRef.current)) {
      const neighbor = orderRef.current.filter((k) => !leaving.has(k) || k === activeKeyRef.current)
      const next = neighborOf(neighbor, activeKeyRef.current)
      if (next) selectTab(next)
      else open(panels[0]!.id)
    }
  }, [project, open, selectTab])

  useEffect(() => {
    const onOpenDoc = (e: Event) => openDocTab((e as CustomEvent<DocRef>).detail)
    window.addEventListener(OPEN_DOC, onOpenDoc)
    return () => window.removeEventListener(OPEN_DOC, onOpenDoc)
  }, [openDocTab])

  // O explorador renomeou ou excluiu o arquivo de uma aba aberta.
  useEffect(() => {
    const onCloseDoc = (e: Event) => void closeTab((e as CustomEvent<string>).detail)
    window.addEventListener(CLOSE_DOC, onCloseDoc)
    return () => window.removeEventListener(CLOSE_DOC, onCloseDoc)
  }, [closeTab])

  // Arquivos gravados fora do app (agente pelo MCP, CLI, editor, Git): catálogo, explorador e abas releem.
  useEffect(() => listenDiskChanges(), [])

  // "Abrir no Catálogo", "Abrir em Tests"...: o módulo de destino recebe o alvo (lib/navigate).
  useEffect(() => {
    const onNavigate = (e: Event) => open((e as CustomEvent<NavigateTarget>).detail.module)
    window.addEventListener(NAVIGATE, onNavigate)
    return () => window.removeEventListener(NAVIGATE, onNavigate)
  }, [open])

  // "Abrir no Quick Request" (histórico, catálogo, testes): troca de módulo; o Quick Request abre a aba.
  useEffect(() => {
    const toQuick = () => open('quick-request')
    window.addEventListener(OPEN_REQUEST, toQuick)
    return () => window.removeEventListener(OPEN_REQUEST, toQuick)
  }, [open])

  const switchWorkspace = useCallback(() => {
    void window.vvpost.openWorkspace().then(() => {
      services.refresh()
      window.dispatchEvent(new Event(WORKSPACE_CHANGED))
    })
  }, [services])

  /** Ctrl+L: o campo de URL da aba ativa do Quick Request (o módulo foca quando montar). */
  const focusUrl = useCallback(() => {
    open('quick-request')
    focusQuickRequestUrl()
  }, [open])
  const newRequest = useCallback(() => {
    openInQuickRequest({ method: 'GET', url: '', headers: [], body: '', connectorId: null, environmentId: null, keepContext: true })
    focusUrl()
  }, [focusUrl])

  const explorerRef = useRef(explorer)
  explorerRef.current = explorer
  const activeKeyRef = useRef(activeKey)
  activeKeyRef.current = activeKey
  /** Ctrl+PageDown e Ctrl+PageUp: a aba seguinte ou a anterior da barra. */
  const cycleTab = useCallback(
    (step: 1 | -1) => {
      const list = orderRef.current
      if (!list.length) return
      const i = shownRef.current ? list.indexOf(shownRef.current) : -1
      selectTab(list[(i + step + list.length) % list.length]!)
    },
    [selectTab]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      // Ctrl+F que um editor ou o corpo da resposta não tratou: a busca da tela.
      if (matchesShortcut(e, Shortcut.find)) {
        if (e.defaultPrevented) return
        e.preventDefault()
        setFind((f) => f ?? emptyFind)
        setFindFocus((n) => n + 1)
        return
      }
      const shortcut = ([
        [Shortcut.palette, () => setPalette((v) => (v === 'commands' ? false : 'commands'))],
        [Shortcut.searchProject, () => setPalette((v) => (v === 'search' ? false : 'search'))],
        [Shortcut.newRequest, newRequest],
        [Shortcut.focusUrl, focusUrl],
        [Shortcut.newItem, showNewItem],
        [Shortcut.toggleExplorer, () => setExplorer(!explorerRef.current)],
        [Shortcut.nextTab, () => cycleTab(1)],
        [Shortcut.previousTab, () => cycleTab(-1)],
        // Ctrl+W no Quick Request é do módulo (fecha a requisição com o menu dele).
        ...(activeKeyRef.current === 'src:quick-request' ? [] : ([[Shortcut.closeTab, () => shownRef.current && void closeTab(shownRef.current)]] as const))
      ] as const).find(([s]) => matchesShortcut(e, s))
      if (shortcut) {
        e.preventDefault()
        shortcut[1]()
        return
      }
      // O dígito é fixo por módulo (registry.key), independente da ordem agrupada da sidebar.
      const target = /^[0-9]$/.test(e.key) && !e.shiftKey ? panels.find((p) => p.key === Number(e.key)) : undefined
      if (target) {
        e.preventDefault()
        open(target.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, newRequest, focusUrl, setExplorer, cycleTab, closeTab])

  // A busca da tela procura na documentação aberta ou, sem ela, na aba ativa (módulo ou documento).
  const findKey = docs ? 'docs' : (visiblePanel ?? activeKey)
  useEffect(() => {
    if (!find) return
    const roots = main.current?.querySelectorAll<HTMLElement>('[data-find-root]') ?? []
    setFindRoot([...roots].find((el) => el.dataset.findRoot === findKey) ?? null)
  }, [!!find, findKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const commands = useMemo<Command[]>(
    () => [
      ...panels.map((p) => ({
        id: `open-${p.id}`,
        title: `Abrir ${p.label}`,
        group: 'Módulo',
        ...(p.key !== undefined && { hint: formatShortcut(`Mod+${p.key}`) }),
        icon: <p.icon size={16} aria-hidden />,
        run: () => open(p.id)
      })),
      {
        id: 'new-request',
        title: 'Nova requisição',
        group: 'Quick Request',
        hint: formatShortcut(Shortcut.newRequest),
        icon: <Zap size={16} aria-hidden />,
        keywords: ['request', 'aba'],
        run: newRequest
      },
      {
        id: 'new-item',
        title: 'Novo…',
        group: 'Workspace',
        hint: formatShortcut(Shortcut.newItem),
        icon: <Plus size={16} aria-hidden />,
        keywords: ['criar', 'fluxo', 'conector', 'documento', 'diagrama', 'cenario', 'endpoint'],
        run: () => setTimeout(showNewItem)
      },
      {
        id: 'toggle-explorer',
        title: explorer ? 'Ocultar o explorador' : 'Mostrar o explorador',
        group: 'Workspace',
        hint: formatShortcut(Shortcut.toggleExplorer),
        icon: <FolderTree size={16} aria-hidden />,
        keywords: ['arvore', 'arquivos', 'sidebar'],
        run: () => setExplorer(!explorer)
      },
      ...EXPLORER_SIDES.filter((side) => side !== explorerSide).map((side) => ({
        id: `explorer-dock-${side}`,
        title: moveLabel('o explorador', side),
        group: 'Layout',
        icon: <ArrowLeftRight size={16} aria-hidden />,
        keywords: ['layout', 'posição', 'lado', 'painel', 'sidebar', 'mover', 'explorador'],
        run: () => {
          setExplorerSide(side)
          setExplorer(true)
        }
      })),
      ...INSPECTOR_SIDES.map((side) => ({
        id: `inspector-dock-${side}`,
        title: moveLabel('o inspector', side),
        group: 'Layout',
        icon: <PanelsTopLeft size={16} aria-hidden />,
        keywords: ['layout', 'posição', 'lado', 'painel', 'mover', 'inspector'],
        run: () => requestDock('inspector', side)
      })),
      ...(['top', 'left', 'right'] as const).map((side) => ({
        id: `quick-edit-dock-${side}`,
        title: moveLabel('a edição da requisição', side),
        group: 'Layout',
        icon: <PanelsTopLeft size={16} aria-hidden />,
        keywords: ['layout', 'lado a lado', 'resposta', 'quick request', 'mover', 'dividir'],
        run: () => {
          open('quick-request')
          // O Quick Request precisa estar visível para atender (só o painel visível se move).
          setTimeout(() => requestDock('quick-edit', side))
        }
      })),
      ...SIDE_LIST_SIDES.map((side) => ({
        id: `side-list-dock-${side}`,
        title: moveLabel('a lista lateral', side),
        group: 'Layout',
        icon: <ArrowLeftRight size={16} aria-hidden />,
        keywords: ['layout', 'posição', 'lado', 'painel', 'mover', 'lista', 'árvore', 'sidebar'],
        run: () => requestDock('side-list', side)
      })),
      {
        id: 'inspector-join',
        title: 'Juntar o inspector à lista lateral (como aba)',
        group: 'Layout',
        icon: <PanelsTopLeft size={16} aria-hidden />,
        keywords: ['layout', 'aba', 'abas', 'juntar', 'agrupar', 'inspector', 'lista'],
        run: () => requestDock('inspector', 'join')
      },
      {
        id: 'layout-save',
        title: 'Salvar o layout como…',
        group: 'Layout',
        icon: <Save size={16} aria-hidden />,
        keywords: ['layout', 'nome', 'perfil', 'guardar', 'painéis'],
        run: () =>
          void dialog
            .prompt({
              title: 'Salvar o layout',
              label: 'Nome do layout',
              initial: '',
              validate: (v) => (v.length > MAX_LAYOUT_NAME ? `Até ${MAX_LAYOUT_NAME} caracteres.` : undefined)
            })
            .then((name) => {
              if (!name) return
              saveNamedLayout(name)
              setLayouts(namedLayouts())
            })
      },
      ...layouts.flatMap((name) => [
        {
          id: `layout-apply-${name}`,
          title: `Usar o layout ${name}`,
          group: 'Layout',
          icon: <LayoutTemplate size={16} aria-hidden />,
          keywords: ['layout', 'nome', 'perfil', 'aplicar', 'trocar'],
          run: () => void applyNamedLayout(name)
        },
        {
          id: `layout-delete-${name}`,
          title: `Apagar o layout ${name}`,
          group: 'Layout',
          icon: <Trash2 size={16} aria-hidden />,
          keywords: ['layout', 'nome', 'perfil', 'remover'],
          run: () => {
            deleteNamedLayout(name)
            setLayouts(namedLayouts())
          }
        }
      ]),
      {
        id: 'layout-reset',
        title: 'Restaurar o layout dos painéis',
        group: 'Layout',
        icon: <RotateCcw size={16} aria-hidden />,
        keywords: ['tamanho', 'largura', 'altura', 'painel', 'redimensionar', 'padrão'],
        run: resetLayout
      },
      {
        id: 'focus-url',
        title: 'Ir para a URL',
        group: 'Quick Request',
        hint: formatShortcut(Shortcut.focusUrl),
        icon: <TextCursorInput size={16} aria-hidden />,
        run: focusUrl
      },
      {
        id: 'find',
        title: 'Buscar na tela',
        group: 'Workspace',
        hint: formatShortcut(Shortcut.find),
        icon: <TextSearch size={16} aria-hidden />,
        keywords: ['localizar', 'procurar', 'ctrl+f', 'documentação', 'resposta'],
        run: () => {
          setFind((f) => f ?? emptyFind)
          setFindFocus((n) => n + 1)
        }
      },
      {
        id: 'search-project',
        title: 'Procurar no projeto…',
        group: 'Workspace',
        hint: formatShortcut(Shortcut.searchProject),
        icon: <Search size={16} aria-hidden />,
        keywords: ['conector', 'endpoint', 'fluxo', 'cenario'],
        run: () => setTimeout(() => setPalette('search'))
      },
      {
        id: 'workspace-new',
        title: 'Novo projeto a partir de um modelo…',
        group: 'Workspace',
        keywords: ['criar', 'template', 'começar', 'vazio'],
        icon: <FolderPlus size={16} aria-hidden />,
        run: showNewProject
      },
      {
        id: 'workspace-open',
        title: 'Trocar a pasta do workspace…',
        group: 'Workspace',
        icon: <FolderOpen size={16} aria-hidden />,
        run: switchWorkspace
      },
      ...(services.workspace?.projects
        ? [
            {
              id: 'workspace-project-switch',
              title: 'Trocar de projeto do workspace…',
              group: 'Workspace',
              keywords: ['projeto', 'compartilhado', 'subpasta'],
              icon: <Layers size={16} aria-hidden />,
              run: () => setTimeout(showProjectMenu)
            }
          ]
        : []),
      {
        id: 'workspace-convert-flows',
        title: 'Converter conectores para fluxos…',
        group: 'Workspace',
        keywords: ['migrar', 'migrate', 'fluxo-base', 'formato'],
        icon: <Workflow size={16} aria-hidden />,
        run: () => {
          setExplorer(true)
          requestConvertToFlows()
        }
      },
      {
        id: 'workspace-project-new',
        title: 'Novo projeto no workspace…',
        group: 'Workspace',
        keywords: ['projeto', 'subpasta', 'criar', 'compartilhado'],
        icon: <Layers size={16} aria-hidden />,
        run: () => setTimeout(showNewWorkspaceProject)
      },
      {
        id: 'docs-project',
        title: 'Gerar documentação do projeto',
        group: 'Workspace',
        icon: <BookOpen size={16} aria-hidden />,
        run: () => openDocs({ kind: 'project' })
      },
      {
        id: 'onboarding-show',
        title: 'Mostrar os primeiros passos',
        group: 'Workspace',
        keywords: ['onboarding', 'começar', 'tutorial', 'ajuda'],
        icon: <ListChecks size={16} aria-hidden />,
        run: showOnboarding
      },
      {
        id: 'toggle-secrets',
        title:
          services.engine?.status === 'running'
            ? 'Desligar o mock de Secret Managers'
            : 'Ligar o mock de Secret Managers',
        group: 'Serviço',
        icon: <KeyRound size={16} aria-hidden />,
        run: services.toggleEngine
      },
      {
        id: 'toggle-mcp',
        title: services.mcp?.status === 'running' ? 'Desligar o servidor MCP' : 'Ligar o servidor MCP',
        group: 'Serviço',
        icon: <Bot size={16} aria-hidden />,
        run: services.toggleMcp
      },
      {
        id: 'toggle-webhooks',
        title:
          services.webhooks?.status === 'running'
            ? 'Desligar o servidor de webhooks'
            : 'Ligar o servidor de webhooks',
        group: 'Serviço',
        icon: <Webhook size={16} aria-hidden />,
        run: services.toggleWebhooks
      }
    ],
    [
      open,
      explorer,
      setExplorer,
      explorerSide,
      setExplorerSide,
      newRequest,
      focusUrl,
      switchWorkspace,
      services.engine?.status,
      services.mcp?.status,
      services.webhooks?.status,
      services.toggleEngine,
      services.toggleMcp,
      services.toggleWebhooks,
      services.workspace?.projects,
      layouts,
      dialog.prompt
    ]
  )

  // Títulos das abas de arquivo com os nomes do catálogo.
  const names = useMemo(() => {
    const connectors = ws.workspace?.connectors ?? []
    const connector = (id: string) => connectors.find((c) => c.id === id)
    const endpoint = (c: string, e: string) => connector(c)?.endpoints.find((x) => x.id === e)
    return {
      connector: (id: string) => connector(id)?.name,
      endpoint: (c: string, e: string) => endpoint(c, e)?.name,
      scenario: (c: string, e: string, s: string) => endpoint(c, e)?.scenarios.find((x) => x.id === s)?.name
    }
  }, [ws.workspace])

  const tabs = order.flatMap((key) => {
    const src = parseSourceKey(key)
    if (src) {
      const t = sources.get(src.owner)?.tabs.find((x) => x.id === src.id)
      if (!t) return []
      const Icon = SOURCE_ICON[src.owner] ?? Zap
      return [
        {
          id: key,
          title: t.title,
          dirty: t.dirty,
          icon: t.busy ? <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" /> : <Icon {...tabIcon} />
        }
      ]
    }
    if (key.startsWith('tool:')) {
      const p = panels.find((x) => x.id === key.slice(5))
      return p ? [{ id: key, title: p.label, icon: <p.icon {...tabIcon} /> }] : []
    }
    const ref = docTabs.get(key)
    return ref ? [{ id: key, title: docTitle(ref, names), dirty: dirtyDocs.has(key), icon: <span className="shrink-0 text-faint">{docIcon(ref.kind)}</span> }] : []
  })

  const tabMenu = (key: string): ContextMenuEntries => {
    const src = parseSourceKey(key)
    const own = src ? (sources.get(src.owner)?.menu?.(src.id) ?? []) : []
    const files = order.filter((k) => !parseSourceKey(k) && k !== key)
    return [
      ...own,
      ...(own.length ? [separator] : []),
      ...(src ? [] : [{ id: 'ws-close', label: 'Fechar', icon: <X size={14} aria-hidden />, shortcut: Shortcut.closeTab, run: () => void closeTab(key) }]),
      {
        id: 'ws-close-files',
        label: 'Fechar os outros arquivos e ferramentas',
        disabled: files.length === 0,
        run: () => files.forEach((k) => void closeTab(k))
      },
      { id: 'ws-new', label: 'Novo…', icon: <Plus size={14} aria-hidden />, shortcut: Shortcut.newItem, run: showNewItem }
    ]
  }

  const activeDoc = activeKey.startsWith('doc:') ? (docTabs.get(activeKey) ?? null) : null
  const activeFlowId = activeKey === 'src:flows' ? (sources.get('flows')?.activeId ?? null) : null

  // A área de trabalho guarda pelo menos metade da janela ao lado do explorador.
  const explorerMax = Math.max(EXPLORER_MIN, Math.min(EXPLORER_MAX, Math.round(window.innerWidth / 2)))
  const explorerWidth = Math.min(explorerSize.size, explorerMax)
  // Embaixo, o explorador é o painel do VS Code: guarda pelo menos 200 px para as abas acima.
  const explorerMaxHeight = Math.max(EXPLORER_HEIGHT.min, Math.min(EXPLORER_HEIGHT.max, window.innerHeight - 260))
  const explorerHeight = Math.min(explorerHeightSize.size, explorerMaxHeight)
  const explorerBottom = explorerSide === 'bottom'
  const explorerMoves = () => dockEntries('o explorador', EXPLORER_SIDES, explorerSide, setExplorerSide)
  const explorerPane = (
    <div
      data-explorer-side={explorerSide}
      style={explorerBottom ? { height: explorerHeight } : { width: explorerWidth }}
      className={`relative shrink-0 border-border ${explorerBottom ? 'border-t' : explorerSide === 'left' ? 'border-r' : 'border-l'}`}
    >
      {explorerDock.overlay}
      <Suspense fallback={<div className="h-full bg-panel" />}>
        <Explorer
          ws={ws}
          activeKey={shownKey}
          activeDoc={activeDoc}
          activeFlowId={activeFlowId}
          onNewRequest={newRequest}
          headerMenu={shellMenu.bind('Explorador', explorerMoves)}
          // Só o grip: o menu do cabeçalho e a paleta movem pelo teclado, e o título cabe em 180 px.
          dock={<DockGrip label="o explorador" onPointerDown={explorerDock.onPointerDown} />}
        />
      </Suspense>
      {explorerBottom ? (
        <ResizeHandle
          edge="top"
          label="Altura do explorador"
          size={explorerHeight}
          min={EXPLORER_HEIGHT.min}
          max={explorerMaxHeight}
          onResize={explorerHeightSize.setSize}
          onReset={explorerHeightSize.reset}
          onCollapse={() => setExplorer(false)}
        />
      ) : (
        <ResizeHandle
          edge={explorerSide === 'left' ? 'right' : 'left'}
          label="Largura do explorador"
          size={explorerWidth}
          min={EXPLORER_MIN}
          max={explorerMax}
          onResize={explorerSize.setSize}
          onReset={explorerSize.reset}
          onCollapse={() => setExplorer(false)}
        />
      )}
    </div>
  )


  return (
    <AppServicesContext.Provider value={services}>
      <registry.Provider value={registry.registry}>
        <ToastProvider>
          <WriteProblems />
          <div className="flex h-full flex-col">
            <TopBar
              workspace={services.workspace}
              panels={panels}
              activeId={visiblePanel ?? ''}
              onOpen={open}
              onSwitchWorkspace={switchWorkspace}
              onProjectChanged={services.refresh}
              onPalette={() => setPalette('commands')}
            />
            <EnterpriseBar workspace={services.workspace} engine={services.engine} />
            <div ref={workbench} className="flex min-h-0 flex-1">
              <Sidebar
                panels={panels}
                activeId={visiblePanel}
                onOpen={open}
                onPalette={() => setPalette('commands')}
                explorerOpen={explorer}
                onToggleExplorer={() => setExplorer(!explorer)}
              />
              {explorer && explorerSide === 'left' && explorerPane}
              <div className="flex min-w-0 flex-1 flex-col">
                <WorkspaceTabs
                  label="Abas do workspace"
                  idPrefix="ws"
                  tabs={tabs}
                  activeId={shownKey}
                  onSelect={selectTab}
                  onClose={(key) => void closeTab(key)}
                  onNew={showNewItem}
                  newLabel={`Novo… (${formatShortcut(Shortcut.newItem)})`}
                  contextMenu={(t) => tabMenu(t.id)}
                />
                <main ref={main} className="relative min-h-0 min-w-0 flex-1 bg-surface">
                  {panels
                    .filter((p) => opened.includes(p.id))
                    .map(({ id, component }) => (
                      <PanelHost key={PROJECT_PANELS.has(id) ? `${id}\n${project ?? ''}` : id} id={id} component={component} visible={id === visiblePanel} active={id === visiblePanel && !docs} />
                    ))}
                  {[...docTabs].map(([key, ref]) => (
                    <DocTabHost
                      key={key}
                      tabKey={key}
                      doc={ref}
                      active={key === activeKey && !docs}
                      onClose={closeDoc}
                      onReplace={replaceDoc}
                      onDirty={markDirty}
                    />
                  ))}
                  {docs && (
                    <div className="absolute inset-0 z-20" data-find-root="docs">
                      <Suspense fallback={null}>
                        <DocsViewer key={`${JSON.stringify(docs)}\n${project ?? ''}`} scope={docs} onClose={() => setDocs(null)} />
                      </Suspense>
                    </div>
                  )}
                  {find && (
                    <PageFind root={findRoot} state={find} onChange={setFind} onClose={() => setFind(null)} focusSignal={findFocus} />
                  )}
                </main>
                {explorer && explorerBottom && explorerPane}
              </div>
              {explorer && explorerSide === 'right' && explorerPane}
            </div>
            <StatusBar services={services}>
              <Onboarding
                workspace={services.workspace}
                activeId={visiblePanel ?? ''}
                onOpen={open}
                onOpenWorkspace={switchWorkspace}
              />
            </StatusBar>
          </div>
          {/* As ações do módulo ativo (useMenuCommands) entram antes dos comandos globais. */}
          {palette === 'commands' && (
            <CommandPalette commands={[...registry.commands(), ...commands]} onClose={() => setPalette(false)} />
          )}
          {palette === 'search' && <ProjectSearch onClose={() => setPalette(false)} />}
          <NewProject
            onCreated={() => {
              services.refresh()
              window.dispatchEvent(new Event(WORKSPACE_CHANGED))
              open('quick-request')
            }}
          />
          <NewItem onNewRequest={newRequest} />
          {dialog.element}
          <TextEditMenu />
          {shellMenu.menu}
        </ToastProvider>
      </registry.Provider>
    </AppServicesContext.Provider>
  )
}
