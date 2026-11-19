import type { PiiMasker } from './pii'
import type { RealtimeEvent } from './realtime'
import type { AssertionResult, FlowNodeResult, FlowRunReport, HttpHeader, HttpResult, ScenarioResult, ScenarioRunReport, WebhookEvent } from './types'

/**
 * Dados pessoais também para quem usa o app e o CLI (docs/security-model.md, "Dados pessoais para
 * pessoas"): com `.vvpost/privacy.json` (`people.mask`) ou a política da organização mandando, o
 * que mostra uma resposta (Quick Request, cenários, fluxos, realtime, webhooks, histórico, terminal
 * e relatórios) sai pelo mesmo mascaramento do agente. Ao contrário do agente, só os dados da
 * execução mudam: a estrutura (nomes de nós, ids, headers) fica, porque um campo marcado como
 * `name` não pode apagar o nome de um nó. Os valores reais continuam indo para a rede.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Header: o valor mascarado pelo nome (campo marcado) e pelo formato. */
export function peopleHeaders<T extends HttpHeader>(headers: readonly T[], m: PiiMasker): T[] {
  return headers.map((h) => ({ ...h, value: String(m.at(h.name, h.value)) }))
}

/** Os textos de um valor qualquer (relatório, evento), sem mascarar pelo nome das chaves. */
export function peopleText<T>(value: T, m: PiiMasker, depth = 0): T {
  if (depth > 64) return value
  if (typeof value === 'string') return m.text(value) as T
  if (Array.isArray(value)) return value.map((v) => peopleText(v, m, depth + 1)) as T
  if (isObject(value)) {
    if (typeof value['name'] === 'string' && typeof value['value'] === 'string' && Object.keys(value).length <= 3) {
      return { ...value, value: String(m.at(value['name'], value['value'])) } as T
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, peopleText(v, m, depth + 1)])) as T
  }
  return value
}

export function peopleHttpResult(result: HttpResult, m: PiiMasker): HttpResult {
  const out: HttpResult = { ...result }
  if (out.ok) {
    out.response = {
      ...out.response,
      body: m.text(out.response.body),
      headers: peopleHeaders(out.response.headers, m)
    }
  } else out.error = { ...out.error, message: m.text(out.error.message) }
  if (out.sent) out.sent = { ...out.sent, url: m.text(out.sent.url), headers: peopleHeaders(out.sent.headers, m) }
  if (out.scripts) {
    out.scripts = {
      ...out.scripts,
      tests: out.scripts.tests.map((t) => ({ ...t, message: m.text(t.message) })),
      ...(out.scripts.logs !== undefined && { logs: m.text(out.scripts.logs) }),
      variables: Object.fromEntries(Object.entries(out.scripts.variables).map(([k, v]) => [k, String(m.at(k, v))])),
      ...(out.scripts.error && { error: { ...out.scripts.error, message: m.text(out.scripts.error.message) } })
    }
  }
  if (out.plugin?.logs !== undefined) out.plugin = { ...out.plugin, logs: m.text(out.plugin.logs) }
  return out
}

/** O valor achado (e o esperado) de cada asserção, pelo alvo: body.cliente.cpf é o campo cpf. */
export function peopleAssertions(list: readonly AssertionResult[], m: PiiMasker): AssertionResult[] {
  return list.map((a) => {
    const actual = 'actual' in a ? m.at(a.target, a.actual) : undefined
    let message = m.text(a.message)
    // A mensagem repete o valor achado ("recebido ..."): o que o alvo mascarou some dela também.
    if (actual !== a.actual && (typeof a.actual === 'string' || typeof a.actual === 'number') && String(a.actual) !== '') {
      message = message.split(String(a.actual)).join(String(actual))
    }
    return {
      ...a,
      ...('actual' in a && { actual }),
      ...(a.expected !== undefined && typeof a.expected !== 'object' && { expected: m.at(a.target, a.expected) }),
      message
    }
  })
}

