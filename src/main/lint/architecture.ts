import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import type { FlowCatalog } from '@vvpost/core/types'
import {
  applyDriftFixes,
  describeStructureChange,
  linkDiagrams,
  structureSignature,
  type ArchitectureCatalog,
  type DriftCode,
  type DriftItem,
  type StructureSignature
} from '@vvpost/core/docs/architecture'
import type { LintWorkspaceDocument } from '@vvpost/core/lint'
import { plainFlows } from '@vvpost/core/flows/workspace'
import { catFiles, git } from '../workspace/git'

/**
 * A documentação de arquitetura além do que o core vê no texto (docs/documentation.md):
 * a correção automática dos diagramas (fix_diagrams, vvpost lint --fix, botão do painel Lint) e
 * a página que ficou velha porque os conectores que ela mostra mudaram depois do último commit
 * dela (`doc-stale-since-change`, pelo histórico do Git).
 */

export interface DiagramFixPlan {
  files: { file: string; fixes: { code: DriftCode; message: string; line?: number }[]; removed: string[]; added: string[] }[]
  /** Quantas correções o plano aplica. */
  total: number
}

/** O plano das correções que o VVPost sabe fazer, por arquivo; `apply` grava. */
export async function fixDiagrams(
  dir: string,
  drift: readonly DriftItem[],
  options: { apply: boolean; ws: LoadedWorkspace; codes?: readonly string[]; file?: string }
): Promise<DiagramFixPlan> {
  const fixable = drift.filter(
    (d) => d.fix && /^docs\/.+\.(md|mmd)$/i.test(d.file) && (!options.codes?.length || options.codes.includes(d.code)) && (!options.file || d.file === options.file)
  )
  const byFile = new Map<string, DriftItem[]>()
  for (const d of fixable) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d])
  const plan: DiagramFixPlan = { files: [], total: fixable.length }
  const writes: { file: string; text: string }[] = []
  for (const [file, items] of byFile) {
    const before = await readFile(join(dir, file), 'utf8')
    const after = applyDriftFixes(before, items.map((i) => i.fix!))
    const lines = before.replace(/\r\n?/g, '\n').split('\n')
    const removed = [...new Set(items.flatMap((i) => i.fix!.remove ?? []))].sort((a, b) => a - b).map((n) => lines[n - 1] ?? '')
    const added = [...new Set(items.flatMap((i) => i.fix!.insert?.lines ?? []))]
    plan.files.push({ file, fixes: items.map((i) => ({ code: i.code, message: i.message, ...(i.line !== undefined && { line: i.line }) })), removed, added })
    writes.push({ file, text: after })
  }
  if (options.apply) {
    const { writeDocsPage } = await import('@vvpost/core/docs')
    for (const w of writes) await writeDocsPage(options.ws, w.file, w.text)
  }
  return plan
}

const MAX_PAGES = 50
const MAX_REFS = 30
/** Conteúdo de um arquivo num commit: não muda, então fica guardado entre os lints. */
const shown = new Map<string, string | null>()

async function showAt(dir: string, commit: string, file: string): Promise<string | null> {
  const key = `${dir}\0${commit}\0${file}`
  if (shown.has(key)) return shown.get(key)!
  const text = await git(dir, ['show', `${commit}:./${file}`]).catch(() => null)
  if (shown.size > 2000) shown.clear()
  shown.set(key, text)
  return text
}

/**
 * Os arquivos do commit (caminhos relativos à pasta do projeto): um `git ls-tree -r` por commit em vez de
 * um por conector. As páginas costumam ter o mesmo último commit, e no Windows cada processo do Git
 * custa ~100 ms: num projeto com 30 conectores em fluxos, o lint passava 10 s esperando o Git.
 */
const trees = new Map<string, Promise<string[]>>()

function filesAt(dir: string, commit: string): Promise<string[]> {
  const key = `${dir}\0${commit}`
  let files = trees.get(key)
  if (!files) {
    if (trees.size > 20) trees.clear()
    files = git(dir, ['ls-tree', '-r', '-z', '--name-only', commit, '--', '.'])
      .then((out) => out.split('\0').filter(Boolean))
      .catch(() => [])
    trees.set(key, files)
  }
  return files
}

