import { useCallback, useEffect, useState } from 'react'
import type { IdentityState, WorkspaceResult } from '@shared/ipc'
import { useToast } from '../../design-system'

/** Identidade do shell (perfil local e, com o módulo Enterprise, a sessão corporativa). */
export function useIdentity() {
  const [identity, setIdentity] = useState<IdentityState | null>(null)
  const [switching, setSwitching] = useState(false)
  const toast = useToast()

  useEffect(() => {
    void window.vvpost.getIdentity().then(setIdentity)
    return window.vvpost.onIdentityChanged(setIdentity)
  }, [])

  const apply = useCallback(
    async (task: Promise<WorkspaceResult<IdentityState>>) => {
      const result = await task
      if (result.ok) setIdentity(result.value)
      else toast(result.message, 'danger')
      return result
    },
    [toast]
  )

  return {
    identity,
    rename: async (displayName: string) => {
      const result = await window.vvpost.setLocalProfile({ displayName })
      if (result.ok) setIdentity(result.value)
      return result.ok ? null : result.message
    },
    signIn: () => void apply(window.vvpost.signIn()),
    signOut: () => void apply(window.vvpost.signOut()),
    switching,
    switchOrganization: (id: string) => {
      setSwitching(true)
      void apply(window.vvpost.switchOrganization(id)).finally(() => setSwitching(false))
    }
  }
}
