/**
 * Eventos do teste com usuários. Fora do modo de estudo o main descarta o
 * evento; aqui não entra nada além de ids, códigos e tempos.
 */
export function track(type: string, data?: Record<string, string | number | boolean | undefined>): void {
  try {
    window.vvpost.trackUx(type, data)
  } catch {
    // sem preload (testes de componente): nada a registrar
  }
}
