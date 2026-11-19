import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { loadFlows } from '@vvpost/core/flows/workspace'
import type { DocsPublisher, PublishApproval, PublishBundle, PublishPlan } from '@vvpost/core/docs/publish'
import { createPublishService, setPublishersForTests } from '../src/main/docs/publish'
import { setControlPlaneForTests, type ActivityEvent } from '../src/main/enterprise/control-plane'

/** Publicador de mentira: guarda o que recebeu e devolve um plano fixo. */
function fakePublisher(): DocsPublisher & { bundles: PublishBundle[]; approvals: PublishApproval[] } {
  const bundles: PublishBundle[] = []
  const approvals: PublishApproval[] = []
  return {
    id: 'fake',
    title: 'Fake',
    bundles,
    approvals,
    session: async () => ({ status: 'signedIn', account: 'dana@example.com', token: 'NÃO-PODE-SAIR' }) as never,
    plan: async (bundle) => {
      bundles.push(bundle)
      return {
        destination: { label: 'Espaço DOC' },
        warnings: [],
        items: [
          { key: 'document', kind: 'page', title: 'Documentação', path: [], action: 'update', before: 'a', after: 'b' },
          { key: 'folder:guias', kind: 'folder', title: 'Guias', path: ['Documentação'], action: 'create' },
          { key: 'page:velha', kind: 'page', title: 'Velha', path: [], action: 'orphan' }
        ]
      }
    },
    publish: async (_bundle, plan: PublishPlan, approval) => {
      approvals.push(approval)
      return {
        destination: plan.destination,
        items: [
          { key: 'document', kind: 'page', title: 'Documentação', outcome: 'updated', id: '10', version: 3, hash: 'h1', url: 'https://x/10' },
          { key: 'folder:guias', kind: 'folder', title: 'Guias', outcome: 'created', id: '11' }
        ]
      }
    }
  }
}

