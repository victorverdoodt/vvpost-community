import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validatePrivacyConfig } from '@vvpost/schemas'
import type { LoadedWorkspace } from './connectors/workspace'
import { normalizeName as normalize } from './secrets'

/**
 * Tipos de dado pessoal de `x-sensitive`. `pii` é o genérico (`"x-sensitive": true`). Os cinco
 * primeiros também têm detecção por padrão (DETECTABLE).
 */
export const PII_TYPES = ['cpf', 'cnpj', 'email', 'phone', 'card', 'rg', 'name', 'address', 'birthDate', 'document', 'pii'] as const
export type PiiType = (typeof PII_TYPES)[number]
/** Os tipos que a detecção por padrão reconhece num campo não marcado. */
export const DETECTABLE = ['cpf', 'cnpj', 'email', 'phone', 'card'] as const satisfies readonly PiiType[]
export type DetectablePii = (typeof DETECTABLE)[number]

/** Palavra do JSON Schema que marca um campo como dado pessoal. */
export const SENSITIVE_KEYWORD = 'x-sensitive'
/** O que a IA vê no lugar de um dado pessoal: o tipo fica, o valor não. */
export const piiPlaceholder = (type: PiiType): string => `[REDACTED_PII:${type}]`
const PLACEHOLDER = /^\[REDACTED_PII:[A-Za-z]+\]$/

const MAX_DEPTH = 64
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** O tipo de um valor de `x-sensitive`: true é o genérico, texto desconhecido também; false e ausente, nada. */
export function sensitiveType(value: unknown): PiiType | undefined {
  if (value === true) return 'pii'
  if (typeof value !== 'string' || !value.trim()) return undefined
  const v = value.trim().toLowerCase()
  return PII_TYPES.find((t) => t.toLowerCase() === v) ?? 'pii'
}

/** Os campos marcados com `x-sensitive` num JSON Schema, em qualquer profundidade: nome → tipo. */
export function sensitiveFields(schema: unknown, out = new Map<string, PiiType>(), depth = 0): Map<string, PiiType> {
  if (depth > MAX_DEPTH) return out
  if (Array.isArray(schema)) {
    for (const s of schema) sensitiveFields(s, out, depth + 1)
    return out
  }
  if (!isObject(schema)) return out
  const properties = schema['properties']
  if (isObject(properties)) {
    for (const [name, sub] of Object.entries(properties)) {
      // A marca vale na propriedade ou nos itens dela (uma lista de e-mails).
      const type = isObject(sub) ? (sensitiveType(sub[SENSITIVE_KEYWORD]) ?? (isObject(sub['items']) ? sensitiveType(sub['items'][SENSITIVE_KEYWORD]) : undefined)) : undefined
      if (type && !out.has(normalize(name))) out.set(normalize(name), type)
    }
  }
  for (const [k, v] of Object.entries(schema)) if (k !== SENSITIVE_KEYWORD && typeof v === 'object') sensitiveFields(v, out, depth + 1)
  return out
}

// ── Detecção por padrão ──────────────────────────────────────────────────────────────────────

const digits = (s: string) => s.replace(/\D/g, '')

function cpfValid(raw: string): boolean {
  const d = digits(raw)
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false
  const check = (len: number) => {
    let sum = 0
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i)
    const r = (sum * 10) % 11
    return r === 10 ? 0 : r
  }
  return check(9) === Number(d[9]) && check(10) === Number(d[10])
}

function cnpjValid(raw: string): boolean {
  const d = digits(raw)
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false
  const check = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    const sum = weights.reduce((acc, w, i) => acc + w * Number(d[i]), 0)
    const r = sum % 11
    return r < 2 ? 0 : 11 - r
  }
  return check(12) === Number(d[12]) && check(13) === Number(d[13])
}

function luhnValid(raw: string): boolean {
  const d = digits(raw)
  if (d.length < 13 || d.length > 19) return false
  // Só bandeiras conhecidas: um timestamp em ms (13 dígitos, começa com 1) passa no Luhn 1 vez em 10.
  if (!/^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5|4[4-9])|3(?:0[0-5]|[68]))/.test(d)) return false
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i])
    if (i % 2 === 1) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
  }
  return sum % 10 === 0
}

