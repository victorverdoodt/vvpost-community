import { describe, expect, it, vi } from 'vitest'
import type { CatalogConnector } from '@shared/ipc'
import { cleanEntries, isItem, type ContextMenuEntries, type ContextMenuItem } from '../src/renderer/src/design-system/navigation/menu-entries'
import {
  connectorMenu,
  endpointMenu,
  environmentMenu,
  fileMenu,
  flowMenu,
  scenarioMenu,
  sectionMenu,
  type ExplorerMenuDeps
} from '../src/renderer/src/app/workspace/explorer-menus'

const deps = (): ExplorerMenuDeps => ({
  navigate: vi.fn(),
  openQuick: vi.fn(),
  copy: vi.fn(),
  reveal: vi.fn(),
  remove: vi.fn(),
  renameFile: vi.fn(),
  removeFile: vi.fn(),
  create: vi.fn()
})
const items = (entries: ContextMenuEntries) => cleanEntries(entries).filter(isItem)
const ids = (entries: ContextMenuEntries) => items(entries).map((i) => i.id)
const item = (entries: ContextMenuEntries, id: string) => items(entries).find((i) => i.id === id) as ContextMenuItem

const endpoint = { id: 'listar', name: 'Listar', method: 'GET', path: '/pacientes', scenarios: [{ id: 'ok', name: 'OK' }] } as CatalogConnector['endpoints'][number]
const connector = (over: Partial<CatalogConnector> = {}) =>
  ({ id: 'api', name: 'API', chain: ['api'], file: 'connectors/api.connector.vvpost.json', headers: [], endpoints: [endpoint], ...over }) as CatalogConnector

