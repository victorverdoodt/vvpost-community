import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { DocsError } from '../build'
import { normalizeRel } from '../compose'
import type {
  DocsPublisher,
  PublishApproval,
  PublishBundle,
  PublishPlan,
  PublishPlanItem,
  PublishResult,
  PublishResultItem,
  PublishTargetRef,
  PublishTreeNode
} from '../publish/types'
import { changelogEntry, manifestEndpoints, nextChangelog } from './changelog'
import { htmlPageText } from './html'
import type { ChangelogEntry, DocsExporter, ExportFile, SiteManifest } from './types'

/** O estado da pasta exportada; o exportador não pode gravar um arquivo com este nome. */
export const SITE_MANIFEST = 'vvpost-site.json'
const MAX_FILES = 5000
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_TOTAL_BYTES = 300 * 1024 * 1024

/** Onde um destino grava: a pasta absoluta e como mostrar para a pessoa. */
export interface ExportFolder {
  dir: string
  label: string
  /** Relativa ao workspace, para abrir no explorador (o app). */
  path?: string
}

export interface FolderPublisherOptions {
  folder(target: PublishTargetRef): Promise<ExportFolder>
  /** Nome da versão no histórico (vvpost docs export --label). */
  release?: string
}

interface Prepared {
  folder: ExportFolder
  files: ExportFile[]
  previous: SiteManifest | null
  changelog: ChangelogEntry[]
  items: PublishPlanItem[]
  warnings: string[]
}

const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const prepared = new WeakMap<PublishBundle, Prepared>()

/**
 * Um exportador como publicador do "Enviar para…": o destino é uma pasta, sem conta. O plano
 * compara com o vvpost-site.json da exportação anterior (página nova, que muda, igual, editada
 * à mão na pasta ou fora da estrutura) e a publicação grava só o que a pessoa confirmou.
 */
export function createFolderPublisher(exporter: DocsExporter, options: FolderPublisherOptions): DocsPublisher {
  return {
    id: exporter.id,
    title: exporter.title,
    local: true,
    async session(target) {
      const folder = await options.folder(target)
      return { status: 'signedIn', account: 'esta máquina', destination: folder.label }
    },
    async plan(bundle, ctx) {
      const p = await prepareExport(bundle, exporter, await options.folder(bundle.target), options.release, ctx.signal)
      prepared.set(bundle, p)
      return { items: p.items, destination: { label: p.folder.label }, warnings: p.warnings }
    },
    async publish(bundle, _plan, approval, ctx) {
      const p = prepared.get(bundle) ?? (await prepareExport(bundle, exporter, await options.folder(bundle.target), options.release, ctx.signal))
      prepared.delete(bundle)
      return writeExport(bundle, exporter, p, approval)
    }
  }
}

/**
 * Exportação sem diálogo (vvpost docs export): grava tudo o que mudou e tira o que saiu da
 * estrutura. Uma página editada à mão na pasta só é sobrescrita com `force`.
 */
export async function exportToFolder(
  bundle: PublishBundle,
  exporter: DocsExporter,
  folder: ExportFolder,
  options: { release?: string; force?: boolean; signal?: AbortSignal; mermaidScript?: string } = {}
): Promise<PublishResult & { plan: PublishPlan }> {
  const p = await prepareExport(bundle, exporter, folder, options.release, options.signal, options.mermaidScript)
  const conflicts = p.items.filter((i) => i.action === 'conflict')
  if (conflicts.length && !options.force) {
    throw new DocsError(
      `${conflicts.length} página(s) foram editadas à mão em ${folder.label} depois da última exportação (${conflicts
        .slice(0, 5)
        .map((i) => i.title)
        .join(', ')}); use --force para sobrescrever`
    )
  }
  const keys = (action: string) => p.items.filter((i) => i.action === action).map((i) => i.key)
  const result = await writeExport(bundle, exporter, p, { update: keys('update'), conflicts: keys('conflict'), archive: keys('orphan') })
  return { ...result, plan: { items: p.items, destination: { label: folder.label }, warnings: p.warnings } }
}

/**
 * A pasta de saída de um destino do vvpost.publish.json: relativa ao workspace e dentro dele
 * (o arquivo vem do repositório, então não aponta para fora, nem por link). O workspace
 * inteiro não serve: a exportação apaga o que a anterior gravou.
 */
