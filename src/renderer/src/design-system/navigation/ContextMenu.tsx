import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent
} from 'react'
import { ChevronRight, Check } from 'lucide-react'
import { cx } from '../cx'
import type { Command } from './CommandPalette'
import {
  cleanEntries,
  flattenItems,
  isItem,
  itemForShortcut,
  type ContextMenuEntries,
  type ContextMenuEntry,
  type ContextMenuItem
} from './menu-entries'
import { formatShortcut, isEditableTarget, isTextEditingShortcut } from './shortcuts'

export * from './menu-entries'

interface MenuState {
  x: number
  y: number
  label: string
  entries: ContextMenuEntry[]
  /** Quem volta a ter o foco quando o menu fecha. */
  restore: HTMLElement | null
}

type Anchor = { x: number; y: number } | MouseEvent | HTMLElement

/**
 * Menu de contexto (botão direito) do design system. O mesmo menu abre pelo teclado na
 * linha focada, com Shift+F10 ou a tecla de menu, e se navega com as setas, Home, End,
 * Enter, Esc e a primeira letra; → abre um submenu e ← volta. Os atalhos dos itens valem
 * com o foco na linha. Uso: `const ctx = useContextMenu()`, `{...ctx.bind('Endpoint X',
 * () => itens)}` na linha e `{ctx.menu}` em qualquer lugar do componente; `ctx.open` abre
 * num ponto ou elemento (clique esquerdo, atalho).
 */
export function useContextMenu() {
  const [state, setState] = useState<MenuState | null>(null)

  const open = useCallback((at: Anchor, label: string, entries: ContextMenuEntries, restore?: HTMLElement | null) => {
    const list = cleanEntries(entries)
    if (!list.length) return false
    let x: number
    let y: number
    let back: HTMLElement | null = restore ?? null
    if (at instanceof HTMLElement) {
      const rect = at.getBoundingClientRect()
      x = rect.left + 12
      y = rect.bottom
      back ??= at
    } else if ('clientX' in at) {
      x = at.clientX
      y = at.clientY
      back ??= at.currentTarget instanceof HTMLElement ? at.currentTarget : null
    } else {
      x = at.x
      y = at.y
    }
    setState({ x, y, label, entries: list, restore: back ?? (document.activeElement as HTMLElement | null) })
    return true
  }, [])

  const bind = useCallback(
    (label: string, items: () => ContextMenuEntries) => ({
      onContextMenu: (e: MouseEvent<HTMLElement>) => {
        // Num campo de texto dentro da linha, vale o menu de edição de texto (TextEditMenu).
        if (e.defaultPrevented || (e.target !== e.currentTarget && isEditableTarget(e.target))) return
        if (!open(e, label, items(), e.currentTarget)) return
        e.preventDefault()
        e.stopPropagation()
      },
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
        if (e.defaultPrevented) return
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          const target = (document.activeElement as HTMLElement | null) ?? e.currentTarget
          if (!open(target, label, items(), target)) return
          e.preventDefault()
          e.stopPropagation()
          return
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') return
        const item = itemForShortcut(items(), e)
        if (!item || (isEditableTarget(e.target) && isTextEditingShortcut(item.shortcut!))) return
        e.preventDefault()
        e.stopPropagation()
        item.run!()
      }
    }),
    [open]
  )

  const current = useRef(state)
  current.current = state
  const close = useCallback((focus = false) => {
    const restore = current.current?.restore
    setState(null)
    if (focus) restore?.focus()
  }, [])

  const menu = state ? <ContextMenu {...state} onClose={close} /> : null
  /** Abre num ponto (clique esquerdo num valor, atalho de teclado). */
  const openAt = useCallback(
    (at: { x: number; y: number }, label: string, entries: ContextMenuEntries) => void open(at, label, entries),
    [open]
  )
  return { bind, open, openAt, menu, isOpen: !!state, close }
}

function ContextMenu(props: MenuState & { onClose: (focus: boolean) => void }) {
  const { onClose } = props
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.('[data-context-menu]')) onClose(false)
    }
    const dismiss = () => onClose(false)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [onClose])

  return (
    <div ref={root}>
      <MenuList
        label={props.label}
        title={props.label}
        entries={props.entries}
        x={props.x}
        y={props.y}
        onClose={onClose}
      />
    </div>
  )
}

