/**
 * JSONPath do lint (o `given` das regras), no dialeto que o Spectral usa: `$`, `.nome`, `['nome']`,
 * `[0]`, `[-1]`, `[0:2]`, `[a,b]`, `*`, `..` (descida recursiva) e filtros `[?(...)]` com `@`,
 * `@property`, comparações, `&&`, `||`, `!` e os métodos `match`, `test`, `includes`, `startsWith`
 * e `endsWith`. O filtro é interpretado aqui, nunca avaliado como JavaScript: um ruleset do time é
 * dado, não código.
 */

export type JsonPathSegment = string | number

export interface JsonPathMatch {
  value: unknown
  path: JsonPathSegment[]
}

type Selector =
  | { kind: 'name'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'slice'; start?: number; end?: number; step?: number }
  | { kind: 'union'; items: Selector[] }
  | { kind: 'filter'; expr: Expr }

interface Step {
  recursive: boolean
  selector: Selector
}

type Expr =
  | { kind: 'literal'; value: unknown }
  | { kind: 'regex'; value: RegExp }
  | { kind: 'ref'; base: '@' | '$' | '@property' | '@path' | '@parentProperty'; access: (string | number)[] }
  | { kind: 'call'; target: Expr; method: string; args: Expr[] }
  | { kind: 'not'; expr: Expr }
  | { kind: 'logic'; op: '&&' | '||'; left: Expr; right: Expr }
  | { kind: 'compare'; op: string; left: Expr; right: Expr }

export class JsonPathError extends Error {}

const compiled = new Map<string, Step[]>()

/** Compila (com cache) e devolve os passos; erro de sintaxe vira JsonPathError. */
export function parseJsonPath(path: string): Step[] {
  let steps = compiled.get(path)
  if (!steps) {
    steps = new PathParser(path).parse()
    if (compiled.size > 500) compiled.clear()
    compiled.set(path, steps)
  }
  return steps
}

/** Os nós de `root` que o caminho alcança, na ordem do documento, cada um com o caminho até ele. */
export function queryJsonPath(root: unknown, path: string): JsonPathMatch[] {
  let current: JsonPathMatch[] = [{ value: root, path: [] }]
  for (const step of parseJsonPath(path)) {
    const next: JsonPathMatch[] = []
    for (const node of current) {
      if (step.recursive) for (const d of descendants(node)) select(d, step.selector, root, next)
      else select(node, step.selector, root, next)
    }
    current = next
  }
  return current
}

/** O caminho como o Spectral escreve no relatório: $.a.b[0]['com espaço']. */
export function formatJsonPath(path: readonly JsonPathSegment[]): string {
  return (
    '$' +
    path
      .map((s) => (typeof s === 'number' ? `[${s}]` : /^[A-Za-z_$][\w$]*$/.test(s) ? `.${s}` : `[${JSON.stringify(s).replace(/^"|"$/g, "'")}]`))
      .join('')
  )
}

function descendants(node: JsonPathMatch): JsonPathMatch[] {
  const out: JsonPathMatch[] = [node]
  const walk = (n: JsonPathMatch) => {
    for (const child of children(n)) {
      out.push(child)
      walk(child)
    }
  }
  walk(node)
  return out
}

function children(node: JsonPathMatch): JsonPathMatch[] {
  const v = node.value
  if (Array.isArray(v)) return v.map((value, i) => ({ value, path: [...node.path, i] }))
  if (isObject(v)) return Object.keys(v).map((k) => ({ value: v[k], path: [...node.path, k] }))
  return []
}

