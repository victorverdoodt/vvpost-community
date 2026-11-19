import type { EnterpriseIdentity } from '@shared/ipc'
import { Badge, type Tone } from '../primitives/Badge'

const states: Record<EnterpriseIdentity['session']['status'] | 'local', { tone: Tone; label: string }> = {
  local: { tone: 'neutral', label: 'Local' },
  signedOut: { tone: 'neutral', label: 'Desconectado' },
  signingIn: { tone: 'info', label: 'Conectando…' },
  signedIn: { tone: 'success', label: 'Conectado' },
  expired: { tone: 'warning', label: 'Sessão expirada' }
}

/**
 * Estado da sessão: "Local" sem o módulo Enterprise ou sem
 * login; os demais vêm do provedor corporativo. Sempre texto, nunca só a cor.
 */
export function SessionStatus(props: { enterprise: EnterpriseIdentity | null }) {
  const status = props.enterprise?.session.status
  const s = states[!status || status === 'signedOut' ? (props.enterprise?.available ? 'signedOut' : 'local') : status]
  return (
    <Badge tone={s.tone} title={props.enterprise?.session.message}>
      {s.label}
    </Badge>
  )
}
