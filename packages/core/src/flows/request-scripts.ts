import type { Flow, FlowEdge, FlowNode, FlowRequest, RequestScripts } from '@vvpost/schemas'
import type { FlowNodeResult, HttpRequestInput, HttpResult, ScriptTestResult, ScriptUsage } from '../types'
import type { ResolvedConnector } from '../connectors/resolve'
import type { LoadedWorkspace } from '../connectors/workspace'
import { isSensitiveName } from '../secrets'

/**
 * Scripts por requisição (fase 13). Uma requisição com scripts vira, por trás, um fluxo do
 * Flow Studio: um nó javascript.request-script para cada script pre, o nó de requisição e um
 * para cada post, em fila. Roda no mesmo motor (runFlow), com o runtime e a sandbox do
 * vvpost-plugin-javascript, e "Ver como fluxo" abre exatamente esse fluxo no canvas.
 */

export const SCRIPT_NODE = 'javascript.request-script'
/** Nome do nó de requisição no fluxo dos scripts. */
export const REQUEST_NODE = 'Requisicao'

/** Um nível de scripts: um conector da cadeia, o endpoint ou a própria requisição. */
export interface ScriptStep {
  /** Id do conector, "endpoint" ou "request". */
  from: string
  pre?: string
  post?: string
}

const has = (text: string | undefined) => !!text?.trim()

/** Os scripts que valem, da raiz da cadeia até a requisição: todos rodam, nessa ordem (pre e post). */
export function scriptSteps(connector: Pick<ResolvedConnector, 'scripts'> | undefined, endpoint?: { scripts?: RequestScripts }, own?: RequestScripts): ScriptStep[] {
  const steps: ScriptStep[] = [...(connector?.scripts ?? [])]
  for (const [from, s] of [['endpoint', endpoint?.scripts], ['request', own]] as const) {
    if (s && (has(s.pre) || has(s.post))) steps.push({ from, ...(has(s.pre) && { pre: s.pre }), ...(has(s.post) && { post: s.post }) })
  }
  return steps
}

/** A requisição como o script a vê em vv.request: headers e query por nome, corpo em texto. */
export interface ScriptRequest {
  method: string
  url: string
  headers: Record<string, string>
  query: Record<string, string>
  body?: string
}

export interface ScriptFlowSpec {
  /** O nó de requisição: conector, método, URL, payload, timeout. `fromScript` e `scripts` são do fluxo. */
  request: Omit<FlowRequest, 'fromScript' | 'scripts' | 'requestScripts'>
  /** O que o primeiro script recebe em vv.request. */
  template: ScriptRequest
  steps: ScriptStep[]
  /** Valores que vv.variables.get lê (segredos como {{NOME}}); ausente em "Ver como fluxo". */
  environment?: Record<string, string>
  /** Variáveis que scripts anteriores definiram nesta sessão. */
  variables?: Record<string, string>
}

