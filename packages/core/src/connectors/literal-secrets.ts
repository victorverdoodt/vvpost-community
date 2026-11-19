import type { Connector } from '@vvpost/schemas'
import { SENSITIVE_HEADERS } from '../secrets'

const hasVariable = (value: string) => /\{\{\s*[^}]+\}\}/.test(value)

/**
 * Campos de credencial com valor literal (sem nenhuma {{VAR}}): auth, passphrase do
 * mTLS e headers de nome sensível, inclusive os dos cenários.
 */
export function literalSecrets(connector: Connector): string[] {
  const found: string[] = []
  const check = (path: string, value: unknown) => {
    if (typeof value === 'string' && value.trim() && !hasVariable(value)) found.push(path)
  }
  const headers = (path: string, h: Record<string, string | null> | null | undefined) => {
    for (const [name, value] of Object.entries(h ?? {})) {
      if (SENSITIVE_HEADERS.has(name.toLowerCase())) check(`${path}.${name}`, value)
    }
  }
  const auth = connector.config?.auth
  if (auth?.type === 'bearer') check('auth.token', auth.token)
  if (auth?.type === 'apiKey') check('auth.value', auth.value)
  if (auth?.type === 'basic') check('auth.password', auth.password)
  if (auth?.type === 'oauth2') {
    check('auth.clientSecret', auth.clientSecret)
    check('auth.password', auth.password)
  }
  if (auth?.type === 'login') headers('auth.request.headers', auth.request.headers)
  if (auth?.type === 'digest' || auth?.type === 'ntlm') check('auth.password', auth.password)
  if (auth?.type === 'awsSigV4') {
    check('auth.secretAccessKey', auth.secretAccessKey)
    check('auth.sessionToken', auth.sessionToken)
  }
  if (auth?.type === 'oauth1') {
    check('auth.consumerSecret', auth.consumerSecret)
    check('auth.tokenSecret', auth.tokenSecret)
  }
  check('tls.passphrase', connector.config?.tls?.passphrase)
  headers('headers', connector.config?.headers)
  for (const e of connector.endpoints ?? []) {
    headers(`${e.id}.headers`, e.headers)
    for (const s of e.scenarios ?? []) headers(`${e.id}/${s.id}.headers`, s.overrides?.headers)
  }
  return found
}
