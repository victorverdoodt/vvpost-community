import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Flow } from '@vvpost/schemas'
import type { FlowRunReport, ScenarioRunInput, ScenarioRunReport } from '@shared/ipc'
import { ConfigError } from '@vvpost/core/connectors/errors'
import { resolveConnector } from '@vvpost/core/connectors/resolve'
import { accessCheckScenario } from '@vvpost/core/scenarios/access'
import type { LoadedWorkspace, WorkspaceIssue } from '@vvpost/core/connectors/workspace'
import type { CoreSession } from '@vvpost/core/session'
import { plainFlows } from '@vvpost/core/flows/workspace'

/** Erro de uso ou de configuração antes de qualquer disparo: o CLI sai com código 2. */
export class UsageError extends Error {}

export interface RunSelection {
  /** Ids de conector cujos cenários rodam; vazio com `flows` também vazio: tudo. */
  connectors: string[]
  /** Fluxos por id ou caminho do arquivo. */
  flows: string[]
  /** Filtro de cenários, "<endpoint>" ou "<endpoint>/<cenário>", em todo conector escolhido. */
  scenarios: string[]
  /** Ambientes; "all" expande para todos. Vazio: roda sem ambiente. */
  environments: string[]
  /** Linhas do arquivo de `--data`: cada uma é uma iteração dos cenários. */
  data?: ScenarioRunInput['data']
}

export interface FlowRun {
  file: string
  environmentId: string
  report: FlowRunReport
}

export interface CliRunResult {
  workspace: string
  startedAt: number
  durationMs: number
  environments: string[]
  scenarios: ScenarioRunReport[]
  flows: FlowRun[]
  /** Arquivos do workspace (conectores, ambientes, fluxos) ignorados por erro de JSON ou schema. */
  issues: WorkspaceIssue[]
  canceled: boolean
}

export type RunOutcome = 'passed' | 'failed' | 'error' | 'canceled'

export interface RunSummary {
  outcome: RunOutcome
  scenarios: { passed: number; failed: number; error: number }
  flows: { success: number; failed: number }
  /** Lotes ou fluxos que nem rodaram (conector com herança quebrada, fluxo inválido...). */
  configErrors: number
}

export function summarize(result: CliRunResult): RunSummary {
  const scenarios = { passed: 0, failed: 0, error: 0 }
  let configErrors = 0
  for (const r of result.scenarios) {
    scenarios.passed += r.totals.passed
    scenarios.failed += r.totals.failed
    scenarios.error += r.totals.error
    if (r.error !== undefined) configErrors++
  }
  const flows = { success: 0, failed: 0 }
  for (const f of result.flows) {
    if (f.report.error !== undefined) configErrors++
    if (f.report.outcome === 'success') flows.success++
    else flows.failed++
  }
  const outcome: RunOutcome = result.canceled
    ? 'canceled'
    : configErrors
      ? 'error'
      : scenarios.failed || scenarios.error || flows.failed
        ? 'failed'
        : 'passed'
  return { outcome, scenarios, flows, configErrors }
}

/** Código de saída para o CI: 0 passou, 1 teste falhou, 2 configuração ou uso, 130 interrompido. */
export function exitCode(summary: RunSummary): number {
  return { passed: 0, failed: 1, error: 2, canceled: 130 }[summary.outcome]
}

const hasScenarios = (ws: LoadedWorkspace, id: string): boolean => {
  try {
    // O gate de acesso (requiresAuth) também conta: um conector sem cenários escritos ainda roda o $sem-credencial.
    return resolveConnector(id, ws.connectors).endpoints.some((e) => e.scenarios?.length || accessCheckScenario(e))
  } catch (err) {
    // Herança quebrada: entra no lote para o relatório mostrar o erro.
    if (err instanceof ConfigError) return true
    throw err
  }
}

/**
 * `vvpost run`: escolhe os lotes de cenários e os fluxos, roda tudo pelo motor e
 * devolve os relatórios como o app os mostra. Sem filtros, roda os cenários de todo
 * conector que tem cenários e todo fluxo do workspace.
 */
