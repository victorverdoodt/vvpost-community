import type { Endpoint, Scenario } from '@vvpost/schemas'

/**
 * O gate de acesso de um endpoint (`requiresAuth`): o cenário que o `vvpost run` acrescenta sozinho.
 *
 * - `requiresAuth: true`: o endpoint é chamado uma vez sem credencial (sem a auth do conector, sem
 *   os headers de credencial e sem corpo) e precisa responder 401 ou 403.
 * - `requiresAuth: false` sem cenários: a mesma chamada sem credencial não pode dar 401 nem 403.
 *   Com cenários, são eles que dizem o que é funcionar, e rodam sem credencial (buildScenarioRequest).
 *
 * Módulo puro: o renderer usa para mostrar a linha na matriz.
 */

/** Id do cenário acrescentado; o $ não cabe num id de cenário escrito no arquivo. */
export const ACCESS_CHECK_ID = '$sem-credencial'

/** Valor de um {nome} do path sem valor nos cenários: um UUID passa nas restrições de rota de texto e de GUID. */
export const ACCESS_PLACEHOLDER = '00000000-0000-0000-0000-000000000000'

const PATH_PARAM = /(?<!\{)\{([A-Za-z0-9_.-]+)\}(?!\})/g

type AccessEndpoint = Pick<Endpoint, 'path' | 'requiresAuth' | 'plugin'> & { scenarios?: readonly Pick<Scenario, 'overrides'>[] }

/** O cenário do gate de acesso do endpoint, ou nada (sem requiresAuth, com plugin ou público com cenários). */
export function accessCheckScenario(endpoint: AccessEndpoint): Scenario | undefined {
  if (endpoint.requiresAuth === undefined || endpoint.plugin) return undefined
  if (endpoint.requiresAuth === false && endpoint.scenarios?.length) return undefined
  const pathParams: Record<string, string> = {}
  for (const m of endpoint.path.matchAll(PATH_PARAM)) {
    const name = m[1]!
    // O valor de um cenário vale, menos o que vem de outro cenário ({{$capture...}}), que aqui não roda.
    const fromScenario = endpoint.scenarios
      ?.map((s) => s.overrides?.pathParams?.[name])
      .find((v): v is string => v !== undefined && !v.includes('{{$capture.'))
    pathParams[name] = fromScenario ?? ACCESS_PLACEHOLDER
  }
  const overrides = { ...(Object.keys(pathParams).length && { pathParams }), ...(endpoint.requiresAuth && { body: null }) }
  return endpoint.requiresAuth
    ? {
        id: ACCESS_CHECK_ID,
        name: 'Sem credencial: exige auth (401 ou 403)',
        description: 'Acrescentado pelo VVPost porque o endpoint tem requiresAuth: true. Vai sem a auth do conector, sem os headers de credencial e sem corpo.',
        overrides,
        assertions: [
          { target: 'status', operator: 'greaterThanOrEqual', expected: 401 },
          { target: 'status', operator: 'lessThanOrEqual', expected: 403 },
          { target: 'status', operator: 'notEquals', expected: 402 }
        ]
      }
    : {
        id: ACCESS_CHECK_ID,
        name: 'Sem credencial: público',
        description:
          'Acrescentado pelo VVPost porque o endpoint tem requiresAuth: false e nenhum cenário. Vai sem a auth do conector e sem os headers de credencial. Se 401 é a resposta certa sem dados válidos (um login), escreva um cenário para o endpoint.',
        ...(Object.keys(overrides).length && { overrides }),
        assertions: [
          { target: 'status', operator: 'notEquals', expected: 401 },
          { target: 'status', operator: 'notEquals', expected: 403 }
        ]
      }
}