/** As páginas com mudança não commitada, num `git status` só (caminhos relativos à pasta do projeto). */
async function uncommitted(dir: string, files: string[]): Promise<Set<string>> {
  if (!files.length) return new Set()
  const prefix = (await git(dir, ['rev-parse', '--show-prefix'])).trim()
  const out = await git(dir, ['status', '--porcelain', '-z', '--', ...files])
  const dirty = new Set<string>()
  const tokens = out.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]!
    if (entry.length < 4) continue
    // Os caminhos do porcelain são relativos à raiz do repositório; renomeado e copiado trazem a origem em seguida.
    for (const path of /^[RC]/.test(entry) ? [entry.slice(3), tokens[++i] ?? ''] : [entry.slice(3)]) {
      if (path.startsWith(prefix)) dirty.add(path.slice(prefix.length))
    }
  }
  return dirty
}

/** A pasta do caminho com "/", como o dirname dá ("." na raiz). */
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.')

/** Lê de uma vez, para o cache do showAt, os arquivos dos commits que ainda não estão nele. */
async function prefetchShown(dir: string, wanted: readonly { commit: string; file: string }[]): Promise<void> {
  const missing = [...new Map(wanted.map((w) => [`${dir}\0${w.commit}\0${w.file}`, w])).entries()].filter(([key]) => !shown.has(key))
  if (!missing.length) return
  const prefix = (await git(dir, ['rev-parse', '--show-prefix'])).trim()
  const texts = await catFiles(dir, missing.map(([, w]) => `${w.commit}:${prefix}${w.file}`))
  if (shown.size + missing.length > 2000) shown.clear()
  missing.forEach(([key], i) => shown.set(key, texts[i] ?? null))
}

