import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { REQUIRED_SECRET, SchemaId, validateEnvironment, validateProject } from '@vvpost/schemas'
import { ArchiveError, readArchive, writeZip, type ArchiveEntry } from '@vvpost/core/plugins/archive'
import { isProjectDir, PROJECT_FILE, projectLayout } from '@vvpost/core/projects'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { SECRETS_FILE } from '@vvpost/core/secrets'
import type { ArchiveKind, ArchiveSummary } from '@shared/ipc'
import { git } from '../workspace/git'
import { workspaceSecrets } from '../workspace/commit-guard'
import { describeLeaks, findSecretLeaks } from '../workspace/leak-guard'
import { isSecretName, looksLikeSecretValue, slug } from '../importers/postman'

/**
 * Pacote .zip do VVPost (docs/import-export.md, Pacote .zip): a pasta do workspace inteiro (o
 * Compartilhado e os projetos) ou de um projeto, como está no disco, com o manifesto
 * vvpost.archive.json na raiz. Leva também o que o pacote .vvpost.bundle.json não leva (o
 * documento do projeto, diagramas, schemas, dados de teste, webhooks). Nenhum valor de segredo
 * sai: o vault fica fora da pasta, os arquivos de segredos locais ficam de fora, variáveis com
 * cara de credencial vão como __REQUIRED_SECRET__ e o zip inteiro passa pelo leak guard.
 */

export const ARCHIVE_SUFFIX = '.vvpost.zip'
export const MANIFEST_FILE = 'vvpost.archive.json'
const MANIFEST_FORMAT = 'vvpost-archive'
const ENV_SUFFIX = '.env.json'
export const ARCHIVE_LIMITS = { maxFiles: 20_000, maxBytes: 256 * 1024 * 1024 }

export type { ArchiveKind, ArchiveSummary }

export interface ArchiveManifest {
  format: typeof MANIFEST_FORMAT
  version: 1
  kind: ArchiveKind
  name: string
  /** O projeto, num zip de projeto. */
  project?: { id: string; name: string; description?: string }
  /** Os projetos, num zip de workspace com projetos. */
  projects?: { id: string; name: string; folder: string }[]
  exportedAt: string
  generator?: string
  files: number
}

export class ArchiveExportError extends Error {
  /** true: recusada por segredo (o CLI sai com 1, como o pacote). */
  constructor(message: string, readonly leak = false) {
    super(message)
  }
}

/** Pastas que nunca vão no zip; das que começam com ".", só a .vvpost (webhooks, motor de segredos). */
const SKIP_DIRS = new Set(['.git', 'node_modules'])

/** Arquivos locais da máquina: o vault antigo em texto puro e o estado *.local.json da .vvpost. */
function isLocalFile(path: string): boolean {
  const name = basename(path)
  if (name === basename(SECRETS_FILE) || name === '.secrets.local.json') return true
  if (path.split('/').includes('.vvpost') && name.endsWith('.local.json')) return true
  return name.endsWith(ARCHIVE_SUFFIX)
}

const included = (path: string) => {
  const parts = path.split('/')
  if (parts.some((p) => SKIP_DIRS.has(p))) return false
  if (parts.slice(0, -1).some((p) => p.startsWith('.') && p !== '.vvpost')) return false
  return !isLocalFile(path) && path !== MANIFEST_FILE
}

