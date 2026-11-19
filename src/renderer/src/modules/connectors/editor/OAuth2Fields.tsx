import type { Connector } from '@shared/ipc'
import { SelectField, TextField } from './fields'

type OAuth2 = Extract<NonNullable<NonNullable<Connector['config']>['auth']>, { type: 'oauth2' }>

/**
 * Campos do OAuth2 (grant, URLs, cliente, escopo, formato do pedido de token): a auth oauth2 do
 * conector e o nó `oauth2` de um fluxo-base usam os mesmos.
 */
export function OAuth2Fields(props: { auth: OAuth2; onChange: (auth: OAuth2) => void; /** Painel estreito (Inspector do Flow Studio): um campo por linha. */ narrow?: boolean }) {
  const { auth } = props
  const patch = (p: Record<string, unknown>) => props.onChange({ ...auth, ...p } as OAuth2)
  const field = (key: string, label: string, placeholder?: string) => (
    <TextField
      label={label}
      mono
      value={(auth as unknown as Record<string, string | undefined>)[key]}
      onChange={(v) => patch({ [key]: v })}
      placeholder={placeholder}
    />
  )
  return (
    <div className={props.narrow ? 'flex flex-col gap-3' : 'grid grid-cols-3 gap-3'}>
      <SelectField
        label="Grant"
        value={auth.grantType}
        options={[
          { value: 'client_credentials', label: 'client_credentials' },
          { value: 'password', label: 'password' },
          { value: 'authorization_code', label: 'authorization_code (navegador)' }
        ]}
        onChange={(v) => patch({ grantType: v })}
      />
      {auth.grantType === 'authorization_code' && field('authUrl', 'Authorization URL', 'https://login.exemplo.com/authorize')}
      {auth.grantType === 'authorization_code' && field('redirectUri', 'Redirect URI', 'http://127.0.0.1:<porta livre>/callback')}
      {auth.grantType === 'authorization_code' && (
        <SelectField
          label="PKCE"
          value={auth.pkce === false ? 'off' : 'on'}
          options={[
            { value: 'on', label: 'S256 (recomendado)' },
            { value: 'off', label: 'Desligado' }
          ]}
          onChange={(v) => patch({ pkce: v === 'on' ? undefined : false })}
        />
      )}
      {field('tokenUrl', 'Token URL', '/oauth/token')}
      {field('clientId', 'Client id')}
      {field('clientSecret', 'Client secret', '{{CLIENT_SECRET}}')}
      {auth.grantType === 'password' && field('username', 'Usuário')}
      {auth.grantType === 'password' && field('password', 'Senha', '{{PASSWORD}}')}
      {field('scope', 'Scope')}
      {field('audience', 'Audience')}
      <SelectField
        label="Credenciais do cliente"
        value={auth.clientAuthentication ?? 'basic'}
        options={[
          { value: 'basic', label: 'Authorization: Basic' },
          { value: 'body', label: 'No corpo' }
        ]}
        onChange={(v) => patch({ clientAuthentication: v })}
      />
      <SelectField
        label="Corpo do pedido de token"
        value={auth.tokenRequestFormat ?? 'form'}
        options={[
          { value: 'form', label: 'Form (x-www-form-urlencoded)' },
          { value: 'json', label: 'JSON' }
        ]}
        onChange={(v) => patch({ tokenRequestFormat: v })}
      />
    </div>
  )
}
