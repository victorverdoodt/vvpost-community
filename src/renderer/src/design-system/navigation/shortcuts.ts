/**
 * Atalhos dos menus de contexto e da Command Palette. Um atalho é escrito como
 * `Mod+Shift+C`: `Mod` é Ctrl (Cmd no macOS), e a última parte é a tecla (`e.key`).
 * Os mesmos itens valem em todo o app.
 */
export const Shortcut = {
  run: 'Mod+Enter',
  openInNewTab: 'Mod+Shift+Enter',
  rename: 'F2',
  duplicate: 'Mod+D',
  copy: 'Mod+C',
  copyAsCurl: 'Mod+Shift+C',
  remove: 'Delete',
  reveal: 'Shift+Alt+R',
  newTab: 'Mod+T',
  closeTab: 'Mod+W',
  reopenTab: 'Mod+Shift+T',
  palette: 'Mod+K',
  newRequest: 'Mod+N',
  save: 'Mod+S',
  focusUrl: 'Mod+L',
  searchProject: 'Mod+Shift+F',
  /** Modal Novo do workspace: requisição, fluxo, conector, documento... */
  newItem: 'Mod+Shift+N',
  toggleExplorer: 'Mod+Shift+E',
  nextTab: 'Mod+PageDown',
  previousTab: 'Mod+PageUp',
  find: 'Mod+F',
  cancel: 'Escape',
  undo: 'Mod+Z',
  redo: 'Mod+Y',
  cut: 'Mod+X',
  paste: 'Mod+V',
  selectAll: 'Mod+A'
} as const

/** Atalhos de edição de texto: num campo focado, são do campo, nunca de um menu. */
const TEXT_EDITING = new Set(['Mod+Z', 'Mod+Y', 'Mod+Shift+Z', 'Mod+X', 'Mod+C', 'Mod+V', 'Mod+A', 'Delete', 'Mod+D', 'F2'])

export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

const isMac = () => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

interface Parsed {
  mod: boolean
  shift: boolean
  alt: boolean
  key: string
}

function parse(shortcut: string): Parsed {
  const parts = shortcut.split('+')
  const key = parts.pop() ?? ''
  return { mod: parts.includes('Mod'), shift: parts.includes('Shift'), alt: parts.includes('Alt'), key }
}

/** O evento corresponde ao atalho (modificadores exatos; letra sem diferença de caixa). */
export function matchesShortcut(e: KeyLike, shortcut: string, mac = isMac()): boolean {
  const s = parse(shortcut)
  const mod = mac ? e.metaKey : e.ctrlKey
  const other = mac ? e.ctrlKey : e.metaKey
  if (mod !== s.mod || other || e.shiftKey !== s.shift || e.altKey !== s.alt) return false
  return e.key.toLowerCase() === s.key.toLowerCase()
}

/** Texto do atalho na tela: `Ctrl+Shift+C`, ou `⌘⇧C` no macOS. */
export function formatShortcut(shortcut: string, mac = isMac()): string {
  const s = parse(shortcut)
  const key = s.key.length === 1 ? s.key.toUpperCase() : s.key === 'Delete' ? 'Del' : s.key
  if (mac) return `${s.mod ? '⌘' : ''}${s.shift ? '⇧' : ''}${s.alt ? '⌥' : ''}${key}`
  return [s.mod && 'Ctrl', s.shift && 'Shift', s.alt && 'Alt', key].filter(Boolean).join('+')
}

/** O atalho é de edição de texto (Ctrl+C, Delete...), que um campo focado consome. */
export function isTextEditingShortcut(shortcut: string): boolean {
  return TEXT_EDITING.has(shortcut)
}

/** Campo de texto, editor ou select: onde as teclas são do próprio campo. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  return (
    target instanceof HTMLInputElement &&
    !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(target.type)
  )
}
