import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { validateProject } from '@vvpost/schemas'
import { ConfigError } from './connectors/errors'

/**
 * Vários projetos num workspace (docs/git-workspace.md, Projetos): uma subpasta direta do
 * workspace com este arquivo é um projeto. O resto da pasta é o Compartilhado, visível em
 * todos os projetos. Um workspace sem nenhum é um projeto só, como sempre foi.
 */
export const PROJECT_FILE = 'vvpost.project.json'

export interface WorkspaceProject {
  id: string
  name: string
  description?: string
  /** Nome da subpasta do projeto no workspace. */
  folder: string
  /** Projeto de referência, só para leitura: o catálogo vem destas fontes, relativas à pasta (src/main/workspace/references.ts). */
  reference?: { workspace?: string; openapi?: string }
}

export interface ProjectLayout {
  /** Pasta do workspace (a raiz, com o Compartilhado). */
  root: string
  projects: WorkspaceProject[]
  /** O projeto de `dir`, quando `dir` é a pasta de um projeto. */
  current?: WorkspaceProject
  issues: { file: string; message: string }[]
}

export const isProjectDir = (dir: string): boolean => existsSync(join(dir, PROJECT_FILE))

/**
 * Os projetos do workspace de `dir`. `dir` pode ser a raiz ou a pasta de um projeto (aí a raiz
 * é a pasta acima dela). Leitura síncrona: são poucos arquivos pequenos, lidos a cada carga.
 */
export function projectLayout(dir: string): ProjectLayout {
  const inProject = isProjectDir(dir)
  const root = inProject ? dirname(dir) : dir
  const layout: ProjectLayout = { root, projects: [], issues: [] }
  let entries: string[] = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    // Pasta que não existe: quem carrega o workspace dá o erro.
  }
  const seen = new Map<string, string>()
  for (const folder of entries) {
    const file = `${folder}/${PROJECT_FILE}`
    let text: string
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch (err) {
      layout.issues.push({ file, message: `JSON inválido (${(err as Error).message})` })
      continue
    }
    const result = validateProject(doc)
    if (!result.ok) {
      for (const i of result.issues) layout.issues.push({ file, message: `${i.path || '/'}: ${i.message}` })
      continue
    }
    const first = seen.get(result.value.id)
    if (first) {
      layout.issues.push({ file, message: `projeto "${result.value.id}" já é a pasta ${first}; ignorado` })
      continue
    }
    seen.set(result.value.id, folder)
    const { id, name, description, reference } = result.value
    layout.projects.push({ id, name, ...(description && { description }), folder, ...(reference && { reference }) })
  }
  if (inProject) layout.current = layout.projects.find((p) => p.folder === basename(dir))
  return layout
}

/** A pasta do projeto `id` no workspace de `dir`; um id que não existe dá erro com os que existem. */
export function projectDir(dir: string, id: string): string {
  const layout = projectLayout(dir)
  const project = layout.projects.find((p) => p.id === id)
  if (!project) {
    const known = layout.projects.map((p) => p.id).join(', ')
    throw new ConfigError(`projeto "${id}" não existe no workspace (${known || 'o workspace não tem projetos'})`)
  }
  return join(layout.root, project.folder)
}

/** "<projeto>:<id>" → [projeto, id]; sem prefixo, undefined. */
export function splitProjectRef(ref: string): [project: string, id: string] | undefined {
  const at = ref.indexOf(':')
  return at > 0 ? [ref.slice(0, at), ref.slice(at + 1)] : undefined
}

/** A pasta do projeto que contém `dir` (ela mesma ou uma acima), como o Git acha o repositório. */
export function enclosingProjectDir(dir: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    if (isProjectDir(at)) return at
    if (dirname(at) === at) return undefined
  }
}
