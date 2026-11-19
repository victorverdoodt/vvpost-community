import type { ReactNode } from 'react'
import { matchesShortcut } from './shortcuts'

// Modelo dos menus de contexto, sem React: o componente (ContextMenu.tsx), a paleta e os testes usam.

export interface ContextMenuItem {
  id: string
  label: string
  icon?: ReactNode
  /** Texto curto à direita (escopo, formato). O atalho, quando há, vai em `shortcut`. */
  hint?: string
  /** Atalho no formato de shortcuts.ts (`Mod+D`, `F2`); vale na linha focada e aparece no menu e na paleta. */
  shortcut?: string
  disabled?: boolean
  /** Ação destrutiva (excluir, descartar): em vermelho. */
  danger?: boolean
  /** Marca de opção ligada (ativar header, mostrar diff). */
  checked?: boolean
  run?: () => void
  /** Submenu (abre com → ou Enter). */
  items?: ContextMenuEntries
  /** Só no menu: fica fora da Command Palette. */
  menuOnly?: boolean
  /** Palavras que acham o item na Command Palette, além do rótulo. */
  keywords?: readonly string[]
}

export interface ContextMenuSeparator {
  type: 'separator'
}

/** Título de um grupo de itens (ex.: "Copiar", "Navegação"). */
export interface ContextMenuHeader {
  type: 'header'
  id?: string
  label: string
  icon?: ReactNode
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator | ContextMenuHeader
/** Entradas com `false`/`null` para itens condicionais: `cond && item`. */
export type ContextMenuEntries = ReadonlyArray<ContextMenuEntry | false | null | undefined | ''>

export const separator: ContextMenuSeparator = { type: 'separator' }
export const menuHeader = (label: string): ContextMenuHeader => ({ type: 'header', label })

export const isItem = (e: ContextMenuEntry): e is ContextMenuItem => !('type' in e)

/**
 * Tira o que não deve aparecer: itens falsos, submenus vazios, separadores no começo, no fim
 * ou repetidos, e títulos de grupo sem itens embaixo.
 */
export function cleanEntries(entries: ContextMenuEntries): ContextMenuEntry[] {
  const out: ContextMenuEntry[] = []
  for (const e of entries) {
    if (!e) continue
    if (isItem(e) && e.items) {
      const items = cleanEntries(e.items)
      if (!items.some(isItem)) continue
      out.push({ ...e, items })
      continue
    }
    out.push(e)
  }
  const result: ContextMenuEntry[] = []
  out.forEach((e, i) => {
    if (isItem(e)) return void result.push(e)
    const rest = out.slice(i + 1)
    const nextItem = rest.findIndex(isItem)
    if (nextItem < 0) return
    if (e.type === 'header' && rest.slice(0, nextItem).some((x) => !isItem(x))) return
    if (e.type === 'separator') {
      if (!result.length || !isItem(result.at(-1)!)) return
      if (rest.slice(0, nextItem).some((x) => !isItem(x) && x.type === 'separator')) return
    }
    result.push(e)
  })
  return result
}

/** Itens que respondem a um atalho ou entram na paleta: as folhas habilitadas, com os submenus abertos. */
export function flattenItems(entries: ContextMenuEntries, prefix = ''): (ContextMenuItem & { path: string })[] {
  return cleanEntries(entries).flatMap((e) => {
    if (!isItem(e) || e.disabled) return []
    if (e.items) return flattenItems(e.items, `${prefix}${e.label}: `)
    return e.run ? [{ ...e, path: `${prefix}${e.label}` }] : []
  })
}

/** O item com esse atalho (o primeiro, na ordem do menu). */
export function itemForShortcut(entries: ContextMenuEntries, e: Parameters<typeof matchesShortcut>[0]) {
  return flattenItems(entries).find((item) => item.shortcut && matchesShortcut(e, item.shortcut))
}