const parse = (text: string | null): unknown => {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const FLOW_FILE = /\.flow\.vvpost\.json$/i

/**
 * Páginas de arquitetura (com diagrama ligado ao catálogo, ou ADR) cujos conectores e fluxos
 * mudaram de estrutura depois do último commit da página: endpoint novo ou removido, origem,
 * auth ou herança, ou o que o fluxo chama. Página com mudança não commitada conta como revisada.
 * Fora de um repositório Git, ou sem o Git, não diz nada.
 */
export async function historyDrift(dir: string, ws: LoadedWorkspace, flows: FlowCatalog, data: LintWorkspaceDocument): Promise<DriftItem[]> {
  try {
    await git(dir, ['rev-parse', '--show-toplevel'])
  } catch {
    return []
  }
  const catalog: ArchitectureCatalog = { connectors: [...ws.connectors.values()], ownConnectors: data.connectors, flows: plainFlows(flows, ws.flowSources) }
  const { links } = linkDiagrams(data.diagrams, catalog)
  // Por página: o que ela mostra e a linha onde mostra.
  const pages = new Map<string, Map<string, number | undefined>>()
  const cite = (file: string, key: string, line: number | undefined) => {
    const refs = pages.get(file) ?? pages.set(file, new Map()).get(file)!
    if (!refs.has(key)) refs.set(key, line)
  }
  for (const l of links) cite(l.diagram.file, `${l.ref.kind}:${l.ref.id}`, l.diagram.line)
  for (const p of data.docs) {
    if (!/^#{1,6}\s+.*\b(ADR|decis(ão|ões|ao|oes)\s+de\s+arquitetura)\b/im.test(p.text)) continue
    for (const c of p.references.connectors) cite(p.file, `connector:${c}`, undefined)
    // O id no texto também conta: o conector pode ter perdido justo o endpoint citado.
    for (const c of catalog.connectors) if (p.text.includes(c.id)) cite(p.file, `connector:${c.id}`, undefined)
  }
  const items: DriftItem[] = []
  const checked = [...pages].slice(0, MAX_PAGES)
  // Sem o status, nenhuma página conta como em dia (como antes, quando cada status falhava sozinho).
  const dirty = await uncommitted(dir, checked.map(([file]) => file)).catch(() => null)
  if (!dirty) return items
  const commits = new Map<string, [commit: string, date: string]>()
  for (const [file] of checked) {
    if (dirty.has(file)) continue
    const last = (await git(dir, ['log', '-1', '--format=%H %cs', '--', file]).catch(() => '')).trim()
    if (last) commits.set(file, last.split(' ') as [string, string])
  }
  // Os arquivos de conector e de fluxo como estavam em cada commit, num cat-file só.
  const sources = (id: string, kind: string) =>
    kind === 'connector' ? (ws.flowSources?.get(id) ?? ws.connectorFiles.get(id)) : flows.flows.find((f) => f.flow.id === id)?.file
  await prefetchShown(
    dir,
    checked.flatMap(([file, refs]) => {
      const at = commits.get(file)
      if (!at) return []
      return [...refs.keys()].slice(0, MAX_REFS).flatMap((key) => {
        const source = sources(key.slice(key.indexOf(':') + 1), key.slice(0, key.indexOf(':')))
        return source && !source.startsWith('../') && !source.startsWith('shared:') ? [{ commit: at[0], file: source }] : []
      })
    })
  ).catch(() => undefined)
  for (const [file, refs] of checked) {
    const at = commits.get(file)
    if (!at) continue
    const [commit, date] = at
    const marked = new Set<string>()
    for (const [key, line] of [...refs].slice(0, MAX_REFS)) {
      const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
      const changes = kind === 'connector' ? await connectorChanges(dir, ws, id, commit) : await flowChanges(dir, flows, id, commit)
      if (!changes?.length || marked.has(key)) continue
      marked.add(key)
      items.push({
        code: 'doc-stale-since-change',
        message: `o ${kind === 'connector' ? 'conector' : 'fluxo'} ${id} mudou depois do último commit desta página (${commit.slice(0, 7)}, ${date}): ${changes.slice(0, 6).join(', ')}${changes.length > 6 ? `, e mais ${changes.length - 6}` : ''}`,
        hint: 'Revise a página e os diagramas dela. Se ela já estiver em dia, registre a revisão (por exemplo <!-- vvpost:revisado AAAA-MM-DD -->) e faça o commit: o aviso some quando a página muda depois da mudança.',
        file,
        ...(line !== undefined && { line }),
        label: id,
        ...(kind === 'connector' ? { connectorId: id } : { flowId: id })
      })
    }
  }
  return items
}

/** O que mudou na estrutura do conector desde o commit; null: não dá para saber (não existia). */
async function connectorChanges(dir: string, ws: LoadedWorkspace, id: string, commit: string): Promise<string[] | null> {
  const file = ws.flowSources?.get(id) ?? ws.connectorFiles.get(id)
  if (!file || file.startsWith('../') || file.startsWith('shared:')) return null
  const before = structureSignature(parse(await showAt(dir, commit, file)))
  if (!before) return null
  const current = structureSignature(parse(await readFile(join(dir, file), 'utf8').catch(() => null)))
  if (!current) return null
  if (FLOW_FILE.test(file)) {
    // Conector em fluxos: os endpoints são os outros arquivos da pasta.
    const folder = dirname(file)
    const base = file.slice(folder.length + 1)
    const names = (list: string[]) => list.map((f) => f.slice(f.lastIndexOf('/') + 1)).filter((f) => FLOW_FILE.test(f) && f !== base).map((f) => f.replace(FLOW_FILE, '')).sort()
    const then = names((await filesAt(dir, commit)).filter((f) => parentOf(f) === folder))
    const now = names(await readdir(join(dir, folder)).catch(() => []))
    before.endpoints = then.map((e) => `${e}`)
    current.endpoints = now.map((e) => `${e}`)
  }
  return describeStructureChange(before, current)
}

async function flowChanges(dir: string, flows: FlowCatalog, id: string, commit: string): Promise<string[] | null> {
  const entry = flows.flows.find((f) => f.flow.id === id)
  if (!entry) return null
  const before: StructureSignature | null = structureSignature(parse(await showAt(dir, commit, entry.file)))
  const current = structureSignature(entry.flow)
  if (!before || !current) return null
  return describeStructureChange(before, current)
}
