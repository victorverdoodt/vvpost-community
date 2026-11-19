import { useRef, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { cx } from '../cx'
import { useContextMenu, type ContextMenuEntries } from './ContextMenu'

export interface WorkspaceTab {
  id: string
  title: string
  icon?: ReactNode
  /** Alterações não salvas: mostra um ponto no lugar do X até o hover. */
  dirty?: boolean
}

/**
 * Abas dos artefatos abertos num módulo (requests, flows, arquivos). Setas, Home e End trocam de
 * aba; Delete fecha a ativa; o botão do meio do mouse fecha a aba sob o cursor.
 */
export function WorkspaceTabs(props: {
  tabs: WorkspaceTab[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose?: (id: string) => void
  onNew?: () => void
  newLabel?: string
  label: string
  /** Prefixo dos ids de aba/painel, para aria-controls. */
  idPrefix: string
  /** Menu de contexto da aba (botão direito, Shift+F10): fechar outras, duplicar... */
  contextMenu?: (tab: WorkspaceTab) => ContextMenuEntries
}) {
  const list = useRef<HTMLDivElement>(null)
  const ctx = useContextMenu()
  const onKeyDown = (e: React.KeyboardEvent) => {
    const { tabs } = props
    const i = tabs.findIndex((t) => t.id === props.activeId)
    let next: number | null = null
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    else if (e.key === 'Delete' && props.activeId && props.onClose) props.onClose(props.activeId)
    const target = next === null ? undefined : tabs[next]
    if (!target) return
    e.preventDefault()
    props.onSelect(target.id)
    list.current?.querySelector<HTMLElement>(`#${props.idPrefix}-tab-${CSS.escape(target.id)}`)?.focus()
  }

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-panel">
      <div
        ref={list}
        role="tablist"
        aria-label={props.label}
        onKeyDown={onKeyDown}
        className="flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none]"
      >
        {props.tabs.map((t) => {
          const active = t.id === props.activeId
          return (
            <div
              key={t.id}
              className={cx(
                'group relative flex max-w-56 shrink-0 items-center border-r border-border-subtle',
                active ? 'bg-surface text-fg' : 'text-muted hover:bg-elevated hover:text-fg'
              )}
            >
              {active && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-accent" />}
              <div
                id={`${props.idPrefix}-tab-${t.id}`}
                role="tab"
                aria-selected={active}
                aria-controls={`${props.idPrefix}-panel-${t.id}`}
                tabIndex={active ? 0 : -1}
                onClick={() => props.onSelect(t.id)}
                onAuxClick={(e) => e.button === 1 && props.onClose?.(t.id)}
                {...(props.contextMenu && ctx.bind(`Aba ${t.title}`, () => props.contextMenu!(t)))}
                title={t.title}
                className="flex h-full min-w-0 cursor-pointer items-center gap-2 pr-1 pl-3 text-xs select-none"
              >
                {t.icon}
                <span className="truncate">{t.title}</span>
              </div>
              {props.onClose && (
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => props.onClose!(t.id)}
                  aria-label="Fechar aba"
                  title="Fechar aba (Delete)"
                  className={cx(
                    'mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-border hover:text-fg',
                    !active && !t.dirty && 'opacity-0 group-hover:opacity-100'
                  )}
                >
                  {t.dirty ? (
                    <>
                      <span aria-hidden className="h-2 w-2 rounded-full bg-fg group-hover:hidden" />
                      <X size={12} aria-hidden className="hidden group-hover:block" />
                    </>
                  ) : (
                    <X size={12} aria-hidden />
                  )}
                </button>
              )}
            </div>
          )
        })}
      </div>
      {ctx.menu}
      {props.onNew && (
        <button
          type="button"
          onClick={props.onNew}
          aria-label={props.newLabel ?? 'Nova aba'}
          title={props.newLabel ?? 'Nova aba'}
          className="flex w-9 shrink-0 items-center justify-center text-muted hover:bg-elevated hover:text-fg"
        >
          <Plus size={14} aria-hidden />
        </button>
      )}
    </div>
  )
}
