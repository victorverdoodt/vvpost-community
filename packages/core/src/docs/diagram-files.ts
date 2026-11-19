import { readFile, stat, writeFile } from 'node:fs/promises'
import type { LoadedWorkspace } from '../connectors/workspace'
import { createSecretSanitizer } from '../sanitizer'
import { DocsError } from './build'
import { normalizeRel, resolveWorkspaceFile, workspaceWritePath } from './compose'
import { DIAGRAM_ORIGIN, DIAGRAMS_DIR, diagramSlug, type DiagramOrigin } from './diagram-origin'

export { DIAGRAM_ORIGIN, DIAGRAMS_DIR, splitDiagramOrigin, type DiagramOrigin } from './diagram-origin'

/**
 * Diagramas Mermaid do documento: o editor de diagramas do app abre um diagrama da documentação
 * e grava de volta onde ele está escrito (um bloco ```mermaid num Markdown ou um arquivo .mmd).
 */

const MAX_DIAGRAM_BYTES = 512 * 1024
const MERMAID_OPEN = /^(\s{0,3})(`{3,}|~{3,})\s*mermaid\s*$/i

/** Nome de arquivo para um diagrama novo: docs/diagramas/<nome>.mmd. */
export function diagramFileName(name: string): string {
  const slug = diagramSlug(name)
  if (!slug) throw new DocsError('dê um nome ao diagrama')
  return `${DIAGRAMS_DIR}/${slug}.mmd`
}

const same = (a: string, b: string) => a.replace(/\r\n?/g, '\n').replace(/\s+$/, '') === b.replace(/\r\n?/g, '\n').replace(/\s+$/, '')

function checkCode(ws: LoadedWorkspace, code: string): string {
  if (typeof code !== 'string') throw new DocsError('o diagrama precisa ser texto')
  const clean = code.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  if (!clean.trim()) throw new DocsError('o diagrama está vazio')
  if (Buffer.byteLength(clean) > MAX_DIAGRAM_BYTES) throw new DocsError('o diagrama passa de 512 KB')
  if (clean.split('\n').some((l) => MERMAID_OPEN.test(l) || /^\s{0,3}(`{3,}|~{3,})\s*$/.test(l))) {
    throw new DocsError('o diagrama não pode ter uma cerca de código (```)')
  }
  if (clean.startsWith(DIAGRAM_ORIGIN)) throw new DocsError('tire a linha de origem do diagrama')
  const sanitizer = createSecretSanitizer()
  sanitizer.addWorkspace(ws)
  if (sanitizer.leaks(clean)) throw new DocsError('o diagrama tem o valor de um segredo do workspace; nada foi gravado')
  return clean
}

function checkFile(file: string): string {
  const rel = normalizeRel(file)
  if (!/\.(md|mmd)$/i.test(rel)) throw new DocsError(`diagramas ficam em arquivos .md ou .mmd ("${file}")`)
  if (rel.startsWith('../') || rel === '..' || rel.startsWith('.git/') || rel.startsWith('.vvpost/')) {
    throw new DocsError(`"${file}" não pode receber diagramas`)
  }
  return rel
}

/** Um diagrama .mmd do workspace, para abrir no editor. */
export async function readDiagram(ws: LoadedWorkspace, file: string): Promise<string> {
  const rel = checkFile(file)
  if (!/\.mmd$/i.test(rel)) throw new DocsError('abra só arquivos .mmd; um bloco de um Markdown abre pelo documento')
  const path = await resolveWorkspaceFile(ws.dir, rel)
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_DIAGRAM_BYTES) throw new DocsError(`"${rel}" não é um diagrama válido`)
  return readFile(path, 'utf8')
}

export interface WriteDiagramInput extends DiagramOrigin {
  code: string
  /** O código que o editor abriu: se o arquivo mudou desde então, nada é gravado. */
  previous?: string
  /** Num .mmd novo: falha se o arquivo já existir. */
  create?: boolean
}

/**
 * Grava um diagrama onde ele vive: o conteúdo de um .mmd ou o bloco ```mermaid que abre na linha
 * `line` de um Markdown. Recusa se o bloco não estiver mais lá ou mudou desde que foi aberto
 * (`previous`), cerca de código dentro do diagrama, caminho fora do workspace e segredo.
 */
export async function writeDiagram(ws: LoadedWorkspace, input: WriteDiagramInput): Promise<{ file: string; line?: number }> {
  const rel = checkFile(input.file)
  const code = checkCode(ws, input.code)
  if (/\.mmd$/i.test(rel)) {
    if (input.line !== undefined) throw new DocsError('um .mmd não tem linha: o arquivo inteiro é o diagrama')
    const path = await workspaceWritePath(ws.dir, rel)
    const current = await readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (input.create && current !== null) throw new DocsError(`"${rel}" já existe; escolha outro nome`)
    if (!input.create && current === null) throw new DocsError(`"${rel}" não existe mais`)
    if (input.previous !== undefined && current !== null && !same(current, input.previous)) {
      throw new DocsError(`"${rel}" mudou desde que o diagrama foi aberto; abra de novo`)
    }
    await writeFile(path, `${code}\n`)
    return { file: rel }
  }
  if (!input.line || !Number.isInteger(input.line) || input.line < 1) throw new DocsError('diga a linha do bloco ```mermaid')
  const path = await resolveWorkspaceFile(ws.dir, rel)
  const text = await readFile(path, 'utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const open = MERMAID_OPEN.exec(lines[input.line - 1] ?? '')
  if (!open) throw new DocsError(`o bloco do diagrama não está mais na linha ${input.line} de "${rel}"; abra de novo`)
  const fence = open[2]!
  let end = -1
  for (let i = input.line; i < lines.length; i++) {
    const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]!)
    if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
      end = i
      break
    }
  }
  if (end < 0) throw new DocsError(`o bloco do diagrama na linha ${input.line} de "${rel}" não fecha`)
  const current = lines.slice(input.line, end).join('\n')
  if (input.previous !== undefined && !same(current, input.previous)) {
    throw new DocsError(`o diagrama mudou em "${rel}" desde que foi aberto; abra de novo`)
  }
  const next = [...lines.slice(0, input.line), ...code.split('\n'), ...lines.slice(end)]
  await writeFile(await workspaceWritePath(ws.dir, rel), next.join(eol))
  return { file: rel, line: input.line }
}
