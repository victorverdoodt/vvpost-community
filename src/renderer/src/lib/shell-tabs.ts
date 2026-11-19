import { useEffect, useSyncExternalStore } from 'react'
import type { ContextMenuEntries } from '../design-system'

/**
 * Abas únicas do workspace (estilo editor de código): os módulos que abrem vários documentos
 * (Quick Request, Flow Studio) não desenham mais as próprias abas; publicam a lista aqui e o
 * shell mostra todas numa barra só, junto com as abas de arquivo e de ferramenta.
 */
export interface SourceTab {
  id: string
  title: string
  /** Alterações não salvas. */
  dirty?: boolean
  /** Enviando ou conectado: um ponto pulsando na aba. */
  busy?: boolean
}

export interface TabSource {
  tabs: SourceTab[]
  activeId: string | null
  select(id: string): void
  close(id: string): void
  /** Menu de contexto da aba. */
  menu?(id: string): ContextMenuEntries
}

const sources = new Map<string, TabSource>()
const signatures = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0

const signature = (s: TabSource) =>
  `${s.activeId ?? ''}|${s.tabs.map((t) => `${t.id}:${t.title}:${t.dirty ? 1 : 0}${t.busy ? 1 : 0}`).join('|')}`

function publish(owner: string, source: TabSource | null): void {
  if (!source) {
    if (!sources.delete(owner)) return
    signatures.delete(owner)
  } else {
    sources.set(owner, source)
    // Só o que aparece na barra (ids, títulos, ativa) redesenha o shell; os handlers só trocam.
    const sig = signature(source)
    if (signatures.get(owner) === sig) return
    signatures.set(owner, sig)
  }
  version++
  listeners.forEach((l) => l())
}

/** O módulo `owner` publica as abas dele na barra do workspace a cada render. */
export function useTabSource(owner: string, source: TabSource): void {
  // Depois do paint: o primeiro quadro do app não espera a barra de abas redesenhar.
  useEffect(() => publish(owner, source))
  useEffect(() => () => publish(owner, null), [owner])
}

export function tabSource(owner: string): TabSource | undefined {
  return sources.get(owner)
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** As fontes de abas, para a barra do workspace: muda só quando algo visível muda. */
export function useTabSources(): { version: number; get(owner: string): TabSource | undefined; owners(): string[] } {
  const v = useSyncExternalStore(subscribe, () => version)
  return { version: v, get: (owner) => sources.get(owner), owners: () => [...sources.keys()] }
}
