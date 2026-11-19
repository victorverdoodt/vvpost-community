import { Building2 } from 'lucide-react'
import { controlClass } from '../primitives/Button'
import { cx } from '../cx'
import type { OrganizationRef } from './types'

/**
 * Organização da conta corporativa. Com uma só, é um rótulo; com várias autorizadas, um
 * seletor. Trocar é pedido ao provider de identidade, que confere a autorização.
 */
export function OrganizationSwitcher(props: {
  organization?: OrganizationRef
  organizations?: OrganizationRef[]
  onSwitch: (id: string) => void
  disabled?: boolean
  className?: string
}) {
  const { organization } = props
  const all = props.organizations ?? (organization ? [organization] : [])
  if (!organization) return null
  if (all.length <= 1) {
    return (
      <div className={cx('flex min-w-0 items-center gap-2 text-xs', props.className)} title={`Organização: ${organization.name} (${organization.id})`}>
        <Building2 size={13} className="shrink-0 text-muted" aria-hidden />
        <span className="truncate text-fg">{organization.name}</span>
      </div>
    )
  }
  return (
    <label className={cx('flex min-w-0 items-center gap-2 text-xs', props.className)}>
      <Building2 size={13} className="shrink-0 text-muted" aria-hidden />
      <span className="sr-only">Organização</span>
      <select
        aria-label="Organização"
        className={cx(controlClass, 'min-w-0 flex-1 rounded-[var(--radius-control)]')}
        value={organization.id}
        disabled={props.disabled}
        onChange={(e) => props.onSwitch(e.target.value)}
      >
        {all.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  )
}
