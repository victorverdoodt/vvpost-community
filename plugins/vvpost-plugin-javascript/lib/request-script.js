// @ts-check
'use strict'

/**
 * API `vv` dos scripts por requisição (fase 13): o nó javascript.request-script roda o script
 * de uma requisição como um nó do fluxo. Na fase pre, `vv.request` é a requisição que vai
 * ser enviada (o script pode mudar tudo); na fase post, `vv.response` é a resposta. Os dois
 * definem variáveis e o post declara testes, que voltam como asserções.
 */

/** @typedef {{ name: string, passed: boolean, message: string }} TestResult */

/**
 * Igualdade profunda pela estrutura, sem olhar o protótipo: o objeto escrito no script nasce
 * no contexto do vm, e a resposta no do plugin (same diria que são diferentes).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function same(a, b) {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && same(/** @type {any} */ (a)[k], /** @type {any} */ (b)[k]))
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function show(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return String(value)
    return text.length > 120 ? `${text.slice(0, 120)}…` : text
  } catch {
    return String(value)
  }
}

/**
 * Asserções no estilo do chai (`expect(x).to.equal(y)`, o que os scripts do Postman usam) e do
 * Jest (`expect(x).toBe(y)`), sem dependência: um erro com a mensagem quando não passa.
 * @param {unknown} actual
 */
