import {
  Copy,
  CopyPlus,
  Download,
  FlaskConical,
  FolderOpen,
  GitBranchPlus,
  KeyRound,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  SquarePlus,
  Terminal,
  Trash2,
  Zap
} from 'lucide-react'
import type { ProjectEdit, RegistryConnector, RegistryEndpoint } from '@shared/ipc'
import type { Connector } from '@vvpost/schemas'
import { formatShortcut, separator, Shortcut, useToast, usePromptDialog, type ContextMenuEntries } from '../../design-system'
import { copyName, freeId } from '../../lib/clipboard'
import { navigate } from '../../lib/navigate'
import { openInQuickRequest } from '../../lib/open-request'
import { toCode } from '../../lib/request-code'
import { docsMenuItems } from '../docs/open'

const icon = { size: 14, 'aria-hidden': true } as const
const CONNECTOR_ID = /^[a-z0-9]+([._-][a-z0-9]+)*$/

/** Id livre para a cópia de um conector: connector.users → connector.users-copia (-2, -3...). */
function copyConnectorId(id: string, taken: ReadonlySet<string>): string {
  let next = `${id}-copia`
  for (let i = 2; taken.has(next); i++) next = `${id}-copia-${i}`
  return next
}

/**
 * Menus de contexto do Catálogo: projeto, conector, endpoint e request (cenário). As
 * mudanças passam pela camada em lote (editProject), as de nome pelo editor do conector.
 */