export function peopleScenarioResult(r: ScenarioResult, m: PiiMasker): ScenarioResult {
  return {
    ...r,
    request: { ...r.request, url: m.text(r.request.url) },
    ...(r.error && { error: { ...r.error, message: m.text(r.error.message) } }),
    assertions: peopleAssertions(r.assertions, m),
    ...(r.captures && { captures: Object.fromEntries(Object.entries(r.captures).map(([k, v]) => [k, String(m.at(k, v))])) }),
    ...(r.bodyPreview !== undefined && { bodyPreview: m.text(r.bodyPreview) }),
    ...(r.responseHeaders && { responseHeaders: peopleHeaders(r.responseHeaders, m) })
  }
}

export function peopleScenarioReport(report: ScenarioRunReport, m: PiiMasker): ScenarioRunReport {
  return { ...report, results: report.results.map((r) => peopleScenarioResult(r, m)) }
}

export function peopleFlowNode(r: FlowNodeResult, m: PiiMasker): FlowNodeResult {
  return {
    ...r,
    ...(r.output && {
      output: {
        ...r.output,
        // A saída do nó é o dado da resposta (ou do script): aqui a chave marcada vale.
        data: m.sanitize(r.output.data),
        ...(r.output.headers && { headers: Object.fromEntries(Object.entries(r.output.headers).map(([k, v]) => [k, String(m.at(k, v))])) })
      }
    }),
    ...(r.error && { error: { ...r.error, message: m.text(r.error.message) } }),
    ...(r.request && { request: { ...r.request, url: m.text(r.request.url) } }),
    ...(r.logs !== undefined && { logs: m.text(r.logs) }),
    ...(r.tests && { tests: r.tests.map((t) => ({ ...t, message: m.text(t.message) })) })
  }
}

export function peopleFlowReport(report: FlowRunReport, m: PiiMasker): FlowRunReport {
  return { ...report, results: report.results.map((r) => peopleFlowNode(r, m)) }
}

/** Uma troca do histórico, como o app a mostra (gravada antes de a máscara valer, também sai mascarada). */
export interface PeopleExchange {
  sent?: { url: string; headers: HttpHeader[]; body?: string | null }
  response?: { headers: HttpHeader[]; body?: string }
  assertions?: AssertionResult[]
  logs?: string
  errorMessage: string | null
}

export function peopleExchange<T extends PeopleExchange>(x: T, m: PiiMasker): T {
  return {
    ...x,
    ...(x.sent && { sent: { ...x.sent, url: m.text(x.sent.url), headers: peopleHeaders(x.sent.headers, m), ...(typeof x.sent.body === 'string' && { body: m.text(x.sent.body) }) } }),
    ...(x.response && { response: { ...x.response, headers: peopleHeaders(x.response.headers, m), ...(x.response.body !== undefined && { body: m.text(x.response.body) }) } }),
    ...(x.assertions && { assertions: peopleAssertions(x.assertions, m) }),
    ...(x.logs !== undefined && { logs: m.text(x.logs) }),
    errorMessage: x.errorMessage === null ? null : m.text(x.errorMessage)
  }
}

export function peopleRealtimeEvent(e: RealtimeEvent, m: PiiMasker): RealtimeEvent {
  if (e.type === 'message') return e.message.binary ? e : { ...e, message: { ...e.message, data: m.text(e.message.data) } }
  return { ...e, ...(e.detail !== undefined && { detail: m.text(e.detail) }), ...(e.url !== undefined && { url: m.text(e.url) }) }
}

/** Evento recebido pelo servidor de webhooks: corpo, headers, query e URL. */
export function peopleWebhookEvent<T extends Partial<Pick<WebhookEvent, 'body' | 'headers'>> & Pick<WebhookEvent, 'url' | 'query'>>(e: T, m: PiiMasker): T {
  return {
    ...e,
    url: m.text(e.url),
    query: Object.fromEntries(Object.entries(e.query).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => String(m.at(k, x))) : String(m.at(k, v))])),
    ...(e.headers && { headers: peopleHeaders(e.headers, m) }),
    ...(e.body !== undefined && { body: m.text(e.body) })
  }
}