function expect(actual) {
  let negate = false
  let deep = false
  /**
   * @param {boolean} ok
   * @param {string} what
   */
  const check = (ok, what) => {
    if (ok === negate) throw new Error(`esperava ${show(actual)} ${negate ? 'não ' : ''}${what}`)
    return chain
  }
  const equal = (/** @type {unknown} */ expected) =>
    check(deep ? same(actual, expected) : actual === expected, `${deep ? 'igual (profundo) a' : 'igual a'} ${show(expected)}`)
  const eql = (/** @type {unknown} */ expected) => check(same(actual, expected), `igual (profundo) a ${show(expected)}`)
  const include = (/** @type {unknown} */ item) => {
    let ok = false
    if (typeof actual === 'string') ok = actual.includes(String(item))
    else if (Array.isArray(actual)) ok = actual.some((x) => same(x, item))
    else if (actual && typeof actual === 'object' && item && typeof item === 'object') {
      ok = Object.entries(item).every(([k, v]) => same(/** @type {any} */ (actual)[k], v))
    }
    return check(ok, `contendo ${show(item)}`)
  }
  const num = (/** @type {string} */ op, /** @type {number} */ n, /** @type {(a: number) => boolean} */ test) =>
    check(typeof actual === 'number' && test(actual), `${op} ${n}`)
  const type = (/** @type {string} */ name) => {
    const t = Array.isArray(actual) ? 'array' : actual === null ? 'null' : typeof actual
    return check(t === name.toLowerCase(), `do tipo ${name}`)
  }
  const length = (/** @type {number} */ n) => {
    const len = actual != null && typeof (/** @type {any} */ (actual).length) === 'number' ? /** @type {any} */ (actual).length : undefined
    return check(len === n, `com tamanho ${n}`)
  }
  const property = (/** @type {string} */ name, /** @type {unknown[]} */ ...value) => {
    const has = actual != null && typeof actual === 'object' && name in actual
    if (value.length === 0) return check(has, `com a propriedade ${name}`)
    return check(has && same(/** @type {any} */ (actual)[name], value[0]), `com ${name} = ${show(value[0])}`)
  }
  const status = (/** @type {number} */ code) => {
    const got = actual && typeof actual === 'object' ? /** @type {any} */ (actual).status ?? /** @type {any} */ (actual).code : undefined
    return check(got === code, `com status ${code}`)
  }
  /** @type {any} */
  const chain = {
    equal,
    equals: equal,
    eq: equal,
    eql,
    include,
    includes: include,
    contain: include,
    contains: include,
    above: (/** @type {number} */ n) => num('maior que', n, (a) => a > n),
    gt: (/** @type {number} */ n) => num('maior que', n, (a) => a > n),
    below: (/** @type {number} */ n) => num('menor que', n, (a) => a < n),
    lt: (/** @type {number} */ n) => num('menor que', n, (a) => a < n),
    least: (/** @type {number} */ n) => num('maior ou igual a', n, (a) => a >= n),
    gte: (/** @type {number} */ n) => num('maior ou igual a', n, (a) => a >= n),
    most: (/** @type {number} */ n) => num('menor ou igual a', n, (a) => a <= n),
    lte: (/** @type {number} */ n) => num('menor ou igual a', n, (a) => a <= n),
    within: (/** @type {number} */ a, /** @type {number} */ b) => check(typeof actual === 'number' && actual >= a && actual <= b, `entre ${a} e ${b}`),
    a: type,
    an: type,
    lengthOf: length,
    length,
    property,
    status,
    match: (/** @type {RegExp} */ re) => check(typeof actual === 'string' && re.test(actual), `casando com ${re}`),
    oneOf: (/** @type {unknown[]} */ list) => check(list.some((x) => same(x, actual)), `um de ${show(list)}`),
    // Jest
    toBe: equal,
    toEqual: eql,
    toStrictEqual: eql,
    toContain: include,
    toMatch: (/** @type {RegExp | string} */ re) => check(typeof actual === 'string' && (typeof re === 'string' ? actual.includes(re) : re.test(actual)), `casando com ${re}`),
    toHaveProperty: property,
    toHaveLength: length,
    toBeGreaterThan: (/** @type {number} */ n) => num('maior que', n, (a) => a > n),
    toBeLessThan: (/** @type {number} */ n) => num('menor que', n, (a) => a < n),
    toBeGreaterThanOrEqual: (/** @type {number} */ n) => num('maior ou igual a', n, (a) => a >= n),
    toBeLessThanOrEqual: (/** @type {number} */ n) => num('menor ou igual a', n, (a) => a <= n),
    toBeTruthy: () => check(!!actual, 'verdadeiro'),
    toBeFalsy: () => check(!actual, 'falso'),
    toBeNull: () => check(actual === null, 'null'),
    toBeUndefined: () => check(actual === undefined, 'undefined'),
    toBeDefined: () => check(actual !== undefined, 'definido')
  }
  // Palavras de ligação do chai: só deixam a frase legível.
  for (const word of ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'does', 'still']) {
    Object.defineProperty(chain, word, { get: () => chain })
  }
  Object.defineProperty(chain, 'not', {
    get: () => {
      negate = !negate
      return chain
    }
  })
  Object.defineProperty(chain, 'deep', {
    get: () => {
      deep = true
      return chain
    }
  })
  /** @type {[string, (v: unknown) => boolean, string][]} */
  const flags = [
    ['true', (v) => v === true, 'true'],
    ['false', (v) => v === false, 'false'],
    ['null', (v) => v === null, 'null'],
    ['undefined', (v) => v === undefined, 'undefined'],
    ['ok', (v) => !!v, 'verdadeiro'],
    ['exist', (v) => v !== null && v !== undefined, 'definido'],
    ['empty', (v) => (typeof v === 'string' || Array.isArray(v) ? v.length === 0 : !!v && typeof v === 'object' && Object.keys(v).length === 0), 'vazio']
  ]
  for (const [name, test, what] of flags) {
    Object.defineProperty(chain, name, { get: () => check(test(actual), what) })
  }
  Object.defineProperty(chain, 'json', { get: () => check(actual !== null && typeof actual === 'object', 'JSON') })
  return chain
}

/**
 * Valor de um header por nome, sem diferenciar maiúsculas.
 * @param {Record<string, unknown>} headers
 * @param {string} name
 */
function headerOf(headers, name) {
  const wanted = String(name).toLowerCase()
  const key = Object.keys(headers).find((k) => k.toLowerCase() === wanted)
  return key === undefined ? undefined : headers[key]
}

