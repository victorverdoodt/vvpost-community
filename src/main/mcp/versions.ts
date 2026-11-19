import { readFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { versionOf } from '../project/apply'

// Versão de um arquivo do projeto para a concorrência otimista do MCP: as leituras devolvem a
// versão e as escritas aceitam `expect` ({caminho: versão}). Se a pessoa (ou outro agente) gravou
// o arquivo depois da leitura, a escrita é recusada com CONFLICT em vez de sobrescrever.
export { versionOf }

/** Versão do arquivo no disco agora; null se não existe. */
export async function fileVersion(dir: string, rel: string): Promise<string | null> {
  const text = await readFile(join(dir, safeRel(rel)), 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  return versionOf(text)
}

/** Versões de vários arquivos, por caminho relativo (com "/"). */
export async function fileVersions(dir: string, rels: Iterable<string>): Promise<Record<string, string | null>> {
  const list = [...new Set(rels)]
  const versions = await Promise.all(list.map((rel) => fileVersion(dir, rel)))
  return Object.fromEntries(list.map((rel, i) => [rel, versions[i]!]))
}

/** `expect` da IA: caminho relativo → versão lida (null: o arquivo não pode existir). */
export type Expected = Record<string, string | null>

export interface VersionConflict {
  path: string
  expected: string | null
  actual: string | null
}

/** Arquivos cujo conteúdo no disco não é mais o que a IA leu. */
export async function versionConflicts(dir: string, expect: Expected | undefined): Promise<VersionConflict[]> {
  if (!expect) return []
  const actual = await fileVersions(dir, Object.keys(expect))
  return Object.entries(expect)
    .filter(([path, version]) => actual[path] !== version)
    .map(([path, expected]) => ({ path, expected, actual: actual[path] ?? null }))
}

/** Caminho relativo dentro do projeto; recusa absoluto e "..". */
export function safeRel(rel: string): string {
  const n = normalize(rel)
  if (isAbsolute(n) || n === '..' || n.startsWith(`..${sep}`)) throw new Error(`caminho fora do projeto: ${rel}`)
  return n
}

export const expectSchema = {
  type: 'object',
  description:
    'Concorrência otimista: {caminho: versão} como as leituras devolvem (null: o arquivo não pode existir). Se algum mudou no disco desde a leitura, nada é gravado e o erro CONFLICT traz a versão atual.',
  additionalProperties: { type: ['string', 'null'] }
}
