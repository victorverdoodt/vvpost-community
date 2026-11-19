import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ImportFolder, ImportText } from './foreign'
import { isInsomnia } from './insomnia'
import { isOpenApi } from './openapi'

/** Arquivos (e respostas) maiores que isso provavelmente não são coleções nem specs, ou travariam a conversão. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024
const FETCH_TIMEOUT_MS = 30_000

export const isUrl = (location: string): boolean => /^https?:\/\//i.test(location)

/**
 * Lê o conteúdo de um arquivo de import: JSON e, se não for JSON, YAML (specs OpenAPI e a
 * exportação v5 do Insomnia costumam vir em YAML). Só aceita o YAML quando ele é de um desses,
 * para um JSON quebrado de outro formato continuar mostrando o erro de JSON. `.bru` do Bruno e
 * XML (WSDL) seguem como texto, em `{ $text }`.
 */
export function parseImportText(text: string, file: string): unknown {
  const content = text.replace(/^\uFEFF/, '')
  if (/\.bru$/i.test(file) || content.trimStart().startsWith('<')) return { $text: content } satisfies ImportText
  const yamlFile = /\.ya?ml$/i.test(file)
  if (!yamlFile) {
    try {
      return JSON.parse(content)
    } catch (err) {
      const data = tryYaml(content)
      if (isOpenApi(data) || isInsomnia(data)) return data
      throw new Error(`JSON inválido (${(err as Error).message})`)
    }
  }
  try {
    return parseYaml(content, { maxAliasCount: 1000 })
  } catch (err) {
    throw new Error(`YAML inválido (${(err as Error).message.split('\n')[0]})`)
  }
}

function tryYaml(text: string): unknown {
  try {
    return parseYaml(text, { maxAliasCount: 1000 })
  } catch {
    return undefined
  }
}

/** Lê um arquivo de import do disco, com o limite de tamanho. Uma pasta (coleção do Bruno) vira `{ $folder }`. */
export async function readImportFile(path: string): Promise<unknown> {
  const info = await stat(path)
  if (info.isDirectory()) return readImportFolder(path)
  if (info.size > MAX_FILE_BYTES) throw new Error('arquivo maior que 50 MB')
  return parseImportText(await readFile(path, 'utf8'), basename(path))
}

const MAX_FOLDER_FILES = 5000
const FOLDER_SKIP = new Set(['node_modules', '.git'])

/**
 * Lê uma pasta de coleção do Bruno: os `.bru`, o `bruno.json` e o `.env`, por caminho relativo.
 * O resto (respostas salvas, arquivos de corpo) fica de fora.
 */
export async function readImportFolder(dir: string): Promise<ImportFolder> {
  const files: Record<string, string> = {}
  let total = 0
  let count = 0
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!FOLDER_SKIP.has(entry.name)) await walk(path)
        continue
      }
      if (!entry.isFile() || !(/\.bru$/i.test(entry.name) || path === 'bruno.json' || path === '.env')) continue
      if (++count > MAX_FOLDER_FILES) throw new Error(`a pasta tem mais de ${MAX_FOLDER_FILES} arquivos .bru`)
      const text = await readFile(join(dir, path), 'utf8')
      total += text.length
      if (total > MAX_FILE_BYTES) throw new Error('a pasta tem mais de 50 MB de arquivos .bru')
      files[path] = text
    }
  }
  await walk('')
  if (!Object.keys(files).some((p) => p.endsWith('.bru') || p === 'bruno.json')) {
    throw new Error('a pasta não é uma coleção do Bruno (sem bruno.json nem arquivos .bru)')
  }
  return { $folder: files, name: basename(dir) }
}

/** Baixa uma spec (ou coleção) por HTTP(S), com timeout e limite de tamanho. */
export async function fetchImportUrl(url: string): Promise<unknown> {
  if (!isUrl(url)) throw new Error('a URL precisa começar com http:// ou https://')
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json, application/yaml, text/yaml, text/xml, application/xml, */*' } })
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause?.message
    throw new Error(`não foi possível baixar ${url}: ${cause ?? (err as Error).message}`)
  }
  if (!res.ok) throw new Error(`${url} respondeu ${res.status}`)
  if (Number(res.headers.get('content-length') ?? 0) > MAX_FILE_BYTES) throw new Error('resposta maior que 50 MB')
  const text = await res.text()
  if (text.length > MAX_FILE_BYTES) throw new Error('resposta maior que 50 MB')
  const type = res.headers.get('content-type') ?? ''
  const name = /ya?ml/i.test(type) ? 'spec.yaml' : (new URL(url).pathname.split('/').pop() || 'spec.json')
  return parseImportText(text, name)
}

/**
 * Lê a spec do `source.location` de um conector: URL, ou caminho relativo à pasta do
 * workspace (ou absoluto).
 */
export function readSourceLocation(location: string, workspaceDir: string): Promise<unknown> {
  return isUrl(location) ? fetchImportUrl(location) : readImportFile(resolve(workspaceDir, location))
}

/**
 * Como guardar o caminho de uma spec no conector: relativo ao workspace quando o
 * arquivo está dentro dele (o caminho vale para o time pelo Git), absoluto fora.
 */
export function storedLocation(location: string, workspaceDir: string | undefined): string {
  if (isUrl(location) || !workspaceDir || !isAbsolute(location)) return location
  const rel = relative(workspaceDir, location)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return location
  return rel.split(sep).join('/')
}