export async function workspaceExportFolder(workspaceDir: string, destination: string): Promise<ExportFolder> {
  const rel = normalizeRel(destination.trim())
  if (!rel || rel.startsWith('..') || isAbsolute(destination.trim()) || /^[A-Za-z]:/.test(destination) || destination.includes('\0')) {
    throw new DocsError(`a pasta de saída "${destination}" precisa ser relativa ao workspace e ficar dentro dele (ex.: dist/site)`)
  }
  const root = await realpath(workspaceDir)
  const dir = resolve(root, rel)
  // A parte que já existe não pode sair do workspace por um link.
  let probe = dir
  while (probe !== root) {
    const real = await realpath(probe).catch(() => null)
    if (real !== null) {
      if (real !== root && !real.startsWith(root + sep)) throw new DocsError(`a pasta de saída "${rel}" aponta para fora do workspace`)
      break
    }
    probe = dirname(probe)
  }
  return { dir, label: rel, path: rel }
}

export async function readSiteManifest(dir: string): Promise<SiteManifest | null> {
  let text: string
  try {
    text = await readFile(resolve(dir, SITE_MANIFEST), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  let doc: SiteManifest
  try {
    doc = JSON.parse(text) as SiteManifest
  } catch {
    throw new DocsError(`${SITE_MANIFEST} da pasta de saída não é um JSON válido`)
  }
  if (doc?.generator !== 'VVPost' || doc.version !== 1 || typeof doc.pages !== 'object' || typeof doc.files !== 'object') {
    throw new DocsError(`${SITE_MANIFEST} da pasta de saída não é de uma exportação do VVPost`)
  }
  return { ...doc, endpoints: doc.endpoints ?? {}, changelog: Array.isArray(doc.changelog) ? doc.changelog : [] }
}

async function prepareExport(
  bundle: PublishBundle,
  exporter: DocsExporter,
  folder: ExportFolder,
  release: string | undefined,
  signal?: AbortSignal,
  mermaidScript?: string
): Promise<Prepared> {
  const previous = await readSiteManifest(folder.dir)
  if (previous && previous.exporter !== exporter.id) {
    throw new DocsError(`${folder.label} tem uma exportação de "${previous.exporter}", não de "${exporter.id}"; use outra pasta`)
  }
  if (!previous) {
    const entries = await readdir(folder.dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [] as string[]
      throw err
    })
    // Arquivos ocultos (.git de um gh-pages, .nojekyll) não contam.
    if (entries.some((e) => !e.startsWith('.'))) {
      throw new DocsError(`${folder.label} já tem arquivos e não é uma exportação do VVPost (sem ${SITE_MANIFEST}); escolha uma pasta vazia`)
    }
  }
  const changelog = bundle.site?.changelog === false ? [] : nextChangelog(previous, changelogEntry(bundle, previous, release))
  const files = checkFiles(await exporter.render(bundle, { changelog, previous, ...(signal && { signal }), ...(mermaidScript && { mermaidScript }) }), exporter.id)
  const byPage = new Map<string, ExportFile>()
  for (const f of files) if (f.page && !byPage.has(f.page)) byPage.set(f.page, f)

  const items: PublishPlanItem[] = []
  const seen = new Set<string>()
  const walk = async (nodes: PublishTreeNode[], path: string[]) => {
    for (const n of nodes) {
      seen.add(n.key)
      const before = previous?.pages[n.key]
      const file = byPage.get(n.key)
      const item: PublishPlanItem = { key: n.key, kind: n.kind, title: n.title, path, action: 'create' }
      if (before) {
        item.remote = { id: before.file ?? n.key }
        const onDisk = before.file ? await readOut(folder.dir, before.file) : null
        const edited = onDisk !== null && before.file !== undefined && previous!.files[before.file] !== undefined && sha(onDisk) !== previous!.files[before.file]
        if (before.file && onDisk === null) item.action = 'create'
        else if (edited) item.action = 'conflict'
        else item.action = before.hash === n.hash ? 'same' : 'update'
        if ((item.action === 'update' || item.action === 'conflict') && file && onDisk) {
          item.before = textOf(before.file!, onDisk)
          item.after = textOf(file.path, file.data)
        }
      }
      items.push(item)
      await walk(n.children, [...path, n.title])
    }
  }
  await walk(bundle.nodes, [])
  for (const [key, before] of Object.entries(previous?.pages ?? {})) {
    if (!seen.has(key)) items.push({ key, kind: before.kind, title: before.title, path: [], action: 'orphan', remote: { id: before.file ?? key } })
  }
  const warnings: string[] = []
  const pending = bundle.assets.filter((a) => a.diagram !== undefined && !a.data).length
  if (pending && bundle.target.diagrams !== 'code') {
    warnings.push(
      mermaidScript && exporter.id === 'html'
        ? `${pending} diagrama(s) sem imagem vão desenhados no navegador (assets/mermaid.min.js)`
        : `${pending} diagrama(s) sem imagem vão como código Mermaid`
    )
  }
  return { folder, files, previous, changelog, items, warnings }
}

async function writeExport(bundle: PublishBundle, exporter: DocsExporter, p: Prepared, approval: PublishApproval): Promise<PublishResult> {
  const { folder, previous } = p
  const allowed = (i: PublishPlanItem) =>
    i.action === 'create' || i.action === 'same' || (i.action === 'update' && approval.update.includes(i.key)) || (i.action === 'conflict' && approval.conflicts.includes(i.key))
  const skipped = new Set(p.items.filter((i) => (i.action === 'update' || i.action === 'conflict') && !allowed(i)).map((i) => i.key))
  const kept = new Set(p.items.filter((i) => i.action === 'orphan' && !approval.archive.includes(i.key)).map((i) => i.key))
  const failed = new Map<string, string>()

  await mkdir(folder.dir, { recursive: true })
  const root = await realpath(folder.dir)
  const written: Record<string, string> = {}
  for (const f of p.files) {
    if (f.page && skipped.has(f.page)) continue
    try {
      const path = await outPath(root, f.path)
      await writeFile(path, f.data)
      written[f.path] = sha(f.data)
    } catch (err) {
      if (!f.page) throw err
      failed.set(f.page, (err as Error).message)
    }
  }

  // O manifesto novo: as páginas mantidas (não confirmadas ou fora da estrutura sem arquivar) ficam como estavam.
  const pages: SiteManifest['pages'] = {}
  const files: SiteManifest['files'] = { ...written }
  const fileOf = new Map<string, string>()
  for (const f of p.files) if (f.page && !fileOf.has(f.page)) fileOf.set(f.page, f.path)
  const keepPrevious = (key: string) => {
    const before = previous?.pages[key]
    if (!before) return
    pages[key] = before
    if (before.file && previous!.files[before.file]) files[before.file] = previous!.files[before.file]!
  }
  const walk = (nodes: PublishTreeNode[]) => {
    for (const n of nodes) {
      if (skipped.has(n.key) || failed.has(n.key)) keepPrevious(n.key)
      else {
        const file = fileOf.get(n.key)
        pages[n.key] = { kind: n.kind, title: n.title, hash: n.hash, ...(file && { file }) }
      }
      walk(n.children)
    }
  }
  walk(bundle.nodes)
  for (const key of kept) keepPrevious(key)

  // O que a exportação anterior gravou e esta não: sai, menos o arquivo de uma página mantida.
  for (const path of Object.keys(previous?.files ?? {})) {
    if (files[path] !== undefined) continue
    try {
      await rm(await outPath(root, path), { force: true })
    } catch {
      // Caminho que não fica mais dentro da pasta (um link trocado): não apaga nada.
    }
  }

  const manifest: SiteManifest = {
    generator: 'VVPost',
    version: 1,
    exporter: exporter.id,
    project: bundle.project,
    target: bundle.target.id,
    generatedAt: bundle.generatedAt,
    pages: Object.fromEntries(Object.entries(pages).sort(([a], [b]) => a.localeCompare(b))),
    endpoints: manifestEndpoints(bundle),
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    changelog: p.changelog
  }
  const target = await outPath(root, SITE_MANIFEST)
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rename(tmp, target)

  const items: PublishResultItem[] = p.items.map((i) => {
    const base = { key: i.key, kind: i.kind, title: i.title }
    const file = fileOf.get(i.key)
    if (failed.has(i.key)) return { ...base, outcome: 'failed', error: failed.get(i.key)! }
    if (i.action === 'orphan') return { ...base, outcome: kept.has(i.key) ? 'skipped' : 'archived' }
    if (skipped.has(i.key)) return { ...base, outcome: 'skipped' }
    const outcome = i.action === 'create' ? 'created' : i.action === 'same' ? 'unchanged' : 'updated'
    const node = pages[i.key]
    return { ...base, outcome, ...(file && { id: file }), ...(node && { hash: node.hash }) }
  })
  return { items, destination: { label: folder.label, ...(folder.path !== undefined && { path: folder.path }) } }
}

/** Confere os caminhos e os tamanhos do que o exportador devolveu. */
function checkFiles(files: ExportFile[], exporter: string): ExportFile[] {
  if (!Array.isArray(files)) throw new DocsError(`o exportador ${exporter} não devolveu uma lista de arquivos`)
  if (files.length > MAX_FILES) throw new DocsError(`o exportador ${exporter} devolveu mais de ${MAX_FILES} arquivos`)
  const seen = new Set<string>()
  let total = 0
  return files.map((f) => {
    const raw = typeof f?.path === 'string' ? f.path : ''
    const path = normalizeRel(raw)
    if (!path || path !== raw.replaceAll('\\', '/').replace(/^\.\//, '') || path.startsWith('..') || isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.includes('\0') || path.length > 300) {
      throw new DocsError(`o exportador ${exporter} devolveu um caminho inválido: "${raw.slice(0, 120)}"`)
    }
    if (path.toLowerCase() === SITE_MANIFEST || path.toLowerCase().startsWith(`${SITE_MANIFEST}.`)) throw new DocsError(`o exportador ${exporter} não pode gravar ${SITE_MANIFEST}`)
    if (seen.has(path.toLowerCase())) throw new DocsError(`o exportador ${exporter} devolveu "${path}" duas vezes`)
    seen.add(path.toLowerCase())
    if (typeof f.data !== 'string' && !(f.data instanceof Uint8Array)) throw new DocsError(`o exportador ${exporter} devolveu "${path}" sem conteúdo`)
    const size = typeof f.data === 'string' ? Buffer.byteLength(f.data) : f.data.byteLength
    if (size > MAX_FILE_BYTES) throw new DocsError(`"${path}" passa de 50 MB`)
    total += size
    if (total > MAX_TOTAL_BYTES) throw new DocsError(`a exportação passa de 300 MB`)
    return { path, data: f.data, ...(typeof f.page === 'string' && { page: f.page }) }
  })
}

/** Caminho dentro da pasta de saída, criando as pastas; recusa o que sair dela (por .. ou por link). */
async function outPath(root: string, rel: string): Promise<string> {
  const target = resolve(root, rel)
  const inside = (path: string) => {
    const r = relative(root, path)
    return r !== '' && !r.startsWith('..') && !isAbsolute(r)
  }
  if (!inside(target)) throw new DocsError(`"${rel}" fica fora da pasta de saída`)
  await mkdir(dirname(target), { recursive: true })
  const parent = await realpath(dirname(target))
  if (parent !== root && !parent.startsWith(root + sep)) throw new DocsError(`"${rel}" aponta para fora da pasta de saída`)
  const info = await lstat(target).catch(() => null)
  if (info?.isSymbolicLink() || (info && !info.isFile())) throw new DocsError(`"${rel}" não é um arquivo`)
  return target
}

async function readOut(dir: string, rel: string): Promise<Uint8Array | null> {
  try {
    const root = await realpath(dir)
    const path = resolve(root, rel)
    const real = await realpath(path)
    if (!real.startsWith(root + sep)) return null
    return new Uint8Array(await readFile(real))
  } catch {
    return null
  }
}

/** Texto de um arquivo para o diff do plano: a página de um site sem as tags; outro texto como está. */
function textOf(path: string, data: string | Uint8Array): string | undefined {
  const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
  if (text.includes('\uFFFD') || text.includes('\0')) return undefined
  return /\.html?$/i.test(path) ? htmlPageText(text) : text
}