function select(node: JsonPathMatch, selector: Selector, root: unknown, out: JsonPathMatch[]): void {
  const v = node.value
  switch (selector.kind) {
    case 'name':
      if (isObject(v) && Object.hasOwn(v, selector.name)) out.push({ value: v[selector.name], path: [...node.path, selector.name] })
      // `length` e índices escritos como nome também valem em arrays ($.a.0 não, mas $.a['0'] sim).
      else if (Array.isArray(v) && /^\d+$/.test(selector.name) && Number(selector.name) < v.length)
        out.push({ value: v[Number(selector.name)], path: [...node.path, Number(selector.name)] })
      return
    case 'index': {
      if (!Array.isArray(v)) return
      const i = selector.index < 0 ? v.length + selector.index : selector.index
      if (i >= 0 && i < v.length) out.push({ value: v[i], path: [...node.path, i] })
      return
    }
    case 'wildcard':
      out.push(...children(node))
      return
    case 'slice': {
      if (!Array.isArray(v)) return
      const step = selector.step ?? 1
      if (step <= 0) return
      const norm = (n: number | undefined, fallback: number) => (n === undefined ? fallback : n < 0 ? Math.max(0, v.length + n) : Math.min(n, v.length))
      for (let i = norm(selector.start, 0); i < norm(selector.end, v.length); i += step) out.push({ value: v[i], path: [...node.path, i] })
      return
    }
    case 'union':
      for (const item of selector.items) select(node, item, root, out)
      return
    case 'filter':
      for (const child of children(node)) {
        const ctx: FilterContext = { node: child, parent: node, root }
        if (truthy(evaluate(selector.expr, ctx))) out.push(child)
      }
  }
}

interface FilterContext {
  node: JsonPathMatch
  parent: JsonPathMatch
  root: unknown
}

const METHODS = new Set(['match', 'test', 'includes', 'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase', 'trim'])

function evaluate(expr: Expr, ctx: FilterContext): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value
    case 'regex':
      return expr.value
    case 'ref': {
      let value: unknown
      if (expr.base === '@') value = ctx.node.value
      else if (expr.base === '$') value = ctx.root
      else if (expr.base === '@property') value = ctx.node.path.at(-1)
      else if (expr.base === '@parentProperty') value = ctx.parent.path.at(-1)
      else value = formatJsonPath(ctx.node.path)
      for (const key of expr.access) value = access(value, key)
      return value
    }
    case 'call': {
      const target = evaluate(expr.target, ctx)
      const args = expr.args.map((a) => evaluate(a, ctx))
      if (expr.method === 'test') {
        // /re/.test(@property) ou @property.test? Só a primeira forma faz sentido.
        return target instanceof RegExp && typeof args[0] === 'string' ? new RegExp(target.source, target.flags.replace('g', '')).test(args[0]) : false
      }
      if (typeof target !== 'string' && !Array.isArray(target)) return undefined
      switch (expr.method) {
        case 'match': {
          if (typeof target !== 'string') return undefined
          const re = args[0] instanceof RegExp ? args[0] : typeof args[0] === 'string' ? safeRegExp(args[0]) : null
          return re ? target.match(new RegExp(re.source, re.flags.replace('g', ''))) : null
        }
        case 'includes':
          return (target as string | unknown[]).includes(args[0] as never)
        case 'startsWith':
          return typeof target === 'string' && typeof args[0] === 'string' && target.startsWith(args[0])
        case 'endsWith':
          return typeof target === 'string' && typeof args[0] === 'string' && target.endsWith(args[0])
        case 'toLowerCase':
          return typeof target === 'string' ? target.toLowerCase() : undefined
        case 'toUpperCase':
          return typeof target === 'string' ? target.toUpperCase() : undefined
        case 'trim':
          return typeof target === 'string' ? target.trim() : undefined
      }
      return undefined
    }
    case 'not':
      return !truthy(evaluate(expr.expr, ctx))
    case 'logic': {
      const left = truthy(evaluate(expr.left, ctx))
      if (expr.op === '&&') return left && truthy(evaluate(expr.right, ctx))
      return left || truthy(evaluate(expr.right, ctx))
    }
    case 'compare': {
      const a = evaluate(expr.left, ctx)
      const b = evaluate(expr.right, ctx)
      switch (expr.op) {
        case '===':
          return a === b
        case '!==':
          return a !== b
        case '==':
          return a === b || (a == null && b == null) || (typeof a !== 'object' && typeof b !== 'object' && a != null && b != null && String(a) === String(b))
        case '!=':
          return !(a === b || (a == null && b == null) || (typeof a !== 'object' && typeof b !== 'object' && a != null && b != null && String(a) === String(b)))
        case '<':
          return comparable(a, b) && (a as number) < (b as number)
        case '<=':
          return comparable(a, b) && (a as number) <= (b as number)
        case '>':
          return comparable(a, b) && (a as number) > (b as number)
        case '>=':
          return comparable(a, b) && (a as number) >= (b as number)
      }
      return false
    }
  }
}

