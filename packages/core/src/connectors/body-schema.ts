/**
 * Edição do bodySchema de um endpoint sem escrever JSON Schema à mão: um campo por caminho
 * (`cliente.nome`, `itens[].sku`) com tipo, obrigatório, descrição, enum e formato, e um schema
 * inicial gerado de um corpo de exemplo. É o que o editor visual do app, as operações
 * setBodyField/setBodySchema (MCP) e `vvpost schema` (CLI) usam, para os três gravarem o mesmo.
 */

export type BodySchema = Record<string, unknown>

export const BODY_FIELD_TYPES = ['string', 'integer', 'number', 'boolean', 'object', 'array'] as const
export type BodyFieldType = (typeof BODY_FIELD_TYPES)[number]

/** Um campo do corpo, no formato curto que o MCP e o CLI recebem. */
export interface BodyFieldSpec {
  type: BodyFieldType
  required?: boolean
  description?: string
  /** Valores aceitos (string, integer ou number). */
  enum?: (string | number)[]
  /** Formato de string: date, date-time, email, uuid, uri... */
  format?: string
  /** Tipo dos itens, quando type é array (padrão: string). */
  items?: BodyFieldType
  default?: unknown
  example?: unknown
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
}

export class BodySchemaError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Os segmentos de um caminho: `itens[].sku` → [itens, [], sku] (o [] desce para os itens da lista). */
export function parseFieldPath(path: string): string[] {
  const parts: string[] = []
  for (const raw of path.split('.')) {
    const m = /^([^[\]]*)((?:\[\])*)$/.exec(raw)
    if (!m || (!m[1] && !m[2])) throw new BodySchemaError(`caminho de campo inválido: "${path}" (use a.b ou lista[].campo)`)
    if (m[1]) parts.push(m[1])
    for (let i = 0; i < m[2]!.length / 2; i++) parts.push('[]')
  }
  if (!parts.length || (parts[0] === '[]' && parts.length === 1)) throw new BodySchemaError(`caminho de campo inválido: "${path}"`)
  return parts
}

/** O schema de um campo a partir do formato curto. */
export function fieldSchema(spec: BodyFieldSpec): BodySchema {
  if (!BODY_FIELD_TYPES.includes(spec.type)) throw new BodySchemaError(`tipo "${String(spec.type)}" inválido; use ${BODY_FIELD_TYPES.join(', ')}`)
  const out: BodySchema = { type: spec.type }
  if (spec.description) out['description'] = spec.description
  if (spec.type === 'array') out['items'] = { type: spec.items ?? 'string' }
  if (spec.type === 'object') out['properties'] = {}
  if (spec.enum?.length) {
    if (!['string', 'integer', 'number'].includes(spec.type)) throw new BodySchemaError(`enum só vale para string, integer e number`)
    out['enum'] = spec.enum.map((v) => coerce(v, spec.type))
  }
  if (spec.format) out['format'] = spec.format
  for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern'] as const) if (spec[k] !== undefined) out[k] = spec[k]
  if (spec.default !== undefined) out['default'] = spec.default
  if (spec.example !== undefined) out['examples'] = [spec.example]
  return out
}

/** Valor de enum com o tipo do campo: "2" num integer vira 2. */
function coerce(v: string | number, type: BodyFieldType): string | number {
  if (type === 'string') return String(v)
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  if (!Number.isFinite(n) || (type === 'integer' && !Number.isInteger(n))) throw new BodySchemaError(`"${v}" não é ${type}`)
  return n
}

/**
 * `schema` com o campo em `path` criado ou trocado (spec) ou removido (null). Os objetos do caminho
 * são criados quando faltam; `required` do pai acompanha. O resto do schema (inclusive $defs, $ref e
 * oneOf de outros campos) não muda. Devolve undefined quando o schema fica sem nenhum campo.
 */
