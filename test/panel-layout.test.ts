import { beforeEach, describe, expect, it } from 'vitest'

// lib/layout usa localStorage e eventos da janela: um armazenamento em memória basta aqui.
const store = new Map<string, string>()
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  }
}
const events: string[] = []
Object.assign(globalThis, {
  localStorage: new Proxy(storage, { ownKeys: () => [...store.keys()], getOwnPropertyDescriptor: (_t, k) => (store.has(String(k)) ? { enumerable: true, configurable: true, value: store.get(String(k)) } : undefined) }),
  window: { dispatchEvent: (e: Event) => void events.push(e.type) }
})

const { applyNamedLayout, clampSize, deleteNamedLayout, layoutScope, namedLayouts, readLayout, readSize, resetLayout, saveNamedLayout, setLayoutScope, writeLayout } =
  await import('../src/renderer/src/lib/layout')

describe('layout dos painéis por workspace', () => {
  beforeEach(() => {
    store.clear()
    setLayoutScope(null)
  })

  it('a chave do workspace é a pasta, mais o projeto aberto quando há projetos', () => {
    expect(layoutScope(null)).toBeNull()
    expect(layoutScope({ dir: '/repo' })).toBe('/repo')
    expect(layoutScope({ dir: '/repo', projects: { current: null } })).toBe('/repo')
    expect(layoutScope({ dir: '/repo', projects: { current: 'erp' } })).toBe('/repo#erp')
  })

  it('cada workspace lembra o próprio tamanho; um workspace novo começa com o último usado', () => {
    setLayoutScope('/a')
    writeLayout('explorer.width', '320')
    setLayoutScope('/b')
    // Nunca ajustado em /b: herda o último tamanho usado.
    expect(readSize('explorer.width', 240, 180, 720)).toBe(320)
    writeLayout('explorer.width', '400')
    setLayoutScope('/a')
    expect(readSize('explorer.width', 240, 180, 720)).toBe(320)
    setLayoutScope('/b')
    expect(readSize('explorer.width', 240, 180, 720)).toBe(400)
  })

  it('trocar de workspace avisa os painéis para relerem', () => {
    events.length = 0
    setLayoutScope('/a')
    setLayoutScope('/a')
    expect(events).toEqual(['vvpost:layout-changed'])
  })

  it('o tamanho lido fica entre o mínimo e o máximo; valor inválido usa o padrão', () => {
    setLayoutScope('/a')
    writeLayout('x', '9999')
    expect(readSize('x', 240, 180, 720)).toBe(720)
    writeLayout('x', 'abc')
    expect(readSize('x', 240, 180, 720)).toBe(240)
    expect(clampSize(10, 180, 720)).toBe(180)
    // Máximo menor que o mínimo (janela estreita): o mínimo vence.
    expect(clampSize(500, 180, 100)).toBe(180)
  })

  it('restaurar o layout volta ao padrão só no workspace aberto', () => {
    setLayoutScope('/a')
    writeLayout('explorer.width', '320')
    setLayoutScope('/b')
    writeLayout('explorer.width', '400')
    store.set('vvpost.inspector.flows.width', '420')
    resetLayout()
    expect(readSize('explorer.width', 240, 180, 720)).toBe(240)
    expect(store.has('vvpost.inspector.flows.width')).toBe(false)
    setLayoutScope('/a')
    expect(readSize('explorer.width', 240, 180, 720)).toBe(320)
  })

  it('um layout com nome guarda o arranjo e volta exato em outro workspace', () => {
    setLayoutScope('/a')
    writeLayout('pane.catalog.tree.side', 'right')
    writeLayout('inspector.connectors.joined', 'yes')
    saveNamedLayout('  Revisão  ')
    expect(namedLayouts()).toEqual(['Revisão'])

    setLayoutScope('/b')
    resetLayout()
    writeLayout('explorer.width', '400')
    events.length = 0
    expect(applyNamedLayout('Revisão')).toBe(true)
    expect(events).toEqual(['vvpost:layout-changed'])
    expect(readLayout('pane.catalog.tree.side')).toBe('right')
    expect(readLayout('inspector.connectors.joined')).toBe('yes')
    // O que o layout salvo não tem volta ao padrão.
    expect(readLayout('explorer.width')).toBeNull()

    expect(applyNamedLayout('outro')).toBe(false)
    deleteNamedLayout('Revisão')
    expect(namedLayouts()).toEqual([])
  })

  it('preferência de layouts corrompida não quebra a lista', () => {
    store.set('vvpost.layouts.named', '[1,2]')
    expect(namedLayouts()).toEqual([])
    store.set('vvpost.layouts.named', '{')
    expect(namedLayouts()).toEqual([])
  })
})
