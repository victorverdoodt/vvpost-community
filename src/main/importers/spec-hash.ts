import { createHash } from 'node:crypto'
import type { Endpoint } from '@vvpost/schemas'
import { schemaBody } from '@vvpost/core/connectors/shared-schemas'

/**
 * Os hashes da reimportação de uma spec (importers/openapi.ts): o que veio da spec num endpoint e
 * num schema compartilhado. Módulo à parte, para a camada de escrita do projeto usar sem o importador.
 */

type Obj = Record<string, unknown>

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Campos do endpoint que vêm da spec: são os que o hash resume e os que a reimportação atualiza. */
export const SPEC_FIELDS = ['name', 'description', 'method', 'path', 'requiresAuth', 'headers', 'query', 'bodySchema', 'body', 'payload'] as const

/**
 * A marca de dado pessoal (`x-sensitive`) fica fora dos hashes: o usuário marca um campo no projeto
 * sem que isso conte como edição do contrato, e a reimportação a preserva (keepSensitiveMarks).
 */
const SENSITIVE = 'x-sensitive'

/** Resumo estável dos campos que vêm da spec. */
export function endpointHash(e: Endpoint): string {
  const picked: Obj = {}
  for (const f of SPEC_FIELDS) if (e[f] !== undefined) picked[f] = e[f]
  return createHash('sha256').update(stableJson(picked)).digest('hex').slice(0, 16)
}

/** Resumo estável de um schema compartilhado (sem a marca do import), para a reimportação saber se ele foi editado. */
export function schemaHash(schema: Obj): string {
  return createHash('sha256').update(stableJson(schemaBody(schema))).digest('hex').slice(0, 16)
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (isObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined && k !== SENSITIVE)
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}


/**
 * Leva para `target` (a versão da spec de um schema) as marcas `x-sensitive` que `source` (a versão
 * do projeto) tem no mesmo caminho e `target` não tem. Muda e devolve `target`.
 */
export function keepSensitiveMarks<T>(target: T, source: unknown): T {
  const walk = (t: unknown, s: unknown, depth: number): void => {
    if (depth > 64) return
    if (Array.isArray(t) && Array.isArray(s)) {
      t.forEach((item, i) => walk(item, s[i], depth + 1))
      return
    }
    if (!isObject(t) || !isObject(s)) return
    if (s[SENSITIVE] !== undefined && t[SENSITIVE] === undefined) t[SENSITIVE] = structuredClone(s[SENSITIVE])
    for (const [k, v] of Object.entries(t)) if (typeof v === 'object' && v !== null) walk(v, s[k], depth + 1)
  }
  walk(target, source, 0)
  return target
}

/** A spec marca com `x-sensitive` algum campo que a versão do projeto não marca. */
export function specAddsSensitiveMarks(spec: unknown, local: unknown): boolean {
  const walk = (a: unknown, b: unknown, depth: number): boolean => {
    if (depth > 64) return false
    if (Array.isArray(a)) return a.some((item, i) => walk(item, Array.isArray(b) ? b[i] : undefined, depth + 1))
    if (!isObject(a)) return false
    const other = isObject(b) ? b : {}
    if (a[SENSITIVE] !== undefined && other[SENSITIVE] === undefined) return true
    return Object.entries(a).some(([k, v]) => typeof v === 'object' && v !== null && walk(v, other[k], depth + 1))
  }
  return walk(spec, local, 0)
}
