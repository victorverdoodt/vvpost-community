import { SegmentedControl } from '../primitives/SegmentedControl'
import { PROVIDER_NAME, type AuthProvider } from './types'

/**
 * Escolha do provedor de login quando a organização configura mais de um. Com um só, mostra
 * qual é (o usuário sabe para onde o navegador vai antes de clicar em Entrar).
 */
export function AuthProviderSelector(props: { providers: AuthProvider[]; value: AuthProvider; onChange: (p: AuthProvider) => void; disabled?: boolean }) {
  if (props.providers.length <= 1) {
    return <p className="text-xs text-muted">Login por {PROVIDER_NAME[props.value]}</p>
  }
  return (
    <SegmentedControl
      label="Provedor de login"
      value={props.value}
      onChange={props.onChange}
      disabled={props.disabled}
      options={props.providers.map((p) => ({ value: p, label: PROVIDER_NAME[p] }))}
    />
  )
}
