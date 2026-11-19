import type { ConnectorAuth } from '@vvpost/schemas'

/** Toda auth de conector que injeta algo na requisição. */
export type ActiveAuth = Exclude<ConnectorAuth, { type: 'none' }>
export type AuthType = ActiveAuth['type']

/** Onde a credencial entra na requisição. */
export type AuthPlacement = { in: 'header'; name: string } | { in: 'query'; name: string }

/**
 * Contrato de cada tipo de auth. É o que vale para todo
 * chamador do motor (Quick Request, cenários, Flow Studio, plugins, MCP, CLI), sem
 * nada da interface: a auth roda no main process e devolve headers ou parâmetros de
 * query prontos (ou a assinatura e a resposta ao desafio, que dependem da requisição).
 * A única interação é o login no navegador do OAuth2 authorization_code, por um hook
 * de quem tem uma pessoa do outro lado.
 */
export interface AuthTypeContract<T extends AuthType = AuthType> {
  /** O valor pode ser buscado de novo (fluxo com token): depois de um 401 com token em cache, o motor repete uma vez. */
  renewable: boolean
  /** Dispara requisições próprias (token endpoint, login) antes da requisição do usuário. */
  runsFlow: boolean
  /** Onde a credencial entra. Um header com o mesmo nome digitado pelo usuário substitui a auth. */
  placement(config: Extract<ActiveAuth, { type: T }>): AuthPlacement
  /**
   * Campos que carregam credencial e só podem vir de {{VAR}} de um ambiente (nunca
   * literais num arquivo versionado). Caminhos relativos ao objeto de auth.
   */
  secretFields: readonly string[]
}

export const AUTH_CONTRACT: { readonly [T in AuthType]: AuthTypeContract<T> } = {
  bearer: {
    renewable: false,
    runsFlow: false,
    placement: (c) => ({ in: 'header', name: c.header ?? 'Authorization' }),
    secretFields: ['token']
  },
  apiKey: {
    renewable: false,
    runsFlow: false,
    placement: (c) => ({ in: c.in === 'query' ? 'query' : 'header', name: c.name }),
    secretFields: ['value']
  },
  basic: {
    renewable: false,
    runsFlow: false,
    placement: () => ({ in: 'header', name: 'Authorization' }),
    secretFields: ['password']
  },
  oauth2: {
    renewable: true,
    runsFlow: true,
    placement: () => ({ in: 'header', name: 'Authorization' }),
    secretFields: ['clientSecret', 'password']
  },
  login: {
    renewable: true,
    runsFlow: true,
    placement: (c) => ({ in: c.inject?.in === 'query' ? 'query' : 'header', name: c.inject?.name ?? 'Authorization' }),
    // O corpo do login é livre: os campos de credencial dele são achados pelo nome (ver literalSecrets).
    secretFields: []
  },
  // As quatro abaixo dependem da requisição final: Digest e NTLM respondem ao 401 do servidor
  // (AppliedAuth.challenge); SigV4 e OAuth 1.0 assinam método, URL e corpo (AppliedAuth.sign).
  digest: {
    renewable: false,
    runsFlow: false,
    placement: () => ({ in: 'header', name: 'Authorization' }),
    secretFields: ['password']
  },
  ntlm: {
    renewable: false,
    runsFlow: false,
    placement: () => ({ in: 'header', name: 'Authorization' }),
    secretFields: ['password']
  },
  awsSigV4: {
    renewable: false,
    runsFlow: false,
    placement: () => ({ in: 'header', name: 'Authorization' }),
    secretFields: ['secretAccessKey', 'sessionToken']
  },
  oauth1: {
    renewable: false,
    runsFlow: false,
    placement: () => ({ in: 'header', name: 'Authorization' }),
    secretFields: ['consumerSecret', 'tokenSecret']
  }
}

export function authPlacement(auth: ActiveAuth): AuthPlacement {
  return (AUTH_CONTRACT[auth.type] as AuthTypeContract).placement(auth as never)
}

/** Header onde a auth entra, ou undefined quando ela vai na query. */
export function authHeaderName(auth: ActiveAuth): string | undefined {
  const placement = authPlacement(auth)
  return placement.in === 'header' ? placement.name : undefined
}
