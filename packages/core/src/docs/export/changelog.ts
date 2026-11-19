import type { PublishBundle, PublishTreeNode } from '../publish/types'
import type { ChangelogEntry, ChangelogRef, SiteManifest } from './types'

/** Entradas guardadas no vvpost-site.json: o bastante para anos de exportações semanais. */
export const MAX_CHANGELOG_ENTRIES = 200

/** Páginas com conteúdo do pacote, em ordem (as pastas e as páginas só de agrupar ficam de fora). */
export function contentPages(nodes: PublishTreeNode[]): PublishTreeNode[] {
  const out: PublishTreeNode[] = []
  const walk = (list: PublishTreeNode[]) => {
    for (const n of list) {
      if (n.kind === 'page' && n.page) out.push(n)
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}

const endpointTitle = (e: { method: string; path: string; name: string }) => `${e.method} ${e.path} · ${e.name}`

/**
 * O que mudou desde a exportação anterior: páginas e endpoints novos, alterados e removidos.
 * null quando nada mudou. Sem a anterior, uma entrada "initial" sem listas.
 */
export function changelogEntry(bundle: PublishBundle, previous: SiteManifest | null, label?: string): ChangelogEntry | null {
  const at = bundle.generatedAt
  const empty = () => ({ added: [] as ChangelogRef[], changed: [] as ChangelogRef[], removed: [] as ChangelogRef[] })
  const entry: ChangelogEntry = { at, ...(label && { label }), pages: empty(), endpoints: empty() }
  if (!previous) return { ...entry, initial: true }

  const pages = contentPages(bundle.nodes)
  const keys = new Set(pages.map((p) => p.key))
  for (const p of pages) {
    const before = previous.pages[p.key]
    if (!before || before.kind !== 'page' || !before.file) entry.pages.added.push({ key: p.key, title: p.title })
    else if (before.hash !== p.hash) entry.pages.changed.push({ key: p.key, title: p.title })
  }
  for (const [key, before] of Object.entries(previous.pages)) {
    if (before.kind === 'page' && before.file && !keys.has(key)) entry.pages.removed.push({ key, title: before.title })
  }

  const endpoints = bundle.api?.endpoints ?? []
  const ekeys = new Set(endpoints.map((e) => e.key))
  for (const e of endpoints) {
    const before = previous.endpoints[e.key]
    if (!before) entry.endpoints.added.push({ key: e.key, title: endpointTitle(e) })
    else if (before.hash !== e.hash) entry.endpoints.changed.push({ key: e.key, title: endpointTitle(e) })
  }
  for (const [key, before] of Object.entries(previous.endpoints)) {
    if (!ekeys.has(key)) entry.endpoints.removed.push({ key, title: before.title })
  }

  const changed = [entry.pages, entry.endpoints].some((g) => g.added.length || g.changed.length || g.removed.length)
  return changed || label ? entry : null
}

/** O histórico com a entrada nova no topo, cortado no teto. */
export function nextChangelog(previous: SiteManifest | null, entry: ChangelogEntry | null): ChangelogEntry[] {
  const list = previous?.changelog ?? []
  return (entry ? [entry, ...list] : list).slice(0, MAX_CHANGELOG_ENTRIES)
}

export function manifestEndpoints(bundle: PublishBundle): SiteManifest['endpoints'] {
  return Object.fromEntries((bundle.api?.endpoints ?? []).map((e) => [e.key, { title: endpointTitle(e), hash: e.hash }]))
}
