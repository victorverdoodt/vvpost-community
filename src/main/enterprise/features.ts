import { FEATURE_IDS, setFeaturePolicy, type FeaturePolicy } from '@vvpost/core/policy/features'
import type { FeaturePolicySession, FeaturePolicyState } from './control-plane'
import { EnterpriseModuleMissingError, loadEnterpriseModule, type EnterpriseSecretsModule, type OrganizationRef } from '../secret-engine/backend'

/**
 * Recursos desligados pela organização (docs/control-plane.md, "Recursos desligados"): a sessão
 * do módulo Enterprise diz o que a política central desligou, e o core recusa o recurso no app,
 * no CLI e no MCP (assertFeature em @vvpost/core/policy/features). Como a política do agente,
 * com o workspace declarando a organização não há "sem política": ou ela vale, ou todos os
 * recursos da lista ficam desligados até ela chegar.
 */

/** O que o core aplica para um estado da sessão; null quando só a variável de ambiente vale. */
export function featurePolicyOf(state: FeaturePolicyState): FeaturePolicy | null {
  if (state.status === 'none') return null
  if (state.status === 'unavailable') return { disabled: FEATURE_IDS, source: `política da organização, indisponível (${state.reason})` }
  const when = state.cached ? `, cópia de ${state.fetchedAt.slice(0, 16).replace('T', ' ')}` : ''
  return { disabled: state.disabled, source: `política da organização (${state.source}${when})` }
}

/** Liga (ou desliga, com null) a sessão ao core. */
export function applyFeaturePolicy(session: FeaturePolicySession | null): void {
  setFeaturePolicy(session ? () => featurePolicyOf(session.state()) : null)
}

/**
 * Sessão de recursos do módulo Enterprise, se houver; null sem módulo e sem organização
 * declarada (o build Community fica só com VVPOST_DISABLE_FEATURES).
 */
export async function openFeaturePolicy(
  context: { surface: 'app' | 'cli' | 'stdio' },
  load: () => Promise<EnterpriseSecretsModule> = loadEnterpriseModule,
  declared: OrganizationRef | null = null
): Promise<FeaturePolicySession | null> {
  const host = declared && new URL(declared.controlPlane).host
  let mod: EnterpriseSecretsModule
  try {
    mod = await load()
  } catch (err) {
    if (!(err instanceof EnterpriseModuleMissingError)) return unavailableFeatures(`módulo Enterprise: ${(err as Error).message}`)
    return host ? unavailableFeatures(`o workspace exige a política da organização (${host}) e o módulo VVPost Enterprise não está instalado`) : null
  }
  if (declared) {
    if (!mod.organization) return unavailableFeatures(`o workspace declara a organização (${host}), mas o módulo VVPost Enterprise instalado é anterior à configuração pelo Control Plane; atualize-o`)
    mod.organization.use(declared)
  }
  const ext = mod.controlPlane?.features
  if (!ext) {
    // Módulo anterior aos recursos desligados: com a organização declarada, fica restrito, como o agente.
    return host ? unavailableFeatures(`o módulo VVPost Enterprise instalado é anterior aos recursos desligados pela organização (${host}); atualize-o`) : null
  }
  try {
    return (await ext.open(context)) ?? (host ? unavailableFeatures(`o workspace exige a política da organização (${host}), que o módulo Enterprise não abriu`) : null)
  } catch (err) {
    return unavailableFeatures(`módulo Enterprise: ${(err as Error).message}`)
  }
}

/** Sem política possível: todos os recursos da lista desligados, com o motivo. */
export function unavailableFeatures(reason: string): FeaturePolicySession {
  const state = { status: 'unavailable', reason } as const
  return { state: () => state, ready: async () => state, close: async () => {} }
}
