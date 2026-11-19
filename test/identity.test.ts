import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EnterpriseIdentity, IdentityState } from '../src/shared/ipc'
import {
  identityState,
  initials,
  onIdentityChange,
  registerIdentityProvider,
  setLocalProfile,
  setProfileDir,
  signIn,
  signOut,
  switchOrganization
} from '../src/main/identity'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vvpost-identity-'))
  setProfileDir(dir)
})
afterEach(() => {
  registerIdentityProvider(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('identidade', () => {
  it('sem o módulo Enterprise: só o perfil local, e login responde com erro', async () => {
    const state = identityState()
    expect(state.enterprise).toBeNull()
    expect(state.profile.displayName.length).toBeGreaterThan(0)
    for (const action of [signIn(), signOut(), switchOrganization('org.a')]) {
      expect(await action).toMatchObject({ ok: false, message: expect.stringContaining('Enterprise') })
    }
  })

  it('grava o nome de exibição local em profile.json e calcula as iniciais', async () => {
    const result = await setLocalProfile({ displayName: '  Victor   Verdoodt ' })
    expect(result).toMatchObject({ ok: true, value: { profile: { displayName: 'Victor Verdoodt', initials: 'VV' } } })
    expect(JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'))).toEqual({ displayName: 'Victor Verdoodt' })
    expect(identityState().profile.displayName).toBe('Victor Verdoodt')
    expect(await setLocalProfile({ displayName: ' ' })).toMatchObject({ ok: false })
    expect(await setLocalProfile({ displayName: 'x'.repeat(61) })).toMatchObject({ ok: false })
    expect(initials('ana')).toBe('A')
    expect(initials('élio de souza')).toBe('ÉS')
  })

  it('o provedor Enterprise preenche a sessão e cada mudança chega aos ouvintes', async () => {
    let session: EnterpriseIdentity = { available: true, session: { status: 'signedOut' } }
    registerIdentityProvider({
      state: () => session,
      signIn: async () => {
        session = {
          available: true,
          session: { status: 'signedIn', user: { name: 'Ana Lima' }, provider: 'azureAd' },
          organization: { id: 'org.a', name: 'Acme' }
        }
      },
      signOut: async () => {
        session = { available: true, session: { status: 'signedOut' } }
      },
      switchOrganization: async (id) => {
        session = { ...session, organization: { id, name: id } }
      }
    })
    const seen: IdentityState[] = []
    const off = onIdentityChange((s) => seen.push(s))
    expect(await signIn()).toMatchObject({ ok: true, value: { enterprise: { session: { status: 'signedIn' } } } })
    expect(await switchOrganization('org.b')).toMatchObject({
      ok: true,
      value: { enterprise: { organization: { id: 'org.b' } } }
    })
    expect(await switchOrganization(42)).toMatchObject({ ok: false })
    await signOut()
    off()
    expect(seen.map((s) => s.enterprise?.session.status)).toEqual(['signedIn', 'signedIn', 'signedOut'])
    // O perfil local continua o mesmo: autenticar-se não troca o perfil da estação.
    expect(identityState().profile).toEqual(seen[0]!.profile)
  })
})