/**
 * Monta o `vv` do script e devolve o que o nó produz no fim.
 * @param {{ phase: 'pre' | 'post', request?: any, response?: any, environment?: Record<string, string>, variables?: Record<string, string> }} config
 */
function createApi(config) {
  /** @type {Record<string, string>} */
  const set = { ...(config.variables ?? {}) }
  const environment = config.environment ?? {}
  /** @type {Promise<TestResult>[]} */
  const tests = []
  const req = config.request ?? {}
  const request = {
    method: typeof req.method === 'string' ? req.method : 'GET',
    url: typeof req.url === 'string' ? req.url : '',
    headers: { ...(req.headers ?? {}) },
    query: { ...(req.query ?? {}) },
    body: req.body,
    /** @param {string} name */
    header: (name) => headerOf(request.headers, name),
    /**
     * Define um header (troca o de mesmo nome, sem diferenciar maiúsculas). Aceita também
     * `{ key, value }`, como o pm.request.headers.upsert do Postman.
     * @param {string | { key: string, value: unknown }} name
     * @param {unknown} [value]
     */
    setHeader: (name, value) => {
      const [key, val] = typeof name === 'object' && name ? [name.key, name.value] : [name, value]
      request.removeHeader(String(key))
      request.headers[String(key)] = val
    },
    /** @param {string | { key: string }} name */
    removeHeader: (name) => {
      const wanted = String(typeof name === 'object' && name ? name.key : name).toLowerCase()
      for (const k of Object.keys(request.headers)) if (k.toLowerCase() === wanted) delete request.headers[k]
    }
  }
  const variables = {
    /** @param {string} name */
    get: (name) => (Object.hasOwn(set, name) ? set[name] : environment[name]),
    /** @param {string} name */
    has: (name) => Object.hasOwn(set, name) || Object.hasOwn(environment, name),
    /**
     * @param {string} name
     * @param {unknown} value
     */
    set: (name, value) => {
      if (!/^[A-Za-z_][\w.-]*$/.test(String(name))) throw new Error(`nome de variável inválido: ${name}`)
      set[String(name)] = typeof value === 'string' ? value : JSON.stringify(value)
    },
    /** @param {string} name */
    unset: (name) => {
      delete set[name]
    },
    /** As variáveis definidas pelos scripts desta execução. */
    toObject: () => ({ ...environment, ...set })
  }
  const res = config.response
  const response =
    config.phase === 'post' && res
      ? {
          status: res.status,
          code: res.status,
          headers: { ...(res.headers ?? {}) },
          body: res.data,
          responseTime: res.durationMs,
          /** @param {string} name */
          header: (name) => headerOf(res.headers ?? {}, name),
          json: () => (typeof res.data === 'string' ? JSON.parse(res.data) : res.data),
          text: () => (typeof res.data === 'string' ? res.data : JSON.stringify(res.data))
        }
      : undefined
  const vv = Object.freeze({
    phase: config.phase,
    request: config.phase === 'pre' ? request : Object.freeze({ ...request }),
    response,
    variables,
    environment: variables,
    expect,
    /**
     * @param {string} name
     * @param {() => unknown} fn
     */
    test(name, fn) {
      tests.push(
        (async () => {
          try {
            await fn()
            return { name: String(name), passed: true, message: 'passou' }
          } catch (/** @type {any} */ err) {
            return { name: String(name), passed: false, message: err && err.message ? err.message : String(err) }
          }
        })()
      )
    }
  })
  return {
    vv,
    async result() {
      const out = { variables: set, tests: await Promise.all(tests) }
      if (config.phase !== 'pre') return out
      return {
        ...out,
        request: {
          method: String(request.method).toUpperCase(),
          url: String(request.url),
          headers: Object.fromEntries(Object.entries(request.headers).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])),
          query: Object.fromEntries(Object.entries(request.query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])),
          ...(request.body !== undefined && request.body !== null && { body: typeof request.body === 'string' ? request.body : JSON.stringify(request.body) })
        }
      }
    }
  }
}

module.exports = { createApi, expect }
