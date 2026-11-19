import { useEffect, useState } from 'react'
import { Command as CommandIcon, FolderTree, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { PANEL_GROUPS, type PanelDefinition } from '../../panels/registry'
import { cx } from '../../design-system'

const STORAGE_KEY = 'vvpost.shell.sidebar'
/** Configurações > Interface muda a sidebar sem passar pelo botão dela. */
const SIDEBAR_CHANGED = 'vvpost:sidebar-changed'

export function setSidebarExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, expanded ? 'expanded' : 'collapsed')
  } catch {
    // sem armazenamento local: só não lembra
  }
  window.dispatchEvent(new CustomEvent<boolean>(SIDEBAR_CHANGED, { detail: expanded }))
}

export function rememberedExpanded(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'expanded'
  } catch {
    return false
  }
}

/**
 * Navegação global entre módulos, agrupada por intenção: 48 px
 * recolhida, só ícones com divisórias entre os grupos; expandida, com rótulos e títulos dos grupos
 * (o atalho de cada módulo fica na dica). A escolha fica lembrada entre sessões. O primeiro botão
 * mostra o explorador do projeto, a árvore de arquivos que abre cada um numa aba.
 */
export function Sidebar(props: {
  panels: PanelDefinition[]
  activeId: string | null
  onOpen: (id: string) => void
  onPalette: () => void
  /** O explorador do projeto (árvore de arquivos), ao lado da sidebar. */
  explorerOpen: boolean
  onToggleExplorer: () => void
}) {
  const [expanded, setExpanded] = useState(rememberedExpanded)
  useEffect(() => {
    const follow = (e: Event) => setExpanded((e as CustomEvent<boolean>).detail)
    window.addEventListener(SIDEBAR_CHANGED, follow)
    return () => window.removeEventListener(SIDEBAR_CHANGED, follow)
  }, [])
  const toggle = () =>
    setExpanded((v) => {
      try {
        localStorage.setItem(STORAGE_KEY, v ? 'collapsed' : 'expanded')
      } catch {
        // sem armazenamento local: só não lembra
      }
      return !v
    })

  const item = cx(
    'relative flex h-9 shrink-0 items-center rounded-[var(--radius-control)] transition-colors',
    expanded ? 'w-full gap-2.5 px-2.5' : 'w-9 justify-center'
  )
  const ToggleIcon = expanded ? PanelLeftClose : PanelLeftOpen

  return (
    <nav
      aria-label="Módulos"
      className={cx(
        'flex min-h-0 shrink-0 flex-col gap-0.5 border-r border-border bg-panel py-2',
        expanded ? 'w-52 px-2' : 'w-12 items-center'
      )}
    >
      <button
        type="button"
        onClick={props.onToggleExplorer}
        aria-label="Explorador"
        aria-pressed={props.explorerOpen}
        aria-keyshortcuts="Control+Shift+E"
        title="Explorador: conectores, fluxos, ambientes e documentos do projeto (Ctrl+Shift+E)"
        className={cx(item, props.explorerOpen ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-border/50 hover:text-fg')}
      >
        <FolderTree size={18} strokeWidth={1.75} aria-hidden className="shrink-0" />
        {expanded && <span className="min-w-0 flex-1 truncate text-left text-sm">Explorador</span>}
      </button>
      <span aria-hidden className={cx('my-1 h-px bg-border', expanded ? 'mx-2.5' : 'w-6')} />
      {/* Os módulos rolam quando a janela é baixa (zoom 150%); paleta e recolher ficam sempre visíveis. */}
      <div
        data-modules
        className={cx(
          'flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto',
          expanded ? '-mx-2 px-2' : 'w-full items-center'
        )}
      >
        {PANEL_GROUPS.map((group, gi) => {
          const items = props.panels.filter((p) => p.group === group.id)
          if (!items.length) return null
          return (
            <div
              key={group.id}
              role="group"
              aria-label={group.label}
              className={cx('flex flex-col gap-0.5', !expanded && 'items-center')}
            >
              {expanded ? (
                <span
                  aria-hidden
                  className={cx(
                    'px-2.5 text-[11px] font-medium tracking-wide text-faint uppercase',
                    gi > 0 ? 'pt-2.5' : 'pt-1'
                  )}
                >
                  {group.label}
                </span>
              ) : (
                gi > 0 && <span aria-hidden className="my-1 h-px w-6 bg-border" />
              )}
              {items.map((p) => {
                const active = p.id === props.activeId
                const Icon = p.icon
                return (
                  <button
                    key={p.id}
                    type="button"
                    data-panel={p.id}
                    onClick={() => props.onOpen(p.id)}
                    aria-label={p.label}
                    aria-current={active ? 'page' : undefined}
                    aria-keyshortcuts={p.key === undefined ? undefined : `Control+${p.key}`}
                    title={`${p.label}: ${p.description}${p.key === undefined ? '' : ` (Ctrl+${p.key})`}`}
                    className={cx(
                      item,
                      active ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-border/50 hover:text-fg'
                    )}
                  >
                    {active && (
                      <span
                        aria-hidden
                        className={cx(
                          'absolute top-2 bottom-2 w-0.5 rounded-full bg-accent',
                          expanded ? '-left-2' : '-left-1.5'
                        )}
                      />
                    )}
                    <Icon size={18} strokeWidth={1.75} aria-hidden className="shrink-0" />
                    {expanded && <span className="min-w-0 flex-1 truncate text-left text-sm">{p.label}</span>}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
      <button
        type="button"
        onClick={props.onPalette}
        aria-label="Paleta de comandos"
        aria-keyshortcuts="Control+K"
        title="Paleta de comandos (Ctrl+K)"
        className={cx(item, 'text-muted hover:bg-border/50 hover:text-fg')}
      >
        <CommandIcon size={18} strokeWidth={1.75} aria-hidden className="shrink-0" />
        {expanded && <span className="flex-1 text-left text-sm">Paleta de comandos</span>}
      </button>
      <button
        type="button"
        onClick={toggle}
        aria-label={expanded ? 'Recolher a navegação' : 'Expandir a navegação'}
        aria-expanded={expanded}
        title={expanded ? 'Recolher a navegação' : 'Expandir a navegação com rótulos'}
        className={cx(item, 'text-muted hover:bg-border/50 hover:text-fg')}
      >
        <ToggleIcon size={18} strokeWidth={1.75} aria-hidden className="shrink-0" />
        {expanded && <span className="flex-1 text-left text-sm">Recolher</span>}
      </button>
    </nav>
  )
}
