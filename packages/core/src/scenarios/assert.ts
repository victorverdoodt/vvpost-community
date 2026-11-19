import { validateJsonSchema } from '@vvpost/schemas'
import type { ResponseExample } from '@vvpost/schemas'
import type { AssertionResult, HttpResponseData, ScenarioAssertion } from '../types'

const PREVIEW_CHARS = 200

/** Resposta já lida uma vez: o corpo é parseado só uma vez para todas as asserções do cenário. */
export interface AssertionSubject {
  status: number
  responseTimeMs: number
  headers: HttpResponseData['headers']
  /** Corpo como JSON quando dá para parsear, senão o texto; undefined com corpo vazio. */
  body: unknown
  bodyIsJson: boolean
  truncated: boolean
}

export function toSubject(res: HttpResponseData): AssertionSubject {
  let body: unknown = res.body === '' ? undefined : res.body
  let bodyIsJson = false
  if (res.body.trim() && !res.truncated) {
    try {
      body = JSON.parse(res.body)
      bodyIsJson = true
    } catch {
      // texto puro
    }
  }
  return {
    status: res.status,
    responseTimeMs: res.timings.totalMs,
    headers: res.headers,
    body,
    bodyIsJson,
    truncated: res.truncated
  }
}

/**
 * Motor de asserções declarativas. Alvos: status, responseTimeMs, body,
 * body.<caminho> (com .chave e [índice]) e headers.<nome> (sem diferenciar maiúsculas).
 * Nunca lança: problema na asserção vira falha com a explicação. `examples` são as respostas de
 * exemplo do endpoint, que matchesExample usa (o schema do exemplo do mesmo status da resposta).
 */
export function evaluateAssertion(assertion: ScenarioAssertion, subject: AssertionSubject, examples: readonly ResponseExample[] = []): AssertionResult {
  const { target, operator, expected } = assertion
  const found = readTarget(target, subject)
  const actual = found.value
  const result = (passed: boolean, message: string): AssertionResult => ({
    ...assertion,
    passed,
    ...(actual !== undefined && { actual: actualValue(actual) }),
    message
  })
  if (found.problem && operator !== 'notExists') return result(false, found.problem)

  // Headers sempre chegam como texto: "42" vale como 42 neles, e só neles.
  const loose = target.startsWith('headers.')
  const want = preview(expected)

  switch (operator) {
    case 'exists':
      return actual === undefined ? result(false, `${target} não existe na resposta`) : result(true, `${target} existe`)
    case 'notExists':
      return actual === undefined ? result(true, `${target} não existe`) : result(false, `${target} existe na resposta`)
    case 'equals':
    case 'notEquals': {
      if (actual === undefined) return result(false, `${target} não existe na resposta`)
      const same = sameValue(actual, expected, loose)
      if (operator === 'equals') return same ? result(true, `${target} = ${want}`) : result(false, `esperado ${want}, recebido ${preview(actual)}`)
      return same ? result(false, `${target} não deveria ser ${want}`) : result(true, `${target} ≠ ${want}`)
    }
    case 'lessThan':
    case 'lessThanOrEqual':
    case 'greaterThan':
    case 'greaterThanOrEqual': {
      const n = toNumber(actual, loose)
      if (typeof expected !== 'number') return result(false, 'expected deve ser um número')
      if (n === undefined) {
        return result(false, actual === undefined ? `${target} não existe na resposta` : `${target} não é um número`)
      }
      const [ok, symbol] = compare(operator, n, expected)
      return ok ? result(true, `${n} ${symbol} ${expected}`) : result(false, `esperado ${symbol} ${expected}, recebido ${n}`)
    }
    case 'contains': {
      if (actual === undefined) return result(false, `${target} não existe na resposta`)
      return contains(actual, expected)
        ? result(true, `${target} contém ${want}`)
        : result(false, `${target} não contém ${want}`)
    }
    case 'matches': {
      if (typeof expected !== 'string') return result(false, 'expected deve ser uma expressão regular em texto')
      let regex: RegExp
      try {
        regex = toRegExp(expected)
      } catch (err) {
        return result(false, `expressão regular inválida: ${(err as Error).message}`)
      }
      if (typeof actual !== 'string' && typeof actual !== 'number') {
        return result(false, actual === undefined ? `${target} não existe na resposta` : `${target} não é texto`)
      }
      return regex.test(String(actual)) ? result(true, `${target} casa com ${regex}`) : result(false, `${preview(actual)} não casa com ${regex}`)
    }
    case 'matchesSchema': {
      if (!isRecord(expected)) return result(false, 'expected deve ser um JSON Schema (objeto)')
      if (actual === undefined) return result(false, `${target} não existe na resposta`)
      return followsSchema(expected, actual, `${target} segue o schema`, 'fora do schema', result)
    }
    case 'matchesExample': {
      // O exemplo do mesmo status que tem schema; vários com o mesmo status: vale o primeiro com schema.
      const example = examples.find((e) => e.status === subject.status && isRecord(e.schema))
      if (!example) return result(false, `nenhum exemplo de resposta ${subject.status} com schema neste endpoint`)
      if (actual === undefined) return result(false, `${target} não existe na resposta`)
      return followsSchema(example.schema!, actual, `${target} segue o schema do exemplo "${example.name}"`, `fora do schema do exemplo "${example.name}"`, result)
    }
    default:
      return result(false, `operador desconhecido "${String(operator)}"`)
  }
}

