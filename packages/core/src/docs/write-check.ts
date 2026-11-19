import type { LoadedWorkspace } from '../connectors/workspace'
import { buildRegistry, exampleProblem } from '../connectors/registry'
import type { FlowCatalog } from '../types'
import { composeDocumentation, loadDocsProject } from './compose'

/**
 * O que uma escrita pode deixar para trás e o `vvpost validate` do CI reprova: diretiva do
 * documento do projeto que aponta para o que não existe, corpo padrão de endpoint fora do
 * bodySchema e resposta de exemplo fora do schema dela. Uma linha por problema, estável entre
 * duas leituras, para comparar o antes e o depois de uma gravação (o app avisa só o que a
 * gravação causou).
 */
export async function writeProblems(ws: LoadedWorkspace, flows: FlowCatalog): Promise<string[]> {
  const problems: string[] = []
  const registry = await buildRegistry(ws)
  for (const c of registry.connectors) {
    if (ws.shared?.has(c.id)) continue
    for (const e of c.endpoints) {
      for (const check of e.checks) {
        if (check.source !== 'body' || !check.issues.length) continue
        const issues = check.issues
          .slice(0, 3)
          .map((i) => `${i.path || '/'}: ${i.message}`)
          .join('; ')
        problems.push(`endpoint ${c.id}/${e.id}: corpo padrão fora do bodySchema (${issues})`)
      }
      for (const check of e.exampleChecks ?? []) {
        if (check.issues.length) problems.push(`endpoint ${c.id}/${e.id}: ${exampleProblem(check)}`)
      }
    }
  }
  const project = await loadDocsProject(ws.dir)
  if (project.source !== null) {
    const composed = await composeDocumentation(ws, flows, { source: project.source, sourceFile: project.sourceFile, config: project.config }).catch(() => null)
    for (const d of composed?.diagnostics ?? []) {
      if (d.severity === 'error') problems.push(`${d.file}: ${d.message}`)
    }
  }
  return problems
}