export function useCatalogMenus(props: {
  connectors: RegistryConnector[]
  reload: () => void
  onSelect: (connectorId: string) => void
  onEdit: (connectorId: string) => void
  onCreate: () => void
}) {
  const toast = useToast()
  const dialog = usePromptDialog()
  const ids = new Set(props.connectors.map((c) => c.id))

  const apply = async (ops: ProjectEdit[], done: string) => {
    const r = await window.vvpost.editProject(ops)
    if (!r.ok) {
      toast(r.message, 'danger')
      return false
    }
    props.reload()
    toast(done, 'success')
    return true
  }
  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(() => toast(`${what} na área de transferência.`, 'success'))
  const reveal = (path: string) =>
    void window.vvpost.revealInFolder({ workspacePath: path }).then((r) => !r.ok && toast(r.message, 'danger'))

  /** O arquivo do conector como está no disco (para duplicar e editar um endpoint). */
  const source = async (connectorId: string) => {
    const r = await window.vvpost.readConnector(connectorId)
    if (!r.ok) toast(r.message, 'danger')
    return r.ok ? r.value : null
  }

  const endpointCurl = (e: RegistryEndpoint) =>
    toCode('curl', { method: e.method, url: e.url ?? e.path, headers: e.headers, ...(e.body && { body: e.body }) })

  const openEndpoint = (c: RegistryConnector, e: RegistryEndpoint) =>
    openInQuickRequest({
      method: e.method,
      url: e.path,
      headers: e.headers,
      body: e.body ?? '',
      connectorId: c.id,
      environmentId: null,
      endpointId: e.id
    })

  const projectEntries = (dir: string): ContextMenuEntries => [
    { id: 'new-connector', label: 'Novo conector', icon: <Plus {...icon} />, run: props.onCreate },
    { id: 'reload', label: 'Recarregar', icon: <RefreshCw {...icon} />, run: props.reload },
    { id: 'reveal', label: 'Revelar a pasta', icon: <FolderOpen {...icon} />, shortcut: Shortcut.reveal, run: () => reveal('') },
    { id: 'export', label: 'Exportar o projeto…', icon: <Download {...icon} />, run: () => navigate({ module: 'import-export' }) },
    { id: 'copy-dir', label: 'Copiar o caminho da pasta', icon: <Copy {...icon} />, run: () => copy(dir, 'Caminho copiado') },
    separator,
    ...docsMenuItems({ kind: 'project' })
  ]

  const connectorEntries = (c: RegistryConnector): ContextMenuEntries => [
    { id: 'edit', label: 'Editar', icon: <Pencil {...icon} />, run: () => props.onEdit(c.id) },
    {
      id: 'quick',
      label: 'Abrir no Quick Request',
      icon: <Zap {...icon} />,
      shortcut: Shortcut.openInNewTab,
      disabled: !!c.error,
      run: () =>
        openInQuickRequest({ method: 'GET', url: '', headers: [], body: '', connectorId: c.id, environmentId: null })
    },
    {
      id: 'tests',
      label: 'Abrir os cenários em Tests',
      icon: <FlaskConical {...icon} />,
      run: () => navigate({ module: 'scenarios', connectorId: c.id })
    },
    ...(c.source
      ? [
          {
            id: 'reimport-spec',
            label: 'Reimportar a spec OpenAPI',
            icon: <RefreshCw {...icon} />,
            keywords: ['openapi', 'swagger', 'sincronizar', 'atualizar'],
            run: () => navigate({ module: 'import-export', reimportConnectorId: c.id })
          }
        ]
      : []),
    separator,
    {
      id: 'new-child',
      label: 'Novo conector filho',
      icon: <GitBranchPlus {...icon} />,
      run: async () => {
        const id = await dialog.prompt({
          title: `Novo conector que herda de ${c.name}`,
          label: 'Id do conector',
          initial: copyConnectorId(c.id, ids).replace(/-copia(-\d+)?$/, '.filho'),
          confirmLabel: 'Criar',
          validate: (v) => (!CONNECTOR_ID.test(v) ? 'Use minúsculas, números, ponto, - e _.' : ids.has(v) ? 'Já existe um conector com esse id.' : undefined)
        })
        if (!id) return
        const connector: Connector = { id, name: `${c.name} (filho)`, version: '1.0.0', extends: c.id, endpoints: [] }
        if (await apply([{ op: 'upsertConnector', connector }], `Conector ${id} criado.`)) props.onEdit(id)
      }
    },
    {
      id: 'duplicate',
      label: 'Duplicar',
      icon: <CopyPlus {...icon} />,
      shortcut: Shortcut.duplicate,
      run: async () => {
        const src = await source(c.id)
        if (!src) return
        const id = copyConnectorId(c.id, ids)
        const connector = { ...structuredClone(src.connector), id, name: copyName(c.name, props.connectors.map((x) => x.name)) }
        if (await apply([{ op: 'upsertConnector', connector }], `Conector duplicado como ${id}.`)) props.onSelect(id)
      }
    },
    {
      id: 'rename',
      label: 'Renomear…',
      icon: <Pencil {...icon} />,
      shortcut: Shortcut.rename,
      run: async () => {
        const name = await dialog.prompt({ title: `Renomear ${c.name}`, label: 'Nome', initial: c.name })
        if (!name || name === c.name) return
        const src = await source(c.id)
        if (!src) return
        const r = await window.vvpost.saveConnector({ ...src.connector, name }, src.file, src.version)
        if (!r.ok) return toast(r.message, 'danger')
        props.reload()
        toast(`Conector renomeado para ${name}.`, 'success')
      }
    },
    {
      id: 'move-id',
      label: 'Trocar o id…',
      icon: <Pencil {...icon} />,
      run: async () => {
        const newId = await dialog.prompt({
          title: `Trocar o id de ${c.name}`,
          message: 'Os filhos (extends) e os nós dos fluxos que usam o conector são atualizados juntos.',
          label: 'Id',
          initial: c.id,
          validate: (v) =>
            !CONNECTOR_ID.test(v) ? 'Use minúsculas, números, ponto, - e _.' : v !== c.id && ids.has(v) ? 'Já existe um conector com esse id.' : undefined
        })
        if (!newId || newId === c.id) return
        if (await apply([{ op: 'moveConnector', id: c.id, newId }], `Id trocado para ${newId}.`)) props.onSelect(newId)
      }
    },
    {
      id: 'clear-token',
      label: 'Limpar o token em cache',
      icon: <KeyRound {...icon} />,
      disabled: !c.resolved?.auth,
      run: () => void window.vvpost.clearAuthCache(c.id).then(() => toast(`Token de ${c.name} descartado; o próximo envio faz login de novo.`, 'success'))
    },
    separator,
    { id: 'copy-id', label: 'Copiar o id', icon: <Copy {...icon} />, shortcut: Shortcut.copy, run: () => copy(c.id, 'Id copiado') },
    { id: 'reveal', label: 'Revelar o arquivo', icon: <FolderOpen {...icon} />, shortcut: Shortcut.reveal, run: () => reveal(c.file) },
    separator,
    {
      id: 'delete',
      label: 'Excluir…',
      icon: <Trash2 {...icon} />,
      shortcut: Shortcut.remove,
      danger: true,
      run: async () => {
        if (c.children.length) {
          return toast(`${c.name} tem filhos (${c.children.join(', ')}): exclua ou mova os filhos antes.`, 'warning')
        }
        const ok = await dialog.confirm({
          title: `Excluir o conector ${c.name}?`,
          message: `O arquivo ${c.file} (e a documentação .md ao lado) é apagado do workspace. Dá para recuperar pelo Git.`,
          confirmLabel: 'Excluir',
          danger: true
        })
        if (ok) await apply([{ op: 'deleteConnector', id: c.id }], `Conector ${c.name} excluído.`)
      }
    },
    separator,
    ...docsMenuItems({ kind: 'connector', connectorId: c.id })
  ]

  const endpointEntries = (c: RegistryConnector, e: RegistryEndpoint): ContextMenuEntries => [
    { id: 'quick', label: 'Abrir no Quick Request', icon: <SquarePlus {...icon} />, shortcut: Shortcut.openInNewTab, run: () => openEndpoint(c, e) },
    {
      id: 'run',
      label: 'Executar os cenários',
      icon: <Play {...icon} />,
      disabled: !e.scenarios.length,
      run: () => navigate({ module: 'scenarios', connectorId: c.id, endpointId: e.id, action: 'run' })
    },
    {
      id: 'new-scenario',
      label: 'Novo cenário',
      icon: <FlaskConical {...icon} />,
      run: () => navigate({ module: 'scenarios', connectorId: c.id, endpointId: e.id, action: 'new' })
    },
    separator,
    {
      id: 'duplicate',
      label: 'Duplicar',
      icon: <CopyPlus {...icon} />,
      shortcut: Shortcut.duplicate,
      run: async () => {
        const src = await source(c.id)
        const original = src?.connector.endpoints?.find((x) => x.id === e.id)
        if (!src || !original) return
        const taken = (src.connector.endpoints ?? []).map((x) => x.id)
        const endpoint = { ...structuredClone(original), id: freeId(`${e.id}-copia`, taken), name: copyName(e.name, (src.connector.endpoints ?? []).map((x) => x.name)) }
        const index = (src.connector.endpoints ?? []).findIndex((x) => x.id === e.id) + 1
        await apply([{ op: 'upsertEndpoint', connectorId: c.id, endpoint, index }], `Endpoint duplicado como ${endpoint.id}.`)
      }
    },
    {
      id: 'rename',
      label: 'Renomear…',
      icon: <Pencil {...icon} />,
      shortcut: Shortcut.rename,
      run: async () => {
        const name = await dialog.prompt({ title: `Renomear ${e.name}`, label: 'Nome', initial: e.name })
        if (!name || name === e.name) return
        const src = await source(c.id)
        const original = src?.connector.endpoints?.find((x) => x.id === e.id)
        if (!original) return
        const { scenarios: _keep, ...rest } = original
        await apply([{ op: 'upsertEndpoint', connectorId: c.id, endpoint: { ...rest, name } }], `Endpoint renomeado para ${name}.`)
      }
    },
    separator,
    { id: 'copy-curl', label: 'Copiar como cURL', icon: <Terminal {...icon} />, shortcut: Shortcut.copyAsCurl, run: () => copy(endpointCurl(e), 'cURL copiado (sem a auth do conector)') },
    { id: 'copy-path', label: 'Copiar o caminho', icon: <Copy {...icon} />, shortcut: Shortcut.copy, run: () => copy(e.path, 'Caminho copiado') },
    { id: 'copy-id', label: 'Copiar o id', run: () => copy(e.id, 'Id copiado') },
    separator,
    {
      id: 'delete',
      label: 'Excluir…',
      icon: <Trash2 {...icon} />,
      shortcut: Shortcut.remove,
      danger: true,
      run: async () => {
        const ok = await dialog.confirm({
          title: `Excluir o endpoint ${e.name}?`,
          message: e.scenarios.length ? `Os ${e.scenarios.length} cenários dele vão junto.` : undefined,
          confirmLabel: 'Excluir',
          danger: true
        })
        if (ok) await apply([{ op: 'deleteEndpoint', connectorId: c.id, endpointId: e.id }], `Endpoint ${e.name} excluído.`)
      }
    },
    separator,
    ...docsMenuItems({ kind: 'endpoint', connectorId: c.id, endpointId: e.id })
  ]

  const scenarioEntries = (c: RegistryConnector, e: RegistryEndpoint, s: { id: string; name: string }): ContextMenuEntries =>
    scenarioMenu({
      connectorId: c.id,
      endpointId: e.id,
      scenario: s,
      apply,
      dialog,
      openInQuick: () => openEndpoint(c, e),
      copyCurl: () => copy(endpointCurl(e), 'cURL do endpoint copiado'),
      onEdit: () => navigate({ module: 'scenarios', connectorId: c.id, endpointId: e.id, scenarioId: s.id, action: 'edit' }),
      onRun: () => navigate({ module: 'scenarios', connectorId: c.id, endpointId: e.id, scenarioId: s.id, action: 'run' })
    })

  return { projectEntries, connectorEntries, endpointEntries, scenarioEntries, dialog: dialog.element }
}