describe('serviço do "Enviar para…" no main', () => {
  let dir: string
  const put = (path: string, data: unknown) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  }
  const service = (svgToPng = vi.fn(async () => new Uint8Array([1, 2, 3]))) =>
    createPublishService({
      dir: async () => dir,
      workspace: () => loadWorkspace(dir),
      flows: (d) => loadFlows(d),
      openExternal: async () => {},
      svgToPng
    })

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vvpost-publish-svc-'))
    put('connectors/billing.connector.vvpost.json', {
      id: 'billing',
      name: 'Billing',
      version: '1.0.0',
      config: { baseUrl: 'https://billing.dev' },
      endpoints: [{ id: 'list', name: 'Listar', method: 'GET', path: '/charges' }]
    })
    put('docs/projeto.md', ['## Visão geral', '', '```mermaid', 'flowchart LR', '  A --> B', '```'].join('\n'))
    put('docs/guias/inicio.md', '# Primeiros passos\n\nTexto.')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  afterEach(() => {
    setPublishersForTests(null)
    setControlPlaneForTests(undefined)
  })

  it('sem arquivo: lista os publicadores e cria o modelo de partida', async () => {
    setPublishersForTests([fakePublisher()])
    const svc = service()
    const before = await svc.targets()
    expect(before).toMatchObject({ configExists: false, targets: [], providers: [{ id: 'fake', title: 'Fake' }] })
    await expect(svc.init('outro', 'x')).rejects.toThrow('não está disponível')
    expect(await svc.init('fake', 'catalog:pagamentos')).toEqual({ file: 'vvpost.publish.json' })
    await expect(svc.init('fake', 'catalog:pagamentos')).rejects.toThrow('já existe')
    const after = await svc.targets()
    // A sessão vai ao renderer campo a campo: o token do módulo fica para trás.
    expect(after.targets).toEqual([
      expect.objectContaining({ id: 'fake', provider: 'fake', available: true, providerTitle: 'Fake', session: { status: 'signedIn', account: 'dana@example.com' } })
    ])
  })

  it('prepara, completa os diagramas, planeja e publica só o que a pessoa aprovou', async () => {
    const fake = fakePublisher()
    setPublishersForTests([fake])
    const activity: ActivityEvent[] = []
    setControlPlaneForTests({ activity: (e) => void activity.push(e) })
    const png = vi.fn(async () => new Uint8Array([9]))
    const svc = service(png)

    const prepared = await svc.prepare('fake')
    expect(prepared.pages).toBeGreaterThan(2)
    expect(prepared.nodes[0]).toMatchObject({ key: 'document', kind: 'page' })
    // O do docs/projeto.md, além dos que a documentação gerada desenha.
    const diagram = prepared.diagrams.find((d) => d.source === 'flowchart LR\n  A --> B')!
    expect(diagram).toBeDefined()
    const plan = await svc.plan(prepared.id, [
      { id: diagram.id, svg: '<svg width="10" height="10"></svg>' },
      { id: 'nao-existe', svg: '<svg/>' },
      { id: diagram.id, svg: '<script>alert(1)</script>' }
    ])
    expect(plan.items).toHaveLength(3)
    expect(png).toHaveBeenCalledTimes(1)
    expect(fake.bundles[0]!.assets.find((a) => a.id === diagram.id)?.data).toEqual(new Uint8Array([9]))

    await expect(svc.apply('outro-id', { update: [], conflicts: [], archive: [] })).rejects.toThrow('expirou')
    const result = await svc.apply(prepared.id, {
      update: ['document', 'folder:guias', 'inventada'],
      conflicts: ['document'],
      archive: ['page:velha', 'page:velha']
    })
    // Cada chave só vale na lista da ação que o plano deu a ela.
    expect(fake.approvals[0]).toEqual({ update: ['document'], conflicts: [], archive: ['page:velha'] })
    expect(result.recorded).toBe(true)
    const saved = JSON.parse(readFileSync(join(dir, 'vvpost.publish.json'), 'utf8'))
    expect(saved.targets[0].published).toEqual({
      document: { id: '10', kind: 'page', version: 3, hash: 'h1', url: 'https://x/10' },
      'folder:guias': { id: '11', kind: 'folder' }
    })
    await vi.waitFor(() => expect(activity).toEqual([expect.objectContaining({ kind: 'docsPublish', provider: 'fake', target: 'fake', created: 1, updated: 1, failed: 0 })]))
    // Depois de publicar, o pacote acabou: outra publicação começa do zero.
    await expect(svc.apply(prepared.id, { update: [], conflicts: [], archive: [] })).rejects.toThrow('expirou')
  })

  it('publicação que mexeu no arquivo no meio: avisa em vez de sobrescrever', async () => {
    setPublishersForTests([fakePublisher()])
    const svc = service()
    const prepared = await svc.prepare('fake')
    await svc.plan(prepared.id, [])
    const file = join(dir, 'vvpost.publish.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('"fake"', '"fake" '))
    const result = await svc.apply(prepared.id, { update: [], conflicts: [], archive: [] })
    expect(result).toMatchObject({ recorded: false, warning: expect.stringContaining('mudou durante a publicação') })
  })

  it('destino de um publicador que não está instalado: diz que ele vem com o Enterprise', async () => {
    setPublishersForTests([])
    await expect(service().prepare('fake')).rejects.toThrow('VVPost Enterprise')
    const state = await service().targets()
    expect(state.targets[0]).toMatchObject({ id: 'fake', available: false })
    expect(state.targets[0]!.session).toBeUndefined()
  })
})

describe('tamanho do SVG para o PNG', () => {
  it('usa width/height, o max-width do Mermaid ou o viewBox', async () => {
    const { svgSize } = await import('../src/main/docs/svg-size')
    expect(svgSize('<svg width="120" height="40"></svg>')).toEqual({ width: 120, height: 40 })
    expect(svgSize('<svg width="100%" style="max-width: 300px;" viewBox="0 0 600 200"></svg>')).toEqual({ width: 300, height: 100 })
    expect(svgSize('<svg viewBox="0 0 50 25"></svg>')).toEqual({ width: 50, height: 25 })
    expect(svgSize('<div></div>')).toBeNull()
  })
})
