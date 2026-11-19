import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { globToRegExp } from '../lint/ruleset'
import { brandScanContext, scanBrandSource } from './scan'
import { parseTokensFile, type BrandFile, type BrandItem } from './tokens'

/** Pasta dos arquivos de tokens, no projeto (ou na raiz do workspace, quando o projeto não tem). */
export const BRAND_DIR = 'brand'
export const TOKENS_SUFFIX = '.tokens.json'

const MAX_TOKEN_FILES = 20
const MAX_TOKEN_BYTES = 1024 * 1024
const MAX_SOURCE_FILES = 3000
const MAX_SOURCE_BYTES = 512 * 1024
const MAX_WALK_DEPTH = 12
/** Ficam de fora sempre: gerado, dependência e build. */
const ALWAYS_IGNORED = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'bin', 'obj', 'coverage', 'vendor', 'gen'])

export interface BrandLoad {
  files: BrandFile[]
  /** Os achados de tokens e, com `scan`, os do código. */
  items: BrandItem[]
  /** Quantos arquivos do frontend foram lidos. */
  scanned: number
}

const rel = (base: string, path: string) => relative(base, path).split(sep).join('/')

/** Os arquivos de tokens do projeto (brand/ do projeto, senão o da raiz do workspace). */
export async function findTokenFiles(dir: string, root?: string): Promise<{ base: string; files: string[] }> {
  for (const base of root && resolve(root) !== resolve(dir) ? [dir, root] : [dir]) {
    const names = await readdir(join(base, BRAND_DIR)).catch(() => [] as string[])
    const files = names.filter((n) => n.toLowerCase().endsWith(TOKENS_SUFFIX)).sort().slice(0, MAX_TOKEN_FILES)
    if (files.length) return { base, files: files.map((n) => join(base, BRAND_DIR, n)) }
  }
  return { base: dir, files: [] }
}

/**
 * Lê os tokens do projeto e, com `scan`, confere o código do frontend que cada arquivo declara em
 * `$extensions.vvpost.sources`. Os globs são relativos ao projeto e podem subir até a raiz do
 * repositório Git (o frontend ao lado do workspace), nunca além.
 */
export async function loadBrand(dir: string, options: { root?: string; scan?: boolean } = {}): Promise<BrandLoad> {
  const { files: paths } = await findTokenFiles(dir, options.root)
  const files: BrandFile[] = []
  for (const path of paths) {
    const file = rel(dir, path)
    try {
      if ((await stat(path)).size > MAX_TOKEN_BYTES) {
        files.push({ ...parseTokensFile(file, '{}'), problems: [{ code: 'tokens-invalid', message: 'arquivo de tokens acima de 1 MB', file }] })
        continue
      }
      files.push(parseTokensFile(file, await readFile(path, 'utf8')))
    } catch (err) {
      files.push({ ...parseTokensFile(file, '{}'), problems: [{ code: 'tokens-invalid', message: `não deu para ler: ${(err as Error).message}`, file }] })
    }
  }
  const items = files.flatMap((f) => f.problems)
  if (!options.scan || !files.some((f) => f.sources.length)) return { files, items, scanned: 0 }

  const limit = repoRoot(options.root ?? dir)
  const ctx = brandScanContext(files)
  const sources = await sourceFiles(dir, limit, files)
  for (const path of sources) {
    let text: string
    try {
      if ((await stat(path)).size > MAX_SOURCE_BYTES) continue
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    items.push(...scanBrandSource(rel(dir, path), text, ctx))
  }
  return { files, items, scanned: sources.length }
}

/** A raiz do repositório Git acima do workspace; sem Git, o próprio workspace. */
function repoRoot(from: string): string {
  let current = resolve(from)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(from)
    current = parent
  }
}

async function sourceFiles(dir: string, limit: string, files: BrandFile[]): Promise<string[]> {
  const include = files.flatMap((f) => f.sources)
  const ignore = files.flatMap((f) => f.ignore).map((g) => globToRegExp(g))
  const out = new Set<string>()
  const inside = (path: string) => path === limit || path.startsWith(limit + sep)
  for (const glob of include) {
    const re = globToRegExp(glob)
    // A parte fixa do glob (antes do primeiro curinga) é onde a busca começa.
    const fixed = glob.replace(/\\/g, '/').split('/')
    const cut = fixed.findIndex((p) => /[*?{[]/.test(p))
    const startRel = (cut < 0 ? fixed.slice(0, -1) : fixed.slice(0, cut)).join('/')
    const start = resolve(dir, startRel || '.')
    if (!inside(start)) continue
    const walk = async (folder: string, depth: number) => {
      if (depth > MAX_WALK_DEPTH || out.size >= MAX_SOURCE_FILES) return
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.size >= MAX_SOURCE_FILES) return
        const path = join(folder, e.name)
        if (e.isDirectory()) {
          if (!e.name.startsWith('.') && !ALWAYS_IGNORED.has(e.name)) await walk(path, depth + 1)
        } else if (e.isFile()) {
          const r = rel(dir, path)
          if (re.test(r) && !ignore.some((x) => x.test(r)) && !r.toLowerCase().endsWith(TOKENS_SUFFIX) && !/\.min\.(js|css)$/i.test(r)) out.add(path)
        }
      }
    }
    if (cut < 0) {
      const path = resolve(dir, glob)
      if (inside(path) && existsSync(path)) out.add(path)
    } else await walk(start, 0)
  }
  return [...out].sort()
}
