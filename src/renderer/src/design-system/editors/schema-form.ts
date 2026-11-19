/**
 * Lógica do formulário gerado de um JSON Schema (o bodySchema do endpoint, como o import do
 * OpenAPI grava): resolve $ref e allOf, diz que controle cada campo usa e edita o valor por
 * caminho, sem mexer no que o schema não descreve. O componente fica em SchemaForm.tsx.
 */

export type Schema = Record<string, unknown>
export type FormPath = (string | number)[]

/** Que controle o campo usa no formulário. */
export type FieldKind = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'null' | 'any'

/** Até onde o formulário desce; mais fundo que isso, o campo pede o JSON. */
export const MAX_FORM_DEPTH = 8

const isSchema = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v)
const isRecord = isSchema

/** {{VAR}} ou {{ $nodes.X }} inteiro: aceito em qualquer campo, como na validação do corpo. */
export const WHOLE_TEMPLATE = /^\{\{[^{}]+\}\}$/

/** O schema em `ref` (#/$defs/Nome, #/definitions/Nome...) dentro de `root`. */
function pointer(root: Schema, ref: string): unknown {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return undefined
  let target: unknown = root
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    target = isSchema(target) ? target[key] : undefined
  }
  return target
}

/**
 * O schema de um campo pronto para o formulário: segue $ref (até 16 saltos, para não girar em
 * referência circular) e junta os ramos de allOf (propriedades, obrigatórios e o resto).
 */
export function resolveSchema(root: Schema, raw: unknown, hops = 0): Schema {
  if (raw === true || raw === undefined) return {}
  if (!isSchema(raw)) return {}
  let s = raw
  if (typeof s['$ref'] === 'string' && hops < 16) {
    const { $ref, ...rest } = s
    const target = resolveSchema(root, pointer(root, $ref as string), hops + 1)
    // Palavras ao lado do $ref (description, default) valem sobre as do alvo.
    s = { ...target, ...rest }
  }
  if (Array.isArray(s['allOf']) && hops < 16) {
    const { allOf, ...rest } = s
    let merged: Schema = {}
    for (const part of allOf as unknown[]) merged = mergeSchemas(merged, resolveSchema(root, part, hops + 1))
    s = mergeSchemas(merged, rest)
  }
  return s
}

function mergeSchemas(a: Schema, b: Schema): Schema {
  const out: Schema = { ...a, ...b }
  if (isSchema(a['properties']) || isSchema(b['properties']))
    out['properties'] = { ...(a['properties'] as Schema | undefined), ...(b['properties'] as Schema | undefined) }
  const required = [
    ...(Array.isArray(a['required']) ? a['required'] : []),
    ...(Array.isArray(b['required']) ? b['required'] : [])
  ]
  if (required.length) out['required'] = [...new Set(required)]
  return out
}

/** Os tipos declarados, sem o "null" (que vira a opção de enviar null). */
function types(s: Schema): string[] {
  const t = s['type']
  const list = Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : typeof t === 'string' ? [t] : []
  return list.filter((x) => x !== 'null')
}

/** O schema aceita null (type com "null", ou enum com null). */
export function isNullable(s: Schema): boolean {
  const t = s['type']
  return (Array.isArray(t) && t.includes('null')) || (Array.isArray(s['enum']) && s['enum'].includes(null))
}

/** Valores aceitos de um enum ou const, sem o null. */
export function enumValues(s: Schema): unknown[] | undefined {
  if (Array.isArray(s['enum'])) return s['enum'].filter((v) => v !== null)
  if ('const' in s) return [s['const']]
  return undefined
}

/** Que controle o campo usa. */
export function fieldKind(s: Schema): FieldKind {
  if (enumValues(s)) return 'enum'
  const [t] = types(s)
  switch (t) {
    case 'object':
    case 'array':
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
      return t
  }
  if (s['type'] === 'null') return 'null'
  if (isSchema(s['properties'])) return 'object'
  if (s['items'] !== undefined) return 'array'
  return 'any'
}

