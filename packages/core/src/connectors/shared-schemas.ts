import type { Connector, Endpoint } from '@vvpost/schemas'

/**
 * Schemas compartilhados do catálogo (docs/connectors.md, Schemas compartilhados): um JSON Schema por
 * arquivo em schemas/<Nome>.schema.json, citado nos endpoints como {"$ref": "schema:<Nome>"} (no
 * bodySchema, no schema de um exemplo de resposta ou dentro de outro schema). A leitura do workspace
 * troca cada citação pelo schema, em $defs do próprio bodySchema, então o envio, a validação, o mock,
 * a doc e o MCP veem o schema completo, e editar o arquivo muda todos os usos de uma vez.
 *
 * Módulo puro (sem disco): o app, o importador e a camada de escrita usam as mesmas regras.
 */

type Obj = Record<string, unknown>

export const SCHEMAS_DIR = 'schemas'
export const SCHEMA_SUFFIX = '.schema.json'
export const SCHEMA_REF_PREFIX = 'schema:'
/** Nome de um schema: vira nome de arquivo e chave de $defs. */
export const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/
/** Palavras do arquivo que não entram no schema embutido: as de documento e a marca do import. */
const FILE_ONLY = ['$schema', '$id', 'x-vvpost'] as const

export interface SharedSchema {
  name: string
  /** Caminho relativo ao workspace, com "/" ("../schemas/X.schema.json" para o do Compartilhado). */
  file: string
  schema: Obj
  /** Origem, quando o schema é só de leitura aqui (o Compartilhado do workspace). */
  shared?: string
}

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export const schemaRef = (name: string): string => `${SCHEMA_REF_PREFIX}${name}`
export const schemaFile = (name: string): string => `${SCHEMAS_DIR}/${name}${SCHEMA_SUFFIX}`

/** O nome que um $ref cita ("schema:Pedido" → "Pedido"), ou undefined se não é de um schema compartilhado. */
export function refName(ref: unknown): string | undefined {
  return typeof ref === 'string' && ref.startsWith(SCHEMA_REF_PREFIX) ? ref.slice(SCHEMA_REF_PREFIX.length) : undefined
}

/** O schema compartilhado que o schema inteiro é ({"$ref": "schema:X"}, com ou sem descrição ao lado). */
export function rootSchemaName(schema: unknown): string | undefined {
  return isObject(schema) ? refName(schema['$ref']) : undefined
}

/** Os schemas compartilhados citados em `value`, em qualquer profundidade. */
export function schemaRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) schemaRefs(v, out)
  else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const name = k === '$ref' ? refName(v) : undefined
      if (name) out.add(name)
      else schemaRefs(v, out)
    }
  }
  return out
}

/** Troca, em `value` (no lugar), as citações "schema:<antigo>" por "schema:<novo>". Devolve se mudou algo. */
export function renameSchemaRefs(value: unknown, names: ReadonlyMap<string, string>): boolean {
  let changed = false
  if (Array.isArray(value)) for (const v of value) changed = renameSchemaRefs(v, names) || changed
  else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const name = k === '$ref' ? refName(v) : undefined
      const next = name !== undefined ? names.get(name) : undefined
      if (next !== undefined) {
        value[k] = schemaRef(next)
        changed = true
      } else if (name === undefined) changed = renameSchemaRefs(v, names) || changed
    }
  }
  return changed
}

/** O schema do arquivo sem as palavras de documento ($schema, $id) e sem a marca do import. */
export function schemaBody(schema: Obj): Obj {
  const out = { ...schema }
  for (const k of FILE_ONLY) delete out[k]
  return out
}

/**
 * `schema` com cada "schema:X" trocado por "#/$defs/X" e o schema X (e os que ele cita) em $defs.
 * As referências internas de X ("#/...") passam a apontar para dentro de $defs/X. Um nome que já é
 * de um $defs do próprio schema ganha sufixo. Sem citação, devolve o mesmo objeto; um schema que não
 * existe vira {} (aceita tudo) e é avisado em `missing`.
 */
