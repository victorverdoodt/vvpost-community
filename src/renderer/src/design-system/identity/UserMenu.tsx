import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Building2, LogIn, LogOut, Pencil, RefreshCw } from 'lucide-react'
import type { IdentityState } from '@shared/ipc'
import { cx } from '../cx'
import { Button } from '../primitives/Button'
import { SessionStatus } from './SessionStatus'

/**
 * Avatar da barra superior e menu da conta. Mostra o perfil
 * local ou a identidade corporativa, sem confundir os dois: perfil local não é sessão
 * autenticada. Conectar uma conta só aparece quando o módulo Enterprise oferece o login.
 */
export function UserMenu(props: {
  identity: IdentityState | null
  onRename: (displayName: string) => Promise<string | null>
  onSignIn: () => void
  onSignOut: () => void
  /** Ponto para o OrganizationSwitcher do módulo Enterprise. */
  organizationSlot?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  const enterprise = props.identity?.enterprise ?? null
  const session = enterprise?.session
  const signedIn = session?.status === 'signedIn'
  const name = signedIn && session.user ? session.user.name : (props.identity?.profile.displayName ?? '')
  const avatar = signedIn && session.user ? initialsOf(session.user.name) : (props.identity?.profile.initials ?? '')
  const subtitle = signedIn
    ? [enterprise?.organization?.name, 'Conta autenticada'].filter(Boolean).join(' · ')
    : 'Usuário local · Sem sessão autenticada'

  const close = (focus = true) => {
    setOpen(false)
    setEditing(false)
    if (focus) trigger.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    // Setas num seletor do slot (organização) são do próprio seletor.
    if ((e.target as HTMLElement).closest('select, input, textarea')) return
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    if (!items.length) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]!.focus()
  }

  const item =
    'flex h-8 w-full items-center gap-2 rounded-[var(--radius-control)] px-2 text-left text-xs hover:bg-elevated focus-visible:bg-elevated'

  return (
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Conta: ${name || 'carregando'}`}
        title={`${name}\n${subtitle}`}
        disabled={!props.identity}
        onClick={() => (open ? close() : setOpen(true))}
        className={cx(
          'flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold',
          signedIn ? 'bg-accent text-surface' : 'border border-border bg-elevated text-fg hover:border-faint'
        )}
      >
        {avatar}
      </button>
      {open && props.identity && (
        <div
          ref={menu}
          role="menu"
          aria-label="Conta"
          className="absolute top-9 right-0 z-50 w-80 rounded-[var(--radius-card)] border border-border bg-panel p-1.5 shadow-[var(--shadow-overlay)]"
        >
          <div className="flex items-start gap-2.5 px-2 py-2">
            <span
              aria-hidden
              className={cx(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                signedIn ? 'bg-accent text-surface' : 'border border-border bg-elevated'
              )}
            >
              {avatar}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-semibold">{name}</span>
                <SessionStatus enterprise={enterprise} />
              </div>
              <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
              {signedIn && session.user?.email && <p className="truncate text-xs text-muted">{session.user.email}</p>}
            </div>
          </div>
          {session?.message && session.status !== 'signedIn' && (
            <p className="px-2 pb-2 text-xs text-warning">{session.message}</p>
          )}
          {signedIn && (enterprise?.organization || props.organizationSlot) && (
            <div className="border-t border-border-subtle px-2 py-2 text-xs">
              {props.organizationSlot ?? (
                <span className="flex items-center gap-2 text-muted">
                  <Building2 size={14} aria-hidden /> {enterprise?.organization?.name}
                </span>
              )}
            </div>
          )}
          <div className="border-t border-border-subtle pt-1.5">
            {editing ? (
              <RenameForm
                initial={props.identity.profile.displayName}
                onCancel={() => setEditing(false)}
                onSave={async (value) => {
                  const error = await props.onRename(value)
                  if (!error) setEditing(false)
                  return error
                }}
              />
            ) : (
              <button type="button" role="menuitem" className={item} onClick={() => setEditing(true)}>
                <Pencil size={14} className="text-muted" aria-hidden />
                Editar perfil local
              </button>
            )}
            {enterprise?.available && !signedIn && (
              <button
                type="button"
                role="menuitem"
                className={item}
                disabled={session?.status === 'signingIn'}
                onClick={() => {
                  close()
                  props.onSignIn()
                }}
              >
                {session?.status === 'expired' ? (
                  <RefreshCw size={14} className="text-accent" aria-hidden />
                ) : (
                  <LogIn size={14} className="text-accent" aria-hidden />
                )}
                {session?.status === 'expired' ? 'Entrar novamente' : 'Conectar conta Enterprise'}
              </button>
            )}
            {signedIn && (
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  close()
                  props.onSignOut()
                }}
              >
                <LogOut size={14} className="text-muted" aria-hidden />
                Sair da conta
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function RenameForm(props: {
  initial: string
  onSave: (value: string) => Promise<string | null>
  onCancel: () => void
}) {
  const [value, setValue] = useState(props.initial)
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="space-y-1.5 px-2 py-1.5"
      onSubmit={async (e) => {
        e.preventDefault()
        setError(await props.onSave(value))
      }}
    >
      <label className="block text-[11px] text-muted" htmlFor="profile-name">
        Nome de exibição (só nesta estação)
      </label>
      <input
        id="profile-name"
        autoFocus
        maxLength={60}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            props.onCancel()
          }
        }}
        className="h-7 w-full border px-2 text-xs"
      />
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" onClick={props.onCancel}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={!value.trim()}>
          Salvar
        </Button>
      </div>
    </form>
  )
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1)
  return letters.map((w) => [...w][0]!.toUpperCase()).join('') || '?'
}