/** Na ordem: o mais longo e o mais específico primeiro (um CNPJ contém onze dígitos seguidos). */
const DETECTORS: { type: DetectablePii; pattern: RegExp; valid?: (match: string) => boolean }[] = [
  { type: 'email', pattern: /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}(?![\w-])/g },
  { type: 'card', pattern: /(?<![\d.-])\d(?:[ -]?\d){12,18}(?![\d])/g, valid: luhnValid },
  { type: 'cnpj', pattern: /(?<![\d./-])\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?![\d/])/g, valid: cnpjValid },
  { type: 'cpf', pattern: /(?<![\d./-])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?![\d/])/g, valid: cpfValid },
  // Telefone com DDD e separador antes dos 4 últimos dígitos, ou E.164 (+5511987654321).
  { type: 'phone', pattern: /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,3}\)|\d{2,3})[\s.-]?\d{4,5}[\s.-]\d{4}(?!\d)|(?<![\w+])\+\d{10,15}(?!\d)/g }
]

export interface PiiOptions {
  /** Detecção por padrão nos campos não marcados: true liga todos os tipos de DETECTABLE. */
  detect?: boolean | readonly DetectablePii[]
}

export interface PiiMasker {
  /** Junta os campos marcados de um JSON Schema. */
  addSchema(schema: unknown): void
  /** Todo schema do workspace: compartilhados, bodySchema e schemas dos exemplos de resposta. */
  addWorkspace(ws: LoadedWorkspace): void
  /** Liga a detecção por padrão (só liga: o mais forte vale). */
  addDetect(detect: PiiOptions['detect']): void
  /** Os campos marcados, pelo nome normalizado. */
  readonly fields: ReadonlyMap<string, PiiType>
  /** Os tipos detectados por padrão. */
  readonly detecting: ReadonlySet<DetectablePii>
  /** Mascara os dados pessoais de um valor JSON, sem alterar o original. */
  sanitize<T>(value: T): T
  /** Mascara os dados pessoais de um texto (JSON inteiro, cortado, form, query ou prosa). */
  text(value: string): string
  /**
   * O valor tirado da resposta num caminho ("body.cliente.cpf", "$.itens[0].email"): mascarado
   * inteiro se o último campo do caminho é marcado; senão, como qualquer outro valor.
   */
  at<T>(path: string, value: T): T | string
}

/**
 * Mascaramento de dados pessoais (PII) no que vai ao agente de IA. Duas camadas:
 * 1. Campos marcados com `x-sensitive` nos schemas do projeto, pelo nome, em qualquer
 *    profundidade, em JSON estruturado, em JSON cortado e em chave=valor.
 * 2. Detecção por padrão (opcional): CPF e CNPJ com dígito verificador, cartão com Luhn,
 *    e-mail e telefone, em qualquer texto.
 * Roda antes do Secret Sanitizer e antes de qualquer corte de preview.
 */
export function createPiiMasker(options: PiiOptions = {}): PiiMasker {
  const fields = new Map<string, PiiType>()
  const detecting = new Set<DetectablePii>()
  addDetect(options.detect)

  function addDetect(detect: PiiOptions['detect']): void {
    if (!detect) return
    for (const t of detect === true ? DETECTABLE : detect) if ((DETECTABLE as readonly string[]).includes(t)) detecting.add(t)
  }

  const typeOf = (key: string) => fields.get(normalize(key))
  const active = () => fields.size > 0 || detecting.size > 0

  function detect(text: string): string {
    if (!detecting.size) return text
    let out = text
    for (const { type, pattern, valid } of DETECTORS) {
      if (!detecting.has(type)) continue
      out = out.replace(pattern, (m) => (!valid || valid(m) ? piiPlaceholder(type) : m))
    }
    return out
  }

  /** "chave": valor e chave=valor em texto que não é JSON inteiro (corpo cortado, query, form, log). */
  const PAIR = /(["']?)([A-Za-z0-9_.-]{1,64})\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"?|'[^']*'?|-?\d[\d.eE+-]*|[^\s&;,"'}\])?#]+)/g
  function pairs(text: string): string {
    if (!fields.size) return text
    return text.replace(PAIR, (match, quote: string, key: string, sep: string, value: string) => {
      const type = typeOf(key)
      if (!type || PLACEHOLDER.test(value.replace(/^["']|["']$/g, '')) || /^(?:null|true|false|""|'')$/.test(value)) return match
      const q = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : ''
      // Texto cortado no meio do valor: a aspa de fechamento pode não existir.
      const close = q && value.length > 1 && value.endsWith(q) ? q : ''
      return `${quote}${key}${quote}${sep}${q}${piiPlaceholder(type)}${close}`
    })
  }

  function text(value: string, depth = 0): string {
    if (!active()) return value
    const trimmed = value.trim()
    if (trimmed.length >= 2 && (trimmed[0] === '{' || trimmed[0] === '[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        const indent = /^[{[]\s*\n(\s+)/.exec(trimmed)?.[1]?.length ?? 0
        return JSON.stringify(walk(parsed, depth + 1), null, indent || undefined)
      } catch {
        // JSON cortado: cai nas regras de texto
      }
    }
    return detect(pairs(value))
  }

  function walk(value: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) return value
    if (typeof value === 'string') return text(value, depth)
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1))
    if (isObject(value)) {
      // { name, value }: um header ou parâmetro; o nome decide.
      const named = typeof value['name'] === 'string' && 'value' in value ? typeOf(value['name']) : undefined
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => {
          const type = k === 'value' && named ? named : typeOf(k)
          if (type && v !== null && v !== undefined && v !== '') return [k, piiPlaceholder(type)]
          return [k, walk(v, depth + 1)]
        })
      )
    }
    return value
  }

  return {
    addSchema(schema) {
      sensitiveFields(schema, fields)
    },
    addWorkspace(ws) {
      for (const s of ws.schemas?.values() ?? []) sensitiveFields(s.schema, fields)
      for (const c of ws.connectors.values()) {
        for (const e of c.endpoints ?? []) {
          sensitiveFields(e.bodySchema, fields)
          for (const x of e.examples ?? []) sensitiveFields(x.schema, fields)
        }
      }
    },
    addDetect,
    fields,
    detecting,
    sanitize: <T>(value: T) => (active() ? (walk(value, 0) as T) : value),
    text: (value: string) => text(value),
    at<T>(path: string, value: T): T | string {
      if (!active()) return value
      const last = /([A-Za-z0-9_.-]+?)(?:\[\d*\])*$/.exec(path.replace(/^\$\.?/, '').split('.').pop() ?? '')?.[1]
      const type = last ? typeOf(last) : undefined
      if (type && value !== null && value !== undefined && value !== '') return piiPlaceholder(type)
      return walk(value, 0) as T
    }
  }
}

