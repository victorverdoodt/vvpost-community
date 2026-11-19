import type { PublisherCredentials } from '@vvpost/core/docs/publish'

/** Seção do cofre com as credenciais dos publicadores, por <plugin>/<publicador>. */
const SCOPE = 'publishers'

/**
 * As credenciais que a pessoa cola no "Enviar para…" para um publicador de plugin. Ficam no cofre
 * local (cifrado, a chave no cofre do sistema), numa pasta própria da pasta de usuário: são da
 * conta da pessoa, valem para qualquer workspace e nunca entram num projeto.
 */
export function vaultCredentials(dir: string): PublisherCredentials {
  const vault = () => import('@vvpost/core/vault')
  return {
    async get(key) {
      const store = await (await vault()).readVault(dir)
      return store[SCOPE]?.[key] ?? null
    },
    async set(key, value) {
      await (await vault()).updateVault(dir, (store) => {
        store[SCOPE] = { ...store[SCOPE], [key]: value }
      })
    },
    async delete(key) {
      await (await vault()).updateVault(dir, (store) => {
        if (store[SCOPE]) delete store[SCOPE][key]
      })
    }
  }
}
