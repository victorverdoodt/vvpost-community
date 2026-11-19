import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SchemaId, validateProject } from '@vvpost/schemas'
import { PROJECT_FILE, projectLayout } from '@vvpost/core/projects'
import { slug } from '../importers/postman'

/**
 * Cria um projeto no workspace (docs/git-workspace.md, Projetos): a subpasta com o id tirado do
 * nome e o vvpost.project.json dela. Ambientes e segredos da raiz já valem lá dentro. Devolve a
 * pasta do projeto.
 */
export async function createProject(root: string, name: string, description?: string): Promise<string> {
  const id = slug(name)
  const doc = { $schema: SchemaId.Project, id, name, ...(description && { description }) }
  const valid = validateProject(doc)
  if (!id || !valid.ok) throw new Error(`"${name}" não dá um id de projeto válido${valid.ok ? '' : `: ${valid.issues[0]?.message}`}`)
  const taken = projectLayout(root).projects.find((p) => p.id === id || p.folder === id)
  if (taken) throw new Error(`o workspace já tem o projeto "${taken.name}" (${taken.folder})`)
  const folder = join(root, id)
  await mkdir(folder, { recursive: true })
  // wx: uma pasta com esse nome que já tenha o arquivo não é sobrescrita.
  await writeFile(join(folder, PROJECT_FILE), `${JSON.stringify(doc, null, 2)}\n`, { flag: 'wx' })
  return folder
}
