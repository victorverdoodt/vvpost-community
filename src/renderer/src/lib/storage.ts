/** localStorage pode faltar (modo bench, armazenamento bloqueado): só perde a conveniência. */
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(`vvpost.${key}`)
  } catch {
    return null
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(`vvpost.${key}`, value)
  } catch {
    // sem armazenamento local
  }
}