export function resolveSchemaRefs(
  schema: Obj,
  lookup: (name: string) => Obj | undefined,
  missing?: (name: string) => void,
  /** Cada schema embutido, inclusive os que outro schema cita. */
  used?: (name: string) => void
): Obj {
  if (!schemaRefs(schema).size) return schema
  const ownDefs = isObject(schema['$defs']) ? schema['$defs'] : {}
  const keys = new Map<string, string | null>()
  const queue: string[] = []
  const keyOf = (name: string): string | null => {
    if (keys.has(name)) return keys.get(name)!
    if (!lookup(name)) {
      keys.set(name, null)
      missing?.(name)
      return null
    }
    let key = name
    const taken = new Set([...Object.keys(ownDefs), ...[...keys.values()].filter((k): k is string => !!k)])
    for (let n = 2; taken.has(key); n++) key = `${name}_${n}`
    keys.set(name, key)
    queue.push(name)
    used?.(name)
    return key
  }
  const pointer = (key: string) => `#/$defs/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
  /** Copia `value` trocando as citações; `base` prefixa as referências locais de um schema embutido. */
  const rewrite = (value: unknown, base: string | undefined): unknown => {
    if (Array.isArray(value)) return value.map((v) => rewrite(v, base))
    if (!isObject(value)) return value
    const out: Obj = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string') {
        const name = refName(v)
        if (name !== undefined) {
          const key = keyOf(name)
          if (key) out[k] = pointer(key)
          continue
        }
        out[k] = base && v.startsWith('#') ? `${base}${v.slice(1)}` : v
        continue
      }
      out[k] = rewrite(v, base)
    }
    return out
  }
  const root = rewrite(schema, undefined) as Obj
  const defs: Obj = {}
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i]!
    const key = keys.get(name)!
    defs[key] = rewrite(schemaBody(lookup(name)!), pointer(key))
  }
  if (Object.keys(defs).length) root['$defs'] = { ...(isObject(root['$defs']) ? root['$defs'] : {}), ...defs }
  return root
}

/** Onde um endpoint cita schemas: o bodySchema e o schema de cada exemplo de resposta. */
function endpointSchemas(e: Endpoint): Obj[] {
  return [e.bodySchema, ...(e.examples ?? []).map((x) => x.schema)].filter(isObject)
}

/**
 * O conector com as citações resolvidas, ou undefined quando ele não cita nenhum schema compartilhado.
 * `onUse` recebe cada uso ("<conector>/<endpoint>" ou "<conector>/<endpoint>#<exemplo>", e o schema),
 * inclusive o de um schema citado por outro.
 */
export function resolveConnectorSchemas(
  connector: Connector,
  lookup: (name: string) => Obj | undefined,
  onMissing: (name: string, where: string) => void,
  onUse?: (name: string, where: string) => void
): Connector | undefined {
  if (!connector.endpoints?.some((e) => endpointSchemas(e).some((s) => schemaRefs(s).size))) return undefined
  const resolve = (schema: Obj, where: string): Obj =>
    resolveSchemaRefs(
      schema,
      lookup,
      (name) => onMissing(name, where),
      onUse && ((name) => onUse(name, where))
    )
  return {
    ...connector,
    endpoints: connector.endpoints.map((e) => {
      if (!endpointSchemas(e).some((s) => schemaRefs(s).size)) return e
      const at = `${connector.id}/${e.id}`
      return {
        ...e,
        ...(e.bodySchema && { bodySchema: resolve(e.bodySchema, at) }),
        ...(e.examples && { examples: e.examples.map((x) => (x.schema ? { ...x, schema: resolve(x.schema, `${at}#${x.id}`) } : x)) })
      }
    })
  }
}

/** O mesmo valor JSON (ordem das chaves não conta). */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]))
  if (isObject(a)) {
    if (!isObject(b)) return false
    const ka = Object.keys(a).filter((k) => a[k] !== undefined)
    const kb = Object.keys(b).filter((k) => b[k] !== undefined)
    return ka.length === kb.length && ka.every((k) => sameJson(a[k], b[k]))
  }
  return a === b
}

export interface ExtractedSchemas {
  /** Schemas novos, pelo nome. */
  schemas: Map<string, Obj>
  /** De quantos schemas cada um saiu (as cópias que ele substitui). */
  uses: Map<string, number>
}

/**
 * A migração dos catálogos que repetem o mesmo schema (o import antigo do OpenAPI copiava os
 * componentes em $defs de cada endpoint): cada entrada de $defs que aparece igual, com o mesmo nome,
 * em `minUses` schemas ou mais vira um schema compartilhado, e os schemas passam a citá-lo. As
 * entradas que ela cita no mesmo $defs vão junto (citadas como schema também). Muda `schemas` no lugar.
 * `existing` são os schemas que o projeto já tem: um igual é reaproveitado, e um nome já usado por
 * outro conteúdo ganha sufixo.
 */
