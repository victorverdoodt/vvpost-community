import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { DriftItem } from './architecture'

/**
 * O mapa do código: uma linha por área (cada pasta dentro de uma pasta do repositório) com os arquivos de código dela.
 * Com ele, quem lê (gente ou agente) vai direto ao arquivo do caso de uso em vez de listar pastas ou abrir a área
 * inteira.
 *
 *   {{> codemap src/Api/Features}}            na documentação, o mapa montado do código (nunca fica velho)
 *   <!-- vvpost:codemap src/Api/Features -->  antes de uma cópia escrita à mão (AGENTS.md, CLAUDE.md ou uma página),
 *                                             que o lint confere contra o código (doc-code-map)
 *
 * A linha de cada área tem o formato que o agente lê sem esforço: `- <Área>: `A.cs`, `B.cs``. A pasta é relativa à raiz
 * do repositório (a pasta com .git acima do workspace).
 */

export interface CodeMapArea {
  area: string
  files: string[]
}

/** Arquivos de instrução de agente na raiz do repositório, conferidos junto com as páginas do workspace. */
export const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md']
export const CODEMAP_MARKER = /^\s*<!--\s*vvpost:codemap\s+(\S+)\s*-->\s*$/
const MAX_AREAS = 200
const MAX_AGENT_FILE_BYTES = 512 * 1024
const SKIP = new Set(['bin', 'obj', 'node_modules', 'dist', 'build', 'out', 'gen', 'generated', '__pycache__', 'coverage'])
const CODE = /\.(cs|fs|vb|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|kts|rb|php|swift|rs|scala|vue|svelte|dart|c|cc|cpp|h|hpp|ex|exs)$/i
const LINE = /^- ([^:\s`]+): (.*)$/
const LISTED = /`([^`/\\]+)`/g

export class CodeMapError extends Error {}

/** A raiz do repositório: a primeira pasta com .git acima de `from` (ou `from` sem Git). */
export function repoRoot(from: string): string {
  let current = resolve(from)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(from)
    current = parent
  }
}

/** As áreas de `folder` (relativa à raiz) e os arquivos de código de cada uma, em ordem alfabética. */
export async function readCodeMap(root: string, folder: string): Promise<CodeMapArea[]> {
  const base = resolve(root, folder)
  if (!folder || (base !== resolve(root) && !base.startsWith(resolve(root) + sep))) throw new CodeMapError(`"${folder}" fica fora do repositório`)
  const entries = await readdir(base, { withFileTypes: true }).catch(() => null)
  if (!entries) throw new CodeMapError(`a pasta "${folder}" não existe no repositório`)
  const areas: CodeMapArea[] = []
  for (const dir of entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    if (areas.length >= MAX_AREAS) break
    const files = (await readdir(join(base, dir.name), { withFileTypes: true }).catch(() => []))
      .filter((f) => f.isFile() && CODE.test(f.name))
      .map((f) => f.name)
      .sort((a, b) => a.localeCompare(b))
    if (files.length) areas.push({ area: dir.name, files })
  }
  return areas
}

export function codeMapLine(a: CodeMapArea): string {
  return `- ${a.area}: ${a.files.map((f) => `\`${f}\``).join(', ')}`
}

export function renderCodeMapMarkdown(areas: CodeMapArea[]): string {
  return areas.map(codeMapLine).join('\n')
}

/**
 * Os achados de uma cópia do mapa escrita à mão: cada `<!-- vvpost:codemap <pasta> -->` e as linhas `- <Área>: ` logo
 * abaixo dele (até a primeira linha que não é item de lista). `file` é como o achado aponta o arquivo.
 */
export async function codeMapDrift(root: string, file: string, text: string): Promise<DriftItem[]> {
  const items: DriftItem[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const marker = CODEMAP_MARKER.exec(lines[i]!)
    if (!marker) continue
    const folder = marker[1]!
    let areas: CodeMapArea[]
    try {
      areas = await readCodeMap(root, folder)
    } catch (err) {
      if (!(err instanceof CodeMapError)) throw err
      items.push({ code: 'doc-code-map', message: `mapa do código: ${err.message}`, file, line: i + 1, label: folder })
      continue
    }
    // As linhas do mapa: os itens de lista logo abaixo do marcador (linhas em branco antes deles contam como parte).
    const written = new Map<string, { line: number; files: string[] }>()
    let j = i + 1
    while (j < lines.length && !lines[j]!.trim()) j++
    let last = i + 1
    for (; j < lines.length && lines[j]!.startsWith('- '); j++) {
      last = j + 1
      const m = LINE.exec(lines[j]!)
      if (m) written.set(m[1]!, { line: j + 1, files: [...m[2]!.matchAll(LISTED)].map((x) => x[1]!).filter((f) => CODE.test(f)) })
    }
    const real = new Map(areas.map((a) => [a.area, a]))
    for (const a of areas) {
      const w = written.get(a.area)
      if (!w) {
        items.push({ code: 'doc-code-map', message: `área ${a.area} de ${folder} fora do mapa do código`, hint: `Acrescente a linha: ${codeMapLine(a)}`, file, line: last, label: a.area })
        continue
      }
      const missing = a.files.filter((f) => !w.files.includes(f))
      const gone = w.files.filter((f) => !a.files.includes(f))
      if (!missing.length && !gone.length) continue
      const parts = [missing.length && `faltam ${missing.join(', ')}`, gone.length && `não existem mais ${gone.join(', ')}`].filter(Boolean)
      items.push({ code: 'doc-code-map', message: `mapa do código de ${a.area} desatualizado: ${parts.join('; ')}`, hint: `Troque a linha por: ${codeMapLine(a)}`, file, line: w.line, label: a.area })
    }
    for (const [area, w] of written)
      if (!real.has(area))
        items.push({ code: 'doc-code-map', message: `área ${area} do mapa do código não existe mais em ${folder}`, hint: 'Tire a linha (ou acerte o nome da área).', file, line: w.line, label: area })
  }
  return items
}

/** Os achados das cópias do mapa nos arquivos de instrução de agente da raiz (AGENTS.md, CLAUDE.md), com o caminho
 * relativo ao workspace. */
export async function agentFilesCodeMapDrift(wsDir: string, root: string): Promise<DriftItem[]> {
  const out: DriftItem[] = []
  for (const name of AGENT_FILES) {
    const path = join(root, name)
    try {
      if ((await stat(path)).size > MAX_AGENT_FILE_BYTES) continue
      out.push(...(await codeMapDrift(root, relative(wsDir, path).split(sep).join('/'), await readFile(path, 'utf8'))))
    } catch {
      continue
    }
  }
  return out
}