/** Os ramos de oneOf/anyOf já resolvidos, ou undefined sem ramos. */
export function variantsOf(root: Schema, s: Schema): Schema[] | undefined {
  const list = Array.isArray(s['oneOf']) ? s['oneOf'] : Array.isArray(s['anyOf']) ? s['anyOf'] : undefined
  if (!list?.length) return undefined
  // Palavras de fora do oneOf (description, type comum) valem para cada ramo.
  const { oneOf: _o, anyOf: _a, ...shared } = s
  return list.map((v) => mergeSchemas(shared, resolveSchema(root, v)))
}

/** Nome de um ramo de oneOf/anyOf para o seletor. */
export function variantLabel(raw: unknown, s: Schema, i: number): string {
  if (typeof s['title'] === 'string') return s['title']
  if (isSchema(raw) && typeof raw['$ref'] === 'string') return raw['$ref'].split('/').pop()!.replace(/~1/g, '/').replace(/~0/g, '~')
  const t = types(s)
  return t.length ? `${t.join(' | ')}${i ? ` (${i + 1})` : ''}` : `Opção ${i + 1}`
}

/** O ramo que melhor descreve `value`: o que tem o tipo dele e mais propriedades em comum. */
export function pickVariant(variants: Schema[], value: unknown): number {
  if (value === undefined) return 0
  let best = 0
  let bestScore = -1
  variants.forEach((v, i) => {
    let score = matchesType(v, value) ? 1 : 0
    const values = enumValues(v)
    if (values?.some((x) => JSON.stringify(x) === JSON.stringify(value))) score += 10
    if (isRecord(value) && isSchema(v['properties'])) {
      const props = Object.keys(v['properties'])
      score += Object.keys(value).filter((k) => props.includes(k)).length
      const required = Array.isArray(v['required']) ? (v['required'] as string[]) : []
      if (required.some((k) => !(k in value))) score -= 5
    }
    if (score > bestScore) {
      best = i
      bestScore = score
    }
  })
  return best
}

function matchesType(s: Schema, value: unknown): boolean {
  switch (fieldKind(s)) {
    case 'object':
      return isRecord(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'integer':
      return Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    case 'enum':
      return enumValues(s)!.some((x) => JSON.stringify(x) === JSON.stringify(value))
    default:
      return true
  }
}

/**
 * Valor inicial de um campo novo (item de array, objeto opcional que a pessoa liga):
 * default, const, exemplo, o primeiro do enum, e num objeto os obrigatórios preenchidos.
 */
export function initialValue(root: Schema, raw: unknown, depth = 0): unknown {
  const s = resolveSchema(root, raw)
  if ('default' in s) return s['default']
  if ('const' in s) return s['const']
  if (Array.isArray(s['examples']) && s['examples'].length) return s['examples'][0]
  const variants = variantsOf(root, s)
  if (variants) return initialValue(root, variants[0], depth + 1)
  switch (fieldKind(s)) {
    case 'enum':
      return enumValues(s)![0]
    case 'object': {
      const out: Record<string, unknown> = {}
      if (depth >= MAX_FORM_DEPTH) return out
      const props = isSchema(s['properties']) ? s['properties'] : {}
      for (const name of Array.isArray(s['required']) ? (s['required'] as string[]) : [])
        if (name in props) out[name] = initialValue(root, props[name], depth + 1)
      return out
    }
    case 'array':
      return []
    case 'string':
      return ''
    case 'number':
    case 'integer':
      return 0
    case 'boolean':
      return false
    case 'null':
      return null
    default:
      return ''
  }
}

/** O valor em `path`, ou undefined. */
export function getIn(value: unknown, path: FormPath): unknown {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string | number, unknown>)[key]
  }
  return current
}