function access(value: unknown, key: string | number): unknown {
  if (key === 'length' && (typeof value === 'string' || Array.isArray(value))) return value.length
  if (Array.isArray(value)) {
    const i = typeof key === 'number' ? key : /^-?\d+$/.test(key) ? Number(key) : NaN
    return Number.isNaN(i) ? undefined : value[i < 0 ? value.length + i : i]
  }
  if (isObject(value)) return Object.hasOwn(value, String(key)) ? value[String(key)] : undefined
  return undefined
}

const comparable = (a: unknown, b: unknown) => (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string')
const truthy = (v: unknown) => Boolean(v)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function safeRegExp(text: string): RegExp | null {
  try {
    return new RegExp(text)
  } catch {
    return null
  }
}

// --- Parser ---

class PathParser {
  private i = 0
  constructor(private readonly src: string) {}

  parse(): Step[] {
    const s = this.src.trim()
    if (!s.startsWith('$')) throw new JsonPathError(`JSONPath "${this.src}" deve começar com $`)
    this.i = this.src.indexOf('$') + 1
    const steps: Step[] = []
    while (this.i < this.src.length) {
      const c = this.src[this.i]!
      if (/\s/.test(c)) {
        this.i++
        continue
      }
      if (this.src.startsWith('..', this.i)) {
        this.i += 2
        if (this.src[this.i] === '[') steps.push({ recursive: true, selector: this.bracket() })
        else steps.push({ recursive: true, selector: this.dotName() })
      } else if (c === '.') {
        this.i++
        steps.push({ recursive: false, selector: this.dotName() })
      } else if (c === '[') {
        steps.push({ recursive: false, selector: this.bracket() })
      } else {
        throw this.error(`caractere inesperado "${c}"`)
      }
    }
    return steps
  }

  private error(message: string): JsonPathError {
    return new JsonPathError(`JSONPath "${this.src}": ${message} (posição ${this.i})`)
  }

  private dotName(): Selector {
    if (this.src[this.i] === '*') {
      this.i++
      return { kind: 'wildcard' }
    }
    const m = /^[^.[\]\s]+/.exec(this.src.slice(this.i))
    if (!m) throw this.error('nome esperado depois do ponto')
    this.i += m[0].length
    return { kind: 'name', name: m[0] }
  }

  private bracket(): Selector {
    this.i++ // [
    this.skipSpace()
    if (this.src[this.i] === '?') {
      this.i++
      this.skipSpace()
      let wrapped = false
      if (this.src[this.i] === '(') {
        wrapped = true
        this.i++
      }
      const expr = new ExprParser(this.src, this.i).parseUntil(wrapped ? ')' : ']')
      this.i = expr.end
      if (wrapped) this.expect(')')
      this.skipSpace()
      this.expect(']')
      return { kind: 'filter', expr: expr.expr }
    }
    const items: Selector[] = []
    for (;;) {
      this.skipSpace()
      items.push(this.bracketItem())
      this.skipSpace()
      if (this.src[this.i] === ',') {
        this.i++
        continue
      }
      this.expect(']')
      break
    }
    return items.length === 1 ? items[0]! : { kind: 'union', items }
  }

  private bracketItem(): Selector {
    const c = this.src[this.i]
    if (c === '*') {
      this.i++
      return { kind: 'wildcard' }
    }
    if (c === "'" || c === '"') return { kind: 'name', name: this.quoted() }
    const m = /^(-?\d*)\s*(?::\s*(-?\d*)\s*(?::\s*(-?\d*))?)?/.exec(this.src.slice(this.i))
    if (m && m[0].length && (m[1] !== '' || m[0].includes(':'))) {
      this.i += m[0].length
      if (!m[0].includes(':')) return { kind: 'index', index: Number(m[1]) }
      const num = (t: string | undefined) => (t === undefined || t === '' ? undefined : Number(t))
      return { kind: 'slice', ...defined({ start: num(m[1]), end: num(m[2]), step: num(m[3]) }) }
    }
    // Nome sem aspas, como o Spectral aceita em uniões: [get,put,post].
    const name = /^[^,\]\s]+/.exec(this.src.slice(this.i))
    if (!name) throw this.error('seletor vazio')
    this.i += name[0].length
    return { kind: 'name', name: name[0] }
  }

  private quoted(): string {
    const quote = this.src[this.i]!
    let out = ''
    this.i++
    while (this.i < this.src.length && this.src[this.i] !== quote) {
      if (this.src[this.i] === '\\') this.i++
      out += this.src[this.i] ?? ''
      this.i++
    }
    this.expect(quote)
    return out
  }

  private skipSpace(): void {
    while (/\s/.test(this.src[this.i] ?? '')) this.i++
  }

  private expect(c: string): void {
    if (this.src[this.i] !== c) throw this.error(`"${c}" esperado`)
    this.i++
  }
}