describe('menus de contexto do explorador', () => {
  it('documento e diagrama: abrir, renomear, copiar o caminho, revelar e excluir', () => {
    const d = deps()
    const open = vi.fn()
    const menu = fileMenu('docs/c4/04-componentes.md', open, d)
    expect(ids(menu)).toEqual(['open', 'rename', 'copy-path', 'reveal', 'delete'])
    item(menu, 'open').run!()
    item(menu, 'rename').run!()
    item(menu, 'copy-path').run!()
    item(menu, 'reveal').run!()
    item(menu, 'delete').run!()
    expect(open).toHaveBeenCalled()
    expect(d.renameFile).toHaveBeenCalledWith('docs/c4/04-componentes.md')
    expect(d.copy).toHaveBeenCalledWith('docs/c4/04-componentes.md', 'Caminho copiado')
    expect(d.reveal).toHaveBeenCalledWith('docs/c4/04-componentes.md')
    expect(d.removeFile).toHaveBeenCalledWith('docs/c4/04-componentes.md')
    expect(item(menu, 'rename').shortcut).toBe('F2')
    expect(item(menu, 'delete').shortcut).toBe('Delete')
  })

  it('cabeçalho de cada seção: criar o tipo dela, revelar a pasta, recolher e recarregar', () => {
    const d = deps()
    const base = { collapsed: false, toggle: vi.fn(), reload: vi.fn() }
    const docs = sectionMenu('docs', base, d)
    expect(ids(docs)).toEqual(['new-markdown', 'docs-project', 'reveal-folder', 'toggle', 'reload'])
    item(docs, 'new-markdown').run!()
    item(docs, 'reveal-folder').run!()
    item(docs, 'toggle').run!()
    item(docs, 'reload').run!()
    expect(d.create).toHaveBeenCalledWith('markdown')
    expect(d.reveal).toHaveBeenCalledWith('docs')
    expect(base.toggle).toHaveBeenCalled()
    expect(base.reload).toHaveBeenCalled()
    expect(item(docs, 'toggle').label).toBe('Recolher a seção')
    expect(item(sectionMenu('docs', { ...base, collapsed: true }, d), 'toggle').label).toBe('Expandir a seção')

    item(sectionMenu('flows', base, d), 'new-flow').run!()
    item(sectionMenu('environments', base, d), 'new-environment').run!()
    item(sectionMenu('diagrams', base, d), 'new-diagram').run!()
    expect(d.create).toHaveBeenCalledWith('flow')
    expect(d.create).toHaveBeenCalledWith('environment')
    expect(d.create).toHaveBeenCalledWith('diagram')
    item(sectionMenu('diagrams', base, d), 'reveal-folder').run!()
    expect(d.reveal).toHaveBeenCalledWith('docs/diagramas')
  })

  it('cabeçalho de Conectores: criar, converter, Compartilhado sem uso e expandir ou recolher tudo', () => {
    const d = deps()
    const s = { collapsed: false, toggle: vi.fn(), reload: vi.fn(), expandAll: vi.fn(), collapseAll: vi.fn(), convert: vi.fn(), toggleUnused: vi.fn() }
    const plain = ids(sectionMenu('connectors', s, d))
    expect(plain).toEqual(expect.arrayContaining(['new-connector', 'new-endpoint', 'new-scenario', 'new-request', 'expand-all', 'collapse-all']))
    // Sem conector antigo nem base sem uso, essas opções somem.
    expect(plain).not.toContain('convert')
    expect(plain).not.toContain('unused')
    const menu = sectionMenu('connectors', { ...s, legacy: 2, unused: 3, showUnused: false }, d)
    expect(item(menu, 'unused').label).toBe('Mostrar 3 do Compartilhado sem uso aqui')
    item(menu, 'convert').run!()
    item(menu, 'unused').run!()
    item(menu, 'new-endpoint').run!()
    expect(s.convert).toHaveBeenCalled()
    expect(s.toggleUnused).toHaveBeenCalled()
    expect(d.create).toHaveBeenCalledWith('endpoint')
  })

  it('conector do projeto tem excluir; o compartilhado é só leitura', () => {
    const d = deps()
    const own = connectorMenu(connector(), () => {}, d)
    expect(ids(own)).toEqual(expect.arrayContaining(['open', 'catalog', 'quick', 'tests', 'copy-id', 'reveal', 'delete', 'docs-connector']))
    item(own, 'delete').run!()
    expect(d.remove).toHaveBeenCalledWith(expect.objectContaining({ ops: [{ op: 'deleteConnector', id: 'api' }] }))

    const shared = ids(connectorMenu(connector({ shared: 'org' }), () => {}, d))
    expect(shared).not.toContain('delete')
    expect(shared).not.toContain('reveal')
    expect(shared).not.toContain('docs-connector')
  })

  it('endpoint de um fluxo de requisição exclui o fluxo e revela o arquivo dele', () => {
    const d = deps()
    const fromFlow = { ...endpoint, flowFile: 'flows/api/listar.flow.vvpost.json' }
    const menu = endpointMenu(connector(), fromFlow, () => {}, d, 'api.listar')
    item(menu, 'reveal').run!()
    item(menu, 'delete').run!()
    expect(d.reveal).toHaveBeenCalledWith('flows/api/listar.flow.vvpost.json')
    expect(d.remove).toHaveBeenCalledWith(expect.objectContaining({ ops: [{ op: 'deleteFlow', id: 'api.listar' }] }))
    // Sem o fluxo achado, não há o que excluir.
    expect(ids(endpointMenu(connector(), fromFlow, () => {}, d))).not.toContain('delete')
  })

  it('endpoint abre no Quick Request com o conector e executa os cenários', () => {
    const d = deps()
    const menu = endpointMenu(connector(), endpoint, () => {}, d)
    item(menu, 'quick').run!()
    item(menu, 'run').run!()
    expect(d.openQuick).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: '/pacientes', connectorId: 'api', endpointId: 'listar' }))
    expect(d.navigate).toHaveBeenCalledWith({ module: 'scenarios', connectorId: 'api', endpointId: 'listar', action: 'run' })
    item(menu, 'delete').run!()
    expect(d.remove).toHaveBeenCalledWith(expect.objectContaining({ ops: [{ op: 'deleteEndpoint', connectorId: 'api', endpointId: 'listar' }] }))
  })

  it('cenário, fluxo e ambiente têm as ações do próprio item', () => {
    const d = deps()
    expect(ids(scenarioMenu(connector(), endpoint, endpoint.scenarios[0]!, () => {}, d))).toEqual(
      expect.arrayContaining(['open', 'run', 'edit', 'copy-id', 'delete', 'docs-request'])
    )
    const flow = flowMenu({ id: 'f', name: 'Fluxo' }, 'flows/f.flow.vvpost.json', () => {}, d)
    item(flow, 'canvas').run!()
    expect(d.navigate).toHaveBeenCalledWith({ module: 'flows', flowId: 'f' })
    expect(ids(flow)).toEqual(['open', 'canvas', 'copy-path', 'copy-id', 'reveal', 'delete'])
    const env = environmentMenu({ id: 'hml', name: 'HML' }, () => {}, d)
    item(env, 'delete').run!()
    expect(d.remove).toHaveBeenCalledWith(expect.objectContaining({ ops: [{ op: 'deleteEnvironment', id: 'hml' }] }))
  })
})