function followsSchema(
  schema: Record<string, unknown>,
  actual: unknown,
  ok: string,
  failed: string,
  result: (passed: boolean, message: string) => AssertionResult
): AssertionResult {
  const validation = validateJsonSchema(schema, actual)
  if (validation.ok) return result(true, ok)
  const issues = validation.issues.slice(0, 3).map((i) => `${i.path || '/'}: ${i.message}`)
  const more = validation.issues.length > 3 ? ` (+${validation.issues.length - 3})` : ''
  return result(false, `${failed}: ${issues.join('; ')}${more}`)
}

/** Lê um alvo (status, body, body.<caminho>, headers.<nome>) da resposta; usado também pelo capture dos cenários. */
export function readTarget(target: string, s: AssertionSubject): { value: unknown; problem?: string } {
  if (target === 'status') return { value: s.status }
  if (target === 'responseTimeMs') return { value: s.responseTimeMs }
  if (target === 'body') return { value: s.body }
  if (target.startsWith('headers.')) {
    const name = target.slice('headers.'.length).toLowerCase()
    const values = s.headers.filter((h) => h.name.toLowerCase() === name).map((h) => h.value)
    return { value: values.length ? values.join(', ') : undefined }
  }
  if (target.startsWith('body.') || target.startsWith('body[')) {
    if (!s.bodyIsJson) {
      const problem =
        s.body === undefined
          ? 'resposta sem corpo'
          : s.truncated
            ? 'corpo grande demais para ler como JSON (cortado em 10 MB)'
            : 'o corpo da resposta não é JSON'
      return { value: undefined, problem }
    }
    let current = s.body
    for (const part of target.slice('body'.length).match(/[^.[\]]+/g) ?? []) {
      const key = part.replace(/^(["'])(.*)\1$/, '$2')
      if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)]
      else if (isRecord(current) && Object.hasOwn(current, key)) current = current[key]
      else return { value: undefined }
    }
    return { value: current }
  }
  return { value: undefined, problem: `alvo desconhecido "${target}"` }
}

function sameValue(actual: unknown, expected: unknown, loose: boolean): boolean {
  if (loose && typeof actual === 'string' && (typeof expected === 'number' || typeof expected === 'boolean')) {
    return actual.trim() === String(expected)
  }
  return deepEqual(actual, expected)
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

/**
 * Texto contém o trecho; lista contém o item; objeto contém as chaves e valores
 * de `expected` (subconjunto) ou, com `expected` em texto, a chave.
 */
function contains(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string') return actual.includes(typeof expected === 'string' ? expected : JSON.stringify(expected))
  if (Array.isArray(actual)) return actual.some((item) => deepEqual(item, expected) || (isRecord(expected) && isSubset(item, expected)))
  if (isRecord(actual)) return typeof expected === 'string' ? Object.hasOwn(actual, expected) : isSubset(actual, expected)
  return false
}

function isSubset(actual: unknown, expected: unknown): boolean {
  if (!isRecord(expected)) return deepEqual(actual, expected)
  return isRecord(actual) && Object.entries(expected).every(([k, v]) => Object.hasOwn(actual, k) && isSubset(actual[k], v))
}

function toNumber(value: unknown, loose: boolean): number | undefined {
  if (typeof value === 'number') return value
  if (loose && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function compare(operator: 'lessThan' | 'lessThanOrEqual' | 'greaterThan' | 'greaterThanOrEqual', a: number, b: number): [boolean, string] {
  switch (operator) {
    case 'lessThan':
      return [a < b, '<']
    case 'lessThanOrEqual':
      return [a <= b, '≤']
    case 'greaterThan':
      return [a > b, '>']
    case 'greaterThanOrEqual':
      return [a >= b, '≥']
  }
}

/** Aceita "padrão" ou "/padrão/flags". */
function toRegExp(text: string): RegExp {
  const literal = /^\/(.+)\/([dgimsuvy]*)$/s.exec(text)
  return literal ? new RegExp(literal[1]!, literal[2]!.replace(/[gy]/g, '')) : new RegExp(text)
}

/**
 * O valor encontrado com o tipo da resposta (500, não "500"). Texto longo é cortado;
 * objeto ou lista grande demais para mostrar inteiro vira o resumo em JSON (texto).
 */
function actualValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS)}…` : value
  if (value === null || typeof value !== 'object') return value
  return (JSON.stringify(value) ?? '').length > PREVIEW_CHARS ? preview(value) : value
}

export function preview(value: unknown): string {
  const text = value === undefined ? 'undefined' : typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value))
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