async function walk(root: string, at = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(join(root, at), { withFileTypes: true })) {
    const path = at ? `${at}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.vvpost')) continue
      out.push(...(await walk(root, path)))
    } else if (entry.isFile()) out.push(path)
  }
  return out
}

/**
 * Os arquivos da pasta que vão no zip, relativos a ela. Num repositório Git, o que o Git leva
 * (versionados e novos, sem os ignorados); fora dele, a pasta toda, sem .git, node_modules e
 * pastas ocultas.
 */
export async function archiveFiles(folder: string): Promise<string[]> {
  let paths: string[]
  try {
    const list = await git(folder, ['ls-files', '-co', '--exclude-standard', '-z', '--', '.'])
    paths = list.split('\0').filter(Boolean)
  } catch {
    paths = await walk(folder)
  }
  const files: string[] = []
  for (const path of [...new Set(paths)].filter(included).sort((a, b) => a.localeCompare(b))) {
    // Apagado e ainda no index, ou link simbólico: fica de fora.
    const info = await lstat(join(folder, ...path.split('/'))).catch(() => null)
    if (info?.isFile()) files.push(path)
  }
  return files
}

/** Variáveis secretas e com cara de credencial vão como __REQUIRED_SECRET__, como no pacote. */
function scrubEnvironment(path: string, text: string, warnings: string[]): { text: string; pending: number } {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return { text, pending: 0 }
  }
  if (!validateEnvironment(doc).ok) return { text, pending: 0 }
  const env = doc as { id: string; variables: Record<string, { value: unknown; isSecret?: boolean; type?: string }> }
  let changed = false
  let pending = 0
  for (const [name, v] of Object.entries(env.variables)) {
    const looksSecret = !v.isSecret && v.value !== '' && (isSecretName(name) || looksLikeSecretValue(v.value))
    if (looksSecret) warnings.push(`${path}: ${name} parece credencial e foi no zip como segredo pendente`)
    if ((v.isSecret || looksSecret) && v.value !== REQUIRED_SECRET) {
      env.variables[name] = { ...v, type: 'string', value: REQUIRED_SECRET, isSecret: true }
      changed = true
    }
    if (v.isSecret || looksSecret) pending++
  }
  return { text: changed ? `${JSON.stringify(env, null, 2)}\n` : text, pending }
}

function summarize(paths: string[], pendingSecrets: number, projects: number): ArchiveSummary {
  const count = (suffix: string) => paths.filter((p) => p.endsWith(suffix)).length
  return {
    files: paths.length,
    projects,
    connectors: count('.connector.vvpost.json'),
    flows: count('.flow.vvpost.json'),
    environments: count(ENV_SUFFIX),
    docs: count('.md'),
    pendingSecrets
  }
}

export interface ArchiveExportResult {
  data: Buffer
  manifest: ArchiveManifest
  /** A pasta exportada: a do projeto, ou a raiz do workspace. */
  folder: string
  summary: ArchiveSummary
  warnings: string[]
}

/**
 * Monta o zip. `dir` é a pasta aberta (um projeto, ou a raiz); com `scope: 'workspace'` sai a
 * raiz do workspace com todos os projetos. Na raiz de um workspace com projetos, o zip é sempre
 * o workspace inteiro (o Compartilhado sozinho não é um projeto).
 */
export async function exportArchive(
  dir: string,
  scope: ArchiveKind,
  meta: { name?: string; generator?: string; now?: Date } = {}
): Promise<ArchiveExportResult> {
  const layout = projectLayout(dir)
  const folder = scope === 'workspace' ? layout.root : dir
  const kind: ArchiveKind = isProjectDir(folder) ? 'project' : 'workspace'
  const project = kind === 'project' ? layout.projects.find((p) => join(layout.root, p.folder) === folder) : undefined
  const warnings: string[] = []
  const entries: ArchiveEntry[] = []
  let pendingSecrets = 0
  for (const path of await archiveFiles(folder)) {
    let data = await readFile(join(folder, ...path.split('/')))
    if (path.endsWith(ENV_SUFFIX) && path.split('/').includes('environments')) {
      const scrubbed = scrubEnvironment(path, data.toString('utf8'), warnings)
      data = Buffer.from(scrubbed.text)
      pendingSecrets += scrubbed.pending
    }
    entries.push({ path, data })
    if (entries.length > ARCHIVE_LIMITS.maxFiles) throw new ArchiveExportError(`a pasta passa de ${ARCHIVE_LIMITS.maxFiles} arquivos`)
  }
  if (!entries.length) throw new ArchiveExportError(`nada para exportar em ${folder}`)
  const bytes = entries.reduce((n, e) => n + e.data.length, 0)
  if (bytes > ARCHIVE_LIMITS.maxBytes) throw new ArchiveExportError(`a pasta passa de ${ARCHIVE_LIMITS.maxBytes / 1024 / 1024} MB`)

  // O mesmo leak guard do commit, com os valores de todos os vaults do workspace.
  const leaks = await findSecretLeaks(
    folder,
    entries.map((e) => ({ path: e.path, content: e.data.toString('utf8') })),
    await workspaceSecrets(layout.root)
  )
  if (leaks.length) {
    throw new ArchiveExportError(
      `exportação recusada: o zip teria segredo.\n${describeLeaks(leaks).split('\n').slice(1, -1).join('\n')}\n` +
        'Troque o valor por uma variável {{NOME}} de um ambiente, marcada como segredo.',
      true
    )
  }

  if (project) warnings.push(...(await outsideReferences(folder)))
  const projects = kind === 'workspace' ? layout.projects : []
  const manifest: ArchiveManifest = {
    format: MANIFEST_FORMAT,
    version: 1,
    kind,
    name: meta.name || project?.name || basename(folder),
    ...(project && { project: { id: project.id, name: project.name, ...(project.description && { description: project.description }) } }),
    ...(projects.length && { projects: projects.map(({ id, name, folder: f }) => ({ id, name, folder: f })) }),
    exportedAt: (meta.now ?? new Date()).toISOString(),
    ...(meta.generator && { generator: meta.generator }),
    files: entries.length
  }
  entries.push({ path: MANIFEST_FILE, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) })
  return {
    data: writeZip(entries),
    manifest,
    folder,
    summary: summarize(entries.map((e) => e.path).filter((p) => p !== MANIFEST_FILE), pendingSecrets, projects.length),
    warnings
  }
}

/** O que o projeto usa do Compartilhado ou de outro projeto, que não vai no zip dele. */
async function outsideReferences(folder: string): Promise<string[]> {
  const ws = await loadWorkspace(folder).catch(() => null)
  if (!ws) return []
  const notes = new Set<string>()
  for (const [id, c] of ws.connectors) {
    if (ws.shared?.has(id) || !c.extends) continue
    const parent = c.extends
    if (parent.includes(':')) notes.add(`o conector ${id} herda de ${parent}, de outro projeto, que não vai no zip`)
    else if (ws.shared?.has(parent)) notes.add(`o conector ${id} herda de ${parent}, do Compartilhado, que não vai no zip`)
  }
  if (notes.size) notes.add('para levar junto, exporte o workspace inteiro')
  return [...notes]
}

// ---------------------------------------------------------------------------
// Importar

export interface ReadArchive {
  manifest: ArchiveManifest
  /** Os arquivos, sem o manifesto e sem nada local. */
  entries: ArchiveEntry[]
  /** Os projetos dentro do zip (subpastas com vvpost.project.json). */
  projects: { id: string; name: string; folder: string }[]
  summary: ArchiveSummary
  warnings: string[]
}

/**
 * Lê um zip do VVPost. Um zip sem manifesto (a pasta zipada à mão) também vale: com
 * vvpost.project.json na raiz é um projeto, sem, um workspace; se tudo estiver numa pasta só,
 * ela é a raiz.
 */
export function readWorkspaceArchive(buf: Buffer, fileName = 'pacote.zip'): ReadArchive {
  if (buf.length > ARCHIVE_LIMITS.maxBytes) throw new ArchiveError(`o zip passa de ${ARCHIVE_LIMITS.maxBytes / 1024 / 1024} MB`)
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new ArchiveError(`${fileName} não é um .zip`)
  let entries = readArchive(buf, ARCHIVE_LIMITS)
  const tops = new Set(entries.map((e) => e.path.split('/')[0]!))
  if (tops.size === 1 && entries.every((e) => e.path.includes('/')) && !entries.some((e) => e.path === MANIFEST_FILE)) {
    const [top] = tops
    entries = entries.map((e) => ({ ...e, path: e.path.slice(top!.length + 1) }))
  }
  const warnings: string[] = []
  let manifest: ArchiveManifest | undefined
  const manifestEntry = entries.find((e) => e.path === MANIFEST_FILE)
  if (manifestEntry) {
    try {
      const doc = JSON.parse(manifestEntry.data.toString('utf8')) as Partial<ArchiveManifest>
      if (doc.format === MANIFEST_FORMAT && (doc.kind === 'workspace' || doc.kind === 'project')) manifest = doc as ArchiveManifest
    } catch {
      // Manifesto ilegível: o zip vale como pasta zipada à mão.
    }
    if (!manifest) warnings.push(`${MANIFEST_FILE} ilegível; o zip foi lido como pasta`)
  }
  const files: ArchiveEntry[] = []
  for (const e of entries) {
    if (e.path === MANIFEST_FILE) continue
    if (e.path.split('/').some((p) => SKIP_DIRS.has(p))) continue
    if (isLocalFile(e.path)) {
      warnings.push(`${e.path}: arquivo local de segredos, fica de fora`)
      continue
    }
    files.push(e)
  }
  if (!files.length) throw new ArchiveError(`${fileName} está vazio`)

  const projectDoc = (path: string) => {
    const entry = files.find((f) => f.path === path)
    if (!entry) return undefined
    try {
      const result = validateProject(JSON.parse(entry.data.toString('utf8')))
      return result.ok ? result.value : undefined
    } catch {
      return undefined
    }
  }
  const projects: ReadArchive['projects'] = []
  for (const f of files) {
    const parts = f.path.split('/')
    if (parts.length !== 2 || parts[1] !== PROJECT_FILE) continue
    const doc = projectDoc(f.path)
    if (doc) projects.push({ id: doc.id, name: doc.name, folder: parts[0]! })
  }
  const own = projectDoc(PROJECT_FILE)
  const kind: ArchiveKind = own ? 'project' : 'workspace'
  if (manifest && manifest.kind !== kind) warnings.push(`o manifesto diz ${manifest.kind}, mas o zip tem ${kind === 'project' ? 'um' : 'nenhum'} ${PROJECT_FILE} na raiz`)
  const name = manifest?.name || own?.name || basename(fileName).replace(/(\.vvpost)?\.zip$/i, '')
  const pendingSecrets = files
    .filter((f) => f.path.endsWith(ENV_SUFFIX))
    .reduce((n, f) => {
      try {
        const env = JSON.parse(f.data.toString('utf8')) as { variables?: Record<string, { isSecret?: boolean }> }
        return n + Object.values(env.variables ?? {}).filter((v) => v?.isSecret).length
      } catch {
        return n
      }
    }, 0)
  return {
    manifest: {
      format: MANIFEST_FORMAT,
      version: 1,
      exportedAt: manifest?.exportedAt ?? '',
      ...(manifest?.generator && { generator: manifest.generator }),
      kind,
      name,
      ...(own && { project: { id: own.id, name: own.name, ...(own.description && { description: own.description }) } }),
      ...(projects.length && { projects }),
      files: files.length
    },
    entries: files,
    projects,
    summary: summarize(files.map((f) => f.path), pendingSecrets, projects.length),
    warnings
  }
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw err
  }
}

async function writeEntries(dest: string, entries: ArchiveEntry[]): Promise<string[]> {
  const root = resolve(dest)
  const written: string[] = []
  for (const e of entries) {
    const target = resolve(root, ...e.path.split('/'))
    if (!target.startsWith(root + sep)) throw new ArchiveError(`caminho fora da pasta: ${e.path}`)
    await mkdir(dirname(target), { recursive: true })
    // wx: nada que já exista é sobrescrito.
    await writeFile(target, e.data, { flag: 'wx' })
    written.push(relative(root, target).split(sep).join('/'))
  }
  return written
}

export interface ArchiveImportResult {
  /** A pasta criada: o workspace novo, ou a do projeto no workspace. */
  dir: string
  written: string[]
  pendingSecrets: number
  warnings: string[]
}

/**
 * Abre o zip como workspace novo em `dest`, que precisa estar vazia (ou não existir). Um zip de
 * projeto vira um workspace de um projeto só (sem o vvpost.project.json na raiz).
 */
export async function importArchiveAsWorkspace(archive: ReadArchive, dest: string): Promise<ArchiveImportResult> {
  if (!(await isEmptyDir(dest))) throw new ArchiveError(`${dest} não está vazia: escolha uma pasta vazia para o workspace`)
  const entries = archive.manifest.kind === 'project' ? archive.entries.filter((e) => e.path !== PROJECT_FILE) : archive.entries
  const written = await writeEntries(dest, entries)
  return { dir: resolve(dest), written, pendingSecrets: archive.summary.pendingSecrets, warnings: archive.warnings }
}

export interface ProjectTarget {
  id: string
  name: string
  /** Por que o zip não entra como projeto (workspace com projetos), se for o caso. */
  blocked?: string
  /** Id ou pasta que já existe no workspace. */
  taken?: string
}

/** Id e nome do projeto que o zip vira no workspace `root`, e o que impede. */
export function projectTarget(archive: ReadArchive, root: string, wanted: { id?: string; name?: string } = {}): ProjectTarget {
  const name = wanted.name?.trim() || archive.manifest.project?.name || archive.manifest.name
  const id = wanted.id?.trim() || archive.manifest.project?.id || slug(name) || 'projeto'
  const target: ProjectTarget = { id, name }
  if (archive.projects.length) {
    target.blocked = `o zip é um workspace com ${archive.projects.length} projeto(s); abra-o como workspace novo`
    return target
  }
  if (!validateProject({ id, name }).ok) target.blocked = `"${id}" não é um id de projeto válido (letras minúsculas, números, - e _)`
  const layout = projectLayout(root)
  const clash = layout.projects.find((p) => p.id === id || p.folder === id)
  if (clash) target.taken = `o workspace já tem o projeto "${clash.name}" (${clash.folder})`
  else if (existsSync(join(layout.root, id))) target.taken = `já existe a pasta ${id} no workspace`
  return target
}

/**
 * Acrescenta o zip como projeto (subpasta com vvpost.project.json) no workspace de `dir`. Um zip
 * de workspace sem projetos também entra, e ganha o vvpost.project.json.
 */
export async function importArchiveAsProject(
  archive: ReadArchive,
  dir: string,
  wanted: { id?: string; name?: string } = {}
): Promise<ArchiveImportResult> {
  const root = projectLayout(dir).root
  const target = projectTarget(archive, root, wanted)
  if (target.blocked) throw new ArchiveError(target.blocked)
  if (target.taken) throw new ArchiveError(`${target.taken}; escolha outro id`)
  const folder = join(root, target.id)
  const description = archive.manifest.project?.description
  const doc = { $schema: SchemaId.Project, id: target.id, name: target.name, ...(description && { description }) }
  const entries = [
    ...archive.entries.filter((e) => e.path !== PROJECT_FILE),
    { path: PROJECT_FILE, data: Buffer.from(`${JSON.stringify(doc, null, 2)}\n`) }
  ]
  const written = await writeEntries(folder, entries)
  const warnings = [...archive.warnings]
  if (!projectLayout(root).projects.some((p) => p.id !== target.id)) {
    warnings.push('o workspace não tinha projetos: o que está na raiz passa a ser o Compartilhado, visível no projeto novo')
  }
  return { dir: folder, written: written.map((p) => `${target.id}/${p}`), pendingSecrets: archive.summary.pendingSecrets, warnings }
}
