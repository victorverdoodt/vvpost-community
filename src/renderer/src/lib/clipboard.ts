/** Copia para a área de transferência e devolve a mensagem do toast ("URL copiada."). */
export async function copyText(text: string, what: string): Promise<string> {
  await navigator.clipboard.writeText(text)
  return `${what} na área de transferência.`
}

/** Id local livre a partir de um nome ("Cenário da request" → cenario-da-request-2). */
export function freeId(base: string, taken: Iterable<string>): string {
  const slug =
    base
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'item'
  const used = new Set(taken)
  if (!used.has(slug)) return slug
  for (let i = 2; ; i++) if (!used.has(`${slug}-${i}`)) return `${slug}-${i}`
}

/** Nome livre para uma cópia: "Cobrança (cópia)", "Cobrança (cópia 2)". */
export function copyName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const first = `${name} (cópia)`
  if (!used.has(first)) return first
  for (let i = 2; ; i++) if (!used.has(`${name} (cópia ${i})`)) return `${name} (cópia ${i})`
}