/**
 * `value` com `next` em `path` (undefined tira a chave, ou o item do array). Cria os objetos e
 * arrays que faltam no caminho e copia só o que muda: o resto, inclusive campos fora do schema,
 * continua igual.
 */
export function setIn(value: unknown, path: FormPath, next: unknown): unknown {
  if (path.length === 0) return next
  const [key, ...rest] = path
  if (typeof key === 'number') {
    const list = Array.isArray(value) ? [...value] : []
    if (rest.length === 0 && next === undefined) {
      list.splice(key, 1)
      return list
    }
    list[key] = setIn(list[key], rest, next)
    return list
  }
  const obj: Record<string, unknown> = isRecord(value) ? { ...value } : {}
  if (rest.length === 0 && next === undefined) {
    delete obj[key!]
    return obj
  }
  obj[key!] = setIn(obj[key!], rest, next)
  return obj
}

/**
 * O que a pessoa digitou num campo numérico: número quando é número; {{VAR}} ou texto que ainda
 * não é número ficam como texto (o JSON mostra, e a validação do corpo aponta se não servir).
 * Vazio: undefined (num campo opcional, a chave sai do corpo).
 */
export function parseNumberInput(text: string, integer: boolean): number | string | undefined {
  const t = text.trim()
  if (!t) return undefined
  if (WHOLE_TEMPLATE.test(t)) return t
  const n = Number(t.replace(',', '.'))
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) return text
  return n
}

/** Texto que o seletor de enum usa para cada valor (o JSON dele). */
export const enumKey = (v: unknown): string => JSON.stringify(v)

/** O corpo como valor para o formulário: vazio vira undefined; JSON inválido, um erro. */
export function parseFormBody(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  if (!text.trim()) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/** Chaves de um objeto que o schema não descreve (o formulário não mostra; o JSON sim). */
export function extraKeys(s: Schema, value: unknown): string[] {
  if (!isRecord(value)) return []
  const props = isSchema(s['properties']) ? s['properties'] : {}
  return Object.keys(value).filter((k) => !(k in props))
}

/** Rótulo do tipo do campo para a interface: "string · date-time", "integer ≥ 1", "string[]". */
export function typeLabel(root: Schema, s: Schema): string {
  const kind = fieldKind(s)
  if (kind === 'enum') return 'enum'
  if (kind === 'array') {
    const item = resolveSchema(root, s['items'])
    const inner = fieldKind(item)
    return inner === 'any' || inner === 'object' ? 'array' : `${inner === 'enum' ? 'enum' : inner}[]`
  }
  const parts: string[] = [kind === 'any' ? 'qualquer' : kind]
  if (typeof s['format'] === 'string') parts.push(s['format'])
  const range = [
    typeof s['minimum'] === 'number' && `≥ ${s['minimum']}`,
    typeof s['exclusiveMinimum'] === 'number' && `> ${s['exclusiveMinimum']}`,
    typeof s['maximum'] === 'number' && `≤ ${s['maximum']}`,
    typeof s['exclusiveMaximum'] === 'number' && `< ${s['exclusiveMaximum']}`,
    typeof s['minLength'] === 'number' && s['minLength'] > 0 && `mín. ${s['minLength']}`,
    typeof s['maxLength'] === 'number' && `máx. ${s['maxLength']}`
  ].filter(Boolean)
  return [parts.join(' · '), ...range].join(' ')
}

/** O schema é um objeto com propriedades (ou array delas): dá para montar um formulário útil. */
export function hasFormFields(root: Schema | undefined): boolean {
  if (!root) return false
  const s = resolveSchema(root, root)
  const variants = variantsOf(root, s)
  if (variants) return variants.some((v) => hasFormFields({ ...root, ...v }))
  const kind = fieldKind(s)
  if (kind === 'object') return isSchema(s['properties']) && Object.keys(s['properties']).length > 0
  if (kind === 'array') return fieldKind(resolveSchema(root, s['items'])) !== 'any'
  return kind !== 'any'
}
