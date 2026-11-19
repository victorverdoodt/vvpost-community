import type { LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { resolveConnector } from '@vvpost/core/connectors/resolve'
import type { FlowCatalog } from '@vvpost/core/types'

export interface WorkspaceProblem {
  file: string
  message: string
}

/**
 * O que o `vvpost validate` confere no workspace, fora os plugins: arquivos, herança, corpo padrão e
 * de cenário contra o bodySchema, exemplos de resposta contra o schema deles e o documento do
 * projeto. `problems` reprova; `warnings` só avisa (com `strict`, também reprova). O sync com a spec
 * (importers/spec-sync.ts) compara o resultado antes e depois para dizer o que quebrou.
 */
export async function workspaceProblems(
  ws: LoadedWorkspace,
  flows: FlowCatalog,
  strict = false
): Promise<{ problems: WorkspaceProblem[]; warnings: WorkspaceProblem[] }> {
  const [{ buildRegistry, exampleProblem }, docs] = await Promise.all([import('@vvpost/core/connectors/registry'), import('@vvpost/core/docs')])
  const registry = await buildRegistry(ws)
  const problems: WorkspaceProblem[] = [...ws.issues, ...flows.issues]
  const warnings: WorkspaceProblem[] = []
  // Do registro vêm, além das do workspace, as seções do .md sem endpoint e os avisos da herança.
  for (const issue of registry.issues.slice(ws.issues.length)) (issue.file.endsWith('.md') || strict ? problems : warnings).push(issue)
  for (const id of ws.connectors.keys()) {
    try {
      resolveConnector(id, ws.connectors)
    } catch (err) {
      problems.push({ file: ws.connectorFiles.get(id)!, message: (err as Error).message })
    }
  }
  for (const c of registry.connectors) {
    const file = (endpointId: string) => ws.flowSources?.get(`${c.id}/${endpointId}`) ?? c.file
    for (const e of c.endpoints) {
      for (const check of e.checks) {
        if (!check.issues.length) continue
        const issue = {
          file: file(e.id),
          message: `${e.id}: ${check.label.toLowerCase()} fora do bodySchema (${check.issues
            .slice(0, 3)
            .map((i) => `${i.path || '/'}: ${i.message}`)
            .join('; ')})`
        }
        if (check.source === 'body' || strict) problems.push(issue)
        else warnings.push(issue)
      }
      // A resposta de exemplo é o que a documentação e o mock mostram: fora do schema dela, reprova.
      for (const check of e.exampleChecks ?? []) {
        if (check.issues.length) problems.push({ file: file(e.id), message: `${e.id}: ${exampleProblem(check)}` })
      }
    }
  }
  // Cenário com valor para um {parâmetro} que o caminho não tem (o caminho mudou, ou o parâmetro trocou de nome).
  for (const [id, c] of ws.connectors) {
    if (ws.shared?.has(id)) continue
    for (const e of c.endpoints ?? []) {
      const params = new Set([...e.path.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!))
      for (const sc of e.scenarios ?? []) {
        const stale = [...new Set([...Object.keys(sc.overrides?.pathParams ?? {}), ...(sc.overrides?.rawPathParams ?? [])])].filter((p) => !params.has(p))
        if (!stale.length) continue
        const issue = {
          file: ws.flowSources?.get(`${id}/${e.id}`) ?? ws.connectorFiles.get(id)!,
          message: `${e.id}: o cenário ${sc.name} dá valor a ${stale.map((p) => `{${p}}`).join(', ')}, que o caminho ${e.path} não tem`
        }
        ;(strict ? problems : warnings).push(issue)
      }
    }
  }
  const project = await docs.loadDocsProject(ws.dir)
  problems.push(...project.configIssues)
  if (project.source !== null) {
    const composed = await docs.composeDocumentation(ws, flows, { source: project.source, sourceFile: project.sourceFile, config: project.config })
    for (const d of composed.diagnostics) {
      const issue = { file: `${d.file}:${d.line}`, message: d.message }
      if (d.severity === 'error' || strict) problems.push(issue)
      else warnings.push(issue)
    }
  }
  return { problems, warnings }
}