/** Arquivo da configuração de privacidade, versionado com o workspace. */
export const PRIVACY_FILE = '.vvpost/privacy.json'

/**
 * A detecção pedida em `.vvpost/privacy.json` de cada pasta (a do projeto e a raiz do workspace):
 * vale a união. Arquivo ausente é detecção desligada; arquivo inválido é erro, para ninguém achar
 * que a detecção está ligada quando não está.
 */
export async function loadPrivacyDetect(dirs: readonly string[]): Promise<DetectablePii[]> {
  return (await loadPrivacy(dirs)).agent
}

export interface PrivacySettings {
  /** Detecção por padrão no que vai ao agente. */
  agent: DetectablePii[]
  /** Mascarar também para pessoas (app e CLI), e a detecção por padrão para elas. */
  people: { mask: boolean; detect: DetectablePii[] }
}

/** Tudo de `.vvpost/privacy.json` nas pastas (a do projeto e a raiz): vale a união, e o mais forte. */
export async function loadPrivacy(dirs: readonly string[]): Promise<PrivacySettings> {
  const agent = new Set<DetectablePii>()
  const people = { mask: false, detect: new Set<DetectablePii>() }
  const add = (to: Set<DetectablePii>, detect: boolean | readonly DetectablePii[] | undefined) => {
    for (const t of detect === true ? DETECTABLE : detect || []) to.add(t)
  }
  for (const dir of new Set(dirs)) {
    let raw: string
    try {
      raw = await readFile(join(dir, PRIVACY_FILE), 'utf8')
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`${PRIVACY_FILE} não é JSON válido: ${(err as Error).message}`)
    }
    const valid = validatePrivacyConfig(parsed)
    if (!valid.ok) throw new Error(`${PRIVACY_FILE} inválido: ${valid.issues.map((i) => `${i.path || '/'} ${i.message}`).join('; ')}`)
    add(agent, valid.value.agent?.detect)
    if (valid.value.people?.mask) {
      people.mask = true
      add(people.detect, valid.value.people.detect)
    }
  }
  return { agent: [...agent], people: { mask: people.mask, detect: [...people.detect] } }
}

/**
 * O mascaramento para pessoas (pii-people.ts) do workspace, ou null quando ninguém pediu: nem o
 * `people.mask` do privacy.json, nem a política (`policy`, o que a organização manda).
 */
export async function peopleMasker(ws: LoadedWorkspace, dirs: readonly string[], policy = false): Promise<PiiMasker | null> {
  const { people } = await loadPrivacy(dirs)
  if (!people.mask && !policy) return null
  const masker = createPiiMasker({ detect: people.detect })
  masker.addWorkspace(ws)
  return masker
}
