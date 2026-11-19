// JSONPath do filtro da resposta (como o filtro do Postman): $, .chave, ['chave'], [n], [-n], [*],
// .*, .., [a:b], [0,2], ['a','b'] e filtros [?(@.campo op valor)] com ==, !=, <, <=, >, >=, =~ e &&, ||.

export type JsonPathKey = string | number

export interface JsonPathMatch {
  path: JsonPathKey[]
  value: unknown
}

type Selector =
  | { kind: 'name'; names: string[] }
  | { kind: 'index'; indexes: number[] }
  | { kind: 'wildcard' }
  | { kind: 'slice'; start?: number; end?: number; step?: number }
  | { kind: 'filter'; test: (v: unknown, root: unknown) => boolean }

interface Step {
  descendant: boolean
  selector: Selector
}

export class JsonPathError extends Error {}

/** Avalia `expr` sobre `root`; erro de sintaxe vira JsonPathError. */
export function evaluateJsonPath(root: unknown, expr: string): JsonPathMatch[] {
  const steps = parse(expr.trim())
  let current: JsonPathMatch[] = [{ path: [], value: root }]
  for (const step of steps) {
    const next: JsonPathMatch[] = []
    for (const m of current) {
      if (step.descendant) for (const d of descendants(m)) apply(step.selector, d, root, next)
      else apply(step.selector, m, root, next)
    }
    current = next
  }
  return current
}

/** Path em notação JSONPath: $.data[0].name, $['com espaço']. */
export function toJsonPath(path: JsonPathKey[]): string {
  return (
    '$' +
    path
      .map((k) =>
        typeof k === 'number' ? `[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `['${k.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`
      )
      .join('')
  )
}

/** O próprio nó e todos abaixo dele, na ordem do documento. */
function descendants(m: JsonPathMatch, out: JsonPathMatch[] = []): JsonPathMatch[] {
  out.push(m)
  for (const child of children(m)) descendants(child, out)
  return out
}

function children(m: JsonPathMatch): JsonPathMatch[] {
  const v = m.value
  if (Array.isArray(v)) return v.map((value, i) => ({ path: [...m.path, i], value }))
  if (v && typeof v === 'object') return Object.entries(v).map(([k, value]) => ({ path: [...m.path, k], value }))
  return []
}

function apply(sel: Selector, m: JsonPathMatch, root: unknown, out: JsonPathMatch[]): void {
  const v = m.value
  switch (sel.kind) {
    case 'wildcard':
      out.push(...children(m))
      return
    case 'name':
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const name of sel.names) {
          if (Object.hasOwn(v, name)) out.push({ path: [...m.path, name], value: (v as Record<string, unknown>)[name] })
        }
      }
      return
    case 'index':
      if (Array.isArray(v)) {
        for (const raw of sel.indexes) {
          const i = raw < 0 ? v.length + raw : raw
          if (i >= 0 && i < v.length) out.push({ path: [...m.path, i], value: v[i] })
        }
      }
      return
    case 'slice': {
      if (!Array.isArray(v)) return
      const step = sel.step ?? 1
      if (step <= 0) return
      const norm = (n: number) => (n < 0 ? Math.max(0, v.length + n) : Math.min(n, v.length))
      for (let i = norm(sel.start ?? 0); i < norm(sel.end ?? v.length); i += step) out.push({ path: [...m.path, i], value: v[i] })
      return
    }
    case 'filter':
      for (const c of children(m)) if (sel.test(c.value, root)) out.push(c)
  }
}

function parse(expr: string): Step[] {
  if (!expr.startsWith('$')) throw new JsonPathError('O caminho começa com $')
  const steps: Step[] = []
  let i = 1
  while (i < expr.length) {
    const c = expr[i]!
    if (c === '.') {
      const descendant = expr[i + 1] === '.'
      i += descendant ? 2 : 1
      if (expr[i] === '[') {
        if (!descendant) throw new JsonPathError(`"[" inesperado na posição ${i + 1}`)
        const [sel, end] = bracket(expr, i)
        steps.push({ descendant, selector: sel })
        i = end
      } else if (expr[i] === '*') {
        steps.push({ descendant, selector: { kind: 'wildcard' } })
        i++
      } else {
        const name = /^[^.[\]\s]+/.exec(expr.slice(i))?.[0]
        if (!name) throw new JsonPathError(`Nome esperado na posição ${i + 1}`)
        steps.push({ descendant, selector: { kind: 'name', names: [name] } })
        i += name.length
      }
    } else if (c === '[') {
      const [sel, end] = bracket(expr, i)
      steps.push({ descendant: false, selector: sel })
      i = end
    } else if (/\s/.test(c)) {
      i++
    } else {
      throw new JsonPathError(`"${c}" inesperado na posição ${i + 1}`)
    }
  }
  return steps
}

