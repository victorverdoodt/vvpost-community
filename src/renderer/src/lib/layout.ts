/**
 * Tamanhos e posições dos painéis, lembrados por workspace (como o VS Code): cada pasta (e
 * projeto do workspace) guarda o próprio layout. Um workspace que nunca foi ajustado começa com o
 * último layout usado em qualquer outro, e só então com o padrão do painel.
 *
 * Fica no localStorage, fora do repositório: o layout é do usuário, não do projeto versionado.
 */
import { useCallback, useEffect, useState } from 'react'
import { readPref, writePref } from './storage'

export const LAYOUT_CHANGED = 'vvpost:layout-changed'

let scope: string | null = null

/** A chave do workspace aberto: a pasta, mais o projeto quando o workspace tem projetos. */
export function layoutScope(info: { dir: string; projects?: { current: string | null } } | null): string | null {
  if (!info) return null
  return info.projects?.current ? `${info.dir}#${info.projects.current}` : info.dir
}

/** O shell chama ao abrir ou trocar de workspace: os painéis releem os tamanhos dele. */
export function setLayoutScope(next: string | null): void {
  if (next === scope) return
  scope = next
  window.dispatchEvent(new Event(LAYOUT_CHANGED))
}

export function layoutKeys(id: string, at: string | null = scope): { scoped: string | null; last: string } {
  return { scoped: at ? `layout.ws.${encodeURIComponent(at)}.${id}` : null, last: `layout.last.${id}` }
}

export function readLayout(id: string): string | null {
  const keys = layoutKeys(id)
  return (keys.scoped && readPref(keys.scoped)) ?? readPref(keys.last)
}

export function writeLayout(id: string, value: string): void {
  const keys = layoutKeys(id)
  if (keys.scoped) writePref(keys.scoped, value)
  writePref(keys.last, value)
  window.dispatchEvent(new CustomEvent(LAYOUT_CHANGED, { detail: id }))
}

/** "Restaurar o layout": o workspace aberto volta aos tamanhos e posições padrão. */
export function resetLayout(): void {
  try {
    const prefixes = ['vvpost.layout.last.', 'vvpost.inspector.', ...(scope ? [`vvpost.${layoutKeys('', scope).scoped}`] : [])]
    for (const key of Object.keys(localStorage)) if (prefixes.some((p) => key.startsWith(p))) localStorage.removeItem(key)
  } catch {
    // sem armazenamento local: nada lembrado
  }
  window.dispatchEvent(new Event(LAYOUT_CHANGED))
}

export function clampSize(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(min, max), Math.max(min, value)))
}

/** Valor numérico lembrado (largura em px, fração em %), com o padrão do painel. */
export function readSize(id: string, fallback: number, min: number, max: number): number {
  const n = Number(readLayout(id))
  return clampSize(Number.isFinite(n) && n > 0 ? n : fallback, min, max)
}

/**
 * Um tamanho de painel lembrado no workspace aberto: relê ao trocar de workspace e grava a cada
 * ajuste. `reset` volta ao padrão (duplo clique na borda, como no VS Code).
 */
export function usePanelSize(id: string, opts: { fallback: number; min: number; max: number }) {
  const { fallback, min, max } = opts
  const [size, setState] = useState(() => readSize(id, fallback, min, max))
  useEffect(() => {
    const reread = (e: Event) => {
      const detail = (e as CustomEvent<string | undefined>).detail
      if (!detail || detail === id) setState(readSize(id, fallback, min, max))
    }
    window.addEventListener(LAYOUT_CHANGED, reread)
    return () => window.removeEventListener(LAYOUT_CHANGED, reread)
  }, [id, fallback, min, max])
  const setSize = useCallback(
    (next: number) => {
      const v = clampSize(next, min, max)
      setState(v)
      writeLayout(id, String(v))
    },
    [id, min, max]
  )
  const reset = useCallback(() => setSize(fallback), [setSize, fallback])
  return { size, setSize, reset }
}

/** Uma escolha de layout lembrada no workspace aberto (lado do explorador, painel recolhido...). */
export function useLayoutChoice<T extends string>(id: string, fallback: T, allowed: readonly T[]) {
  const read = useCallback(() => {
    const v = readLayout(id) as T | null
    return v && allowed.includes(v) ? v : fallback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fallback])
  const [value, setState] = useState(read)
  useEffect(() => {
    const reread = (e: Event) => {
      const detail = (e as CustomEvent<string | undefined>).detail
      if (!detail || detail === id) setState(read())
    }
    window.addEventListener(LAYOUT_CHANGED, reread)
    return () => window.removeEventListener(LAYOUT_CHANGED, reread)
  }, [id, read])
  const set = useCallback(
    (next: T) => {
      setState(next)
      writeLayout(id, next)
    },
    [id]
  )
  return [value, set] as const
}

/**
 * Layouts com nome (como os perfis de layout do VS Code): uma foto dos tamanhos e posições do
 * workspace aberto, para voltar a ela em qualquer workspace. Ficam no localStorage, fora dos
 * workspaces: o layout é do usuário.
 */
const NAMED = 'layouts.named'
export const MAX_LAYOUT_NAME = 60

type NamedLayouts = Record<string, Record<string, string>>

function readNamed(): NamedLayouts {
  try {
    const v = JSON.parse(readPref(NAMED) ?? '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as NamedLayouts) : {}
  } catch {
    return {}
  }
}

export function namedLayouts(): string[] {
  return Object.keys(readNamed()).sort((a, b) => a.localeCompare(b))
}

/** Os ids de layout com valor agora no workspace aberto (o dele ou o último usado). */
function currentLayout(): Record<string, string> {
  const out: Record<string, string> = {}
  const prefixes = [`vvpost.${layoutKeys('').last}`, ...(scope ? [`vvpost.${layoutKeys('', scope).scoped}`] : [])]
  try {
    for (const key of Object.keys(localStorage)) {
      const prefix = prefixes.find((p) => key.startsWith(p))
      if (!prefix) continue
      const id = key.slice(prefix.length)
      const value = readLayout(id)
      if (id && value !== null) out[id] = value
    }
  } catch {
    // sem armazenamento local
  }
  return out
}

export function saveNamedLayout(name: string): void {
  const all = readNamed()
  all[name.trim().slice(0, MAX_LAYOUT_NAME)] = currentLayout()
  writePref(NAMED, JSON.stringify(all))
}

/** Aplica no workspace aberto exatamente o layout salvo: o que ele não tem volta ao padrão. */
export function applyNamedLayout(name: string): boolean {
  const saved = readNamed()[name]
  if (!saved) return false
  for (const id of Object.keys(currentLayout())) {
    if (id in saved) continue
    const keys = layoutKeys(id)
    try {
      if (keys.scoped) localStorage.removeItem(`vvpost.${keys.scoped}`)
      localStorage.removeItem(`vvpost.${keys.last}`)
    } catch {
      // sem armazenamento local
    }
  }
  for (const [id, value] of Object.entries(saved)) {
    const keys = layoutKeys(id)
    if (keys.scoped) writePref(keys.scoped, value)
    writePref(keys.last, value)
  }
  window.dispatchEvent(new Event(LAYOUT_CHANGED))
  return true
}

export function deleteNamedLayout(name: string): void {
  const all = readNamed()
  delete all[name]
  writePref(NAMED, JSON.stringify(all))
}