export function setBodyField(schema: BodySchema | undefined, path: string, spec: BodyFieldSpec | null): BodySchema | undefined {
  const parts = parseFieldPath(path)
  const root: BodySchema = structuredClone(schema ?? { type: 'object', properties: {} })
  let parent = root
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!
    let next: unknown
    if (part === '[]') {
      if (parent['type'] !== 'array' && parent['items'] === undefined) throw new BodySchemaError(`${parts.slice(0, i).join('.') || 'o corpo'} não é uma lista`)
      if (!isRecord(parent['items'])) parent['items'] = {}
      next = parent['items']
      if (spec && !isRecord((next as BodySchema)['properties'])) {
        const items = next as BodySchema
        if (items['type'] !== undefined && items['type'] !== 'object') throw new BodySchemaError(`os itens de ${joinPath(parts.slice(0, i))} são ${String(items['type'])}, não objetos`)
        items['type'] = 'object'
        items['properties'] = {}
      }
    } else {
      const props = propsOf(parent, parts.slice(0, i), !!spec)
      if (!props) return schema
      next = props[part]
      if (next === undefined) {
        if (!spec) return schema
        next = props[part] = parts[i + 1] === '[]' ? { type: 'array', items: { type: 'object', properties: {} } } : { type: 'object', properties: {} }
      }
      if (!isRecord(next)) throw new BodySchemaError(`${joinPath(parts.slice(0, i + 1))} não pode ter campos`)
      if (typeof next['$ref'] === 'string') throw new BodySchemaError(`${joinPath(parts.slice(0, i + 1))} é uma referência (${next['$ref']}); edite o $defs no JSON Schema`)
    }
    parent = next as BodySchema
  }
  const last = parts.at(-1)!
  if (last === '[]') {
    if (!spec) throw new BodySchemaError('para remover os itens, remova a lista')
    parent['type'] = 'array'
    parent['items'] = fieldSchema(spec)
    return root
  }
  const props = propsOf(parent, parts.slice(0, -1), !!spec)
  if (!props) return schema
  const required = new Set(Array.isArray(parent['required']) ? (parent['required'] as string[]) : [])
  if (spec) {
    const before = isRecord(props[last]) ? (props[last] as BodySchema) : undefined
    const next = fieldSchema(spec)
    // Um objeto ou lista de objetos que já tinha campos continua com eles quando só muda o resto.
    if (before && spec.type === 'object' && isRecord(before['properties'])) {
      next['properties'] = before['properties']
      if (Array.isArray(before['required'])) next['required'] = before['required']
    }
    if (before && spec.type === 'array' && isRecord(before['items']) && !spec.items) next['items'] = before['items']
    props[last] = next
    if (spec.required) required.add(last)
    else required.delete(last)
  } else {
    if (!(last in props)) throw new BodySchemaError(`campo ${joinPath(parts)} não existe`)
    delete props[last]
    required.delete(last)
  }
  if (required.size) parent['required'] = [...required]
  else delete parent['required']
  return isRecord(root['properties']) && Object.keys(root['properties']).length === 0 && root['type'] === 'object' && !root['$defs']
    ? undefined
    : root
}

function propsOf(parent: BodySchema, at: string[], create: boolean): Record<string, unknown> | undefined {
  if (isRecord(parent['properties'])) return parent['properties']
  if (!create) return undefined
  if (parent['type'] !== undefined && parent['type'] !== 'object') throw new BodySchemaError(`${joinPath(at) || 'o corpo'} é ${String(parent['type'])}, não objeto`)
  parent['type'] = 'object'
  return (parent['properties'] = {})
}

const joinPath = (parts: string[]) => parts.join('.').replace(/\.\[\]/g, '[]')

/**
 * Schema inicial a partir de um corpo de exemplo: tipos pelos valores, objetos aninhados e listas
 * pelo primeiro item (objetos da lista juntam as chaves). Ninguém sai obrigatório: isso a pessoa
 * decide depois. Strings no formato de data, data-hora, e-mail ou UUID ganham o format.
 */
export function inferBodySchema(value: unknown, depth = 0): BodySchema {
  if (depth > 16) return {}
  if (value === null || value === undefined) return {}
  if (Array.isArray(value)) {
    const objects = value.filter(isRecord)
    if (objects.length) return { type: 'array', items: inferBodySchema(Object.assign({}, ...objects), depth + 1) }
    return value.length ? { type: 'array', items: inferBodySchema(value[0], depth + 1) } : { type: 'array', items: {} }
  }
  if (isRecord(value)) {
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inferBodySchema(v, depth + 1)]))
    }
  }
  if (typeof value === 'boolean') return { type: 'boolean' }
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' }
  if (typeof value === 'string') {
    const format = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? 'date'
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)
        ? 'date-time'
        : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
          ? 'email'
          : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
            ? 'uuid'
            : undefined
    return format ? { type: 'string', format } : { type: 'string' }
  }
  return {}
}

/** O corpo de exemplo de um endpoint (objeto ou texto JSON) como valor, ou undefined. */
export function bodyValue(body: unknown): unknown {
  if (typeof body !== 'string') return body
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}
