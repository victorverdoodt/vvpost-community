import { ChevronDown, ChevronRight, FolderOpen, Search } from 'lucide-react'
import type { WorkspaceInfo } from '@shared/ipc'
import type { PanelDefinition } from '../../panels/registry'
import { cx, Kbd, OrganizationSwitcher, PermissionIndicator, UserMenu } from '../../design-system'
import { Logo } from './Logo'
import { ProjectSwitcher } from './ProjectSwitcher'
import { useIdentity } from './useIdentity'

/** Módulos com atalho na barra superior, como na referência (os demais ficam na sidebar e na paleta). */
const QUICK_LINKS = ['quick-request', 'flows', 'scenarios', 'git']

/**
 * Barra superior do AppShell, que também é a barra de título da janela: marca, workspace, atalhos
 * dos módulos principais e busca. A barra inteira arrasta a janela (os controles não); os botões
 * nativos da janela ficam sobrepostos à direita (ou à esquerda, no macOS), no espaço que
 * `env(titlebar-area-*)` reserva.
 */
export function TopBar(props: {
  workspace: WorkspaceInfo | null
  panels: PanelDefinition[]
  activeId: string
  onOpen: (id: string) => void
  onSwitchWorkspace: () => void
  /** Trocou ou criou um projeto do workspace: relê a pasta aberta. */
  onProjectChanged: () => void
  onPalette: () => void
}) {
  const links = QUICK_LINKS.flatMap((id) => props.panels.find((p) => p.id === id) ?? [])
  return (
    <header className="app-drag titlebar-inset flex h-11 shrink-0 items-center gap-1 border-b border-border bg-panel">
      <div className="flex h-full shrink-0 items-center gap-2.5 pl-3.5 pr-1">
        <Logo size={22} />
        <span className="text-[13px] font-semibold tracking-tight">VVPost</span>
      </div>
      <ChevronRight size={14} className="shrink-0 text-faint" aria-hidden />
      <button
        type="button"
        onClick={props.onSwitchWorkspace}
        aria-label="Trocar de pasta"
        // Com projetos, a pasta cede espaço antes do nome do projeto aberto.
        title={
          props.workspace ? `${props.workspace.dir}\nClique para trocar de pasta` : 'Escolher a pasta do workspace'
        }
        className="flex h-7 max-w-56 min-w-0 shrink-[4] items-center gap-1.5 rounded-[var(--radius-control)] border border-transparent px-2 text-xs hover:border-border hover:bg-elevated"
      >
        <FolderOpen size={14} className="shrink-0 text-muted" aria-hidden />
        <span className={cx('truncate', !props.workspace && 'text-muted')}>
          {props.workspace?.name ?? 'Abrir workspace'}
        </span>
        <ChevronDown size={13} className="shrink-0 text-faint" aria-hidden />
      </button>
      {props.workspace?.projects && <ChevronRight size={14} className="shrink-0 text-faint" aria-hidden />}
      <ProjectSwitcher workspace={props.workspace} onChanged={props.onProjectChanged} />
      <span className="mx-2 h-4 w-px shrink-0 bg-border" />
      <nav aria-label="Atalhos rápidos" className="flex min-w-0 items-center gap-0.5 max-md:hidden">
        {links.map((p) => {
          const Icon = p.icon
          const active = p.id === props.activeId
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => props.onOpen(p.id)}
              aria-pressed={active}
              title={p.label}
              className={cx(
                'flex h-7 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 text-xs',
                active ? 'bg-elevated text-fg' : 'text-muted hover:bg-elevated hover:text-fg'
              )}
            >
              <Icon size={14} className={active ? 'text-accent' : undefined} aria-hidden />
              {p.short}
            </button>
          )
        })}
      </nav>
      <span className="min-w-4 flex-1" />
      <button
        type="button"
        onClick={props.onPalette}
        aria-label="Buscar ou executar comando"
        className="flex h-7 w-72 min-w-0 shrink-[3] items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface px-2 text-xs text-muted hover:border-faint max-lg:w-auto"
      >
        <Search size={14} className="shrink-0" aria-hidden />
        <span className="flex-1 truncate text-left max-lg:hidden">Buscar ou executar comando…</span>
        <Kbd>Ctrl+K</Kbd>
      </button>
      <span className="ml-1">
        <AccountMenu />
      </span>
    </header>
  )
}

function AccountMenu() {
  const { identity, rename, signIn, signOut, switchOrganization, switching } = useIdentity()
  const enterprise = identity?.enterprise
  // Organização e papéis vêm do Control Plane (/me): a interface só mostra, quem decide é o servidor.
  const organizationSlot = enterprise?.organization ? (
    <div className="flex flex-col gap-2">
      <OrganizationSwitcher
        organization={enterprise.organization}
        organizations={enterprise.organizations}
        onSwitch={switchOrganization}
        disabled={switching}
      />
      <PermissionIndicator permissions={enterprise.permissions} />
    </div>
  ) : undefined
  return (
    <UserMenu identity={identity} onRename={rename} onSignIn={signIn} onSignOut={signOut} organizationSlot={organizationSlot} />
  )
}
