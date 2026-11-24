import { createElement } from 'react'
import {
  ArrowRightLeft,
  BookOpen,
  Boxes,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FlaskConical,
  FolderOpen,
  KeyRound,
  Network,
  Pencil,
  Play,
  RefreshCw,
  Route,
  Shapes,
  SquarePlus,
  Trash2,
  Workflow,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { CatalogConnector, ProjectEdit } from '@shared/ipc'
import { separator, type ContextMenuEntries, type ContextMenuItem } from '../../design-system/navigation/menu-entries'
import { Shortcut } from '../../design-system/navigation/shortcuts'
import type { NavigateTarget } from '../../lib/navigate'
import type { OpenRequest } from '../../lib/open-request'
import { docsMenuItems } from '../../modules/docs/open'

// Menus de contexto (botão direito, Shift+F10) das linhas do explorador. Sem estado: o
// Explorer passa as ações (deps), e os testes conferem os itens sem montar a árvore.

const ic = (I: LucideIcon) => createElement(I, { size: 14, 'aria-hidden': true })

type Endpoint = CatalogConnector['endpoints'][number]

export interface ExplorerMenuDeps {
  navigate: (target: NavigateTarget) => void
  openQuick: (request: OpenRequest) => void
  copy: (text: string, what: string) => void
  /** Caminho relativo ao workspace. */
  reveal: (path: string) => void
  /** Confirma e aplica a exclusão pela camada em lote (editProject). */
  remove: (what: { title: string; message?: string; ops: ProjectEdit[]; done: string }) => void
  /** Pede o novo nome e renomeia (ou move) o .md/.mmd. */
  renameFile: (file: string) => void
  /** Confirma e exclui o .md/.mmd. */
  removeFile: (file: string) => void
  /** Criar um item novo do tipo (direto no editor, ou no passo do modal Novo que pede o nome). */
  create: (kind: NewKind) => void
}

/** O que dá para criar pelo menu de uma seção. */
export type NewKind = 'request' | 'connector' | 'endpoint' | 'scenario' | 'flow' | 'environment' | 'markdown' | 'diagram'

const open = (run: () => void): ContextMenuItem => ({ id: 'open', label: 'Abrir', run })
const copyItem = (id: string, label: string, text: string, done: string, d: ExplorerMenuDeps, shortcut?: string): ContextMenuItem => ({
  id,
  label,
  icon: ic(Copy),
  ...(shortcut && { shortcut }),
  run: () => d.copy(text, done)
})
const revealItem = (path: string, d: ExplorerMenuDeps): ContextMenuItem => ({
  id: 'reveal',
  label: 'Revelar o arquivo',
  icon: ic(FolderOpen),
  shortcut: Shortcut.reveal,
  run: () => d.reveal(path)
})
const deleteItem = (run: () => void): ContextMenuItem => ({ id: 'delete', label: 'Excluir…', icon: ic(Trash2), danger: true, shortcut: Shortcut.remove, run })

export function connectorMenu(c: CatalogConnector, onOpen: () => void, d: ExplorerMenuDeps): ContextMenuEntries {
  const editable = !c.shared && !c.asFlow
  return [
    open(onOpen),
    { id: 'catalog', label: 'Abrir no Catálogo', icon: ic(Network), run: () => d.navigate({ module: 'catalog', connectorId: c.id }) },
    {
      id: 'quick',
      label: 'Nova requisição no conector',
      icon: ic(Zap),
      disabled: !!c.error,
      run: () => d.openQuick({ method: 'GET', url: '', headers: [], body: '', connectorId: c.id, environmentId: null })
    },
    { id: 'tests', label: 'Abrir os cenários em Tests', icon: ic(FlaskConical), run: () => d.navigate({ module: 'scenarios', connectorId: c.id }) },
    separator,
    copyItem('copy-id', 'Copiar o id', c.id, 'Id copiado', d, Shortcut.copy),
    !!c.file && !c.shared && revealItem(c.file, d),
    separator,
    editable &&
      deleteItem(() =>
        d.remove({
          title: `Excluir o conector ${c.name}?`,
          message: `O arquivo ${c.file ?? c.id} (e a documentação .md ao lado) é apagado do workspace. Dá para recuperar pelo Git.`,
          ops: [{ op: 'deleteConnector', id: c.id }],
          done: `Conector ${c.name} excluído.`
        })
      ),
    separator,
    ...(c.shared ? [] : docsMenuItems({ kind: 'connector', connectorId: c.id }))
  ]
}

/** `flowId`: o fluxo de requisição que define o endpoint, quando ele vem de um fluxo. */
export function endpointMenu(c: CatalogConnector, e: Endpoint, onOpen: () => void, d: ExplorerMenuDeps, flowId?: string): ContextMenuEntries {
  const file = e.flowFile ?? c.file
  return [
    open(onOpen),
    {
      id: 'quick',
      label: 'Abrir no Quick Request',
      icon: ic(SquarePlus),
      run: () => d.openQuick({ method: e.method, url: e.path, headers: [], body: '', connectorId: c.id, environmentId: null, endpointId: e.id })
    },
    !c.shared && { id: 'catalog', label: 'Abrir no Catálogo', icon: ic(Network), run: () => d.navigate({ module: 'catalog', connectorId: c.id, endpointId: e.id }) },
    {
      id: 'run',
      label: 'Executar os cenários',
      icon: ic(Play),
      disabled: !e.scenarios.length,
      run: () => d.navigate({ module: 'scenarios', connectorId: c.id, endpointId: e.id, action: 'run' })
    },
    !c.shared && {
      id: 'new-scenario',
      label: 'Novo cenário',
      icon: ic(FlaskConical),
      run: () => d.navigate({ module: 'scenarios', connectorId: c.id, endpointId: e.id, action: 'new' })
    },
    separator,
    copyItem('copy-path', 'Copiar o caminho', e.path, 'Caminho copiado', d, Shortcut.copy),
    copyItem('copy-id', 'Copiar o id', e.id, 'Id copiado', d),
    !!file && !c.shared && revealItem(file, d),
    separator,
    !c.shared &&
      (e.flowFile ? !!flowId : !c.asFlow) &&
      deleteItem(() =>
        d.remove({
          title: `Excluir o endpoint ${e.name}?`,
          message: e.flowFile
            ? `O fluxo ${e.flowFile} é apagado do workspace. Dá para recuperar pelo Git.`
            : e.scenarios.length
              ? `Os ${e.scenarios.length} cenários dele vão junto.`
              : undefined,
          ops: e.flowFile ? [{ op: 'deleteFlow', id: flowId! }] : [{ op: 'deleteEndpoint', connectorId: c.id, endpointId: e.id }],
          done: `Endpoint ${e.name} excluído.`
        })
      ),
    separator,
    ...(c.shared ? [] : docsMenuItems({ kind: 'endpoint', connectorId: c.id, endpointId: e.id }))
  ]
}

export function scenarioMenu(c: CatalogConnector, e: Endpoint, s: { id: string; name: string }, onOpen: () => void, d: ExplorerMenuDeps): ContextMenuEntries {
  const at = { module: 'scenarios', connectorId: c.id, endpointId: e.id, scenarioId: s.id } as const
  return [
    open(onOpen),
    { id: 'run', label: 'Executar', icon: ic(Play), run: () => d.navigate({ ...at, action: 'run' }) },
    !c.shared && { id: 'edit', label: 'Editar em Tests', icon: ic(FlaskConical), run: () => d.navigate({ ...at, action: 'edit' }) },
    separator,
    copyItem('copy-id', 'Copiar o id', s.id, 'Id copiado', d, Shortcut.copy),
    separator,
    !c.shared &&
      !e.flowFile &&
      deleteItem(() =>
        d.remove({
          title: `Excluir o cenário ${s.name}?`,
          ops: [{ op: 'deleteScenario', connectorId: c.id, endpointId: e.id, scenarioId: s.id }],
          done: `Cenário ${s.name} excluído.`
        })
      ),
    separator,
    ...(c.shared ? [] : docsMenuItems({ kind: 'request', connectorId: c.id, endpointId: e.id, scenarioId: s.id }))
  ]
}

export function flowMenu(flow: { id: string; name: string }, file: string, onOpen: () => void, d: ExplorerMenuDeps): ContextMenuEntries {
  return [
    open(onOpen),
    { id: 'canvas', label: 'Abrir no canvas', icon: ic(Workflow), run: () => d.navigate({ module: 'flows', flowId: flow.id }) },
    separator,
    copyItem('copy-path', 'Copiar o caminho', file, 'Caminho copiado', d, Shortcut.copy),
    copyItem('copy-id', 'Copiar o id', flow.id, 'Id copiado', d),
    revealItem(file, d),
    separator,
    deleteItem(() =>
      d.remove({
        title: `Excluir o fluxo ${flow.name}?`,
        message: `O arquivo ${file} é apagado do workspace. Dá para recuperar pelo Git.`,
        ops: [{ op: 'deleteFlow', id: flow.id }],
        done: `Fluxo ${flow.name} excluído.`
      })
    )
  ]
}

export function environmentMenu(env: { id: string; name: string }, onOpen: () => void, d: ExplorerMenuDeps): ContextMenuEntries {
  return [
    { id: 'open', label: 'Abrir os segredos', run: onOpen },
    separator,
    copyItem('copy-id', 'Copiar o id', env.id, 'Id copiado', d, Shortcut.copy),
    separator,
    deleteItem(() =>
      d.remove({
        title: `Excluir o ambiente ${env.name}?`,
        message: 'O arquivo do ambiente é apagado, com as variáveis. Os valores do vault local continuam guardados.',
        ops: [{ op: 'deleteEnvironment', id: env.id }],
        done: `Ambiente ${env.name} excluído.`
      })
    )
  ]
}

/** Documento (.md) ou diagrama (.mmd) de docs/. */
export function fileMenu(file: string, onOpen: () => void, d: ExplorerMenuDeps): ContextMenuEntries {
  return [
    open(onOpen),
    separator,
    { id: 'rename', label: 'Renomear…', icon: ic(Pencil), shortcut: Shortcut.rename, run: () => d.renameFile(file) },
    copyItem('copy-path', 'Copiar o caminho', file, 'Caminho copiado', d, Shortcut.copy),
    revealItem(file, d),
    separator,
    deleteItem(() => d.removeFile(file))
  ]
}

export type ExplorerSection = 'connectors' | 'flows' | 'environments' | 'docs' | 'diagrams' | 'brand'

/** O estado e as ações da seção que o menu do cabeçalho usa. */
export interface SectionMenuContext {
  collapsed: boolean
  toggle: () => void
  reload: () => void
  /** Conectores: abrir ou fechar todas as bases e endpoints. */
  expandAll?: () => void
  collapseAll?: () => void
  /** Conectores no formato antigo, que dá para converter em fluxos. */
  legacy?: number
  convert?: () => void
  /** Bases do Compartilhado sem uso no projeto, e se estão à mostra. */
  unused?: number
  showUnused?: boolean
  toggleUnused?: () => void
}

const SECTION_FOLDER: Record<ExplorerSection, string> = {
  connectors: 'connectors',
  flows: 'flows',
  environments: 'environments',
  docs: 'docs',
  diagrams: 'docs/diagramas',
  brand: 'brand'
}

const newItem = (id: string, label: string, icon: LucideIcon, kind: NewKind, d: ExplorerMenuDeps): ContextMenuItem => ({
  id,
  label,
  icon: ic(icon),
  run: () => d.create(kind)
})

/** Menu do cabeçalho de uma seção (Conectores, Fluxos, Ambientes, Documentos, Diagramas). */
export function sectionMenu(section: ExplorerSection, s: SectionMenuContext, d: ExplorerMenuDeps): ContextMenuEntries {
  const own: ContextMenuEntries = {
    connectors: [
      newItem('new-connector', 'Novo fluxo-base (conector)', Network, 'connector', d),
      newItem('new-endpoint', 'Nova requisição de uma base (endpoint)', Route, 'endpoint', d),
      newItem('new-scenario', 'Novo cenário de teste', FlaskConical, 'scenario', d),
      newItem('new-request', 'Nova requisição no Quick Request', Zap, 'request', d),
      separator,
      !!s.legacy && !!s.convert && { id: 'convert', label: 'Converter para fluxos…', icon: ic(ArrowRightLeft), run: s.convert },
      !!s.unused &&
        !!s.toggleUnused && {
          id: 'unused',
          label: `${s.showUnused ? 'Esconder' : 'Mostrar'} ${s.unused} do Compartilhado sem uso aqui`,
          icon: ic(Boxes),
          run: s.toggleUnused
        },
      !!s.expandAll && { id: 'expand-all', label: 'Expandir tudo', icon: ic(ChevronsUpDown), run: s.expandAll },
      !!s.collapseAll && { id: 'collapse-all', label: 'Recolher tudo', icon: ic(ChevronsDownUp), run: s.collapseAll }
    ],
    flows: [newItem('new-flow', 'Novo fluxo', Workflow, 'flow', d)],
    environments: [
      newItem('new-environment', 'Novo ambiente', KeyRound, 'environment', d),
      separator,
      { id: 'secrets', label: 'Abrir os segredos', icon: ic(KeyRound), run: () => d.navigate({ module: 'secrets' }) }
    ],
    docs: [
      newItem('new-markdown', 'Novo documento', BookOpen, 'markdown', d),
      separator,
      ...docsMenuItems({ kind: 'project' })
    ],
    diagrams: [newItem('new-diagram', 'Novo diagrama', Shapes, 'diagram', d)],
    brand: []
  }[section]
  return [
    ...own,
    separator,
    {
      id: 'reveal-folder',
      label: `Revelar a pasta ${SECTION_FOLDER[section]}/`,
      icon: ic(FolderOpen),
      run: () => d.reveal(SECTION_FOLDER[section])
    },
    separator,
    { id: 'toggle', label: s.collapsed ? 'Expandir a seção' : 'Recolher a seção', run: s.toggle },
    { id: 'reload', label: 'Recarregar', icon: ic(RefreshCw), run: s.reload }
  ]
}
