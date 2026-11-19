import { describe, expect, it } from 'vitest'
import type { WorkspaceInfo } from '../src/shared/ipc'
import { docsAfterProjectSwitch, PROJECT_PANELS, projectIdentity, tabsLeavingProject } from '../src/renderer/src/app/workspace/project-switch'
import type { DocRef } from '../src/renderer/src/app/workspace/docs'

const ws = (current: string | null, dir = '/ws'): WorkspaceInfo => ({
  dir,
  name: 'ws',
  branch: null,
  projects: { root: dir, list: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], current }
})

describe('trocar de projeto', () => {
  it('a identidade muda com o projeto e com a pasta, não com o resto do workspace', () => {
    expect(projectIdentity(null)).toBeNull()
    expect(projectIdentity(ws('a'))).not.toBe(projectIdentity(ws('b')))
    expect(projectIdentity(ws(null))).not.toBe(projectIdentity(ws('a')))
    expect(projectIdentity(ws('a'))).not.toBe(projectIdentity(ws('a', '/outra')))
    expect(projectIdentity({ ...ws('a'), branch: 'main' })).toBe(projectIdentity(ws('a')))
    expect(projectIdentity({ dir: '/ws', name: 'ws', branch: null })).toBe(projectIdentity(ws(null)))
  })

  it('as abas de arquivo do projeto anterior fecham, menos as com mudanças não salvas', () => {
    const tabs = new Map<string, DocRef>([
      ['doc:markdown:docs/a.md', { kind: 'markdown', file: 'docs/a.md' }],
      ['doc:diagram:docs/c4.mmd', { kind: 'diagram', file: 'docs/c4.mmd' }],
      ['doc:connector:pedidos', { kind: 'connector', connectorId: 'pedidos' }]
    ])
    expect(tabsLeavingProject(tabs, new Set(['doc:diagram:docs/c4.mmd']))).toEqual(['doc:markdown:docs/a.md', 'doc:connector:pedidos'])
    expect(tabsLeavingProject(new Map(), new Set())).toEqual([])
  })

  it('a documentação do projeto continua aberta (gerada de novo); a de um conector fecha', () => {
    expect(docsAfterProjectSwitch({ kind: 'project' })).toEqual({ kind: 'project' })
    expect(docsAfterProjectSwitch({ kind: 'connector', connectorId: 'pedidos' })).toBeNull()
    expect(docsAfterProjectSwitch({ kind: 'endpoint', connectorId: 'pedidos', endpointId: 'listar' })).toBeNull()
    expect(docsAfterProjectSwitch(null)).toBeNull()
  })

  it('o módulo Documentação remonta com o projeto novo', () => {
    expect(PROJECT_PANELS.has('docs')).toBe(true)
  })
})
