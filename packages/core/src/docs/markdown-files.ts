import { readFile, stat, writeFile } from 'node:fs/promises'
import type { LoadedWorkspace } from '../connectors/workspace'
import { createSecretSanitizer } from '../sanitizer'
import { DocsError } from './build'
import { normalizeRel, resolveWorkspaceFile, workspaceWritePath } from './compose'

export { markdownFileName } from './markdown-name'

/**
 * Documentos Markdown do workspace abertos numa aba do app (documentação viva: prévia com as
 * diretivas {{> ...}} ou o texto cru). Grava só .md dentro do workspace, fora de .git e .vvpost,
 * sem valor de segredo e sem sobrescrever uma mudança feita fora desde a abertura.
 */

const MAX_MARKDOWN_BYTES = 1024 * 1024

const same = (a: string, b: string) => a.replace(/\r\n?/g, '\n').replace(/\s+$/, '') === b.replace(/\r\n?/g, '\n').replace(/\s+$/, '')

function checkFile(file: string): string {
  const rel = normalizeRel(file)
  if (!/\.md$/i.test(rel)) throw new DocsError(`documentos ficam em arquivos .md ("${file}")`)
  if (rel.startsWith('../') || rel === '..' || rel.startsWith('.git/') || rel.startsWith('.vvpost/')) {
    throw new DocsError(`"${file}" não pode ser um documento do projeto`)
  }
  return rel
}

/** Um documento .md do workspace, para abrir numa aba. */
export async function readMarkdownFile(ws: LoadedWorkspace, file: string): Promise<string> {
  const rel = checkFile(file)
  const path = await resolveWorkspaceFile(ws.dir, rel)
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_MARKDOWN_BYTES) throw new DocsError(`"${rel}" não é um documento válido (até 1 MB)`)
  return readFile(path, 'utf8')
}

export interface WriteMarkdownInput {
  file: string
  text: string
  /** O texto que a aba abriu: se o arquivo mudou desde então, nada é gravado. */
  previous?: string
  /** Documento novo: falha se o arquivo já existir. */
  create?: boolean
}

export async function writeMarkdownFile(ws: LoadedWorkspace, input: WriteMarkdownInput): Promise<{ file: string }> {
  const rel = checkFile(input.file)
  if (typeof input.text !== 'string') throw new DocsError('o documento precisa ser texto')
  if (Buffer.byteLength(input.text) > MAX_MARKDOWN_BYTES) throw new DocsError('o documento passa de 1 MB')
  const sanitizer = createSecretSanitizer()
  sanitizer.addWorkspace(ws)
  if (sanitizer.leaks(input.text)) throw new DocsError('o documento tem o valor de um segredo do workspace; nada foi gravado')
  const path = await workspaceWritePath(ws.dir, rel)
  const current = await readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  if (input.create && current !== null) throw new DocsError(`"${rel}" já existe; escolha outro nome`)
  if (!input.create && current === null) throw new DocsError(`"${rel}" não existe mais`)
  if (input.previous !== undefined && current !== null && !same(current, input.previous)) {
    throw new DocsError(`"${rel}" mudou fora do app desde que foi aberto; abra de novo`)
  }
  await writeFile(path, input.text.endsWith('\n') ? input.text : `${input.text}\n`)
  return { file: rel }
}
