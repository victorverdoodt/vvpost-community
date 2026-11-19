import { createHmac, randomInt, randomUUID } from 'node:crypto'
import { ConfigError } from './errors'

/** Uma referência {{NOME}} sem valor no ambiente ativo. */
export class UnresolvedVariableError extends ConfigError {
  constructor(readonly variable: string, detail?: string) {
    super(detail ?? `variável {{${variable}}} não definida no ambiente ativo`)
  }
}

export interface VariableScope {
  /** Valores do ambiente ativo, com os segredos já trocados pelos valores locais. */
  values: ReadonlyMap<string, string>
  /** Segredos declarados no ambiente mas sem valor no arquivo local. */
  missingSecrets?: ReadonlySet<string>
  /** Valores extras só deste contexto, ex.: $token na injeção do login. */
  extra?: Readonly<Record<string, string>>
}

const PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g

/**
 * Troca {{VAR}} pelos valores do escopo. Variáveis dinâmicas começam com $:
 * $uuid, $timestamp (segundos), $isoTimestamp, $randomInt e $totp:VAR (código
 * TOTP de 6 dígitos a partir da semente base32 em VAR, para logins com MFA).
 */
export function interpolate(text: string, scope: VariableScope): string {
  return text.replace(PATTERN, (_, raw: string) => {
    const name = raw.trim()
    const extra = scope.extra?.[name]
    if (extra !== undefined) return extra
    if (name.startsWith('$')) return dynamic(name, scope)
    const value = scope.values.get(name)
    if (value === undefined) throw unresolved(name, scope)
    return value
  })
}

/** Interpola todas as strings de um valor JSON (chaves ficam como estão). */
export function interpolateDeep(value: unknown, scope: VariableScope): unknown {
  if (typeof value === 'string') return interpolate(value, scope)
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, scope))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateDeep(v, scope)]))
  }
  return value
}

function unresolved(name: string, scope: VariableScope): UnresolvedVariableError {
  return scope.missingSecrets?.has(name)
    ? new UnresolvedVariableError(name, `segredo {{${name}}} sem valor no cofre local`)
    : new UnresolvedVariableError(name)
}

function dynamic(name: string, scope: VariableScope): string {
  switch (name) {
    case '$uuid':
    case '$guid':
      return randomUUID()
    case '$timestamp':
      return String(Math.floor(Date.now() / 1000))
    case '$isoTimestamp':
      return new Date().toISOString()
    case '$randomInt':
      return String(randomInt(0, 1001))
  }
  if (name.startsWith('$capture.')) {
    throw new UnresolvedVariableError(
      name,
      `{{${name}}}: nenhum cenário de dependsOn capturou "${name.slice('$capture.'.length)}" (confira capture e dependsOn)`
    )
  }
  if (name.startsWith('$totp:')) {
    const variable = name.slice('$totp:'.length).trim()
    const seed = scope.values.get(variable)
    if (seed === undefined) throw unresolved(variable, scope)
    return totp(seed)
  }
  throw new UnresolvedVariableError(name, `variável dinâmica desconhecida {{${name}}}`)
}

/** TOTP (RFC 6238) com SHA-1, passo de 30 s e 6 dígitos: o padrão dos apps autenticadores. */
export function totp(base32Seed: string, now = Date.now()): string {
  const key = decodeBase32(base32Seed)
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)))
  const hmac = createHmac('sha1', key).update(counter).digest()
  const offset = hmac[hmac.length - 1]! & 0x0f
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return String(code).padStart(6, '0')
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function decodeBase32(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase()
  const bytes: number[] = []
  let bits = 0
  let acc = 0
  for (const ch of clean) {
    const v = BASE32.indexOf(ch)
    if (v < 0) throw new UnresolvedVariableError('$totp', 'semente TOTP inválida: use base32 (A-Z, 2-7)')
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }
  return Buffer.from(bytes)
}
