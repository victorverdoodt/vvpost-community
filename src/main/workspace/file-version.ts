import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/**
 * Versão curta do texto de um arquivo do projeto; null: não existe. É a mesma no app e no MCP:
 * quem leu um arquivo manda a versão ao gravar, e uma gravação de outra pessoa (ou agente) no
 * meio do caminho é recusada em vez de sobrescrita.
 */
export function versionOf(text: string | null | undefined): string | null {
  return text == null ? null : createHash('sha256').update(text).digest('base64url').slice(0, 12)
}

/** Texto do arquivo no disco agora; null se não existe. */
export async function diskText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
}

/** Versão de um conjunto de arquivos (um conector guardado como fluxo-base e os fluxos dele). */
export async function filesVersion(paths: readonly string[]): Promise<string | null> {
  if (paths.length === 1) return versionOf(await diskText(paths[0]!))
  const texts = await Promise.all([...paths].sort().map(async (p) => `${p}\0${(await diskText(p)) ?? ''}`))
  return versionOf(texts.join('\0\0'))
}

/** Mensagem de quando o arquivo mudou no disco desde que a tela abriu. */
export const changedOnDisk = (what: string) =>
  `${what} mudou fora do app desde que foi aberto (a IA ou outra pessoa gravou); abra de novo para não sobrescrever a mudança`