function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

type Token =
  | { t: 'num' | 'str'; v: string | number }
  | { t: 'regex'; v: RegExp }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }

class ExprParser {
  private tokens: Token[] = []
  private p = 0
  end = 0

  constructor(
    private readonly src: string,
    private readonly start: number
  ) {}

  /** Lê a expressão até o `)` ou `]` que fecha o filtro, respeitando parênteses e aspas. */
  parseUntil(close: ')' | ']'): { expr: Expr; end: number } {
    this.tokenize(close)
    const expr = this.or()
    if (this.p < this.tokens.length) throw new JsonPathError(`JSONPath "${this.src}": filtro com sobra perto de "${this.describe(this.tokens[this.p]!)}"`)
    return { expr, end: this.end }
  }

  private describe(t: Token): string {
    return t.t === 'regex' ? String(t.v) : String(t.v)
  }

  private tokenize(close: ')' | ']'): void {
    let i = this.start
    let depth = 0
    const s = this.src
    const prevIsValue = () => {
      const last = this.tokens.at(-1)
      return last !== undefined && (last.t === 'num' || last.t === 'str' || last.t === 'id' || last.t === 'regex' || (last.t === 'op' && (last.v === ')' || last.v === ']')))
    }
    while (i < s.length) {
      const c = s[i]!
      if (/\s/.test(c)) {
        i++
        continue
      }
      if (c === close && depth === 0) break
      if (c === '(' || c === '[') {
        depth++
        this.tokens.push({ t: 'op', v: c })
        i++
        continue
      }
      if (c === ')' || c === ']') {
        depth--
        this.tokens.push({ t: 'op', v: c })
        i++
        continue
      }
      if (c === "'" || c === '"') {
        let out = ''
        i++
        while (i < s.length && s[i] !== c) {
          if (s[i] === '\\') i++
          out += s[i] ?? ''
          i++
        }
        if (s[i] !== c) throw new JsonPathError(`JSONPath "${s}": texto sem fechar no filtro`)
        i++
        this.tokens.push({ t: 'str', v: out })
        continue
      }
      if (c === '/' && !prevIsValue()) {
        let j = i + 1
        let body = ''
        let inClass = false
        while (j < s.length && (s[j] !== '/' || inClass)) {
          if (s[j] === '\\') {
            body += s[j]! + (s[j + 1] ?? '')
            j += 2
            continue
          }
          if (s[j] === '[') inClass = true
          else if (s[j] === ']') inClass = false
          body += s[j]
          j++
        }
        if (s[j] !== '/') throw new JsonPathError(`JSONPath "${s}": expressão regular sem fechar no filtro`)
        j++
        const flags = /^[gimsuy]*/.exec(s.slice(j))![0]
        j += flags.length
        try {
          this.tokens.push({ t: 'regex', v: new RegExp(body, flags) })
        } catch (err) {
          throw new JsonPathError(`JSONPath "${s}": ${(err as Error).message}`)
        }
        i = j
        continue
      }
      const num = /^-?\d+(\.\d+)?/.exec(s.slice(i))
      if (num && !prevIsValue()) {
        this.tokens.push({ t: 'num', v: Number(num[0]) })
        i += num[0].length
        continue
      }
      const op = /^(===|!==|==|!=|<=|>=|&&|\|\||[<>!.,])/.exec(s.slice(i))
      if (op) {
        this.tokens.push({ t: 'op', v: op[0] })
        i += op[0].length
        continue
      }
      const id = /^[@$]?[A-Za-z_][\w-]*|^[@$]/.exec(s.slice(i))
      if (id) {
        this.tokens.push({ t: 'id', v: id[0] })
        i += id[0].length
        continue
      }
      throw new JsonPathError(`JSONPath "${s}": caractere inesperado "${c}" no filtro`)
    }
    if (i >= s.length) throw new JsonPathError(`JSONPath "${s}": filtro sem fechar`)
    this.end = i
  }

