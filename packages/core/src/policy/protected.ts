import type { Environment } from '@vvpost/schemas'

/** Palavras que, no id ou no nome, fazem um ambiente parecer de produção. */
const PRODUCTION_WORDS = new Set(['prod', 'prd', 'production', 'producao', 'produção', 'live'])

/** O id ou o nome parecem de produção: env.prod, "Produção", prd-eu, live. */
export function looksLikeProduction(env: Pick<Environment, 'id' | 'name'>): boolean {
  const words = `${env.id} ${env.name}`.toLowerCase().split(/[^\p{L}\p{N}]+/u)
  return words.some((w) => PRODUCTION_WORDS.has(w))
}

/**
 * Ambiente protegido (docs/security-model.md, Ambientes protegidos): o `protected` do arquivo,
 * ou, sem ele, um ambiente que parece de produção. Nele, quem dispara sem um humano conferindo
 * (a IA pelo MCP, os hooks de webhook) só monta o plano e valida, e o app pede confirmação.
 */
export function isProtectedEnvironment(env: Pick<Environment, 'id' | 'name' | 'protected'> | undefined): boolean {
  if (!env) return false
  return env.protected ?? looksLikeProduction(env)
}