function MenuList(props: {
  label: string
  /** Linha discreta no topo (o nível do menu raiz). */
  title?: string
  entries: ContextMenuEntry[]
  x: number
  y: number
  /** Borda esquerda do item pai, para o submenu abrir do outro lado quando não cabe. */
  parentLeft?: number
  onClose: (focus: boolean) => void
  /** Só nos submenus: ← ou Esc voltam para o item pai. */
  onBack?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  const [pos, setPos] = useState({ left: props.x, top: props.y })
  const [sub, setSub] = useState<{ id: string; x: number; y: number; left: number } | null>(null)
  const { onClose } = props

  // Dentro da janela: se não cabe à direita ou abaixo do ponto, abre para o outro lado.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const fitsRight = props.x + width <= window.innerWidth - 4
    const left = fitsRight ? props.x : props.parentLeft !== undefined ? props.parentLeft - width : window.innerWidth - width - 4
    const top = props.parentLeft !== undefined ? Math.min(props.y, window.innerHeight - height - 4) : props.y + height > window.innerHeight - 4 ? props.y - height : props.y
    setPos({ left: Math.max(4, left), top: Math.max(4, top) })
    el.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus()
  }, [props.x, props.y, props.parentLeft])

  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]:not([aria-disabled="true"])') ?? [])]

  const openSub = (item: ContextMenuItem, el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    setSub({ id: item.id, x: rect.right + 2, y: rect.top - 4, left: (ref.current?.getBoundingClientRect().left ?? rect.left) - 2 })
  }

  const activate = (item: ContextMenuItem, el: HTMLElement) => {
    if (item.disabled) return
    if (item.items) return openSub(item, el)
    onClose(false)
    item.run?.()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    // Teclas de um submenu aberto não sobem para o menu pai.
    if (e.target instanceof HTMLElement && e.target.closest('[role="menu"]') !== ref.current) return
    const list = items()
    const at = list.indexOf(document.activeElement as HTMLElement)
    const go = (i: number) => list[(i + list.length) % list.length]?.focus()
    const entry = (el: HTMLElement | undefined) => props.entries.find((x) => isItem(x) && x.id === el?.dataset.itemId) as ContextMenuItem | undefined
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        if (props.onBack) props.onBack()
        else onClose(true)
        break
      case 'Tab':
        e.preventDefault()
        onClose(true)
        break
      case 'ArrowDown':
        e.preventDefault()
        go(at + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        go(at - 1)
        break
      case 'Home':
        e.preventDefault()
        go(0)
        break
      case 'End':
        e.preventDefault()
        go(list.length - 1)
        break
      case 'ArrowRight': {
        const item = entry(list[at])
        if (item?.items) {
          e.preventDefault()
          openSub(item, list[at]!)
        }
        break
      }
      case 'ArrowLeft':
        if (props.onBack) {
          e.preventDefault()
          e.stopPropagation()
          props.onBack()
        }
        break
      default:
        if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Primeira letra: o próximo item que começa com ela.
          const key = e.key.toLowerCase()
          const order = [...list.slice(at + 1), ...list.slice(0, at + 1)]
          order.find((el) => el.textContent?.trim().toLowerCase().startsWith(key))?.focus()
        }
    }
  }

  const subItem = sub ? (props.entries.find((x) => isItem(x) && x.id === sub.id) as ContextMenuItem | undefined) : undefined

  return (
    <>
      <div
        ref={ref}
        role="menu"
        aria-label={props.label}
        data-context-menu=""
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        style={{ left: pos.left, top: pos.top }}
        className="fixed z-[60] max-h-[calc(100vh-8px)] min-w-56 max-w-96 overflow-auto rounded-[var(--radius-card)] border border-border bg-panel p-1 text-xs shadow-[var(--shadow-overlay)]"
      >
        {props.title && <div className="truncate px-2 pt-1 pb-1.5 text-[11px] text-faint">{props.title}</div>}
        {props.entries.map((entry, i) => {
          if (!isItem(entry)) {
            return entry.type === 'separator' ? (
              <div key={`sep-${i}`} role="separator" className="mx-1 my-1 h-px bg-border-subtle" />
            ) : (
              <div
                key={entry.id ?? `hdr-${i}`}
                role="presentation"
                className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[11px] font-medium text-cyan first:pt-1"
              >
                {entry.icon}
                {entry.label}
              </div>
            )
          }
          const expanded = sub?.id === entry.id
          return (
            <button
              key={entry.id}
              id={`${id}-${entry.id}`}
              type="button"
              role="menuitem"
              data-item-id={entry.id}
              aria-disabled={entry.disabled || undefined}
              aria-haspopup={entry.items ? 'menu' : undefined}
              aria-expanded={entry.items ? expanded : undefined}
              aria-keyshortcuts={entry.shortcut ? entry.shortcut.replace('Mod', 'Control') : undefined}
              onClick={(e) => activate(entry, e.currentTarget)}
              onMouseEnter={(e) => {
                e.currentTarget.focus()
                if (entry.items && !entry.disabled) openSub(entry, e.currentTarget)
                else if (sub) setSub(null)
              }}
              className={cx(
                'flex h-8 w-full items-center gap-2 rounded-[var(--radius-control)] px-2 text-left outline-none hover:bg-elevated focus-visible:bg-elevated focus:bg-elevated',
                entry.disabled ? 'cursor-default text-faint' : entry.danger ? 'text-danger' : 'text-fg',
                expanded && 'bg-elevated'
              )}
            >
              <span className={cx('flex w-4 justify-center', entry.danger && !entry.disabled ? 'text-danger' : 'text-muted')}>
                {entry.checked ? <Check size={14} aria-hidden /> : entry.icon}
              </span>
              <span className="min-w-0 flex-1 truncate" title={entry.label.length > 32 ? entry.label : undefined}>
                {entry.label}
              </span>
              {entry.shortcut ? (
                <span aria-hidden className="text-[11px] text-faint">
                  {formatShortcut(entry.shortcut)}
                </span>
              ) : (
                // A dica cede espaço ao rótulo: o nome inteiro vem antes do id.
                entry.hint && <span className="max-w-[40%] min-w-0 shrink-[2] truncate text-[11px] text-faint">{entry.hint}</span>
              )}
              {entry.items && <ChevronRight size={12} aria-hidden className="text-muted" />}
            </button>
          )
        })}
      </div>
      {sub && subItem?.items && (
        <MenuList
          label={subItem.label}
          entries={subItem.items as ContextMenuEntry[]}
          x={sub.x}
          y={sub.y}
          parentLeft={sub.left}
          onClose={onClose}
          onBack={() => {
            setSub(null)
            document.getElementById(`${id}-${sub.id}`)?.focus()
          }}
        />
      )}
    </>
  )
}