const nodeName = (prefix: string, from: string, taken: Set<string>) => {
  const base = `${prefix}_${from.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')}`.slice(0, 60)
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`
  taken.add(name)
  return name
}

const ref = (name: string, path: string) => `{{ $nodes.${name}${path} }}`

/** O fluxo script → requisição → script de uma requisição. Lido da esquerda para a direita, como roda. */
export function scriptFlow(spec: ScriptFlowSpec, id = 'flow.request-scripts', name = 'Scripts da requisição'): Flow {
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []
  const taken = new Set([REQUEST_NODE])
  let previous: { id: string; name: string } | undefined
  let lastPre: string | undefined
  const link = (node: FlowNode) => {
    if (previous) edges.push({ from: previous.id, to: node.id })
    nodes.push({ ...node, position: { x: nodes.length * 260, y: 0 } })
    previous = { id: node.id, name: node.name }
  }
  const variables = () => (previous && previous.name !== REQUEST_NODE ? ref(previous.name, '.data.variables') : (spec.variables ?? {}))
  const lastVariables = () => {
    // Depois da requisição, as variáveis vêm do último script que rodou antes dela.
    const before = [...nodes].reverse().find((n) => n.type === 'plugin')
    return before ? ref(before.name, '.data.variables') : (spec.variables ?? {})
  }
  const script = (phase: 'pre' | 'post', step: ScriptStep, code: string): FlowNode => {
    const nodeName_ = nodeName(phase === 'pre' ? 'Pre' : 'Post', step.from, taken)
    return {
      id: `${phase}-${nodes.length}`,
      name: nodeName_,
      type: 'plugin',
      plugin: {
        node: SCRIPT_NODE,
        config: {
          phase,
          code,
          request: lastPre ? ref(lastPre, '.data.request') : spec.template,
          ...(phase === 'post' && { response: ref(REQUEST_NODE, '') }),
          ...(spec.environment && { environment: spec.environment }),
          variables: phase === 'pre' ? variables() : previous?.name === REQUEST_NODE ? lastVariables() : variables()
        }
      }
    }
  }

  for (const step of spec.steps) {
    if (!step.pre) continue
    const node = script('pre', step, step.pre)
    link(node)
    lastPre = node.name
  }
  link({
    id: 'request',
    name: REQUEST_NODE,
    type: 'request',
    request: {
      ...spec.request,
      ...(lastPre && { fromScript: lastPre }),
      scripts: false,
      // Um 4xx/5xx ainda vai para os scripts post, que costumam testar o status.
      ignoreHttpErrors: true
    }
  })
  for (const step of spec.steps) if (step.post) link(script('post', step, step.post))
  return { id, name, nodes, edges }
}

/** A requisição do Quick Request como o primeiro script a vê. */
export function scriptRequest(input: Pick<HttpRequestInput, 'method' | 'url' | 'headers' | 'body'>): ScriptRequest {
  const headers: Record<string, string> = {}
  for (const h of input.headers) if (h.name.trim()) headers[h.name.trim()] = h.value
  return { method: input.method, url: input.url, headers, query: {}, ...(input.body !== undefined && { body: input.body }) }
}

/**
 * Variáveis do ambiente para vv.variables.get. Segredos (e nomes sensíveis) chegam como
 * {{NOME}}: o script pode pôr na requisição, que o host resolve no envio, mas não lê o valor.
 */
export function scriptEnvironment(ws: LoadedWorkspace, environmentId: string | undefined): Record<string, string> {
  const env = environmentId ? ws.environments.get(environmentId) : undefined
  const out: Record<string, string> = {}
  for (const [name, variable] of Object.entries(env?.variables ?? {})) {
    out[name] = variable.isSecret || isSensitiveName(name) ? `{{${name}}}` : String(variable.value)
  }
  return out
}

interface ScriptOutput {
  tests?: { name: string; passed: boolean; message: string }[]
  variables?: Record<string, string>
}

/** De onde veio cada nó de script: Pre_connector_billing → connector.billing (pelo spec). */
function origins(flow: Flow, steps: ScriptStep[]): Map<string, { phase: 'pre' | 'post'; from: string }> {
  const out = new Map<string, { phase: 'pre' | 'post'; from: string }>()
  const pres = flow.nodes.filter((n) => n.type === 'plugin' && n.id.startsWith('pre-'))
  const posts = flow.nodes.filter((n) => n.type === 'plugin' && n.id.startsWith('post-'))
  steps.filter((s) => s.pre).forEach((s, i) => pres[i] && out.set(pres[i]!.name, { phase: 'pre', from: s.from }))
  steps.filter((s) => s.post).forEach((s, i) => posts[i] && out.set(posts[i]!.name, { phase: 'post', from: s.from }))
  return out
}

/**
 * O relatório do fluxo dos scripts como o Quick Request (e o cenário) o veem: a resposta do nó
 * de requisição, com os testes, os logs e as variáveis dos scripts ao lado. Um pre que falha
 * vira SCRIPT_ERROR (a requisição não saiu); um post que falha fica em scripts.error.
 */
export function scriptResult(flow: Flow, steps: ScriptStep[], results: FlowNodeResult[], response: HttpResult | undefined, durationMs: number): HttpResult {
  const from = origins(flow, steps)
  const tests: ScriptTestResult[] = []
  const logs: string[] = []
  let variables: Record<string, string> = {}
  let failed: { script: string; phase: 'pre' | 'post'; message: string } | undefined
  const ran: string[] = []
  for (const r of results) {
    const origin = from.get(r.name)
    if (!origin) continue
    const label = `${origin.phase}:${origin.from}`
    if (r.status === 'skipped') continue
    ran.push(label)
    if (r.logs) logs.push(...r.logs.trimEnd().split('\n').map((line) => `[${label}] ${line}`))
    if (r.status === 'error') {
      failed ??= { script: label, phase: origin.phase, message: r.error?.message ?? 'falhou' }
      continue
    }
    const data = (r.output?.data ?? {}) as ScriptOutput
    for (const t of data.tests ?? []) tests.push({ name: t.name, passed: t.passed, message: t.message, from: origin.from })
    if (data.variables) variables = { ...data.variables }
  }
  const usage: ScriptUsage = {
    ran,
    tests,
    ...(logs.length && { logs: logs.join('\n') }),
    variables,
    ...(failed && { error: { script: failed.script, message: failed.message } }),
    durationMs
  }
  if (response) return { ...response, scripts: usage }
  const request = results.find((r) => r.name === REQUEST_NODE)
  const message = failed
    ? `script ${failed.script}: ${failed.message}`
    : (request?.error?.message ?? 'o fluxo dos scripts não chegou à requisição')
  const code = failed ? 'SCRIPT_ERROR' : ((request?.error?.code as Exclude<HttpResult, { ok: true }>['error']['code'] | undefined) ?? 'SCRIPT_ERROR')
  return { ok: false, error: { code, message }, timings: { totalMs: durationMs }, scripts: usage }
}
