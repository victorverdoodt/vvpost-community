import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ConfigError } from '@vvpost/core/connectors/errors'
import { projectDir, projectLayout } from '@vvpost/core/projects'

/**
 * Projetos de referência (docs/git-workspace.md, Projeto de referência): um vvpost.project.json com
 * `reference` não tem catálogo próprio, ele aponta o de outro repositório, só para leitura. Assim o
 * workspace do front ou do app consulta as rotas e os schemas da API pelo MCP sem copiar o catálogo.
 *
 * Vale a primeira fonte que existir: `workspace` (a pasta do VVPost do outro repositório, quando
 * ele está clonado ao lado) ou `openapi` (a spec, que o repositório em geral já copia para gerar o
 * cliente). A spec vira um workspace pelo import do OpenAPI, gravado uma vez por conteúdo numa
 * pasta temporária: a mesma spec não é convertida de novo.
 */

export interface ProjectTarget {
  /** A pasta que as ferramentas leem. */
  dir: string
  /** Num projeto de referência: de onde veio o catálogo. */
  reference?: { project: string; source: 'workspace' | 'openapi'; location: string }
}

/** Muda quando o formato gravado muda, para não reaproveitar uma conversão antiga. */
const CACHE_FORMAT = '1'
const converted = new Map<string, string>()

/** A pasta do projeto `id` no workspace de `dir`, seguindo a referência quando ele é uma. */
export async function resolveProject(dir: string, id: string): Promise<ProjectTarget> {
  const layout = projectLayout(dir)
  const project = layout.projects.find((p) => p.id === id)
  if (!project?.reference) return { dir: projectDir(dir, id) }
  const folder = join(layout.root, project.folder)
  const { workspace, openapi } = project.reference
  if (workspace && isDir(resolve(folder, workspace))) {
    return { dir: resolve(folder, workspace), reference: { project: id, source: 'workspace', location: workspace } }
  }
  if (openapi && existsSync(resolve(folder, openapi))) {
    return { dir: await fromSpec(resolve(folder, openapi)), reference: { project: id, source: 'openapi', location: openapi } }
  }
  const tried = [workspace && `workspace ${workspace}`, openapi && `openapi ${openapi}`].filter(Boolean).join(', ')
  throw new ConfigError(`o projeto de referência "${id}" não achou nenhuma fonte (${tried}, relativas a ${project.folder}/)`)
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** O workspace convertido da spec: uma pasta por conteúdo, gravada inteira antes de valer. */
async function fromSpec(spec: string): Promise<string> {
  const bytes = await readFile(spec)
  const hash = createHash('sha256').update(CACHE_FORMAT).update(bytes).digest('hex').slice(0, 24)
  const known = converted.get(hash)
  if (known) return known
  const dir = join(tmpdir(), 'vvpost-references', hash)
  if (!existsSync(join(dir, '.ready'))) {
    const { prepareImport, writeImport } = await import('../importers')
    const prepared = await prepareImport([spec])
    const errors = [...prepared.readErrors, ...prepared.result.errors, ...prepared.invalid]
    if (errors.length) throw new ConfigError(`a spec ${spec} não deu um catálogo: ${errors[0]!.message}`)
    // Grava ao lado e troca de uma vez: duas sessões ao mesmo tempo não leem uma pasta pela metade.
    const tmp = `${dir}.${randomUUID()}`
    await mkdir(tmp, { recursive: true })
    try {
      await writeImport(prepared, { dir: tmp, isWorkspace: false })
      await writeFile(join(tmp, '.ready'), '')
      await rename(tmp, dir).catch(async (err: NodeJS.ErrnoException) => {
        if (!existsSync(join(dir, '.ready'))) throw err
      })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }
  converted.set(hash, dir)
  return dir
}
