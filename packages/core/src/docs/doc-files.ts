import { rename, stat, unlink } from 'node:fs/promises'
import type { LoadedWorkspace } from '../connectors/workspace'
import { DocsError } from './build'
import { normalizeRel, resolveWorkspaceFile, workspaceWritePath } from './compose'

/**
 * Gerenciar os documentos (.md) e diagramas (.mmd) do workspace pelo explorador: renomear (ou
 * mover de pasta) e excluir. Só esses dois tipos, dentro do workspace e fora de .git e .vvpost.
 */

const KIND = /\.(md|mmd)$/i

function checkFile(file: string): string {
  const rel = normalizeRel(String(file ?? ''))
  if (!KIND.test(rel)) throw new DocsError(`só documentos .md e diagramas .mmd ("${file}")`)
  if (!rel || rel.startsWith('../') || rel === '..' || rel.startsWith('.git/') || rel.startsWith('.vvpost/')) {
    throw new DocsError(`"${file}" não é um documento do projeto`)
  }
  return rel
}

const extension = (rel: string) => rel.slice(rel.lastIndexOf('.')).toLowerCase()

async function existingFile(ws: LoadedWorkspace, rel: string): Promise<string> {
  const path = await resolveWorkspaceFile(ws.dir, rel)
  if (!(await stat(path)).isFile()) throw new DocsError(`"${rel}" não é um arquivo`)
  return path
}

/** Renomeia ou move um .md/.mmd; o destino não pode existir e mantém a extensão. */
export async function renameDocsFile(ws: LoadedWorkspace, input: { from: string; to: string }): Promise<{ file: string }> {
  const from = checkFile(input.from)
  const to = checkFile(input.to)
  if (extension(from) !== extension(to)) throw new DocsError(`o novo nome precisa terminar em ${extension(from)}`)
  if (from === to) return { file: to }
  const source = await existingFile(ws, from)
  const target = await workspaceWritePath(ws.dir, to)
  const taken = await stat(target).then(
    () => true,
    () => false
  )
  // Só mudar maiúsculas num disco que não diferencia: o mesmo arquivo, pode renomear.
  if (taken && from.toLowerCase() !== to.toLowerCase()) throw new DocsError(`"${to}" já existe; escolha outro nome`)
  await rename(source, target)
  return { file: to }
}

/** Exclui um .md/.mmd do workspace (dá para recuperar pelo Git). */
export async function deleteDocsFile(ws: LoadedWorkspace, file: string): Promise<{ file: string }> {
  const rel = checkFile(file)
  await unlink(await existingFile(ws, rel))
  return { file: rel }
}
