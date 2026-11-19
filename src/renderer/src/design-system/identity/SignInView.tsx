import { useState } from 'react'
import { LogIn } from 'lucide-react'
import { Button } from '../primitives/Button'
import { cx } from '../cx'
import { AuthProviderSelector } from './AuthProviderSelector'
import { PROVIDER_NAME, type AuthProvider, type OrganizationRef } from './types'

/**
 * Login corporativo opcional. Abre o navegador do sistema (Authorization Code com PKCE); o app
 * nunca vê a senha. Sempre há como seguir sem conta: o VVPost local não depende de login.
 */
export function SignInView(props: {
  providers: AuthProvider[]
  organization?: OrganizationRef
  status: 'signedOut' | 'signingIn' | 'signedIn' | 'expired'
  message?: string
  onSignIn: (provider: AuthProvider) => void
  onCancel?: () => void
  className?: string
}) {
  const [provider, setProvider] = useState<AuthProvider>(props.providers[0] ?? 'azureAd')
  const busy = props.status === 'signingIn'
  return (
    <section aria-label="Entrar com a conta corporativa" className={cx('flex flex-col gap-3 text-xs', props.className)}>
      <div>
        <h2 className="text-sm font-semibold text-fg">{props.status === 'expired' ? 'Sessão expirada' : 'Conta corporativa'}</h2>
        <p className="mt-1 text-muted">
          {props.organization ? `Entre na ${props.organization.name} para usar SSO, ` : 'Entre para usar SSO, '}
          catálogo, broker de segredos e execução remota. O resto do VVPost funciona sem login.
        </p>
      </div>
      <AuthProviderSelector providers={props.providers} value={provider} onChange={setProvider} disabled={busy} />
      {props.message && (
        <p role="alert" className={props.status === 'expired' ? 'text-warning' : 'text-danger'}>
          {props.message}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button variant="primary" icon={<LogIn size={14} aria-hidden />} disabled={busy} onClick={() => props.onSignIn(provider)}>
          {busy ? 'Esperando o navegador…' : `Entrar com ${PROVIDER_NAME[provider]}`}
        </Button>
        {props.onCancel && (
          <Button variant="ghost" onClick={props.onCancel}>
            Continuar sem conta
          </Button>
        )}
      </div>
    </section>
  )
}
