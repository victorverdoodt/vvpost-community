import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EnterpriseIdentity } from '../src/shared/ipc'
import { connectEnterpriseIdentity, safeOpen, sanitizeIdentity } from '../src/main/enterprise/identity'
import { identityState, registerIdentityProvider, setProfileDir, signIn, signOut, switchOrganization } from '../src/main/identity'
import { EnterpriseModuleMissingError, type EnterpriseIdentityExtension, type EnterpriseSecretsModule } from '../src/main/secret-engine/backend'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

setProfileDir(mkdtempSync(join(tmpdir(), 'vvpost-identity-')))
afterEach(() => registerIdentityProvider(null))

const signedIn: EnterpriseIdentity = {
  available: true,
  session: { status: 'signedIn', user: { name: 'Ana Souza', email: 'ana@contoso.com' }, provider: 'azureAd', expiresAt: '2026-10-24T23:00:00Z' },
  organization: { id: 'contoso', name: 'Contoso' },
  organizations: [{ id: 'contoso', name: 'Contoso' }, { id: 'fabrikam', name: 'Fabrikam' }],
  permissions: [{ project: 'payments', roles: ['Developer'] }]
}

function fakeAccount(initial: EnterpriseIdentity | null) {
  let state = initial
  const listeners = new Set<() => void>()
  const opened: string[] = []
  const ext: EnterpriseIdentityExtension = {
    state: () => state,
    signIn: async (open) => {
      await open('https://login.microsoftonline.com/contoso/oauth2/v2.0/authorize?code_challenge=x')
      opened.push('ok')
      state = signedIn
      listeners.forEach((l) => l())
    },
    signOut: async () => {
      state = { available: true, session: { status: 'signedOut' } }
      listeners.forEach((l) => l())
    },
    switchOrganization: async (id) => {
      if (id !== 'fabrikam') throw new Error('Organização não autorizada.')
      state = { ...signedIn, organization: { id: 'fabrikam', name: 'Fabrikam' } }
    },
    onChange: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
  const mod = { apiVersion: 1, audit: () => {}, createBackend: async () => ({}) as never, identity: ext } as EnterpriseSecretsModule
  return { mod, opened, listeners }
}

describe('Login corporativo do módulo Enterprise', () => {
  it('sem módulo, ou módulo sem conta configurada, o app fica só com o perfil local', async () => {
    await connectEnterpriseIdentity(async () => {}, async () => {
      throw new EnterpriseModuleMissingError()
    })
    expect(identityState().enterprise).toBeNull()
    await connectEnterpriseIdentity(async () => {}, async () => fakeAccount(null).mod)
    expect(identityState().enterprise).toBeNull()
    await expect(signIn()).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/indisponível/) })
  })

  it('login abre o navegador do sistema, e organização e permissões chegam com a sessão', async () => {
    const { mod, listeners } = fakeAccount({ available: true, session: { status: 'signedOut' } })
    const open = vi.fn(async () => {})
    await connectEnterpriseIdentity(open, async () => mod)
    expect(identityState().enterprise?.session.status).toBe('signedOut')
    const result = await signIn()
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/login\.microsoftonline\.com\//))
    expect(result).toMatchObject({ ok: true, value: { enterprise: { session: { status: 'signedIn' }, organization: { id: 'contoso' } } } })
    await expect(switchOrganization('fabrikam')).resolves.toMatchObject({ ok: true, value: { enterprise: { organization: { id: 'fabrikam' } } } })
    await expect(switchOrganization('outra')).resolves.toMatchObject({ ok: false, message: 'Organização não autorizada.' })
    await expect(signOut()).resolves.toMatchObject({ ok: true, value: { enterprise: { session: { status: 'signedOut' } } } })
    expect(identityState().enterprise?.organization).toBeUndefined()
    registerIdentityProvider(null)
    expect(listeners.size).toBe(0)
  })

  it('só o que a interface mostra passa para o renderer, nunca um token', () => {
    const leaky = { ...signedIn, accessToken: 'eyJ.segredo', session: { ...signedIn.session, refreshToken: 'rt' } } as unknown as EnterpriseIdentity
    const clean = sanitizeIdentity(leaky)
    expect(JSON.stringify(clean)).not.toMatch(/segredo|rt"/)
    expect(clean).toEqual(signedIn)
    const policy = { project: 'payments', secretsProxyEnabled: true, secretsBroker: true, allowWrites: false, allowedSecretProviders: ['azureKeyVault', 7], allowedUpstreamHosts: [], maxCacheTtlSeconds: 120, fetchedAt: '2026-10-24T23:00:00Z', token: 'x' }
    expect(sanitizeIdentity({ ...signedIn, policy } as unknown as EnterpriseIdentity).policy).toEqual({
      project: 'payments',
      secretsProxyEnabled: true,
      secretsBroker: true,
      allowWrites: false,
      allowedSecretProviders: ['azureKeyVault'],
      allowedUpstreamHosts: [],
      maxCacheTtlSeconds: 120,
      fetchedAt: '2026-10-24T23:00:00Z'
    })
    expect(sanitizeIdentity({ ...signedIn, policy, session: { status: 'expired' } } as unknown as EnterpriseIdentity).policy).toBeUndefined()
    // Sessão expirada não mostra organização nem papéis antigos.
    expect(sanitizeIdentity({ ...signedIn, session: { status: 'expired', message: 'Sessão expirou' } })).toEqual({
      available: true,
      session: { status: 'expired', message: 'Sessão expirou' }
    })
  })

  it('o login só abre endereço https (http apenas em loopback)', async () => {
    const open = vi.fn(async () => {})
    const guarded = safeOpen(open)
    await expect(guarded('file:///etc/passwd')).rejects.toThrow(/https/)
    await expect(guarded('http://idp.contoso.com/authorize')).rejects.toThrow(/https/)
    await expect(guarded('nada')).rejects.toThrow(/inválido/)
    await guarded('http://127.0.0.1:5000/authorize')
    await guarded('https://idp.contoso.com/authorize')
    expect(open).toHaveBeenCalledTimes(2)
  })
})
