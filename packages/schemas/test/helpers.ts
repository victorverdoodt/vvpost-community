import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import type { ValidationResult } from '../src/index.ts'

/** Lê um fixture de test/fixtures/valid como objeto novo, pronto para ser mutado. */
export function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./fixtures/valid/${name}`, import.meta.url), 'utf8'))
}

export function assertValid(result: ValidationResult<unknown>): void {
  assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.issues, null, 2))
}

/** Falha a menos que haja um problema no caminho dado (e, se informado, com a mensagem). */
export function assertIssue(result: ValidationResult<unknown>, path: string, message?: RegExp): void {
  assert.equal(result.ok, false, 'esperava falha de validação')
  if (result.ok) return
  const atPath = result.issues.filter((i) => i.path === path)
  assert.ok(
    atPath.some((i) => !message || message.test(i.message)),
    `nenhum problema em "${path}"${message ? ` com ${message}` : ''}; recebido: ${JSON.stringify(result.issues)}`
  )
}