/** Lê `[...]` a partir de `start`; devolve o seletor e a posição depois do `]`. */
function bracket(expr: string, start: number): [Selector, number] {
  let depth = 0
  let quote: string | null = null
  let end = -1
  for (let i = start; i < expr.length; i++) {
    const c = expr[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
    } else if (c === "'" || c === '"') quote = c
    else if (c === '[') depth++
    else if (c === ']' && --depth === 0) {
      end = i
      break
    }
  }
  if (end === -1) throw new JsonPathError('Falta fechar "]"')
  const inner = expr.slice(start + 1, end).trim()
  return [selector(inner), end + 1]
}

function selector(inner: string): Selector {
  if (inner === '*') return { kind: 'wildcard' }
  if (inner.startsWith('?')) {
    const body = inner.slice(1).trim()
    const cond = body.startsWith('(') && body.endsWith(')') ? body.slice(1, -1) : body
    return { kind: 'filter', test: compileFilter(cond) }
  }
  const slice = /^(-?\d+)?\s*:\s*(-?\d+)?(?:\s*:\s*(-?\d+))?$/.exec(inner)
  if (slice) {
    return {
      kind: 'slice',
      ...(slice[1] !== undefined && { start: Number(slice[1]) }),
      ...(slice[2] !== undefined && { end: Number(slice[2]) }),
      ...(slice[3] !== undefined && { step: Number(slice[3]) })
    }
  }
  const parts = splitTop(inner, ',').map((p) => p.trim())
  if (parts.every((p) => /^-?\d+$/.test(p))) return { kind: 'index', indexes: parts.map(Number) }
  if (parts.every((p) => /^(['"]).*\1$/s.test(p))) return { kind: 'name', names: parts.map(unquote) }
  throw new JsonPathError(`Seletor inválido: [${inner}]`)
}

function unquote(s: string): string {
  return s.slice(1, -1).replace(/\\(.)/g, '$1')
}

function splitTop(s: string, sep: string): string[] {
  const out: string[] = []
  let quote: string | null = null
  let depth = 0
  let last = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
    } else if (c === "'" || c === '"') quote = c
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (depth === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(last, i))
      last = i + sep.length
      i += sep.length - 1
    }
  }
  out.push(s.slice(last))
  return out
}

/** Filtro [?(...)]: comparações sobre @ (o item) e $ (a raiz), com && e ||. Sem eval. */
function compileFilter(cond: string): (v: unknown, root: unknown) => boolean {
  const ors = splitTop(cond, '||')
  if (ors.length > 1) {
    const fs = ors.map(compileFilter)
    return (v, r) => fs.some((f) => f(v, r))
  }
  const ands = splitTop(cond, '&&')
  if (ands.length > 1) {
    const fs = ands.map(compileFilter)
    return (v, r) => fs.every((f) => f(v, r))
  }
  let c = cond.trim()
  if (c.startsWith('(') && c.endsWith(')')) return compileFilter(c.slice(1, -1))
  const negate = c.startsWith('!')
  if (negate) c = c.slice(1).trim()
  const cmp = /^(.+?)\s*(==|!=|<=|>=|=~|<|>)\s*(.+)$/s.exec(c)
  if (!cmp) {
    const operand = compileOperand(c)
    return (v, r) => {
      const x = operand(v, r)
      const ok = x !== undefined && x !== null && x !== false
      return negate ? !ok : ok
    }
  }
  const left = compileOperand(cmp[1]!)
  const op = cmp[2]!
  if (op === '=~') {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(cmp[3]!.trim())
    if (!m) throw new JsonPathError('Use =~ /regex/')
    const re = new RegExp(m[1]!, m[2])
    return (v, r) => {
      const x = left(v, r)
      return typeof x === 'string' && re.test(x)
    }
  }
  const right = compileOperand(cmp[3]!)
  return (v, r) => {
    const a = left(v, r)
    const b = right(v, r)
    switch (op) {
      case '==':
        return a === b
      case '!=':
        return a !== b
      case '<':
        return typeof a === typeof b && (a as number) < (b as number)
      case '<=':
        return typeof a === typeof b && (a as number) <= (b as number)
      case '>':
        return typeof a === typeof b && (a as number) > (b as number)
      default:
        return typeof a === typeof b && (a as number) >= (b as number)
    }
  }
}

function compileOperand(src: string): (v: unknown, root: unknown) => unknown {
  const s = src.trim()
  if (s.startsWith('@') || s.startsWith('$')) {
    const expr = '$' + s.slice(1)
    const lengthOf = /\.length$/.exec(expr)
    const base = lengthOf ? expr.slice(0, -'.length'.length) : expr
    parse(base)
    return (v, root) => {
      const found = evaluateJsonPath(s.startsWith('@') ? v : root, base)[0]?.value
      if (lengthOf) {
        if (Array.isArray(found) || typeof found === 'string') return found.length
        return found && typeof found === 'object' ? (found as Record<string, unknown>)['length'] : undefined
      }
      return found
    }
  }
  if (/^(['"]).*\1$/s.test(s)) {
    const value = unquote(s)
    return () => value
  }
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
    const n = Number(s)
    return () => n
  }
  if (s === 'true' || s === 'false' || s === 'null') {
    const value = JSON.parse(s) as unknown
    return () => value
  }
  throw new JsonPathError(`Operando inválido: ${s}`)
}
