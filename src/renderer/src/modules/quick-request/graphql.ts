/**
 * GraphQL no Quick Request: a consulta de introspecção, o schema lido da resposta e o
 * autocomplete pelo contexto do cursor. Sem a biblioteca graphql-js: o que o editor precisa
 * é saber o tipo em que o cursor está e os campos dele.
 */

/** A introspecção padrão (a do GraphiQL), sem descrições de diretivas. */
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types { ...FullType }
  }
}
fragment FullType on __Type {
  kind
  name
  description
  fields(includeDeprecated: true) {
    name
    description
    args { ...InputValue }
    type { ...TypeRef }
    isDeprecated
    deprecationReason
  }
  inputFields { ...InputValue }
  interfaces { ...TypeRef }
  enumValues(includeDeprecated: true) { name description isDeprecated }
  possibleTypes { ...TypeRef }
}
fragment InputValue on __InputValue {
  name
  description
  type { ...TypeRef }
  defaultValue
}
fragment TypeRef on __Type {
  kind
  name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }
}`

export type GqlKind = 'SCALAR' | 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT'

export interface GqlArg {
  name: string
  /** Como no SDL: [User!]! */
  type: string
  named: string
  description?: string
  defaultValue?: string
}

export interface GqlField extends GqlArg {
  args: GqlArg[]
  deprecated?: string
}

export interface GqlType {
  kind: GqlKind
  name: string
  description?: string
  fields: GqlField[]
  /** Valores do enum. */
  values: string[]
  /** Tipos de uma union ou de quem implementa a interface. */
  possible: string[]
}

export interface GqlSchema {
  query?: string
  mutation?: string
  subscription?: string
  types: Map<string, GqlType>
}

interface TypeRef {
  kind: string
  name?: string | null
  ofType?: TypeRef | null
}

const render = (t: TypeRef | null | undefined): string =>
  !t ? '?' : t.kind === 'NON_NULL' ? `${render(t.ofType)}!` : t.kind === 'LIST' ? `[${render(t.ofType)}]` : (t.name ?? '?')

const namedOf = (t: TypeRef | null | undefined): string => (!t ? '' : t.name ? t.name : namedOf(t.ofType))

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** O schema a partir da resposta da introspecção ({ data: { __schema } } ou só o __schema). */
export function parseIntrospection(json: unknown): GqlSchema {
  const root = isObj(json) && isObj(json['data']) ? json['data'] : json
  const schema = isObj(root) ? root['__schema'] : undefined
  if (!isObj(schema) || !Array.isArray(schema['types'])) {
    const errors = isObj(json) && Array.isArray(json['errors']) ? json['errors'] : []
    const message = errors.map((e) => (isObj(e) ? String(e['message'] ?? '') : '')).filter(Boolean).join('; ')
    throw new Error(message ? `o servidor recusou a introspecção: ${message}` : 'a resposta não traz data.__schema (o servidor tem introspecção?)')
  }
  const name = (v: unknown) => (isObj(v) && typeof v['name'] === 'string' ? v['name'] : undefined)
  const arg = (a: Record<string, unknown>): GqlArg => ({
    name: String(a['name']),
    type: render(a['type'] as TypeRef),
    named: namedOf(a['type'] as TypeRef),
    ...(typeof a['description'] === 'string' && a['description'] && { description: a['description'] }),
    ...(typeof a['defaultValue'] === 'string' && { defaultValue: a['defaultValue'] })
  })
  const types = new Map<string, GqlType>()
  for (const raw of schema['types']) {
    if (!isObj(raw) || typeof raw['name'] !== 'string') continue
    const fieldsRaw = (Array.isArray(raw['fields']) ? raw['fields'] : Array.isArray(raw['inputFields']) ? raw['inputFields'] : []).filter(isObj)
    types.set(raw['name'], {
      kind: raw['kind'] as GqlKind,
      name: raw['name'],
      ...(typeof raw['description'] === 'string' && raw['description'] && { description: raw['description'] }),
      fields: fieldsRaw.map((f) => ({
        ...arg(f),
        args: (Array.isArray(f['args']) ? f['args'] : []).filter(isObj).map(arg),
        ...(f['isDeprecated'] === true && { deprecated: typeof f['deprecationReason'] === 'string' ? f['deprecationReason'] : 'obsoleto' })
      })),
      values: (Array.isArray(raw['enumValues']) ? raw['enumValues'] : []).map(name).filter((v): v is string => !!v),
      possible: (Array.isArray(raw['possibleTypes']) ? raw['possibleTypes'] : []).map(name).filter((v): v is string => !!v)
    })
  }
  return {
    ...(name(schema['queryType']) && { query: name(schema['queryType'])! }),
    ...(name(schema['mutationType']) && { mutation: name(schema['mutationType'])! }),
    ...(name(schema['subscriptionType']) && { subscription: name(schema['subscriptionType'])! }),
    types
  }
}

/** Tipos do usuário (sem os __ da introspecção e os escalares embutidos), em ordem alfabética. */
export function userTypes(schema: GqlSchema): GqlType[] {
  const builtin = new Set(['String', 'Int', 'Float', 'Boolean', 'ID'])
  return [...schema.types.values()].filter((t) => !t.name.startsWith('__') && !builtin.has(t.name)).sort((a, b) => a.name.localeCompare(b.name))
}

export interface GqlCompletion {
  label: string
  detail?: string
  documentation?: string
  /** Campo de objeto: o editor abre uma seleção { } depois do nome. */
  selection?: boolean
  kind: 'field' | 'argument' | 'keyword' | 'type' | 'value'
}

/** Remove comentários e strings, mantendo o tamanho do texto (as posições continuam valendo). */
function blank(text: string): string {
  return text
    .replace(/"""[\s\S]*?(?:"""|$)/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/"(?:[^"\\\n]|\\.)*(?:"|$)/g, (m) => ' '.repeat(m.length))
    .replace(/#[^\n]*/g, (m) => ' '.repeat(m.length))
}

const selectionOf = (schema: GqlSchema, typeName: string) => {
  const t = schema.types.get(typeName)
  return !!t && (t.kind === 'OBJECT' || t.kind === 'INTERFACE' || t.kind === 'UNION')
}

/**
 * O que sugerir no cursor: os campos do tipo da seleção em que ele está, os argumentos do campo
 * quando está dentro de ( ), os tipos depois de "on" e as palavras-chave no topo do documento.
 * `typed` é o pedaço do nome já digitado, que a sugestão substitui.
 */
export function graphqlCompletionsAt(before: string, schema: GqlSchema): { typed: string; items: GqlCompletion[] } {
  const text = blank(before)
  const typed = /[_A-Za-z][_0-9A-Za-z]*$/.exec(text)?.[0] ?? ''
  const head = text.slice(0, text.length - typed.length)

  // Depois de "on" (fragmento ou inline): os tipos.
  if (/\bon\s+$/.test(head)) {
    return {
      typed,
      items: userTypes(schema)
        .filter((t) => t.kind === 'OBJECT' || t.kind === 'INTERFACE' || t.kind === 'UNION')
        .map((t) => ({ label: t.name, kind: 'type' as const, ...(t.description && { documentation: t.description }) }))
    }
  }

  const tokens: string[] = head.match(/[_A-Za-z][_0-9A-Za-z]*|\.\.\.|[{}():$@!=[\],]/g) ?? []
  // Pilha de tipos das seleções abertas; null quando o tipo é desconhecido (campo que não existe).
  const stack: (string | null)[] = []
  const parens: { field: GqlField | undefined }[] = []
  let pendingType: string | null | undefined
  let lastField: GqlField | undefined
  let opKeyword: string | undefined
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok === '(') {
      parens.push({ field: stack.length ? lastField : undefined })
      continue
    }
    if (tok === ')') {
      parens.pop()
      continue
    }
    if (parens.length) continue
    if (stack.length === 0 && (tok === 'query' || tok === 'mutation' || tok === 'subscription')) {
      opKeyword = tok
      pendingType = (tok === 'query' ? schema.query : tok === 'mutation' ? schema.mutation : schema.subscription) ?? null
      continue
    }
    if (stack.length === 0 && tok === 'fragment') {
      const on = tokens.indexOf('on', i)
      pendingType = on > 0 && tokens[on + 1] ? (schema.types.has(tokens[on + 1]!) ? tokens[on + 1]! : null) : null
      i = on > 0 ? on + 1 : i
      continue
    }
    if (tok === '...' && tokens[i + 1] === 'on' && tokens[i + 2]) {
      pendingType = schema.types.has(tokens[i + 2]!) ? tokens[i + 2]! : null
      i += 2
      continue
    }
    if (tok === '{') {
      if (stack.length === 0 && pendingType === undefined) pendingType = schema.query ?? null
      stack.push(pendingType !== undefined ? pendingType : lastField ? lastField.named : null)
      pendingType = undefined
      lastField = undefined
      continue
    }
    if (tok === '}') {
      stack.pop()
      lastField = undefined
      if (!stack.length) opKeyword = undefined
      continue
    }
    if (/^[_A-Za-z]/.test(tok) && stack.length) {
      // alias: campo → o nome depois dos dois-pontos é o campo.
      if (tokens[i + 1] === ':') continue
      const current = stack.at(-1)
      lastField = current ? schema.types.get(current)?.fields.find((f) => f.name === tok) : undefined
    }
  }

  if (parens.length) {
    const field = parens.at(-1)!.field
    // Depois de "nome:" é valor; só sugere argumentos no começo de um.
    if (!field || /:\s*$/.test(head)) return { typed, items: [] }
    return {
      typed,
      items: field.args.map((a) => ({ label: a.name, detail: a.type, kind: 'argument' as const, ...(a.description && { documentation: a.description }) }))
    }
  }

  if (!stack.length) {
    if (opKeyword) return { typed, items: [] }
    return {
      typed,
      items: ['query', 'mutation', 'subscription', 'fragment']
        .filter((k) => k !== 'mutation' || schema.mutation)
        .filter((k) => k !== 'subscription' || schema.subscription)
        .map((label) => ({ label, kind: 'keyword' as const }))
    }
  }

  const current = stack.at(-1)
  const type = current ? schema.types.get(current) : undefined
  if (!type) return { typed, items: [] }
  const items: GqlCompletion[] = type.fields.map((f) => ({
    label: f.name,
    detail: f.args.length ? `(${f.args.map((a) => `${a.name}: ${a.type}`).join(', ')}): ${f.type}` : f.type,
    kind: 'field' as const,
    ...((f.description ?? f.deprecated) && { documentation: [f.deprecated && `Obsoleto: ${f.deprecated}`, f.description].filter(Boolean).join('\n\n') }),
    ...(selectionOf(schema, f.named) && { selection: true })
  }))
  items.push({ label: '__typename', detail: 'String!', kind: 'field' })
  return { typed, items }
}

/** O corpo JSON que vai na requisição: query, variables (se houver) e operationName (se houver). */
export function graphqlBody(query: string, variables: string, operationName?: string): string {
  let vars: unknown
  try {
    vars = variables.trim() ? JSON.parse(variables) : undefined
  } catch {
    // Variáveis inválidas vão como texto: o servidor responde o erro, e o editor já aponta.
    vars = variables
  }
  return JSON.stringify({ query, ...(vars !== undefined && { variables: vars }), ...(operationName && { operationName }) }, null, 2)
}

/** Lê um corpo já montado ({ query, variables }) de volta para o editor de GraphQL. */
export function fromGraphqlBody(body: string): { query: string; variables: string; operationName?: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (!isObj(parsed) || typeof parsed['query'] !== 'string') return undefined
    return {
      query: parsed['query'],
      variables: parsed['variables'] === undefined ? '' : JSON.stringify(parsed['variables'], null, 2),
      ...(typeof parsed['operationName'] === 'string' && { operationName: parsed['operationName'] })
    }
  } catch {
    return undefined
  }
}

/** Operações nomeadas do documento, para escolher qual rodar. */
export function operationNames(query: string): string[] {
  return [...blank(query).matchAll(/\b(?:query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/g)].map((m) => m[1]!)
}