// --- Command Palette ------------------------------------------------------------------

interface CommandRegistry {
  set(key: string, commands: Command[] | null): void
}

const CommandRegistryContext = createContext<CommandRegistry | null>(null)
/** O App diz a cada módulo se ele é o ativo (os abertos ficam montados, escondidos). */
export const PanelActiveContext = createContext(true)

/**
 * Registro das ações dos módulos para a Command Palette. Guarda num ref, sem estado: a
 * paleta lê `commands()` quando abre, então registrar a cada render não re-renderiza o App.
 */
export function useCommandRegistry() {
  const store = useRef(new Map<string, Command[]>())
  const registry = useRef<CommandRegistry>({
    set(key, commands) {
      if (commands?.length) store.current.set(key, commands)
      else store.current.delete(key)
    }
  })
  const commands = useCallback(() => [...store.current.values()].flat(), [])
  return { registry: registry.current, commands, Provider: CommandRegistryContext.Provider }
}

/**
 * Publica itens de menu na Command Palette (grupo à direita) enquanto o módulo está ativo:
 * o mesmo item, com o mesmo atalho, no menu de contexto e na paleta. Com `shortcuts`, os
 * atalhos também valem na janela inteira com o módulo ativo (Ctrl+T, Ctrl+W).
 */
export function useMenuCommands(group: string, entries: ContextMenuEntries, options: { shortcuts?: boolean } = {}) {
  const registry = useContext(CommandRegistryContext)
  const active = useContext(PanelActiveContext)
  const key = useId()
  const latest = useRef(entries)
  latest.current = entries

  useEffect(() => {
    if (!registry) return
    if (!active) return registry.set(key, null)
    registry.set(
      key,
      flattenItems(entries)
        .filter((item) => !item.menuOnly)
        .map((item) => ({
          id: `${key}-${item.path}`,
          title: item.path,
          group,
          icon: item.icon,
          hint: item.shortcut ? formatShortcut(item.shortcut) : item.hint,
          keywords: item.keywords,
          run: item.run!
        }))
    )
  })
  useEffect(() => () => registry?.set(key, null), [registry, key])

  useEffect(() => {
    if (!options.shortcuts || !active) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented) return
      const item = itemForShortcut(latest.current, e)
      // Ctrl+C, Delete, F2 na janela inteira são do texto selecionado ou do campo: ficam para o menu do item focado.
      if (!item || isTextEditingShortcut(item.shortcut!)) return
      e.preventDefault()
      item.run!()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [options.shortcuts, active])
}
