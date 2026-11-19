import { ShieldCheck, ShieldOff } from 'lucide-react'
import { Badge } from '../primitives/Badge'
import { cx } from '../cx'
import type { ProjectPermission } from './types'

/** Papéis de um projeto, somando os da organização inteira ("*"). */
export function rolesFor(permissions: ProjectPermission[] | undefined, project?: string): string[] {
  const roles = new Set<string>()
  for (const p of permissions ?? []) if (p.project === '*' || (project !== undefined && p.project === project)) p.roles.forEach((r) => roles.add(r))
  return [...roles]
}

/**
 * Permissões efetivas, mostradas no contexto: sem `project`, todos os projetos (menu da conta);
 * com `project` e `requires`, diz se a ação é permitida e o que falta. Só exibe: quem decide é
 * o Control Plane, e a interface nunca libera nada por conta própria.
 */
export function PermissionIndicator(props: {
  permissions?: ProjectPermission[]
  project?: string
  /** Algum destes papéis permite a ação (Admin conta como qualquer um). */
  requires?: string[]
  className?: string
}) {
  const { permissions, project, requires } = props
  if (requires) {
    const roles = rolesFor(permissions, project)
    const allowed = roles.includes('Admin') || requires.some((r) => roles.includes(r))
    const where = project ? ` em ${project}` : ''
    return (
      <span
        role="status"
        className={cx('inline-flex items-center gap-1.5 text-xs', allowed ? 'text-success' : 'text-warning', props.className)}
        title={allowed ? `Permitido${where}: ${roles.join(', ')}` : `Precisa de ${requires.join(' ou ')}${where}${roles.length ? `; você tem ${roles.join(', ')}` : '; você não tem papel'}`}
      >
        {allowed ? <ShieldCheck size={13} aria-hidden /> : <ShieldOff size={13} aria-hidden />}
        {allowed ? 'Permitido' : `Precisa de ${requires.join(' ou ')}`}
      </span>
    )
  }
  const rows = (permissions ?? []).filter((p) => project === undefined || p.project === '*' || p.project === project)
  if (rows.length === 0) {
    return (
      <p className={cx('text-xs text-muted', props.className)} role="status">
        Sem papéis no Control Plane: a conta está autenticada, mas não tem acesso a projetos.
      </p>
    )
  }
  return (
    <ul aria-label="Permissões" className={cx('flex flex-col gap-1 text-xs', props.className)}>
      {rows.map((p) => (
        <li key={p.project} className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-muted">{p.project === '*' ? 'organização' : p.project}</span>
          {p.roles.map((r) => (
            <Badge key={r} tone={r === 'Admin' ? 'accent' : 'neutral'}>
              {r}
            </Badge>
          ))}
        </li>
      ))}
    </ul>
  )
}
