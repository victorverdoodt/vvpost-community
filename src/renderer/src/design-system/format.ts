export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// Datas e horas no português do app, não no idioma do sistema.
const LOCALE = 'pt-BR'

/** Hora: 22:38:19. */
export function formatTime(at: number | Date): string {
  return new Date(at).toLocaleTimeString(LOCALE)
}

/** Data e hora: 24/10/2026, 22:38:19. */
export function formatDateTime(at: number | Date): string {
  return new Date(at).toLocaleString(LOCALE)
}
