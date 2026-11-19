import type { EnterpriseAgentPolicy, EnterpriseIdentity, EnterprisePolicy } from '@shared/ipc'
import { registerIdentityProvider, type IdentityProvider } from '../identity'
import { EnterpriseModuleMissingError, loadEnterpriseModule, type EnterpriseIdentityExtension, type EnterpriseSecretsModule } from '../secret-engine/backend'

const STATUSES = new Set(['signedOut', 'signingIn', 'signedIn', 'expired'])

/**
 * Só o que a interface mostra, copiado campo a campo: o que mais o módulo puser no estado
 * (um token, por engano) nunca chega ao renderer.
 */
export function sanitizeIdentity(raw: EnterpriseIdentity): EnterpriseIdentity {
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const org = (o: unknown) => {
    const { id, name } = (o ?? {}) as { id?: unknown; name?: unknown }
    return typeof id === 'string' && typeof name === 'string' ? { id, name } : undefined
  }
  const s = (raw.session ?? {}) as Partial<EnterpriseIdentity['session']>
  const status = STATUSES.has(s.status as string) ? s.status! : 'signedOut'
  const signedIn = status === 'signedIn'
  const user = signedIn && s.user && typeof s.user.name === 'string' ? { name: s.user.name, ...(text(s.user.email) ? { email: s.user.email } : {}) } : undefined
  const provider = s.provider === 'azureAd' || s.provider === 'okta' || s.provider === 'awsIam' ? s.provider : undefined
  const out: EnterpriseIdentity = {
    available: raw.available === true,
    session: {
      status,
      ...(user ? { user } : {}),
      ...(provider ? { provider } : {}),
      ...(signedIn && text(s.expiresAt) ? { expiresAt: s.expiresAt } : {}),
      ...(text(s.message) ? { message: s.message } : {})
    }
  }
  // Organização e permissões só valem com a sessão aberta: logout ou expiração apagam tudo.
  if (!signedIn) return out
  const organization = org(raw.organization)
  if (organization) out.organization = organization
  if (Array.isArray(raw.organizations)) out.organizations = raw.organizations.map(org).filter((o) => o !== undefined)
  if (Array.isArray(raw.permissions)) {
    out.permissions = raw.permissions
      .filter((p) => typeof p?.project === 'string' && Array.isArray(p.roles))
      .map((p) => ({ project: p.project, roles: p.roles.filter((r) => typeof r === 'string') }))
  }
  const policy = sanitizePolicy(raw.policy)
  if (policy) out.policy = policy
  return out
}

function sanitizePolicy(raw: unknown): EnterprisePolicy | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const p = raw as Record<string, unknown>
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  if (typeof p['fetchedAt'] !== 'string') return undefined
  const ttl = p['maxCacheTtlSeconds']
  return {
    ...(typeof p['project'] === 'string' ? { project: p['project'] } : {}),
    secretsProxyEnabled: p['secretsProxyEnabled'] === true,
    secretsBroker: p['secretsBroker'] === true,
    allowWrites: p['allowWrites'] === true,
    allowedSecretProviders: strings(p['allowedSecretProviders']),
    allowedUpstreamHosts: strings(p['allowedUpstreamHosts']),
    ...(typeof ttl === 'number' && Number.isFinite(ttl) ? { maxCacheTtlSeconds: ttl } : {}),
    ...(p['agentPiiDetection'] === true ? { agentPiiDetection: true } : {}),
    ...(sanitizeAgentPolicy(p['mcp']) ?? {}),
    fetchedAt: p['fetchedAt']
  }
}

function sanitizeAgentPolicy(raw: unknown): { mcp: EnterpriseAgentPolicy } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const m = raw as Record<string, unknown>
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined)
  const out: EnterpriseAgentPolicy = {}
  for (const key of ['allowMethods', 'allowEnvironments', 'protectedEnvironments', 'reviewApprovers'] as const) {
    const list = strings(m[key])
    if (list) out[key] = list
  }
  if (m['readOnly'] === true) out.readOnly = true
  if (m['noWrite'] === true) out.noWrite = true
  const rate = count(m['requestsPerMinute'])
  if (rate !== undefined) out.requestsPerMinute = rate
  const concurrent = count(m['maxConcurrent'])
  if (concurrent !== undefined) out.maxConcurrent = concurrent
  return { mcp: out }
}

/**
 * O login abre no navegador do sistema, nunca numa janela do app. Só https (http apenas em
 * loopback, para o IdP de testes): outro esquema seria abrir um programa qualquer da máquina.
 */
export function safeOpen(openExternal: (url: string) => Promise<void>): (url: string) => Promise<void> {
  return async (url) => {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new Error('O módulo Enterprise pediu para abrir um endereço de login inválido.')
    }
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
      throw new Error(`Login recusado: o endereço precisa ser https (veio ${u.protocol}).`)
    }
    await openExternal(u.href)
  }
}

/** Adapta a conta do módulo ao IdentityProvider do core; null sem conta configurada. */
export function identityProvider(ext: EnterpriseIdentityExtension, openExternal: (url: string) => Promise<void>): IdentityProvider | null {
  const current = ext.state()
  if (!current) return null
  let last = sanitizeIdentity(current)
  return {
    state: () => {
      const next = ext.state()
      if (next) last = sanitizeIdentity(next)
      return last
    },
    signIn: () => ext.signIn(safeOpen(openExternal)),
    signOut: () => ext.signOut(),
    switchOrganization: (id) => ext.switchOrganization(id),
    onChange: (listener) => ext.onChange(listener)
  }
}

/**
 * Liga o login corporativo do módulo Enterprise, se houver. Roda depois da janela abrir, para
 * não pesar no cold start; sem módulo, ou com um módulo sem `identity`, nada muda e o app segue
 * só com o perfil local.
 */
export async function connectEnterpriseIdentity(
  openExternal: (url: string) => Promise<void>,
  load: () => Promise<EnterpriseSecretsModule> = loadEnterpriseModule
): Promise<void> {
  let mod: EnterpriseSecretsModule
  try {
    mod = await load()
  } catch (err) {
    if (!(err instanceof EnterpriseModuleMissingError)) console.error((err as Error).message)
    return
  }
  const ext = mod.identity
  if (!ext) return
  const provider = identityProvider(ext, openExternal)
  if (provider) return registerIdentityProvider(provider)
  // A configuração pode chegar depois: a descoberta do Control Plane responde, ou o workspace aberto declara a organização.
  const off = ext.onChange(() => {
    const later = identityProvider(ext, openExternal)
    if (!later) return
    off()
    registerIdentityProvider(later)
  })
}
