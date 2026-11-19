import { describe, expect, it } from 'vitest'
import type { FlowErrorCode } from '@vvpost/core/types'
import { describeError } from '../src/renderer/src/design-system/feedback/errors'

// Todos os códigos do motor (HttpErrorCode e FlowErrorCode). Um código novo sem entrada aqui cai
// no erro genérico; o Record obriga a lista a acompanhar o tipo.
const CODES: Record<FlowErrorCode, true> = {
  INVALID_URL: true,
  ABORTED: true,
  TIMEOUT: true,
  CONNECTION_REFUSED: true,
  DNS_FAILURE: true,
  TLS_FAILURE: true,
  INVALID_REQUEST: true,
  NETWORK_ERROR: true,
  AUTH_FAILED: true,
  CONFIG_ERROR: true,
  POLICY_DENIED: true,
  PREPARE_FAILED: true,
  HTTP_STATUS: true,
  EXPRESSION_ERROR: true,
  PYTHON_NOT_FOUND: true,
  PYTHON_ERROR: true,
  PLUGIN_UNAVAILABLE: true,
  PLUGIN_ERROR: true,
  PLUGIN_CRASHED: true,
  SCRIPT_ERROR: true,
  ASSERTION_FAILED: true,
  POLL_TIMEOUT: true,
  WEBHOOK_TIMEOUT: true,
  WEBHOOK_UNAVAILABLE: true
}

describe('describeError', () => {
  it('dá categoria, tom e próxima ação a todo código do motor', () => {
    const generic = describeError('???')
    for (const code of Object.keys(CODES)) {
      const d = describeError(code)
      expect(d.hint, code).not.toBe(generic.hint)
      expect(d.hint.length, code).toBeGreaterThan(10)
    }
  })

  it('usa a mesma cor para o mesmo erro em qualquer módulo e não pinta cancelamento de erro', () => {
    expect(describeError('CONFIG_ERROR')).toMatchObject({ category: 'Configuração', tone: 'danger' })
    expect(describeError('ABORTED').tone).toBe('neutral')
  })

  it('tem categoria própria para os erros do app fora do motor: Git, schema e MCP', () => {
    expect(describeError('GIT_ERROR')).toMatchObject({ category: 'Git', tone: 'danger' })
    expect(describeError('SCHEMA_INVALID')).toMatchObject({ category: 'Schema', tone: 'danger' })
    expect(describeError('MCP_ERROR')).toMatchObject({ category: 'MCP', tone: 'danger' })
  })
})

describe('failureKind', () => {
  it('separa asserção, transporte, configuração e política', async () => {
    const { failureKind } = await import('../src/renderer/src/design-system/feedback/errors')
    expect(failureKind(undefined)).toBe('assertion')
    expect(failureKind('ASSERTION_FAILED')).toBe('assertion')
    for (const code of ['TIMEOUT', 'CONNECTION_REFUSED', 'DNS_FAILURE', 'TLS_FAILURE', 'NETWORK_ERROR']) expect(failureKind(code), code).toBe('transport')
    for (const code of ['CONFIG_ERROR', 'AUTH_FAILED', 'INVALID_URL', 'DEPENDENCY_FAILED', 'PREPARE_FAILED']) expect(failureKind(code), code).toBe('config')
    expect(failureKind('POLICY_DENIED')).toBe('policy')
    expect(failureKind('ABORTED')).toBe('canceled')
  })
})
