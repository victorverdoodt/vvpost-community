import type { Flow } from '@vvpost/schemas'
import type { FlowRunReport, HttpRequestInput, HttpResult, PrepareUsage } from '../types'
import { ExpressionError, Substitutions, type NodeOutput, type NodesTree } from './expressions'

/**
 * Fluxo de preparação no Quick Request: um fluxo de login, de token ou de
 * dados de teste roda em segundo plano antes da requisição, sem abrir o canvas. A requisição
 * lê a saída dos nós dele como um nó do próprio fluxo leria: {{ $nodes.Login.data.token }}.
 */

/** A árvore $nodes que a requisição enxerga: a saída de cada nó que rodou com sucesso. */
export function preparationNodes(report: FlowRunReport): NodesTree {
  const tree: Record<string, NodeOutput> = {}
  for (const r of report.results) if (r.status === 'success' && r.output) tree[r.name] = r.output
  return tree
}

/** O resumo que volta com a resposta, sem a saída dos nós (que pode ter tokens). */
export function prepareUsage(flow: Pick<Flow, 'id' | 'name'>, report: FlowRunReport): PrepareUsage {
  const failed = report.results.find((r) => r.status === 'error')
  return {
    flowId: flow.id,
    flowName: flow.name,
    outcome: report.outcome,
    durationMs: report.durationMs,
    nodes: report.results.filter((r) => r.status === 'success').map((r) => r.name),
    ...(failed && {
      failed: { nodeId: failed.nodeId, name: failed.name, code: failed.error?.code ?? 'FLOW_ERROR', message: failed.error?.message ?? 'falhou' }
    })
  }
}

/**
 * Troca as referências {{ $nodes... }} da URL, dos headers e do corpo por marcadores com o
 * valor em `extra`, para o envio resolver tudo junto com os {{VAR}} do ambiente. Como nos
 * fluxos, um valor vindo de uma resposta não é interpolado de novo. Referência a um nó que
 * não rodou ou a um campo que não existe é ExpressionError.
 */
export function applyPreparation(input: HttpRequestInput, nodes: NodesTree): { input: HttpRequestInput; extra: Record<string, string> } {
  const subs = new Substitutions(nodes)
  const prepared: HttpRequestInput = {
    ...input,
    url: subs.text(input.url),
    headers: input.headers.map((h) => ({ name: h.name, value: subs.text(h.value) })),
    ...(input.body !== undefined && { body: subs.text(input.body) })
  }
  return { input: prepared, extra: subs.extra }
}

/** Resultado de erro com o resumo da preparação, para o Quick Request mostrar onde parou. */
function failure(code: 'PREPARE_FAILED' | 'CONFIG_ERROR' | 'ABORTED', message: string, prepare?: PrepareUsage): HttpResult {
  return { ok: false, error: { code, message }, timings: { totalMs: 0 }, ...(prepare && { prepare }) }
}

export type Preparation =
  | { ok: true; input: HttpRequestInput; extra: Record<string, string>; prepare: PrepareUsage }
  | { ok: false; result: HttpResult }

/**
 * Roda a preparação e devolve a requisição pronta para `sendHeadless` (com `extra`), ou o
 * erro que o Quick Request mostra no lugar da resposta. `run` executa o fluxo pelo mesmo
 * dispatcher e cache de tokens da requisição.
 */
export async function prepareRequest(
  input: HttpRequestInput,
  flow: Flow | undefined,
  run: (flow: Flow) => Promise<FlowRunReport>
): Promise<Preparation> {
  if (!flow) return { ok: false, result: failure('CONFIG_ERROR', `o fluxo de preparação "${input.prepareFlowId}" não existe no workspace`) }
  const report = await run(flow)
  const prepare = prepareUsage(flow, report)
  if (report.outcome === 'canceled') return { ok: false, result: failure('ABORTED', 'Requisição cancelada', prepare) }
  if (report.error) return { ok: false, result: failure('PREPARE_FAILED', `preparação ${flow.name}: ${report.error}`, prepare) }
  if (prepare.failed) {
    const { name, message } = prepare.failed
    return { ok: false, result: failure('PREPARE_FAILED', `preparação ${flow.name}: o nó ${name} falhou (${message})`, prepare) }
  }
  try {
    return { ok: true, ...applyPreparation(input, preparationNodes(report)), prepare }
  } catch (err) {
    if (err instanceof ExpressionError) return { ok: false, result: failure('CONFIG_ERROR', err.message, prepare) }
    throw err
  }
}