export function extractSharedSchemas(schemas: Obj[], existing: ReadonlyMap<string, Obj>, minUses = 2): ExtractedSchemas {
  const out: ExtractedSchemas = { schemas: new Map(), uses: new Map() }
  // Candidatos: nome → conteúdos distintos e em quantos schemas cada um aparece.
  const seen = new Map<string, { value: Obj; count: number }[]>()
  for (const s of schemas) {
    const defs = isObject(s['$defs']) ? s['$defs'] : undefined
    for (const [name, value] of Object.entries(defs ?? {})) {
      if (!isObject(value) || !SCHEMA_NAME.test(name)) continue
      const list = seen.get(name) ?? []
      const same = list.find((x) => sameJson(x.value, value))
      if (same) same.count++
      else list.push({ value, count: 1 })
      seen.set(name, list)
    }
  }
  const chosen = new Map<string, Obj>()
  for (const [name, list] of seen) {
    const top = list.reduce((a, b) => (b.count > a.count ? b : a))
    if (top.count >= minUses) chosen.set(name, top.value)
  }
  if (!chosen.size) return out

  // Um escolhido que cita, no mesmo $defs, uma entrada que não vai junto não sai sozinho.
  const localRefs = (value: unknown, found = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) for (const v of value) localRefs(v, found)
    else if (isObject(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (k === '$ref' && typeof v === 'string') {
          const m = /^#\/\$defs\/([^/]+)$/.exec(v)
          if (m) found.add(m[1]!.replace(/~1/g, '/').replace(/~0/g, '~'))
          else if (v.startsWith('#')) found.add('#')
        } else localRefs(v, found)
      }
    }
    return found
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const [name, value] of chosen) {
      if ([...localRefs(value)].some((r) => !chosen.has(r))) {
        chosen.delete(name)
        changed = true
      }
    }
  }
  if (!chosen.size) return out

  // Nome final: o mesmo, a não ser que o projeto já tenha um schema com esse nome e outro conteúdo.
  const finalName = new Map<string, string>()
  for (const [name, value] of chosen) {
    let n = name
    for (let i = 2; existing.has(n) && !sameJson(schemaBody(existing.get(n)!), value); i++) n = `${name}_${i}`
    finalName.set(name, n)
  }
  const toShared = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(toShared)
    if (!isObject(value)) return value
    const o: Obj = {}
    for (const [k, v] of Object.entries(value)) {
      const m = k === '$ref' && typeof v === 'string' ? /^#\/\$defs\/([^/]+)$/.exec(v) : null
      const target = m ? finalName.get(m[1]!.replace(/~1/g, '/').replace(/~0/g, '~')) : undefined
      o[k] = target ? schemaRef(target) : toShared(v)
    }
    return o
  }
  for (const [name, value] of chosen) {
    const n = finalName.get(name)!
    if (!existing.has(n)) out.schemas.set(n, toShared(value) as Obj)
  }
  for (const s of schemas) {
    const defs = isObject(s['$defs']) ? s['$defs'] : undefined
    if (!defs) continue
    // Só as entradas iguais à escolhida saem; uma com o mesmo nome e outro conteúdo fica.
    let moving = Object.keys(defs).filter((name) => chosen.has(name) && sameJson(defs[name], chosen.get(name)))
    // E só junto com as entradas que elas citam: uma citada com outro conteúdo prende as que a citam.
    for (let changed = true; changed; ) {
      const next = moving.filter((name) => [...localRefs(defs[name])].every((r) => moving.includes(r)))
      changed = next.length !== moving.length
      moving = next
    }
    if (!moving.length) continue
    const local = new Map(moving.map((name) => [name, finalName.get(name)!] as const))
    const rewrite = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rewrite)
      if (!isObject(value)) return value
      const o: Obj = {}
      for (const [k, v] of Object.entries(value)) {
        const m = k === '$ref' && typeof v === 'string' ? /^#\/\$defs\/([^/]+)$/.exec(v) : null
        const target = m ? local.get(m[1]!.replace(/~1/g, '/').replace(/~0/g, '~')) : undefined
        o[k] = target ? schemaRef(target) : rewrite(v)
      }
      return o
    }
    for (const name of local.values()) out.uses.set(name, (out.uses.get(name) ?? 0) + 1)
    const { $defs: _, ...rest } = s
    const next = rewrite(rest) as Obj
    const left = Object.fromEntries(Object.entries(defs).filter(([name]) => !local.has(name)).map(([k, v]) => [k, rewrite(v)]))
    for (const k of Object.keys(s)) delete s[k]
    Object.assign(s, next, Object.keys(left).length ? { $defs: left } : {})
  }
  return out
}