export async function runWorkspace(core: CoreSession, selection: RunSelection, signal?: AbortSignal): Promise<CliRunResult> {
  const startedAt = Date.now()
  const start = performance.now()
  const ws = await core.load()
  const catalog = await core.loadFlows()

  const environments = selection.environments.includes('all') ? [...ws.environments.keys()] : selection.environments
  for (const id of environments) {
    if (!ws.environments.has(id)) {
      throw new UsageError(`ambiente "${id}" não existe no workspace (${list(ws.environments.keys())})`)
    }
  }
  if (selection.environments.includes('all') && environments.length === 0) {
    throw new UsageError('--env all: o workspace não tem ambientes em environments/')
  }

  const everything = selection.connectors.length === 0 && selection.flows.length === 0
  for (const id of selection.connectors) {
    if (!ws.connectors.has(id)) throw new UsageError(`conector "${id}" não existe no workspace (${list(ws.connectors.keys())})`)
  }
  const connectorIds = everything ? [...ws.connectors.keys()].filter((id) => hasScenarios(ws, id)).sort() : selection.connectors

  const flows: { file: string; flow: Flow }[] = []
  // Sem filtros, os fluxos comuns: os de requisição rodam pelos cenários do endpoint que eles são.
  if (everything) flows.push(...plainFlows(catalog, ws.flowSources))
  for (const ref of selection.flows) {
    const found = catalog.flows.find((f) => f.flow.id === ref || f.file === workspacePath(ws.dir, ref))
    if (!found) {
      const invalid = catalog.issues.find((i) => i.file === workspacePath(ws.dir, ref))
      throw new UsageError(
        invalid
          ? `fluxo ${invalid.file} é inválido: ${invalid.message}`
          : `fluxo "${ref}" não existe no workspace (${list(catalog.flows.map((f) => f.flow.id))})`
      )
    }
    if (!flows.includes(found)) flows.push(found)
  }
  if (connectorIds.length === 0 && flows.length === 0) {
    throw new UsageError('nada para rodar: o workspace não tem cenários de teste nem fluxos')
  }

  const result: CliRunResult = {
    workspace: ws.dir,
    startedAt,
    durationMs: 0,
    environments,
    scenarios: [],
    flows: [],
    issues: [...ws.issues, ...catalog.issues],
    canceled: false
  }
  const envIds = environments.length ? environments : ['']
  const filters = selection.scenarios

  for (const connectorId of connectorIds) {
    if (signal?.aborted) break
    let endpointIds: string[] | undefined
    let scenarioKeys: string[] | undefined
    if (filters.length) {
      endpointIds = filters.filter((f) => !f.includes('/'))
      scenarioKeys = filters.filter((f) => f.includes('/'))
      // Os dois filtros juntos são "ou": um cenário pedido pelo nome não é excluído pelo filtro de endpoint.
      if (endpointIds.length && scenarioKeys.length) {
        scenarioKeys = [...scenarioKeys, ...expandEndpoints(ws, connectorId, endpointIds)]
        endpointIds = undefined
      } else if (!endpointIds.length) endpointIds = undefined
      else scenarioKeys = undefined
    }
    const report = await core.runScenarios(
      {
        runId: `cli:${connectorId}`,
        connectorId,
        environmentIds: envIds,
        ...(selection.data && { data: selection.data }),
        ...(endpointIds && { endpointIds }),
        ...(scenarioKeys && { scenarioKeys })
      },
      ws,
      signal
    )
    // Um conector sem nenhum cenário depois do filtro não entra no relatório.
    if (report.results.length || report.error !== undefined) result.scenarios.push(report)
  }
  if (filters.length && connectorIds.length && result.scenarios.length === 0 && !signal?.aborted) {
    throw new UsageError(`nenhum cenário corresponde a --scenario ${filters.join(', ')}`)
  }

  for (const { file, flow } of flows) {
    for (const environmentId of envIds) {
      if (signal?.aborted) break
      const report = await core.runFlow({ runId: `cli:${flow.id}:${environmentId}`, flow, environmentId }, ws, {
        ...(signal && { signal })
      })
      result.flows.push({ file, environmentId, report })
    }
  }

  result.canceled = !!signal?.aborted
  result.durationMs = Math.round(performance.now() - start)
  return result
}

function expandEndpoints(ws: LoadedWorkspace, connectorId: string, endpointIds: string[]): string[] {
  try {
    const wanted = new Set(endpointIds)
    return resolveConnector(connectorId, ws.connectors)
      .endpoints.filter((e) => wanted.has(e.id))
      .flatMap((e) => [...(e.scenarios ?? []), accessCheckScenario(e)].flatMap((s) => (s ? [`${e.id}/${s.id}`] : [])))
  } catch {
    return []
  }
}

/** Caminho como o catálogo guarda (relativo ao workspace, com "/"), aceitando relativo à pasta atual ou absoluto. */
function workspacePath(dir: string, ref: string): string {
  const abs = isAbsolute(ref) ? ref : resolve(ref)
  const rel = relative(dir, abs)
  // Em outro drive (Windows), relative() devolve o caminho absoluto.
  return (rel.startsWith('..') || isAbsolute(rel) ? ref : rel).split(sep).join('/')
}

const list = (ids: Iterable<string>): string => {
  const all = [...ids]
  return all.length ? `disponíveis: ${all.join(', ')}` : 'nenhum no workspace'
}