/** Itens de um cenário (request): no Catálogo e nos Tests. */
export function scenarioMenu(p: {
  connectorId: string
  endpointId: string
  scenario: { id: string; name: string }
  apply: (ops: ProjectEdit[], done: string) => Promise<boolean>
  dialog: ReturnType<typeof usePromptDialog>
  openInQuick: () => void
  copyCurl: () => void
  onEdit: () => void
  onRun: () => void
}): ContextMenuEntries {
  const { connectorId, endpointId, scenario: s } = p
  const original = async () => {
    const r = await window.vvpost.readConnector(connectorId)
    const endpoint = r.ok ? r.value.connector.endpoints?.find((x) => x.id === endpointId) : undefined
    return endpoint ? { endpoint, scenario: endpoint.scenarios?.find((x) => x.id === s.id) } : null
  }
  return [
    { id: 'run', label: 'Executar', icon: <Play {...icon} />, hint: formatShortcut(Shortcut.run), keywords: ['testar', 'cenario', 'rodar'], run: p.onRun },
    { id: 'edit', label: 'Editar', icon: <Pencil {...icon} />, run: p.onEdit },
    { id: 'quick', label: 'Abrir o endpoint no Quick Request', icon: <SquarePlus {...icon} />, shortcut: Shortcut.openInNewTab, run: p.openInQuick },
    { id: 'copy-curl', label: 'Copiar como cURL', icon: <Terminal {...icon} />, shortcut: Shortcut.copyAsCurl, run: p.copyCurl },
    separator,
    {
      id: 'duplicate',
      label: 'Duplicar',
      icon: <CopyPlus {...icon} />,
      shortcut: Shortcut.duplicate,
      run: async () => {
        const found = await original()
        if (!found?.scenario) return
        const all = found.endpoint.scenarios ?? []
        const scenario = { ...structuredClone(found.scenario), id: freeId(`${s.id}-copia`, all.map((x) => x.id)), name: copyName(s.name, all.map((x) => x.name)) }
        await p.apply([{ op: 'upsertScenario', connectorId, endpointId, scenario }], `Cenário duplicado como ${scenario.id}.`)
      }
    },
    {
      id: 'rename',
      label: 'Renomear…',
      icon: <Pencil {...icon} />,
      shortcut: Shortcut.rename,
      run: async () => {
        const name = await p.dialog.prompt({ title: `Renomear ${s.name}`, label: 'Nome', initial: s.name })
        if (!name || name === s.name) return
        const found = await original()
        if (!found?.scenario) return
        await p.apply([{ op: 'upsertScenario', connectorId, endpointId, scenario: { ...found.scenario, name } }], `Cenário renomeado para ${name}.`)
      }
    },
    {
      id: 'delete',
      label: 'Excluir…',
      icon: <Trash2 {...icon} />,
      shortcut: Shortcut.remove,
      danger: true,
      run: async () => {
        const ok = await p.dialog.confirm({ title: `Excluir o cenário ${s.name}?`, confirmLabel: 'Excluir', danger: true })
        if (ok) await p.apply([{ op: 'deleteScenario', connectorId, endpointId, scenarioId: s.id }], `Cenário ${s.name} excluído.`)
      }
    },
    separator,
    ...docsMenuItems({ kind: 'request', connectorId, endpointId, scenarioId: s.id })
  ]
}