  private peek(v?: string): Token | undefined {
    const t = this.tokens[this.p]
    if (v === undefined) return t
    return t && t.t === 'op' && t.v === v ? t : undefined
  }

  private take(v: string): void {
    if (!this.peek(v)) throw new JsonPathError(`JSONPath "${this.src}": "${v}" esperado no filtro`)
    this.p++
  }

  private or(): Expr {
    let left = this.and()
    while (this.peek('||')) {
      this.p++
      left = { kind: 'logic', op: '||', left, right: this.and() }
    }
    return left
  }

  private and(): Expr {
    let left = this.unary()
    while (this.peek('&&')) {
      this.p++
      left = { kind: 'logic', op: '&&', left, right: this.unary() }
    }
    return left
  }

  private unary(): Expr {
    if (this.peek('!')) {
      this.p++
      return { kind: 'not', expr: this.unary() }
    }
    return this.compare()
  }

  private compare(): Expr {
    const left = this.postfix()
    const t = this.peek()
    if (t && t.t === 'op' && ['===', '!==', '==', '!=', '<', '<=', '>', '>='].includes(t.v as string)) {
      this.p++
      return { kind: 'compare', op: t.v as string, left, right: this.postfix() }
    }
    return left
  }

  private postfix(): Expr {
    let expr = this.primary()
    for (;;) {
      if (this.peek('.')) {
        this.p++
        const name = this.tokens[this.p]
        if (!name || name.t !== 'id') throw new JsonPathError(`JSONPath "${this.src}": nome esperado depois do ponto no filtro`)
        this.p++
        if (this.peek('(')) {
          if (!METHODS.has(name.v as string)) throw new JsonPathError(`JSONPath "${this.src}": método ${name.v}() não suportado no filtro`)
          this.p++
          const args: Expr[] = []
          while (!this.peek(')')) {
            args.push(this.or())
            if (this.peek(',')) this.p++
            else break
          }
          this.take(')')
          expr = { kind: 'call', target: expr, method: name.v as string, args }
        } else if (expr.kind === 'ref') {
          expr = { ...expr, access: [...expr.access, name.v as string] }
        } else {
          throw new JsonPathError(`JSONPath "${this.src}": acesso .${name.v} fora de @ no filtro`)
        }
        continue
      }
      if (this.peek('[') && expr.kind === 'ref') {
        this.p++
        const key = this.tokens[this.p]
        if (!key || (key.t !== 'str' && key.t !== 'num')) throw new JsonPathError(`JSONPath "${this.src}": índice esperado no filtro`)
        this.p++
        this.take(']')
        expr = { ...expr, access: [...expr.access, key.v as string | number] }
        continue
      }
      return expr
    }
  }

  private primary(): Expr {
    const t = this.tokens[this.p]
    if (!t) throw new JsonPathError(`JSONPath "${this.src}": filtro incompleto`)
    this.p++
    if (t.t === 'num' || t.t === 'str') return { kind: 'literal', value: t.v }
    if (t.t === 'regex') return { kind: 'regex', value: t.v }
    if (t.t === 'op' && t.v === '(') {
      const inner = this.or()
      this.take(')')
      return inner
    }
    if (t.t === 'id') {
      switch (t.v) {
        case 'true':
          return { kind: 'literal', value: true }
        case 'false':
          return { kind: 'literal', value: false }
        case 'null':
          return { kind: 'literal', value: null }
        case 'undefined':
          return { kind: 'literal', value: undefined }
        case '@':
        case '$':
        case '@property':
        case '@path':
        case '@parentProperty':
          return { kind: 'ref', base: t.v, access: [] }
      }
    }
    throw new JsonPathError(`JSONPath "${this.src}": "${this.describe(t)}" inesperado no filtro`)
  }
}
